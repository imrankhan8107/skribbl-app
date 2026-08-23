package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/skribbl-app/gateway/proto"
)

// Multiplexer handles wrapping client WebSocket messages into gRPC GameMessage
// envelopes and routing them through the StreamManager to the correct worker.
// It implements the client-to-worker message multiplexing path (Requirement 4).
type Multiplexer struct {
	streamMgr *StreamManager
	registry  *SessionRegistry
	resolver  *WorkerResolver
	gateway   *Gateway

	// creationMu serializes create_room operations to prevent duplicate streams
	// being opened for the same (not-yet-known) room_code.
	creationMu sync.Mutex
}

// NewMultiplexer creates a Multiplexer with all required dependencies.
func NewMultiplexer(streamMgr *StreamManager, registry *SessionRegistry, resolver *WorkerResolver, gw *Gateway) *Multiplexer {
	return &Multiplexer{
		streamMgr: streamMgr,
		registry:  registry,
		resolver:  resolver,
		gateway:   gw,
	}
}

// clientMessage is the JSON structure of messages received from clients over WebSocket.
type clientMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// joinPayload extracts the room_code from a join_room or reconnect message.
type joinPayload struct {
	RoomCode string `json:"room_code"`
}

// HandleClientMessage is the main entry point for processing a WebSocket message
// from a client. It parses the message type, validates the session state, wraps
// the message in a GameMessage envelope, and routes it through the StreamManager.
//
// Per-player message ordering is preserved because this function is called
// sequentially from the per-connection read loop (one goroutine per client).
func (m *Multiplexer) HandleClientMessage(session *PlayerSession, rawMsg []byte) error {
	// Parse the message type
	var msg clientMessage
	if err := json.Unmarshal(rawMsg, &msg); err != nil {
		return m.sendErrorToClient(session.Conn, "INVALID_JSON", "Could not parse message")
	}

	// Before identification, only allow create_room, join_room, reconnect
	if session.RoomCode == "" {
		switch msg.Type {
		case "create_room":
			return m.handleCreateRoom(session, rawMsg, msg.Payload)
		case "join_room":
			var payload joinPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.RoomCode == "" {
				return m.sendErrorToClient(session.Conn, "INVALID_PAYLOAD", "Missing room_code in join_room")
			}
			return m.handleJoinRoom(session, rawMsg, payload.RoomCode)
		case "reconnect":
			var payload joinPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.RoomCode == "" {
				return m.sendErrorToClient(session.Conn, "INVALID_PAYLOAD", "Missing room_code in reconnect")
			}
			return m.handleJoinRoom(session, rawMsg, payload.RoomCode)
		default:
			// Client not identified — reject with NOT_IDENTIFIED
			return m.sendErrorToClient(session.Conn, "NOT_IDENTIFIED", "Must send create_room, join_room, or reconnect first")
		}
	}

	// Client is identified — wrap and send the envelope
	envelope := &proto.GameMessage{
		PlayerId:    session.PlayerID,
		RoomCode:    session.RoomCode,
		MessageType: msg.Type,
		Payload:     rawMsg,
	}

	return m.streamMgr.Send(session.RoomCode, envelope)
}

