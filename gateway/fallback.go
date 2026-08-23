package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ─── Fallback Mode Constants ─────────────────────────────────────────────────

const (
	// maxRetries is the number of gRPC connection attempts before entering Fallback_Mode.
	maxRetries = 3

	// retryBaseDelay is the initial delay for exponential backoff (1s, 2s, 4s).
	retryBaseDelay = 1 * time.Second
)

// ─── Fallback State Tracking ─────────────────────────────────────────────────

// FallbackState tracks which rooms are operating in fallback (WS proxy) mode.
// A room stays in WS mode until it becomes empty or gRPC is restored.
type FallbackState struct {
	mu    sync.RWMutex
	rooms map[string]*roomFallbackEntry // room_code -> fallback entry
}

// roomFallbackEntry stores per-room fallback metadata.
type roomFallbackEntry struct {
	Reason    string    // Human-readable reason for fallback activation
	EnteredAt time.Time // When fallback was activated
	WorkerID  string    // The worker ID that was unreachable via gRPC
}

// NewFallbackState creates an empty FallbackState tracker.
func NewFallbackState() *FallbackState {
	return &FallbackState{
		rooms: make(map[string]*roomFallbackEntry),
	}
}

// IsInFallback returns true if the given room is currently in WS fallback mode.
func (fs *FallbackState) IsInFallback(roomCode string) bool {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	_, ok := fs.rooms[roomCode]
	return ok
}

// EnterFallback marks a room as operating in fallback mode.
func (fs *FallbackState) EnterFallback(roomCode, workerID, reason string) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.rooms[roomCode] = &roomFallbackEntry{
		Reason:    reason,
		EnteredAt: time.Now(),
		WorkerID:  workerID,
	}
}

// ExitFallback removes a room from fallback mode (e.g., room empty or gRPC restored).
func (fs *FallbackState) ExitFallback(roomCode string) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	delete(fs.rooms, roomCode)
}

// FallbackRoomCount returns the number of rooms currently in fallback mode.
func (fs *FallbackState) FallbackRoomCount() int {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return len(fs.rooms)
}

// ─── FallbackHandler ─────────────────────────────────────────────────────────

// FallbackHandler manages the decision between gRPC multiplexed path and
// per-player WebSocket proxy fallback.
type FallbackHandler struct {
	redis         *redis.Client
	streamManager *StreamManager
	state         *FallbackState
}

// NewFallbackHandler creates a FallbackHandler with the given dependencies.
func NewFallbackHandler(rdb *redis.Client, sm *StreamManager) *FallbackHandler {
	return &FallbackHandler{
		redis:         rdb,
		streamManager: sm,
		state:         NewFallbackState(),
	}
}

