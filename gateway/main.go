// Package main implements a transparent WebSocket proxy gateway.
//
// Architecture:
//
//	Client ──WS──► Go Gateway ──WS──► Python Worker (via room registry lookup)
//
// The gateway:
//   - Accepts client WebSocket connections (goroutine per conn, ~4KB stack)
//   - Reads the first JSON message to determine the room code
//   - Looks up the room registry in Redis to find the owning Python worker
//   - Opens a backend WebSocket to that specific worker
//   - Pipes all frames bidirectionally (client ↔ gateway ↔ worker)
//
// This is a transparent proxy — Python workers see normal WebSocket clients.
// No changes to the Python code are needed.
//
// Performance goal: Hold 100K+ client connections while routing each to the
// correct backend worker, eliminating the proxy-room/RPC overhead entirely.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ─── Configuration ───────────────────────────────────────────────────────────

var (
	listenPort   = flag.Int("port", 9000, "Gateway listen port")
	redisURL     = flag.String("redis", "", "Redis URL (e.g. redis://redis:6379)")
	backendAddrs = flag.String("backends", "localhost:8000", "Comma-separated backend worker addresses (host:port)")
	defaultAddr  = flag.String("default-backend", "", "Default backend for create_room (least-loaded if Redis available)")
)

// ─── Metrics ─────────────────────────────────────────────────────────────────

var (
	activeClients  atomic.Int64
	activeBackends atomic.Int64
	totalConnects  atomic.Int64
	totalErrors    atomic.Int64
)

// ─── Main ────────────────────────────────────────────────────────────────────

func main() {
	flag.Parse()

	// Parse backend addresses
	backends := strings.Split(*backendAddrs, ",")
	for i := range backends {
		backends[i] = strings.TrimSpace(backends[i])
	}

	// Initialize Redis (optional — falls back to round-robin if not configured)
	var rdb *redis.Client
	if *redisURL != "" {
		opts, err := redis.ParseURL(*redisURL)
		if err != nil {
			log.Fatalf("[gateway] Invalid redis URL: %v", err)
		}
		rdb = redis.NewClient(opts)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := rdb.Ping(ctx).Err(); err != nil {
			log.Printf("[gateway] Redis not available, falling back to round-robin: %v", err)
			rdb = nil
		}
		cancel()
	}

	gw := &Gateway{
		backends: backends,
		redis:    rdb,
		resolver: NewWorkerResolver(rdb, 5*time.Second),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}

	// Start resolver cache cleanup goroutine
	if rdb != nil {
		go gw.resolver.StartCleanup(context.Background())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", gw.HandleWebSocket)
	mux.HandleFunc("/health", gw.HandleHealth)
	mux.HandleFunc("/rooms/", gw.HandleCoord) // Coord: GET/POST /rooms/{index}

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", *listenPort),
		Handler: mux,
	}

	// Graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		log.Printf("[gateway] Listening on :%d (backends: %v, redis: %v)",
			*listenPort, backends, rdb != nil)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("[gateway] Server error: %v", err)
		}
	}()

	<-stop
	log.Println("[gateway] Shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(ctx)
	log.Println("[gateway] Stopped")
}

// ─── Gateway ─────────────────────────────────────────────────────────────────

// Gateway is a transparent WebSocket proxy with room-aware routing.
type Gateway struct {
	backends []string
	redis    *redis.Client
	resolver *WorkerResolver
	upgrader websocket.Upgrader
	rrIndex  atomic.Uint64 // round-robin counter
	mu       sync.Mutex
	coordMap map[string]string // in-memory fallback for coord (no Redis)
}

