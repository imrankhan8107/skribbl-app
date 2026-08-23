package main

import (
	"encoding/json"
	"io"
	"log"

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

		// Deliver the broadcast message to the appropriate client(s)
		fanOut.Deliver(msg)
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