// isGRPCAvailable checks whether a worker's gRPC endpoint is reachable by verifying:
// 1. The `worker_grpc_alive:{worker_id}` liveness key exists in Redis (TTL-based heartbeat)
// 2. The `worker_grpc_addresses` hash has an entry for this worker_id
//
// Both conditions must be true for gRPC to be considered available.
func (fh *FallbackHandler) isGRPCAvailable(workerID string) bool {
	if fh.redis == nil {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Check liveness key: worker_grpc_alive:{worker_id}
	aliveKey := fmt.Sprintf("worker_grpc_alive:%s", workerID)
	exists, err := fh.redis.Exists(ctx, aliveKey).Result()
	if err != nil || exists == 0 {
		return false
	}

	// Check address registration: worker_grpc_addresses hash
	addr, err := fh.redis.HGet(ctx, "worker_grpc_addresses", workerID).Result()
	if err != nil || addr == "" {
		return false
	}

	return true
}

// retryStreamConnect attempts to establish a gRPC RoomStream with exponential
// backoff. It makes up to 3 attempts with delays of 1s, 2s, 4s between them.
// Returns the connected RoomStream on success, or an error after all retries are exhausted.
func (fh *FallbackHandler) retryStreamConnect(roomCode, workerID string) (*RoomStream, error) {
	var lastErr error
	delay := retryBaseDelay

	for attempt := 1; attempt <= maxRetries; attempt++ {
		stream, err := fh.streamManager.GetOrCreate(roomCode, workerID)
		if err == nil && stream.isHealthy() {
			return stream, nil
		}

		lastErr = err
		if lastErr == nil {
			lastErr = fmt.Errorf("stream unhealthy after creation (state=%d)", stream.state.Load())
		}

		log.Printf("[fallback] gRPC connect attempt %d/%d failed room=%s worker=%s err=%v",
			attempt, maxRetries, roomCode, workerID, lastErr)

		// Don't sleep after the last attempt
		if attempt < maxRetries {
			time.Sleep(delay)
			delay *= 2 // Exponential backoff: 1s → 2s → 4s
		}
	}

	return nil, fmt.Errorf("gRPC connect failed after %d attempts: %w", maxRetries, lastErr)
}

// handleWithFallback routes a client connection through either the gRPC multiplexed
// path or the per-player WebSocket proxy, depending on worker gRPC availability and
// per-room fallback state.
//
// Decision logic:
// 1. If the room is already in fallback mode → use WS proxy
// 2. If gRPC is not available for the worker → enter fallback, use WS proxy
// 3. Attempt gRPC connection with retries → on failure, enter fallback, use WS proxy
// 4. On success → use gRPC path
//
// Parameters:
//   - gw: the Gateway instance (for WS proxy fallback path)
//   - clientConn: the client's WebSocket connection
//   - firstMsg: the first message bytes (already read from client)
//   - roomCode: the resolved room code for this connection
//   - workerID: the worker ID that owns the room
func handleWithFallback(
	gw *Gateway,
	fh *FallbackHandler,
	clientConn *websocket.Conn,
	firstMsg []byte,
	roomCode string,
	workerID string,
) {
	// Fast path: room already in fallback mode — stay in WS proxy
	if fh.state.IsInFallback(roomCode) {
		log.Printf("[fallback] Room already in fallback mode room=%s worker=%s, using WS proxy",
			roomCode, workerID)
		handleWebSocketProxy(gw, clientConn, firstMsg, workerID)
		return
	}

	// Check if gRPC is available for this worker
	if !fh.isGRPCAvailable(workerID) {
		reason := "worker gRPC not available (alive key missing or no address registered)"
		fh.state.EnterFallback(roomCode, workerID, reason)
		log.Printf("[fallback] WARNING: Entering Fallback_Mode room=%s worker=%s reason=%q",
			roomCode, workerID, reason)
		handleWebSocketProxy(gw, clientConn, firstMsg, workerID)
		return
	}

	// Attempt gRPC connection with retry logic
	stream, err := fh.retryStreamConnect(roomCode, workerID)
	if err != nil {
		reason := fmt.Sprintf("gRPC connection failed after %d retries: %v", maxRetries, err)
		fh.state.EnterFallback(roomCode, workerID, reason)
		log.Printf("[fallback] WARNING: Entering Fallback_Mode room=%s worker=%s reason=%q",
			roomCode, workerID, reason)
		handleWebSocketProxy(gw, clientConn, firstMsg, workerID)
		return
	}

	// gRPC path successful — use multiplexed stream
	_ = stream // Stream is now cached in StreamManager; caller proceeds with gRPC flow
	handleGRPCPath(fh, clientConn, firstMsg, roomCode, stream)
}

// handleGRPCPath processes a client connection through the gRPC multiplexed path.
// The stream is already established; this function handles the client lifecycle
// on that stream (message forwarding, player registration, etc.).
func handleGRPCPath(fh *FallbackHandler, clientConn *websocket.Conn, firstMsg []byte, roomCode string, stream *RoomStream) {
	// Increment player count on the shared stream
	fh.streamManager.AddPlayer(roomCode)
	defer fh.streamManager.RemovePlayer(roomCode)

	// The actual gRPC message multiplexing is handled by the stream manager's
	// send loop and the gateway's receive loop (implemented in task 10.1/10.2).
	// This function establishes that the connection will use the gRPC path.
	log.Printf("[fallback] Using gRPC path room=%s worker=%s stream_healthy=%v",
		roomCode, stream.workerID, stream.isHealthy())
}

// handleWebSocketProxy falls back to the existing per-player WebSocket proxy behavior.
// It dials the worker's WS endpoint and pipes frames bidirectionally.
func handleWebSocketProxy(gw *Gateway, clientConn *websocket.Conn, firstMsg []byte, workerID string) {
	// Resolve worker WS address from worker_addresses (existing mechanism)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	addr, err := gw.resolver.Resolve(ctx, workerID)
	if err != nil {
		log.Printf("[fallback] WS proxy resolve failed worker=%s err=%v", workerID, err)
		sendError(clientConn, "BACKEND_UNAVAILABLE", "Backend worker unavailable")
		return
	}

	// Dial backend WebSocket
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
	}
	backendURL := url.URL{Scheme: "ws", Host: addr, Path: "/ws"}
	backendConn, _, err := dialer.Dial(backendURL.String(), nil)
	if err != nil {
		log.Printf("[fallback] WS proxy dial failed worker=%s addr=%s err=%v", workerID, addr, err)
		sendError(clientConn, "BACKEND_UNAVAILABLE", "Backend worker unavailable")
		return
	}
	defer backendConn.Close()

	// Forward the first message to the backend
	if err := backendConn.WriteMessage(websocket.TextMessage, firstMsg); err != nil {
		log.Printf("[fallback] WS proxy forward first msg failed worker=%s err=%v", workerID, err)
		return
	}

	log.Printf("[fallback] WS proxy active worker=%s addr=%s", workerID, addr)

	// Bidirectional pipe: client ↔ backend
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
