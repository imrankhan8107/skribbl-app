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
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", gw.HandleWebSocket)
	mux.HandleFunc("/health", gw.HandleHealth)

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
	upgrader websocket.Upgrader
	rrIndex  atomic.Uint64 // round-robin counter
	mu       sync.Mutex
}

// HandleWebSocket accepts a client connection, reads the first message to
// determine routing, then pipes bidirectionally to the backend worker.
func (gw *Gateway) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	clientConn, err := gw.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[gateway] Upgrade failed: %v", err)
		return
	}

	totalConnects.Add(1)
	activeClients.Add(1)
	defer func() {
		activeClients.Add(-1)
		clientConn.Close()
	}()

	// Step 1: Read the first message to determine routing
	clientConn.SetReadDeadline(time.Now().Add(30 * time.Second))
	_, firstMsg, err := clientConn.ReadMessage()
	if err != nil {
		log.Printf("[gateway] Failed to read first message: %v", err)
		totalErrors.Add(1)
		return
	}
	clientConn.SetReadDeadline(time.Time{}) // Clear deadline

	// Step 2: Parse to determine which backend owns this room
	backendAddr := gw.routeConnection(firstMsg)
	if backendAddr == "" {
		log.Printf("[gateway] No backend found for message")
		totalErrors.Add(1)
		sendError(clientConn, "NO_BACKEND", "No available backend worker")
		return
	}

	// Step 3: Connect to the backend worker
	backendURL := url.URL{Scheme: "ws", Host: backendAddr, Path: "/ws"}
	backendConn, _, err := websocket.DefaultDialer.Dial(backendURL.String(), nil)
	if err != nil {
		log.Printf("[gateway] Backend dial failed (%s): %v", backendAddr, err)
		totalErrors.Add(1)
		sendError(clientConn, "BACKEND_UNAVAILABLE", "Backend worker unavailable")
		return
	}
	activeBackends.Add(1)
	defer func() {
		activeBackends.Add(-1)
		backendConn.Close()
	}()

	// Step 4: Forward the first message to the backend
	if err := backendConn.WriteMessage(websocket.TextMessage, firstMsg); err != nil {
		log.Printf("[gateway] Failed to forward first message: %v", err)
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
}

// routeConnection parses the first message and determines the backend address.
func (gw *Gateway) routeConnection(firstMsg []byte) string {
	var msg struct {
		Type    string `json:"type"`
		Payload struct {
			RoomCode string `json:"room_code"`
		} `json:"payload"`
	}

	if err := json.Unmarshal(firstMsg, &msg); err != nil {
		// Can't parse — use round-robin
		return gw.roundRobin()
	}

	switch msg.Type {
	case "create_room":
		// New room: pick least-loaded worker (or round-robin)
		if gw.redis != nil {
			if addr := gw.leastLoadedWorker(); addr != "" {
				return addr
			}
		}
		return gw.roundRobin()

	case "join_room", "reconnect":
		// Existing room: lookup owner in Redis
		if gw.redis != nil && msg.Payload.RoomCode != "" {
			if addr := gw.lookupRoomOwner(msg.Payload.RoomCode); addr != "" {
				return addr
			}
		}
		// Fallback: round-robin (will work if workers handle cross-worker routing)
		return gw.roundRobin()

	default:
		return gw.roundRobin()
	}
}

// lookupRoomOwner finds the backend worker that owns a room via Redis.
func (gw *Gateway) lookupRoomOwner(roomCode string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Try per-room key first (has TTL)
	owner, err := gw.redis.Get(ctx, "room_owner:"+roomCode).Result()
	if err == nil && owner != "" {
		return gw.workerIDToAddr(owner)
	}

	// Fallback to hash
	owner, err = gw.redis.HGet(ctx, "room_workers", roomCode).Result()
	if err == nil && owner != "" {
		return gw.workerIDToAddr(owner)
	}

	return ""
}

// leastLoadedWorker queries the Redis sorted set for the least-loaded backend.
func (gw *Gateway) leastLoadedWorker() string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, err := gw.redis.ZRange(ctx, "worker_load", 0, 0).Result()
	if err != nil || len(result) == 0 {
		return ""
	}

	return gw.workerIDToAddr(result[0])
}

// workerIDToAddr maps a Redis worker_id (e.g., "worker_abc123") to a reachable address.
// In Docker Compose, all workers share the same service name and port.
// The worker_id stored in Redis is just an identifier — we need the actual address.
//
// Strategy: If we have Redis, workers register their gRPC/HTTP address.
// For now, use round-robin among known backends since Docker DNS handles routing.
func (gw *Gateway) workerIDToAddr(workerID string) string {
	// In a Kubernetes setup, workerID would be a pod IP.
	// In Docker Compose, all workers are behind the same service DNS.
	// For now, map any known worker ID to the first backend (Docker DNS resolves to a random container).
	if len(gw.backends) > 0 {
		return gw.backends[0]
	}
	return ""
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