// handleCreateRoom handles the create_room flow:
// 1. Select the least-loaded worker
// 2. Open a new Room_Stream to that worker (with creation lock)
// 3. Send the create_room envelope
// 4. Wait for the room_created response to extract room_code
// 5. Register the stream under the new room_code
// 6. Register the player session
func (m *Multiplexer) handleCreateRoom(session *PlayerSession, rawMsg []byte, payloadRaw json.RawMessage) error {
	// Hold creation lock to prevent concurrent create_room racing on stream assignment
	m.creationMu.Lock()
	defer m.creationMu.Unlock()

	// Select the least-loaded worker
	workerID := m.selectLeastLoadedWorker()
	if workerID == "" {
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "No available backend worker")
	}

	// Verify worker gRPC is alive
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	alive, err := m.isGRPCAlive(ctx, workerID)
	if err != nil || !alive {
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Backend worker gRPC unavailable")
	}

	// Use a temporary room code for stream creation. We'll re-register
	// once we know the real room_code from the worker response.
	tempRoomCode := fmt.Sprintf("_pending_%s_%d", session.PlayerID, time.Now().UnixNano())

	// Open a new Room_Stream to the worker
	rs, err := m.streamMgr.GetOrCreate(tempRoomCode, workerID)
	if err != nil {
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Failed to open stream to worker")
	}

	// Send the create_room envelope
	envelope := &proto.GameMessage{
		PlayerId:    session.PlayerID,
		RoomCode:    "", // Will be assigned by worker
		MessageType: "create_room",
		Payload:     rawMsg,
	}

	if err := rs.stream.Send(envelope); err != nil {
		m.streamMgr.MarkUnhealthy(tempRoomCode)
		return m.sendErrorToClient(session.Conn, "STREAM_ERROR", "Failed to send create_room to worker")
	}

	// Wait for the room_created response from the worker
	resp, err := m.waitForRoomCreated(rs, 10*time.Second)
	if err != nil {
		m.streamMgr.MarkUnhealthy(tempRoomCode)
		return m.sendErrorToClient(session.Conn, "TIMEOUT", "Timed out waiting for room creation")
	}

	roomCode := resp.RoomCode
	if roomCode == "" {
		m.streamMgr.MarkUnhealthy(tempRoomCode)
		return m.sendErrorToClient(session.Conn, "STREAM_ERROR", "Worker returned empty room_code")
	}

	// Re-register the stream under the real room_code
	m.streamMgr.Close(tempRoomCode)
	_, err = m.streamMgr.GetOrCreate(roomCode, workerID)
	if err != nil {
		return m.sendErrorToClient(session.Conn, "STREAM_ERROR", "Failed to register stream for room")
	}
	m.streamMgr.AddPlayer(roomCode)

	// Extract player_id from the response payload
	playerID := extractPlayerID(resp.Payload)
	if playerID == "" {
		playerID = session.PlayerID // fallback: use existing if set
	}

	// Update session with player identity
	session.PlayerID = playerID
	session.RoomCode = roomCode

	// Register in session registry
	m.registry.Register(playerID, roomCode, session.Conn)

	// Deliver the response to the client
	if resp.Payload != nil {
		m.deliverToClient(session, resp.Payload)
	}

	log.Printf("[multiplexer] create_room complete player=%s room=%s worker=%s", playerID, roomCode, workerID)
	return nil
}

// handleJoinRoom handles the join_room and reconnect flow:
// 1. Resolve the worker owning the room via Redis
// 2. Get or create the Room_Stream for that room
// 3. Send the envelope over the stream
func (m *Multiplexer) handleJoinRoom(session *PlayerSession, rawMsg []byte, roomCode string) error {
	// Resolve which worker owns this room
	workerID := m.resolveRoomOwner(roomCode)
	if workerID == "" {
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Cannot resolve worker for room "+roomCode)
	}

	// Verify worker gRPC is alive
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	alive, err := m.isGRPCAlive(ctx, workerID)
	if err != nil || !alive {
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Backend worker gRPC unavailable for room "+roomCode)
	}

	// Get or create the Room_Stream for this room
	_, err = m.streamMgr.GetOrCreate(roomCode, workerID)
	if err != nil {
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Failed to open stream for room "+roomCode)
	}

	// Send the envelope over the stream
	// Use a temporary player_id until the worker confirms identity
	playerID := session.PlayerID
	if playerID == "" {
		playerID = fmt.Sprintf("pending_%d", time.Now().UnixNano())
	}

	envelope := &proto.GameMessage{
		PlayerId:    playerID,
		RoomCode:    roomCode,
		MessageType: "join_room",
		Payload:     rawMsg,
	}

	if err := m.streamMgr.Send(roomCode, envelope); err != nil {
		return m.sendErrorToClient(session.Conn, "STREAM_ERROR", "Failed to send message to worker")
	}

	// Optimistically set room_code on session so subsequent messages route correctly.
	// The session registry registration will be finalized when the worker responds
	// with a success message (handled by the receive loop / fan-out dispatcher).
	session.RoomCode = roomCode
	m.streamMgr.AddPlayer(roomCode)

	log.Printf("[multiplexer] join_room sent player=%s room=%s worker=%s", playerID, roomCode, workerID)
	return nil
}

