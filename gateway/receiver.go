package main

import (
	"encoding/json"
	"io"
	"log"
	"strings"

	"github.com/skribbl-app/gateway/proto"
)

// ─── Stream Receiver ─────────────────────────────────────────────────────────

// startStreamReceiver runs a goroutine that continuously receives BroadcastMessages
// from a Room_Stream and delivers them to clients via the FanOutDispatcher.
//
// On each BroadcastMessage received, it calls fanOut.Deliver(msg) which routes
// the payload to the appropriate client WebSocket connections (all in room for
// empty target_player_ids, or specific players for targeted messages).
//
// After delivery, it checks if the message is an identity response (room_created,
// room_joined, reconnected) and updates the session registry with the real
// player_id and room_code from the worker.
//
// On stream error: marks the stream unhealthy and triggers the reconnection flow.
// On context done (rs.done closed): exits gracefully.
//
// Requirements: 5.1, 5.2
func startStreamReceiver(sm *StreamManager, fanOut *FanOutDispatcher, registry *SessionRegistry, rs *RoomStream) {
	defer func() {
		log.Printf("[receiver] recv loop exited room=%s worker=%s", rs.roomCode, rs.workerID)
	}()

	for {
		// Check if the stream has been closed externally
		select {
		case <-rs.done:
			return
		default:
		}

		// Receive the next BroadcastMessage from the worker
		msg, err := rs.stream.Recv()
		if err != nil {
			// Check if stream was closed intentionally
			select {
			case <-rs.done:
				return
			default:
			}

			// Distinguish between graceful EOF and transport errors
			if err == io.EOF {
				log.Printf("[receiver] stream EOF room=%s worker=%s", rs.roomCode, rs.workerID)
			} else {
				log.Printf("[receiver] stream recv error room=%s worker=%s err=%v", rs.roomCode, rs.workerID, err)
			}

			// Mark the stream as unhealthy and trigger reconnection
			rs.state.Store(streamStateDead)
			go handleStreamDisconnect(sm, rs)
			return
		}

		// Update activity timestamp
		rs.markActivity()

		// Skip keepalive pong messages — they are handled by the keepalive goroutine
		if msg.GetMessageType() == "pong" {
			continue
		}

		// Hot path: avoid parsing the payload just to make a log line pretty.
		// Only when debug logging is enabled do we probe the inner JSON "type".
		if debugEnabled {
			innerType := msg.GetMessageType()
			var probe struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg.Payload, &probe) == nil && probe.Type != "" {
				innerType = probe.Type
			}
			debugf("[rx:recv] room=%s type=%s targets=%d bytes=%d", msg.GetRoomCode(), innerType, len(msg.TargetPlayerIds), len(msg.Payload))
		}
		tracef("[trace] GW_GRPC_IN room=%s type=%s targets=%v bytes=%d", msg.GetRoomCode(), msg.GetMessageType(), msg.TargetPlayerIds, len(msg.Payload))

		// Deliver the broadcast message to the appropriate client(s)
		fanOut.Deliver(msg)

		// Intercept identity responses to update session registry
		if isIdentityResponse(msg) {
			interceptIdentityResponse(registry, sm, rs, msg)
		}
	}
}

// ─── Identity Response Interceptor ──────────────────────────────────────────

// isIdentityResponse returns true if the BroadcastMessage payload contains
// a room_created, room_joined, or reconnected response from the worker.
// These responses carry the real player_id and room_code assigned by the worker.
func isIdentityResponse(msg *proto.BroadcastMessage) bool {
	if msg == nil || len(msg.Payload) == 0 {
		return false
	}

	// Quick check on message_type field of the BroadcastMessage itself
	mt := msg.GetMessageType()
	if mt == "room_created" || mt == "room_joined" || mt == "reconnected" {
		return true
	}

	// Also check the JSON payload type field (worker sends type in payload)
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg.Payload, &envelope); err != nil {
		return false
	}
	return envelope.Type == "room_created" || envelope.Type == "room_joined" || envelope.Type == "reconnected"
}

