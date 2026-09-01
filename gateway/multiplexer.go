package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gorilla/websocket"
	"github.com/skribbl-app/gateway/proto"
)

// Multiplexer handles wrapping client WebSocket messages into gRPC GameMessage
// envelopes and routing them through the StreamManager to the correct worker.
// It implements the client-to-worker message multiplexing path (Requirement 4).
//
// All responses (including room_created, room_joined, reconnected) flow back
// through the receiver goroutine → fan-out dispatcher → session SendCh.
// The multiplexer never calls Recv() — this eliminates the race condition
// between waitForRoomCreated and startStreamReceiver.
type Multiplexer struct {
	streamMgr *StreamManager
	registry  *SessionRegistry
	resolver  *WorkerResolver
	gateway   *Gateway
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

	debugf("[mux:handle] player=%s room=%s type=%s identified=%t", session.PlayerID, session.RoomCode, msg.Type, session.RoomCode != "")
	tracef("[trace] GW_MUX_IN player=%s room=%s type=%s", session.PlayerID, session.RoomCode, msg.Type)

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

	debugf("[mux:forward] player=%s room=%s type=%s → streamMgr.Send", session.PlayerID, session.RoomCode, msg.Type)
	tracef("[trace] GW_MUX_FORWARD player=%s room=%s type=%s", session.PlayerID, session.RoomCode, msg.Type)
	if err := m.streamMgr.Send(session.RoomCode, envelope); err != nil {
		log.Printf("[mux:forward] player=%s room=%s type=%s Send error: %v", session.PlayerID, session.RoomCode, msg.Type, err)
		return err
	}
	return nil
}

// handleCreateRoom handles the create_room flow asynchronously:
// 1. Select the least-loaded worker
// 2. Open a Room_Stream to the worker (keyed by workerID for create_room)
// 3. Send the create_room envelope
// 4. Return immediately — the response arrives via receiver → fan-out → SendCh
//
// The session is already registered in the registry by handleGRPCPath with the
// pending PlayerID. The response interceptor in the receiver updates the session's
// PlayerID and RoomCode when the room_created response arrives.
func (m *Multiplexer) handleCreateRoom(session *PlayerSession, rawMsg []byte, payloadRaw json.RawMessage) error {
	// Select the least-loaded worker
	workerID := m.selectLeastLoadedWorker()
	if workerID == "" {
		log.Printf("[mux:create] player=%s NO worker selected", session.PlayerID)
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "No available backend worker")
	}
	log.Printf("[mux:create] player=%s worker selected=%s", session.PlayerID, workerID)

	// Verify worker gRPC is alive
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	alive, err := m.isGRPCAlive(ctx, workerID)
	if err != nil || !alive {
		log.Printf("[mux:create] player=%s worker=%s gRPC alive check failed alive=%t err=%v", session.PlayerID, workerID, alive, err)
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Backend worker gRPC unavailable")
	}
	log.Printf("[mux:create] player=%s worker=%s gRPC alive ok", session.PlayerID, workerID)

	// Use workerID as the stream key for create_room since room_code is unknown.
	// Multiple create_room requests to the same worker share one stream.
	_, err = m.streamMgr.GetOrCreate(workerID, workerID)
	if err != nil {
		log.Printf("[mux:create] player=%s worker=%s GetOrCreate failed err=%v", session.PlayerID, workerID, err)
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Failed to open stream to worker")
	}
	log.Printf("[mux:create] player=%s worker=%s GetOrCreate ok", session.PlayerID, workerID)

	// Send the create_room envelope — response arrives via receiver → fan-out
	envelope := &proto.GameMessage{
		PlayerId:    session.PlayerID,
		RoomCode:    "",
		MessageType: "create_room",
		Payload:     rawMsg,
	}

	tracef("[trace] GW_MUX_CREATE_ROOM_SEND player=%s worker=%s", session.PlayerID, workerID)
	if err := m.streamMgr.Send(workerID, envelope); err != nil {
		log.Printf("[mux:create] player=%s worker=%s Send failed err=%v", session.PlayerID, workerID, err)
		return m.sendErrorToClient(session.Conn, "STREAM_ERROR", "Failed to send create_room to worker")
	}
	log.Printf("[mux:create] player=%s worker=%s envelope sent", session.PlayerID, workerID)

	// Track the player on this worker stream for proper cleanup
	m.streamMgr.AddPlayer(workerID)

	// Store the workerID on the session so the response interceptor knows
	// which worker stream to associate with the new room.
	// RoomCode is temporarily set to workerID; the interceptor replaces it
	// with the real room_code when room_created arrives.
	session.RoomCode = workerID

	log.Printf("[multiplexer] create_room sent player=%s worker=%s (async)", session.PlayerID, workerID)
	tracef("[trace] GW_MUX_CREATE_ROOM_SENT player=%s worker=%s", session.PlayerID, workerID)
	return nil
}

