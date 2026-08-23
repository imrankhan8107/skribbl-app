package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/skribbl-app/gateway/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ─── Keepalive ───────────────────────────────────────────────────────────────

// startKeepalive runs a goroutine that sends a keepalive ping over the
// Room_Stream every 15 seconds (configurable via StreamConfig.KeepaliveInterval).
// If no pong response is received within 5 seconds (StreamConfig.KeepaliveTimeout),
// the stream is marked dead and handleStreamDisconnect is triggered.
//
// The keepalive message uses a special GameMessage with message_type="keepalive".
// The worker is expected to echo back a BroadcastMessage with message_type="pong".
//
// Pong detection relies on rs.lastActivity being updated by the receiver goroutine
// when any message (including pong) arrives. This avoids calling Recv() from
// the keepalive goroutine which would race with the receiver.
func startKeepalive(sm *StreamManager, rs *RoomStream) {
	interval := sm.config.KeepaliveInterval
	timeout := sm.config.KeepaliveTimeout

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// Only send keepalive if stream is healthy
			if rs.state.Load() != streamStateHealthy {
				return
			}

			// Record the time before sending the ping
			pingTime := time.Now()

			// Send keepalive ping
			ping := &proto.GameMessage{
				RoomCode:    rs.roomCode,
				MessageType: "keepalive",
			}

			if err := rs.stream.Send(ping); err != nil {
				log.Printf("[lifecycle] keepalive send failed room=%s err=%v", rs.roomCode, err)
				rs.state.Store(streamStateDead)
				go handleStreamDisconnect(sm, rs)
				return
			}

			// Wait for activity from the receiver goroutine (which handles pong).
			// Instead of calling Recv() here (which races with startStreamReceiver),
			// we poll lastActivity to see if the receiver got any message after our ping.
			deadline := time.After(timeout)
			pongDetected := false
			pollTicker := time.NewTicker(100 * time.Millisecond)

		waitLoop:
			for {
				select {
				case <-deadline:
					break waitLoop
				case <-pollTicker.C:
					// Check if any activity occurred after we sent the ping
					if lastAct, ok := rs.lastActivity.Load().(time.Time); ok {
						if lastAct.After(pingTime) {
							pongDetected = true
							break waitLoop
						}
					}
				case <-rs.done:
					pollTicker.Stop()
					return
				}
			}
			pollTicker.Stop()

			if !pongDetected {
				// No response within timeout — mark stream dead
				log.Printf("[lifecycle] keepalive timeout room=%s (no pong within %v)", rs.roomCode, timeout)
				rs.state.Store(streamStateDead)
				go handleStreamDisconnect(sm, rs)
				return
			}

			// Pong detected — stream is healthy
			rs.markActivity()

		case <-rs.done:
			// Stream closed — stop keepalive
			return
		}
	}
}

// ─── Stream Disconnect Handling ──────────────────────────────────────────────

