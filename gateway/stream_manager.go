package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/skribbl-app/gateway/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ─── Stream State Constants ──────────────────────────────────────────────────

const (
	streamStateHealthy      int32 = 0
	streamStateReconnecting int32 = 1
	streamStateDead         int32 = 2
)

// ─── Configuration ───────────────────────────────────────────────────────────

// StreamConfig holds tunable parameters for stream lifecycle management.
type StreamConfig struct {
	IdleTimeout       time.Duration // Time before closing an idle stream (default: 30s)
	KeepaliveInterval time.Duration // Interval between keepalive pings (default: 15s)
	KeepaliveTimeout  time.Duration // Max wait for keepalive response (default: 5s)
	MaxRetries        int           // Reconnection attempts before fallback (default: 3)
	BufferSize        int           // Max buffered messages during reconnection (default: 500)
}

// DefaultStreamConfig returns a StreamConfig with sensible defaults.
func DefaultStreamConfig() StreamConfig {
	return StreamConfig{
		IdleTimeout:       30 * time.Second,
		KeepaliveInterval: 15 * time.Second,
		KeepaliveTimeout:  5 * time.Second,
		MaxRetries:        3,
		BufferSize:        500,
	}
}

// ─── RoomStream ──────────────────────────────────────────────────────────────

// RoomStream wraps a gRPC bidirectional stream for a single room.
// Multiple players in the same room share one RoomStream instance.
type RoomStream struct {
	roomCode     string
	workerID     string
	stream       proto.GameService_RoomStreamClient
	conn         *grpc.ClientConn
	sendCh       chan *proto.GameMessage // Buffered channel for outbound messages
	playerCount  atomic.Int32
	lastActivity atomic.Value // stores time.Time
	state        atomic.Int32 // 0=healthy, 1=reconnecting, 2=dead
	cancel       context.CancelFunc
	done         chan struct{} // closed when send loop exits
}

// isHealthy returns true if the stream is in a usable state.
func (rs *RoomStream) isHealthy() bool {
	return rs.state.Load() == streamStateHealthy
}

// markActivity updates the last activity timestamp.
func (rs *RoomStream) markActivity() {
	rs.lastActivity.Store(time.Now())
}

// ─── StreamManager ───────────────────────────────────────────────────────────

// StreamManager manages RoomStream instances (one per room_code).
// It provides O(1) lookup from room_code to active stream, lazy-creates streams
// on first player connection, and closes idle streams after a configurable timeout.
type StreamManager struct {
	mu         sync.RWMutex
	streams    map[string]*RoomStream
	resolver   *WorkerResolver
	redis      *redis.Client
	config     StreamConfig
	directAddr string // Direct gRPC address (bypasses Redis discovery)
}

// NewStreamManager creates a StreamManager with the given resolver and config.
func NewStreamManager(resolver *WorkerResolver, rdb *redis.Client, config StreamConfig) *StreamManager {
	return &StreamManager{
		streams:  make(map[string]*RoomStream),
		resolver: resolver,
		redis:    rdb,
		config:   config,
	}
}

// GetOrCreate returns an existing healthy RoomStream for the given room, or
// creates a new one by dialing the worker's gRPC endpoint. This provides the
// multiplexing guarantee: all players in a room share a single stream.
func (sm *StreamManager) GetOrCreate(roomCode string, workerID string) (*RoomStream, error) {
	// Fast path: check for an existing healthy stream (read lock)
	sm.mu.RLock()
	if rs, ok := sm.streams[roomCode]; ok && rs.isHealthy() {
		sm.mu.RUnlock()
		rs.markActivity()
		return rs, nil
	}
	sm.mu.RUnlock()

	// Slow path: need to create or replace (write lock)
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Double-check after acquiring write lock
	if rs, ok := sm.streams[roomCode]; ok && rs.isHealthy() {
		rs.markActivity()
		return rs, nil
	}

	// Evict any dead/unhealthy stream
	if existing, ok := sm.streams[roomCode]; ok {
		sm.closeStreamLocked(existing)
		delete(sm.streams, roomCode)
	}

	// Resolve worker gRPC address
	addr, err := sm.resolveGRPCAddress(workerID)
	if err != nil {
		return nil, fmt.Errorf("resolve worker %s gRPC address: %w", workerID, err)
	}

	// Dial the worker's gRPC endpoint
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial worker %s at %s: %w", workerID, addr, err)
	}

	// Open a bidirectional RoomStream
	client := proto.NewGameServiceClient(conn)
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := client.RoomStream(ctx)
	if err != nil {
		cancel()
		conn.Close()
		return nil, fmt.Errorf("open RoomStream to worker %s: %w", workerID, err)
	}

	rs := &RoomStream{
		roomCode: roomCode,
		workerID: workerID,
		stream:   stream,
		conn:     conn,
		sendCh:   make(chan *proto.GameMessage, sm.config.BufferSize),
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	rs.state.Store(streamStateHealthy)
	rs.markActivity()

	sm.streams[roomCode] = rs

	// Start the send loop goroutine
	go sm.sendLoop(rs)

	log.Printf("[stream_manager] Stream opened room=%s worker=%s addr=%s", roomCode, workerID, addr)
	return rs, nil
}