// HandleWebSocket accepts a client connection, reads the first message to
// determine routing, then pipes bidirectionally to the backend worker.
func (gw *Gateway) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	connID := totalConnects.Add(1)
	upgradeStart := time.Now()

	clientConn, err := gw.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[gateway] UPGRADE_FAILED connID=%d elapsed=%v err=%v", connID, time.Since(upgradeStart), err)
		return
	}
	upgradeDur := time.Since(upgradeStart)

	activeClients.Add(1)
	currentClients := activeClients.Load()
	if connID%100 == 0 || upgradeDur > 100*time.Millisecond {
		log.Printf("[gateway] CONNECTED connID=%d active_clients=%d upgrade_ms=%d", connID, currentClients, upgradeDur.Milliseconds())
	}

	defer func() {
		activeClients.Add(-1)
		clientConn.Close()
	}()

	// Step 1: Read the first message to determine routing
	readStart := time.Now()
	clientConn.SetReadDeadline(time.Now().Add(30 * time.Second))
	_, firstMsg, err := clientConn.ReadMessage()
	if err != nil {
		log.Printf("[gateway] FIRST_MSG_FAILED connID=%d elapsed=%v err=%v", connID, time.Since(readStart), err)
		totalErrors.Add(1)
		return
	}
	clientConn.SetReadDeadline(time.Time{}) // Clear deadline
	readDur := time.Since(readStart)

	// Step 2: Parse to determine which backend owns this room
	routeStart := time.Now()
	backendAddr := gw.routeConnection(firstMsg)
	routeDur := time.Since(routeStart)
	if backendAddr == "" {
		log.Printf("[gateway] NO_BACKEND connID=%d route_ms=%d msg=%s", connID, routeDur.Milliseconds(), string(firstMsg[:min(len(firstMsg), 100)]))
		totalErrors.Add(1)
		sendError(clientConn, "NO_BACKEND", "No available backend worker")
		return
	}

	// Step 3: Connect to backend with fallback (direct dial, no nginx)
	dialStart := time.Now()
	backendConn, finalAddr, dialErr := gw.dialWithFallback(backendAddr)
	dialDur := time.Since(dialStart)
	if dialErr != nil {
		log.Printf("[gateway] DIAL_FAILED connID=%d primary=%s total_ms=%d err=%v", connID, backendAddr, dialDur.Milliseconds(), dialErr)
		totalErrors.Add(1)
		sendError(clientConn, "BACKEND_UNAVAILABLE", "Backend worker unavailable")
		return
	}

	activeBackends.Add(1)
	currentBackends := activeBackends.Load()
	if connID%100 == 0 || dialDur > 200*time.Millisecond || finalAddr != backendAddr {
		log.Printf("[gateway] DIAL_OK connID=%d backend=%s dial_ms=%d read_ms=%d route_ms=%d active_backends=%d",
			connID, finalAddr, dialDur.Milliseconds(), readDur.Milliseconds(), routeDur.Milliseconds(), currentBackends)
	}

	defer func() {
		activeBackends.Add(-1)
		backendConn.Close()
	}()

	// Step 4: Forward the first message to the backend
	if err := backendConn.WriteMessage(websocket.TextMessage, firstMsg); err != nil {
		log.Printf("[gateway] FORWARD_FAILED connID=%d err=%v", connID, err)
		totalErrors.Add(1)
		return
	}

	// Step 5: Bidirectional pipe — run until either side closes
	done := make(chan struct{})

	// Client → Backend
	go func() {
		defer close(done)
		for {
			msgType, msg, err := clientConn.ReadMessage()
			if err != nil {
				return
			}
			if err := backendConn.WriteMessage(msgType, msg); err != nil {
				return
			}
		}
	}()

	// Backend → Client
	for {
		msgType, msg, err := backendConn.ReadMessage()
		if err != nil {
			break
		}
		if err := clientConn.WriteMessage(msgType, msg); err != nil {
			break
		}
	}

	<-done
	sessionDur := time.Since(upgradeStart)
	if connID%100 == 0 {
		log.Printf("[gateway] SESSION_END connID=%d duration=%v", connID, sessionDur)
	}
}