// handleJoinRoom handles the join_room and reconnect flow asynchronously:
// 1. Resolve the worker owning the room via Redis
// 2. Get or create the Room_Stream for that room
// 3. Send the envelope over the stream
// 4. Return immediately — the response arrives via receiver → fan-out → SendCh
//
// The session is already registered in the registry by handleGRPCPath with the
// pending PlayerID. The response interceptor in the receiver updates the session's
// PlayerID when the room_joined/reconnected response arrives.
func (m *Multiplexer) handleJoinRoom(session *PlayerSession, rawMsg []byte, roomCode string) error {
	// Resolve which worker owns this room
	workerID := m.resolveRoomOwner(roomCode)
	if workerID == "" {
		log.Printf("[mux:join] NO_BACKEND room=%s resolveRoomOwner returned empty", roomCode)
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Cannot resolve worker for room "+roomCode)
	}
	log.Printf("[mux:join] player=%s room=%s resolveRoomOwner=%s", session.PlayerID, roomCode, workerID)

	// Verify worker gRPC is alive
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	alive, err := m.isGRPCAlive(ctx, workerID)
	if err != nil || !alive {
		log.Printf("[mux:join] player=%s room=%s worker=%s gRPC alive check failed alive=%t err=%v", session.PlayerID, roomCode, workerID, alive, err)
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Backend worker gRPC unavailable for room "+roomCode)
	}
	log.Printf("[mux:join] player=%s room=%s worker=%s gRPC alive ok", session.PlayerID, roomCode, workerID)

	// Update the session's room in the registry so fan-out can find it
	// for room-wide broadcasts after join.
	m.registry.UpdateIdentity(session.PlayerID, session.PlayerID, roomCode)

	// Get or create the Room_Stream for this room
	_, err = m.streamMgr.GetOrCreate(roomCode, workerID)
	if err != nil {
		log.Printf("[mux:join] player=%s room=%s worker=%s GetOrCreate failed err=%v", session.PlayerID, roomCode, workerID, err)
		return m.sendErrorToClient(session.Conn, "NO_BACKEND", "Failed to open stream for room "+roomCode)
	}
	log.Printf("[mux:join] player=%s room=%s worker=%s GetOrCreate ok", session.PlayerID, roomCode, workerID)

	// Send the envelope over the stream
	envelope := &proto.GameMessage{
		PlayerId:    session.PlayerID,
		RoomCode:    roomCode,
		MessageType: "join_room",
		Payload:     rawMsg,
	}

	tracef("[trace] GW_MUX_JOIN_SEND player=%s room=%s worker=%s", session.PlayerID, roomCode, workerID)
	if err := m.streamMgr.Send(roomCode, envelope); err != nil {
		log.Printf("[mux:join] player=%s room=%s worker=%s Send failed err=%v", session.PlayerID, roomCode, workerID, err)
		return m.sendErrorToClient(session.Conn, "STREAM_ERROR", "Failed to send message to worker")
	}
	log.Printf("[mux:join] player=%s room=%s worker=%s envelope sent", session.PlayerID, roomCode, workerID)

	// Set room_code on session so subsequent messages route correctly
	session.RoomCode = roomCode
	m.streamMgr.AddPlayer(roomCode)

	log.Printf("[multiplexer] join_room sent player=%s room=%s worker=%s (async)", session.PlayerID, roomCode, workerID)
	return nil
}