// handleStreamDisconnect is called when a stream error is detected (keepalive
// timeout, send failure, or transport error). It:
//  1. Sets stream state to reconnecting
//  2. Starts buffering outbound messages in a MessageBuffer
//  3. Attempts reconnection with exponential backoff (1s, 2s, 4s)
//  4. On success: replays buffered messages in order, resumes normal operation
//  5. On failure after 3 retries: transitions to Fallback_Mode
func handleStreamDisconnect(sm *StreamManager, rs *RoomStream) {
	// Transition to reconnecting state (only if not already reconnecting or dead)
	if !rs.state.CompareAndSwap(streamStateDead, streamStateReconnecting) {
		// Already handled by another goroutine, or already reconnecting
		if rs.state.Load() != streamStateReconnecting {
			return
		}
	}

	log.Printf("[lifecycle] stream disconnect detected room=%s worker=%s, starting reconnection",
		rs.roomCode, rs.workerID)

	// Create a message buffer to hold outbound messages during reconnection
	buffer := NewMessageBuffer(sm.config.BufferSize)

	// Start buffering: drain the sendCh into the buffer while reconnecting
	bufferDone := make(chan struct{})
	go func() {
		defer close(bufferDone)
		for {
			select {
			case msg, ok := <-rs.sendCh:
				if !ok {
					return
				}
				buffer.Push(msg)
			case <-rs.done:
				return
			}
		}
	}()

	// Attempt reconnection with exponential backoff
	backoffs := []time.Duration{1 * time.Second, 2 * time.Second, 4 * time.Second}
	maxRetries := sm.config.MaxRetries
	if maxRetries > len(backoffs) {
		maxRetries = len(backoffs)
	}

	var reconnected bool
	for attempt := 0; attempt < maxRetries; attempt++ {
		log.Printf("[lifecycle] reconnection attempt %d/%d room=%s worker=%s",
			attempt+1, maxRetries, rs.roomCode, rs.workerID)

		// Wait for backoff duration
		time.Sleep(backoffs[attempt])

		// Attempt to establish a new stream
		newStream, newConn, err := dialNewStream(sm, rs.workerID)
		if err != nil {
			log.Printf("[lifecycle] reconnection attempt %d failed room=%s err=%v",
				attempt+1, rs.roomCode, err)
			continue
		}

		// Success — replace the old stream with the new one
		log.Printf("[lifecycle] reconnection successful room=%s worker=%s attempt=%d",
			rs.roomCode, rs.workerID, attempt+1)

		// Close old connection resources
		if rs.conn != nil {
			rs.conn.Close()
		}

		// Update the RoomStream with new connection
		rs.stream = newStream
		rs.conn = newConn
		rs.state.Store(streamStateHealthy)
		rs.markActivity()

		reconnected = true
		break
	}

	// Stop buffering goroutine by signaling
	// (it will exit when sendCh is closed or rs.done is closed)

	if reconnected {
		// Replay buffered messages through the new stream
		replayBuffer(rs, buffer)

		// Restart keepalive on the new stream
		go startKeepalive(sm, rs)

		log.Printf("[lifecycle] stream fully restored room=%s buffered_msgs_replayed=%d",
			rs.roomCode, buffer.Len())
	} else {
		// All retries exhausted — transition to Fallback_Mode
		rs.state.Store(streamStateDead)

		log.Printf("[lifecycle] all reconnection attempts exhausted room=%s worker=%s, entering Fallback_Mode",
			rs.roomCode, rs.workerID)

		// Evict the dead stream from the StreamManager
		sm.MarkUnhealthy(rs.roomCode)

		// Log the fallback activation with reason
		log.Printf("[lifecycle] FALLBACK_ACTIVATED room=%s reason=reconnection_exhausted retries=%d",
			rs.roomCode, maxRetries)
	}
}

// ─── Reconnection Dial ───────────────────────────────────────────────────────

// dialNewStream resolves the worker's gRPC address and opens a new bidirectional
// RoomStream connection. Returns the stream client, connection, and any error.
func dialNewStream(sm *StreamManager, workerID string) (proto.GameService_RoomStreamClient, *grpc.ClientConn, error) {
	// Resolve the worker's gRPC address from Redis
	addr, err := sm.resolveGRPCAddress(workerID)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve worker %s: %w", workerID, err)
	}

	// Dial the worker's gRPC endpoint with a timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(ctx, addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("dial worker %s at %s: %w", workerID, addr, err)
	}

	// Open a new bidirectional RoomStream
	client := proto.NewGameServiceClient(conn)
	stream, err := client.RoomStream(context.Background())
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("open RoomStream to worker %s: %w", workerID, err)
	}

	return stream, conn, nil
}

// ─── Buffer Replay ───────────────────────────────────────────────────────────

// replayBuffer drains the MessageBuffer and sends all buffered messages through
// the RoomStream in FIFO order. This is called after a successful reconnection
// to deliver messages that were queued while the stream was down.
func replayBuffer(rs *RoomStream, buffer *MessageBuffer) {
	messages := buffer.Drain()
	if len(messages) == 0 {
		return
	}

	log.Printf("[lifecycle] replaying %d buffered messages room=%s", len(messages), rs.roomCode)

	for i, msg := range messages {
		if err := rs.stream.Send(msg); err != nil {
			log.Printf("[lifecycle] buffer replay failed at message %d/%d room=%s err=%v",
				i+1, len(messages), rs.roomCode, err)
			// Mark stream unhealthy again — reconnection didn't stick
			rs.state.Store(streamStateDead)
			return
		}
	}

	log.Printf("[lifecycle] buffer replay complete room=%s messages=%d dropped=%d",
		rs.roomCode, len(messages), buffer.Dropped())
}