// routeConnection parses the first message and determines the target worker ID.
// Returns the resolved backend address, or empty string if no route found.
func (gw *Gateway) routeConnection(firstMsg []byte) string {
	var msg struct {
		Type    string `json:"type"`
		Payload struct {
			RoomCode string `json:"room_code"`
		} `json:"payload"`
	}

	if err := json.Unmarshal(firstMsg, &msg); err != nil {
		// Can't parse — use round-robin fallback
		return gw.roundRobin()
	}

	switch msg.Type {
	case "create_room":
		// New room: pick least-loaded worker, resolve its address
		if gw.redis != nil {
			if workerID := gw.leastLoadedWorkerID(); workerID != "" {
				if addr := gw.resolveWorkerAddr(workerID); addr != "" {
					return addr
				}
			}
		}
		return gw.roundRobin()

	case "join_room", "reconnect":
		// Existing room: lookup owner, resolve its address
		if gw.redis != nil && msg.Payload.RoomCode != "" {
			if workerID := gw.lookupRoomOwnerID(msg.Payload.RoomCode); workerID != "" {
				if addr := gw.resolveWorkerAddr(workerID); addr != "" {
					return addr
				}
			}
		}
		// Fallback: round-robin
		return gw.roundRobin()

	default:
		return gw.roundRobin()
	}
}

// lookupRoomOwnerID finds which worker ID owns a room via Redis.
// Returns the worker ID string, not an address.
func (gw *Gateway) lookupRoomOwnerID(roomCode string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Try per-room key first (has TTL)
	owner, err := gw.redis.Get(ctx, "room_owner:"+roomCode).Result()
	if err == nil && owner != "" {
		return owner
	}

	// Fallback to hash
	owner, err = gw.redis.HGet(ctx, "room_workers", roomCode).Result()
	if err == nil && owner != "" {
		return owner
	}

	return ""
}

// leastLoadedWorkerID queries the Redis sorted set for the least-loaded worker ID.
func (gw *Gateway) leastLoadedWorkerID() string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, err := gw.redis.ZRange(ctx, "worker_load", 0, 0).Result()
	if err != nil || len(result) == 0 {
		return ""
	}

	return result[0]
}

// resolveWorkerAddr resolves a worker ID to its reachable address via the WorkerResolver.
// Falls back to round-robin among static backends if resolution fails.
func (gw *Gateway) resolveWorkerAddr(workerID string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	addr, err := gw.resolver.Resolve(ctx, workerID)
	if err != nil {
		log.Printf("[gateway] RESOLVE_FAILED worker=%s err=%v", workerID, err)
		return ""
	}
	return addr
}

// dialWithFallback attempts to connect to the primary backend address.
// If it fails, checks liveness and falls back to the least-loaded alternative.
// Returns the connected WebSocket and the address it connected to.
// Maximum 2 attempts: primary + 1 fallback.
func (gw *Gateway) dialWithFallback(primaryAddr string) (*websocket.Conn, string, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
	}

	// Attempt 1: dial the primary address
	backendURL := url.URL{Scheme: "ws", Host: primaryAddr, Path: "/ws"}
	conn, _, err := dialer.Dial(backendURL.String(), nil)
	if err == nil {
		return conn, primaryAddr, nil
	}

	log.Printf("[gateway] DIAL_FALLBACK primary=%s err=%v, trying fallback...", primaryAddr, err)

	// Evict the failed address from resolver cache (if it came from resolver)
	// We don't have the workerID here, but the resolver will re-resolve on next use
	// Try fallback: pick least-loaded worker
	if gw.redis != nil {
		fallbackID := gw.leastLoadedWorkerID()
		if fallbackID != "" {
			fallbackAddr := gw.resolveWorkerAddr(fallbackID)
			if fallbackAddr != "" && fallbackAddr != primaryAddr {
				// Check liveness before dialing fallback
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				alive, _ := gw.resolver.IsAlive(ctx, fallbackID)
				cancel()

				if alive {
					backendURL = url.URL{Scheme: "ws", Host: fallbackAddr, Path: "/ws"}
					conn, _, err = dialer.Dial(backendURL.String(), nil)
					if err == nil {
						return conn, fallbackAddr, nil
					}
					log.Printf("[gateway] DIAL_FALLBACK_FAILED fallback=%s err=%v", fallbackAddr, err)
				} else {
					// Clean up dead worker
					ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
					gw.resolver.CleanupDeadWorker(ctx2, fallbackID)
					cancel2()
				}
			}
		}
	}

	// All attempts exhausted — try round-robin as last resort
	rrAddr := gw.roundRobin()
	if rrAddr != "" && rrAddr != primaryAddr {
		backendURL = url.URL{Scheme: "ws", Host: rrAddr, Path: "/ws"}
		conn, _, err = dialer.Dial(backendURL.String(), nil)
		if err == nil {
			return conn, rrAddr, nil
		}
	}

	return nil, "", fmt.Errorf("all backends unreachable (primary=%s, last_err=%v)", primaryAddr, err)
}