// Send routes a GameMessage to the RoomStream for the given room.
// Returns an error if no stream exists or the stream is unhealthy.
func (sm *StreamManager) Send(roomCode string, msg *proto.GameMessage) error {
	sm.mu.RLock()
	rs, ok := sm.streams[roomCode]
	sm.mu.RUnlock()

	if !ok {
		return fmt.Errorf("no stream for room %s", roomCode)
	}

	if !rs.isHealthy() {
		return fmt.Errorf("stream for room %s is unhealthy (state=%d)", roomCode, rs.state.Load())
	}

	// Non-blocking send to the buffered channel
	select {
	case rs.sendCh <- msg:
		rs.markActivity()
		return nil
	default:
		return fmt.Errorf("send buffer full for room %s", roomCode)
	}
}

// AddPlayer increments the player count for a room's stream.
func (sm *StreamManager) AddPlayer(roomCode string) {
	sm.mu.RLock()
	rs, ok := sm.streams[roomCode]
	sm.mu.RUnlock()

	if ok {
		rs.playerCount.Add(1)
		rs.markActivity()
	}
}

// RemovePlayer decrements the player count for a room's stream.
// When the count reaches zero, schedules an idle timeout to close the stream.
func (sm *StreamManager) RemovePlayer(roomCode string) {
	sm.mu.RLock()
	rs, ok := sm.streams[roomCode]
	sm.mu.RUnlock()

	if !ok {
		return
	}

	newCount := rs.playerCount.Add(-1)
	if newCount <= 0 {
		// Schedule idle timeout — close the stream if no players reconnect
		go sm.scheduleIdleClose(roomCode, rs)
	}
}

// Close immediately closes the RoomStream for a room and removes it from the map.
func (sm *StreamManager) Close(roomCode string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	rs, ok := sm.streams[roomCode]
	if !ok {
		return
	}

	sm.closeStreamLocked(rs)
	delete(sm.streams, roomCode)
	log.Printf("[stream_manager] Stream closed room=%s", roomCode)
}

// GetStream returns the RoomStream for a room, or nil if none exists.
// Used by the receive loop to access the stream directly.
func (sm *StreamManager) GetStream(roomCode string) *RoomStream {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.streams[roomCode]
}

// MarkUnhealthy marks a stream as unhealthy and evicts it from the cache.
// The next GetOrCreate call for this room will establish a fresh stream.
func (sm *StreamManager) MarkUnhealthy(roomCode string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	rs, ok := sm.streams[roomCode]
	if !ok {
		return
	}

	rs.state.Store(streamStateDead)
	sm.closeStreamLocked(rs)
	delete(sm.streams, roomCode)
	log.Printf("[stream_manager] Stream evicted (unhealthy) room=%s worker=%s", roomCode, rs.workerID)
}

// ActiveStreamCount returns the number of currently active streams.
func (sm *StreamManager) ActiveStreamCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.streams)
}

// ─── Internal Methods ────────────────────────────────────────────────────────

// resolveGRPCAddress looks up the gRPC-specific address for a worker using
// the worker_grpc_addresses Redis hash.
func (sm *StreamManager) resolveGRPCAddress(workerID string) (string, error) {
	if sm.redis == nil {
		return "", fmt.Errorf("redis not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	addr, err := sm.redis.HGet(ctx, "worker_grpc_addresses", workerID).Result()
	if err == redis.Nil {
		return "", fmt.Errorf("worker %s has no gRPC address registered", workerID)
	}
	if err != nil {
		return "", fmt.Errorf("redis lookup failed: %w", err)
	}

	return addr, nil
}

// sendLoop drains the sendCh and writes messages to the gRPC stream.
// Runs in its own goroutine. Exits when sendCh is closed or stream errors.
func (sm *StreamManager) sendLoop(rs *RoomStream) {
	defer close(rs.done)

	for msg := range rs.sendCh {
		if err := rs.stream.Send(msg); err != nil {
			log.Printf("[stream_manager] Send error room=%s err=%v", rs.roomCode, err)
			rs.state.Store(streamStateDead)
			sm.MarkUnhealthy(rs.roomCode)
			return
		}
	}
}

// scheduleIdleClose waits for the configured idle timeout, then closes the
// stream if the player count is still zero. If a player reconnects before
// the timeout fires, the close is cancelled.
func (sm *StreamManager) scheduleIdleClose(roomCode string, rs *RoomStream) {
	timer := time.NewTimer(sm.config.IdleTimeout)
	defer timer.Stop()

	select {
	case <-timer.C:
		// Check if players have reconnected during the timeout
		if rs.playerCount.Load() <= 0 {
			sm.Close(roomCode)
			log.Printf("[stream_manager] Idle timeout expired room=%s", roomCode)
		}
	case <-rs.done:
		// Stream already closed by other means
		return
	}
}

// closeStreamLocked tears down a RoomStream's resources.
// Must be called with sm.mu held (write lock).
func (sm *StreamManager) closeStreamLocked(rs *RoomStream) {
	rs.state.Store(streamStateDead)

	// Cancel the stream context (stops gRPC operations)
	if rs.cancel != nil {
		rs.cancel()
	}

	// Close the send channel to stop the send loop
	close(rs.sendCh)

	// Close the gRPC connection
	if rs.conn != nil {
		rs.conn.Close()
	}
}