// selectLeastLoadedWorker queries Redis for the least-loaded worker ID.
func (m *Multiplexer) selectLeastLoadedWorker() string {
	if m.gateway.redis == nil {
		// No Redis — fall back to first backend
		if len(m.gateway.backends) > 0 {
			return m.gateway.backends[0]
		}
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, err := m.gateway.redis.ZRange(ctx, "worker_load", 0, 0).Result()
	if err != nil || len(result) == 0 {
		return ""
	}
	return result[0]
}

// resolveRoomOwner looks up which worker owns a room via Redis.
func (m *Multiplexer) resolveRoomOwner(roomCode string) string {
	if m.gateway.redis == nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Try per-room key first (has TTL)
	owner, err := m.gateway.redis.Get(ctx, "room_owner:"+roomCode).Result()
	if err == nil && owner != "" {
		return owner
	}

	// Fallback to hash
	owner, err = m.gateway.redis.HGet(ctx, "room_workers", roomCode).Result()
	if err == nil && owner != "" {
		return owner
	}

	return ""
}

// isGRPCAlive checks whether a worker's gRPC liveness key exists in Redis.
func (m *Multiplexer) isGRPCAlive(ctx context.Context, workerID string) (bool, error) {
	if m.gateway.redis == nil {
		return false, fmt.Errorf("redis not configured")
	}

	exists, err := m.gateway.redis.Exists(ctx, "worker_grpc_alive:"+workerID).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}

// waitForRoomCreated blocks until a BroadcastMessage with message_type
// containing room creation confirmation is received on the stream, or
// until the timeout expires.
func (m *Multiplexer) waitForRoomCreated(rs *RoomStream, timeout time.Duration) (*proto.BroadcastMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Read from the stream until we get a response
	for {
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("timeout waiting for room_created response")
		default:
			resp, err := rs.stream.Recv()
			if err != nil {
				return nil, fmt.Errorf("stream recv error: %w", err)
			}
			// Check if this is the room creation response
			if resp.MessageType == "room_created" || resp.RoomCode != "" {
				return resp, nil
			}
			// Not the response we want — continue reading
		}
	}
}

// extractPlayerID extracts the player_id from a BroadcastMessage JSON payload.
func extractPlayerID(payload []byte) string {
	if payload == nil {
		return ""
	}

	var resp struct {
		Type    string `json:"type"`
		Payload struct {
			PlayerID string `json:"player_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil {
		// Try flat structure
		var flat struct {
			PlayerID string `json:"player_id"`
		}
		if err := json.Unmarshal(payload, &flat); err != nil {
			return ""
		}
		return flat.PlayerID
	}
	return resp.Payload.PlayerID
}

// deliverToClient sends a raw message to the client's WebSocket via their SendCh.
func (m *Multiplexer) deliverToClient(session *PlayerSession, payload []byte) {
	select {
	case session.SendCh <- payload:
	default:
		log.Printf("[multiplexer] dropped message for player=%s: SendCh full", session.PlayerID)
	}
}

// sendErrorToClient sends a JSON error response to a client WebSocket connection.
func (m *Multiplexer) sendErrorToClient(conn *websocket.Conn, code, message string) error {
	errMsg, _ := json.Marshal(map[string]interface{}{
		"type": "error",
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
	return conn.WriteMessage(websocket.TextMessage, errMsg)
}