// roundRobin returns the next backend in rotation.
func (gw *Gateway) roundRobin() string {
	if len(gw.backends) == 0 {
		return ""
	}
	idx := gw.rrIndex.Add(1)
	return gw.backends[int(idx-1)%len(gw.backends)]
}

// HandleHealth returns gateway metrics.
func (gw *Gateway) HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status":"ok","active_clients":%d,"active_backends":%d,"total_connects":%d,"total_errors":%d}`,
		activeClients.Load(), activeBackends.Load(), totalConnects.Load(), totalErrors.Load())
}

// sendError sends a JSON error to a WebSocket client.
func sendError(conn *websocket.Conn, code, message string) {
	msg, _ := json.Marshal(map[string]interface{}{
		"type": "error",
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
	conn.WriteMessage(websocket.TextMessage, msg)
}

// ─── Coordination Endpoints ──────────────────────────────────────────────────
// Replaces the separate Python coord_server.py.
// Hosts POST room codes, joiners GET them. Stored in Redis or in-memory.

// HandleCoord handles GET/POST /rooms/{index} for k6 test coordination.
func (gw *Gateway) HandleCoord(w http.ResponseWriter, r *http.Request) {
	// Extract room index from path: /rooms/123
	path := strings.TrimPrefix(r.URL.Path, "/rooms/")
	if path == "" || path == r.URL.Path {
		http.Error(w, `{"error":"missing room index"}`, http.StatusBadRequest)
		return
	}
	roomIndex := path

	switch r.Method {
	case http.MethodPost:
		gw.coordPost(w, r, roomIndex)
	case http.MethodGet:
		gw.coordGet(w, r, roomIndex)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (gw *Gateway) coordPost(w http.ResponseWriter, r *http.Request, roomIndex string) {
	var body struct {
		RoomCode string `json:"room_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RoomCode == "" {
		http.Error(w, `{"error":"missing room_code"}`, http.StatusBadRequest)
		return
	}

	if gw.redis != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		gw.redis.Set(ctx, "coord:room:"+roomIndex, body.RoomCode, 10*time.Minute)
	} else {
		gw.mu.Lock()
		if gw.coordMap == nil {
			gw.coordMap = make(map[string]string)
		}
		gw.coordMap[roomIndex] = body.RoomCode
		gw.mu.Unlock()
	}

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status":"published","room_index":"%s","room_code":"%s"}`, roomIndex, body.RoomCode)
}

func (gw *Gateway) coordGet(w http.ResponseWriter, r *http.Request, roomIndex string) {
	var code string

	if gw.redis != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		val, err := gw.redis.Get(ctx, "coord:room:"+roomIndex).Result()
		if err == nil {
			code = val
		}
	} else {
		gw.mu.Lock()
		if gw.coordMap != nil {
			code = gw.coordMap[roomIndex]
		}
		gw.mu.Unlock()
	}

	if code == "" {
		http.Error(w, `{"error":"Room not yet created","room_index":"`+roomIndex+`"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"room_code":"%s","room_index":"%s"}`, code, roomIndex)
}