// interceptIdentityResponse updates the session registry when an identity
// response (room_created, room_joined, reconnected) is received from the worker.
//
// It extracts the real player_id and room_code from the response payload,
// then re-indexes the session under the new identity. This completes the
// async create_room/join_room flow by binding the client to their assigned identity.
//
// The mapping works because:
// 1. The gateway sent the envelope with PlayerID = "pending_X"
// 2. The worker's VirtualTransport sends the response targeted at "pending_X"
// 3. Fan-out already delivered the response to the client via target_player_ids
// 4. This interceptor now updates the registry so future broadcasts find the session
func interceptIdentityResponse(registry *SessionRegistry, sm *StreamManager, rs *RoomStream, msg *proto.BroadcastMessage) {
	if len(msg.TargetPlayerIds) == 0 {
		return
	}

	// The pending player_id that the response is targeted at
	pendingPlayerID := msg.TargetPlayerIds[0]

	// Extract real player_id and room_code from the payload
	realPlayerID := extractPlayerID(msg.Payload)
	realRoomCode := extractRoomCode(msg.Payload)

	log.Printf("[rx:identity] pending=%s real=%s room=%s", pendingPlayerID, realPlayerID, realRoomCode)

	if realPlayerID == "" && realRoomCode == "" {
		return
	}

	// Look up the existing session by the pending player_id
	session := registry.GetByPlayer(pendingPlayerID)
	if session == nil {
		// Session might have disconnected already — key failure signal.
		log.Printf("[rx:identity] SESSION NOT FOUND pending=%s", pendingPlayerID)
		return
	}

	// Determine the final values
	finalPlayerID := realPlayerID
	if finalPlayerID == "" {
		finalPlayerID = pendingPlayerID
	}
	finalRoomCode := realRoomCode
	if finalRoomCode == "" {
		finalRoomCode = session.RoomCode
	}

	// If the player_id or room changed, re-index the session in the registry.
	// UpdateIdentity preserves the session's SendCh and writePump (no new goroutines).
	if finalPlayerID != pendingPlayerID || finalRoomCode != session.RoomCode {
		registry.UpdateIdentity(pendingPlayerID, finalPlayerID, finalRoomCode)

		log.Printf("[receiver] identity updated pending=%s → player=%s room=%s",
			pendingPlayerID, finalPlayerID, finalRoomCode)
	}

	// If this was a create_room, the stream was keyed by workerID.
	// Now that we know the real room_code, ensure a room-keyed stream exists
	// for future messages from this room (join_room, game messages, etc.)
	if realRoomCode != "" && realRoomCode != rs.roomCode {
		// For create_room: the stream is keyed by workerID. We need to also
		// make it findable by room_code. Open a stream for the real room_code
		// pointing to the same worker.
		if strings.HasPrefix(pendingPlayerID, "pending_") {
			_, err := sm.GetOrCreate(realRoomCode, rs.workerID)
			if err != nil {
				log.Printf("[receiver] failed to register room stream room=%s worker=%s err=%v",
					realRoomCode, rs.workerID, err)
			} else {
				sm.AddPlayer(realRoomCode)
				log.Printf("[receiver] room stream registered room=%s worker=%s", realRoomCode, rs.workerID)
			}
		}
	}
}

// ─── Client Disconnect Handling ──────────────────────────────────────────────

// handleClientDisconnect processes a client WebSocket disconnection:
//  1. Removes the player from the session registry
//  2. Sends a disconnect notification GameMessage over the Room_Stream to the worker
//  3. Decrements the player count on the stream (which may schedule idle close)
//
// This ensures the worker is informed of player disconnections so it can
// trigger grace windows, host reassignment, or game-over logic.
//
// Requirements: 5.4
func handleClientDisconnect(registry *SessionRegistry, sm *StreamManager, session *PlayerSession) {
	playerID := session.PlayerID
	roomCode := session.RoomCode

	if playerID == "" || roomCode == "" {
		// Session was never fully identified — just clean up
		registry.Unregister(playerID)
		return
	}

	// Step 1: Remove from session registry
	registry.Unregister(playerID)

	// Step 2: Send disconnect notification to the worker via Room_Stream
	disconnectPayload, _ := json.Marshal(map[string]interface{}{
		"type": "leave_room",
		"payload": map[string]string{
			"player_id": playerID,
			"room_code": roomCode,
			"reason":    "disconnect",
		},
	})

	disconnectMsg := &proto.GameMessage{
		PlayerId:    playerID,
		RoomCode:    roomCode,
		MessageType: "leave_room",
		Payload:     disconnectPayload,
	}

	if err := sm.Send(roomCode, disconnectMsg); err != nil {
		log.Printf("[receiver] failed to send disconnect notification player=%s room=%s err=%v",
			playerID, roomCode, err)
	} else {
		log.Printf("[receiver] disconnect notification sent player=%s room=%s", playerID, roomCode)
	}

	// Step 3: Decrement player count on stream (may trigger idle timeout)
	sm.RemovePlayer(roomCode)
}
