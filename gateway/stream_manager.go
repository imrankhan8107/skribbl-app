package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"

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
	BufferSize        int           // Max buffered messages during reconnection (default: 4096)
}

// DefaultStreamConfig returns a StreamConfig with sensible defaults.
func DefaultStreamConfig() StreamConfig {
	bufSize := 4096
	if env := os.Getenv("GRPC_STREAM_BUFFER_SIZE"); env != "" {
		if val, err := strconv.Atoi(env); err == nil && val > 0 {
			bufSize = val
		}
	}
	return StreamConfig{
		IdleTimeout:       30 * time.Second,
		KeepaliveInterval: 15 * time.Second,
		KeepaliveTimeout:  5 * time.Second,
		MaxRetries:        3,
		BufferSize:        bufSize,
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
	directAddr string             // Direct gRPC address (bypasses Redis discovery)
	fanOut     *FanOutDispatcher  // For starting receive loops on new streams
	registry   *SessionRegistry   // For receiver disconnect handling
	gwRegistry *GatewayRegistry   // For claiming room ownership on room_created (room-sticky routing)
	sf         singleflight.Group // Prevents thundering herd on GetOrCreate

	// grpcAddrCache caches workerID -> gRPC address so resolveGRPCAddress isn't
	// a Redis round-trip per new room during a connect burst. Worker gRPC
	// addresses are stable for a worker's lifetime.
	grpcAddrCache sync.Map // workerID -> string
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

// GetOrCreate returns an existing healthy RoomStream for the given worker, or
// creates a new one by dialing the worker's gRPC endpoint. This provides the
// multiplexing guarantee: all players across all rooms on a worker share a single stream.
func (sm *StreamManager) GetOrCreate(workerID string) (*RoomStream, error) {
	// Fast path: check for an existing healthy stream (read lock)
	sm.mu.RLock()
	if rs, ok := sm.streams[workerID]; ok && rs.isHealthy() {
		sm.mu.RUnlock()
		rs.markActivity()
		debugf("[sm:getorcreate] worker=%s REUSED", workerID)
		return rs, nil
	}
	sm.mu.RUnlock()

	// Slow path: create the stream.
	// Use singleflight to ensure that if 1,000 players join at once, we only
	// open exactly ONE gRPC connection to the Python worker, rather than hammering
	// it with 1,000 concurrent handshakes and throwing away 999 of them.
	res, err, _ := sm.sf.Do(workerID, func() (interface{}, error) {
		// Re-check after waiting for singleflight
		sm.mu.RLock()
		if rs, ok := sm.streams[workerID]; ok && rs.isHealthy() {
			sm.mu.RUnlock()
			return rs, nil
		}
		sm.mu.RUnlock()

		addr, err := sm.resolveGRPCAddress(workerID)
		if err != nil {
			return nil, fmt.Errorf("resolve worker %s gRPC address: %w", workerID, err)
		}

		conn, err := grpc.NewClient(addr,
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		if err != nil {
			return nil, fmt.Errorf("dial worker %s at %s: %w", workerID, addr, err)
		}

		client := proto.NewGameServiceClient(conn)
		ctx, cancel := context.WithCancel(context.Background())
		stream, err := client.RoomStream(ctx)
		if err != nil {
			cancel()
			conn.Close()
			return nil, fmt.Errorf("open RoomStream to %s: %w", workerID, err)
		}

		rs := &RoomStream{
			workerID: workerID,
			roomCode: workerID, // Keep this field for backwards compatibility in logging
			conn:     conn,
			stream:   stream,
			sendCh:   make(chan *proto.GameMessage, sm.config.BufferSize),
			cancel:   cancel,
			done:     make(chan struct{}),
		}
		rs.state.Store(streamStateHealthy)

		sm.mu.Lock()
		if existing, ok := sm.streams[workerID]; ok {
			sm.closeStreamLocked(existing)
			delete(sm.streams, workerID)
		}
		sm.streams[workerID] = rs
		sm.mu.Unlock()

		// Start the send + receive loop goroutines.
		go sm.sendLoop(rs)
		if sm.fanOut != nil {
			go startStreamReceiver(sm, sm.fanOut, sm.registry, rs)
		}

		return rs, nil
	})

	if err != nil {
		return nil, err
	}

	rs := res.(*RoomStream)
	rs.markActivity()
	debugf("[sm:getorcreate] worker=%s RETURNED (singleflight)", workerID)
	return rs, nil
}

// isLossyClientMessage returns true if a message type is safe to drop under
// transient backpressure (e.g. continuous drawing strokes or cursor movements).
// Must-deliver control frames (create_room, join_room, start_game, guess, etc.)
// return false and will wait for buffer capacity rather than failing immediately.
func isLossyClientMessage(msgType string) bool {
	switch msgType {
	case "stroke", "draw_stroke", "cursor_move":
		return true
	default:
		return false
	}
}

// Send routes a GameMessage to the RoomStream for the given worker.
// Returns an error if no stream exists or the stream is unhealthy.
func (sm *StreamManager) Send(workerID string, msg *proto.GameMessage) error {
	sm.mu.RLock()
	rs, ok := sm.streams[workerID]
	sm.mu.RUnlock()

	if !ok {
		debugf("[sm:send] worker=%s FAILED no stream", workerID)
		tracef("[trace] GW_STREAM_SEND_FAIL worker=%s reason=no_stream", workerID)
		return fmt.Errorf("no stream for worker %s", workerID)
	}

	if !rs.isHealthy() {
		debugf("[sm:send] worker=%s FAILED unhealthy state=%d", workerID, rs.state.Load())
		tracef("[trace] GW_STREAM_SEND_FAIL worker=%s reason=unhealthy", workerID)
		return fmt.Errorf("stream for worker %s is unhealthy (state=%d)", workerID, rs.state.Load())
	}

	// Fast path: non-blocking send to the buffered channel
	select {
	case rs.sendCh <- msg:
		rs.markActivity()
		RecordSendQueued(msg.GetMessageType())
		debugf("[sm:send] worker=%s queued type ok", workerID)
		tracef("[trace] GW_STREAM_SEND worker=%s type=%s player=%s", workerID, msg.GetMessageType(), msg.GetPlayerId())
		return nil
	default:
	}

	// sendCh full: differentiate high-frequency lossy drawing strokes from critical control frames.
	// For lossy messages, drop immediately to protect low drawing latency and avoid head-of-line blocking.
	if isLossyClientMessage(msg.GetMessageType()) {
		RecordSendDropped(msg.GetMessageType())
		debugf("[sm:send] worker=%s FAILED buffer full (lossy dropped)", workerID)
		tracef("[trace] GW_STREAM_SEND_FAIL worker=%s reason=buffer_full", workerID)
		return fmt.Errorf("send buffer full for worker %s", workerID)
	}

	// For critical control messages (create_room, join_room, start_game, etc.),
	// do NOT drop immediately — wait up to 2 seconds for sendLoop to drain queue space.
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()

	select {
	case rs.sendCh <- msg:
		rs.markActivity()
		RecordSendQueued(msg.GetMessageType())
		debugf("[sm:send] worker=%s queued after backpressure wait ok", workerID)
		tracef("[trace] GW_STREAM_SEND worker=%s type=%s player=%s (waited)", workerID, msg.GetMessageType(), msg.GetPlayerId())
		return nil
	case <-timer.C:
		RecordSendDropped(msg.GetMessageType())
		debugf("[sm:send] worker=%s FAILED buffer full (control frame timed out)", workerID)
		tracef("[trace] GW_STREAM_SEND_FAIL worker=%s reason=buffer_full_timeout", workerID)
		return fmt.Errorf("send buffer full for worker %s (timeout)", workerID)
	}
}

// AddPlayer increments the player count for a worker's stream.
func (sm *StreamManager) AddPlayer(workerID string) {
	sm.mu.RLock()
	rs, ok := sm.streams[workerID]
	sm.mu.RUnlock()

	if ok {
		rs.playerCount.Add(1)
		rs.markActivity()
	}
}

// RemovePlayer decrements the player count for a worker's stream.
// When the count reaches zero, schedules an idle timeout to close the stream.
func (sm *StreamManager) RemovePlayer(workerID string) {
	sm.mu.RLock()
	rs, ok := sm.streams[workerID]
	sm.mu.RUnlock()

	if !ok {
		return
	}

	newCount := rs.playerCount.Add(-1)
	if newCount <= 0 {
		// Schedule idle timeout — close the stream if no players reconnect
		go sm.scheduleIdleClose(workerID, rs)
	}
}

// Close immediately closes the RoomStream for a worker and removes it from the map.
func (sm *StreamManager) Close(workerID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	rs, ok := sm.streams[workerID]
	if !ok {
		return
	}

	sm.closeStreamLocked(rs)
	delete(sm.streams, workerID)
	debugf("[stream_manager] Stream explicitly closed worker=%s", workerID)
}

// GetStream returns the RoomStream for a worker, or nil if none exists.
// Used by the receive loop to access the stream directly.
func (sm *StreamManager) GetStream(workerID string) *RoomStream {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.streams[workerID]
}

// MarkUnhealthy marks a stream as unhealthy and evicts it from the cache.
// The next GetOrCreate call for this worker will establish a fresh stream.
func (sm *StreamManager) MarkUnhealthy(workerID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	rs, ok := sm.streams[workerID]
	if !ok {
		return
	}

	rs.state.Store(streamStateDead)
	sm.closeStreamLocked(rs)
	delete(sm.streams, workerID)
	debugf("[stream_manager] Stream evicted (unhealthy) worker=%s", workerID)
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
	// Cache hit: worker gRPC addresses are stable, so avoid a Redis round-trip
	// per new room during a connect burst.
	if v, ok := sm.grpcAddrCache.Load(workerID); ok {
		return v.(string), nil
	}

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

	sm.grpcAddrCache.Store(workerID, addr)
	return addr, nil
}

// sendLoop drains the sendCh and writes messages to the gRPC stream.
// Runs in its own goroutine. Exits when sendCh is closed or stream errors.
func (sm *StreamManager) sendLoop(rs *RoomStream) {
	defer close(rs.done)

	for msg := range rs.sendCh {
		if err := rs.stream.Send(msg); err != nil {
			if err != io.EOF {
				debugf("[stream_manager] send loop error worker=%s err=%v", rs.workerID, err)
			}
			sm.MarkUnhealthy(rs.workerID)
			return
		}
	}
}

// scheduleIdleClose waits for the configured idle timeout, then closes the
// stream if no players have reconnected.
func (sm *StreamManager) scheduleIdleClose(workerID string, rs *RoomStream) {
	time.Sleep(sm.config.IdleTimeout)

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Check if this is still the active stream for the worker
	active, ok := sm.streams[workerID]
	if !ok || active != rs {
		return // Stream was already evicted/replaced
	}

	if rs.playerCount.Load() > 0 {
		return // Players reconnected, cancel close
	}

	// Still idle -> close it
	sm.closeStreamLocked(rs)
	delete(sm.streams, workerID)
	debugf("[stream_manager] Stream closed (idle) worker=%s", workerID)
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