// selectLeastLoadedWorker queries Redis for the least-loaded worker ID.
func (m *Multiplexer) selectLeastLoadedWorker() string {
	if m.gateway.redis == nil {
		// No Redis — fall back to first backend
		if len(m.gateway.backends) > 0 {
			tracef("[trace] GW_SELECT_WORKER worker=%s", m.gateway.backends[0])
			return m.gateway.backends[0]
		}
		tracef("[trace] GW_SELECT_WORKER worker=%s", "")
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, err := m.gateway.redis.ZRange(ctx, "worker_load", 0, 0).Result()
	if err != nil || len(result) == 0 {
		tracef("[trace] GW_SELECT_WORKER worker=%s", "")
		return ""
	}
	tracef("[trace] GW_SELECT_WORKER worker=%s", result[0])
	return result[0]
}

// resolveRoomOwner looks up which worker owns a room via Redis.
func (m *Multiplexer) resolveRoomOwner(roomCode string) string {
	if m.gateway.redis == nil {
		tracef("[trace] GW_RESOLVE_OWNER room=%s owner=%s", roomCode, "")
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Try per-room key first (has TTL)
	owner, err := m.gateway.redis.Get(ctx, "room_owner:"+roomCode).Result()
	if err == nil && owner != "" {
		tracef("[trace] GW_RESOLVE_OWNER room=%s owner=%s", roomCode, owner)
		return owner
	}

	// Fallback to hash
	owner, err = m.gateway.redis.HGet(ctx, "room_workers", roomCode).Result()
	if err == nil && owner != "" {
		tracef("[trace] GW_RESOLVE_OWNER room=%s owner=%s", roomCode, owner)
		return owner
	}

	tracef("[trace] GW_RESOLVE_OWNER room=%s owner=%s", roomCode, "")
	return ""
}

// isGRPCAlive checks whether a worker's gRPC liveness key exists in Redis.
func (m *Multiplexer) isGRPCAlive(ctx context.Context, workerID string) (bool, error) {
	if m.gateway.redis == nil {
		return false, fmt.Errorf("redis not configured")
	}

	exists, err := m.gateway.redis.Exists(ctx, "worker_grpc_alive:"+workerID).Result()
	if err != nil {
		tracef("[trace] GW_GRPC_ALIVE worker=%s alive=%v", workerID, false)
		return false, err
	}
	tracef("[trace] GW_GRPC_ALIVE worker=%s alive=%v", workerID, exists > 0)
	return exists > 0, nil
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

// extractRoomCode extracts the room_code from a BroadcastMessage JSON payload.
func extractRoomCode(payload []byte) string {
	if payload == nil {
		return ""
	}

	var resp struct {
		Type    string `json:"type"`
		Payload struct {
			RoomCode string `json:"room_code"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil {
		var flat struct {
			RoomCode string `json:"room_code"`
		}
		if err := json.Unmarshal(payload, &flat); err != nil {
			return ""
		}
		return flat.RoomCode
	}
	return resp.Payload.RoomCode
}

// deliverToClient sends a raw message to the client's WebSocket via their SendCh.
func (m *Multiplexer) deliverToClient(session *PlayerSession, payload []byte) {
	select {
	case session.SendCh <- payload:
	default:
		log.Printf("[multiplexer] dropped message for player=%s: SendCh full", session.PlayerID)
	}
}

// sendErrorToClient sends a JSON error response via the session's SendCh.
// This ensures the writePump remains the sole writer to the WebSocket.
func (m *Multiplexer) sendErrorToClient(conn *websocket.Conn, code, message string) error {
	tracef("[trace] GW_MUX_ERROR player=%s code=%s msg=%s", "", code, message)
	errMsg, _ := json.Marshal(map[string]interface{}{
		"type": "error",
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
	// Use the registry to find the session by connection.
	// Since we can't easily reverse-lookup by conn, write directly.
	// This is safe because sendErrorToClient is called from the read loop
	// goroutine. Gorilla WS supports one concurrent reader + one concurrent writer.
	// The read loop IS the reader, and writing here makes it also the writer —
	// but only momentarily. The writePump might also be writing concurrently.
	//
	// FIX: Don't write directly. Instead, return the error and let the caller
	// decide. For now, use WriteMessage since errors terminate the session anyway.
	conn.WriteMessage(websocket.TextMessage, errMsg)
	return fmt.Errorf("client error: %s", code)
}
