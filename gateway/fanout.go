package main

import (
	"sync/atomic"

	proto "github.com/skribbl-app/gateway/proto"
)

// FanOutDispatcher receives BroadcastMessages from Room_Streams
// and delivers payloads to the correct client WebSocket connections.
// It uses non-blocking enqueue to per-connection SendCh to avoid
// slow-client head-of-line blocking.
type FanOutDispatcher struct {
	registry       *SessionRegistry
	deliveredCount atomic.Uint64 // Total messages delivered (for observability)
	droppedCount   atomic.Uint64 // Messages dropped due to full SendCh
}

// NewFanOutDispatcher creates a FanOutDispatcher with a reference to the session registry.
func NewFanOutDispatcher(registry *SessionRegistry) *FanOutDispatcher {
	return &FanOutDispatcher{
		registry: registry,
	}
}

// Deliver routes a BroadcastMessage to the appropriate client WebSocket connections.
// If target_player_ids is empty, it broadcasts to all players in the room.
// If target_player_ids is populated, it delivers only to those specific players.
// Enqueue is non-blocking: if a player's SendCh is full, the message is dropped
// and a warning is logged (backpressure for slow clients).
func (f *FanOutDispatcher) Deliver(msg *proto.BroadcastMessage) {
	// Classify the message for free from the protobuf message_type set by the
	// worker (no JSON parse on the hot path):
	//   "broadcast_lossy" → strokes/draw events, safe to drop under backpressure.
	//   everything else   → must-deliver control/game events.
	class := "control"
	if msg.GetMessageType() == "broadcast_lossy" {
		class = "lossy"
	}

	if len(msg.TargetPlayerIds) == 0 {
		// Broadcast to all players in the room
		sessions := f.registry.GetByRoom(msg.RoomCode)
		debugf("[fanout] room=%s targets=0 sessions_found=%d class=%s", msg.RoomCode, len(sessions), class)
		tracef("[trace] GW_FANOUT_ALL room=%s recipients=%d class=%s", msg.RoomCode, len(sessions), class)
		for _, s := range sessions {
			f.enqueueNonBlocking(s, msg.Payload, class)
		}
	} else {
		// Targeted delivery to specific players
		tracef("[trace] GW_FANOUT_TARGET room=%s targets=%v class=%s", msg.RoomCode, msg.TargetPlayerIds, class)
		found := 0
		for _, pid := range msg.TargetPlayerIds {
			if s := f.registry.GetByPlayer(pid); s != nil {
				found++
				f.enqueueNonBlocking(s, msg.Payload, class)
			} else {
				debugf("[fanout] TARGET MISS player=%s", pid)
			}
		}
		debugf("[fanout] room=%s targets=%d sessions_found=%d class=%s", msg.RoomCode, len(msg.TargetPlayerIds), found, class)
	}
}

// enqueueNonBlocking attempts to send the payload to the player's SendCh
// without blocking. If the channel is full, the message is dropped and the drop
// is recorded against its class. A nonzero "control" drop count is the signal
// that must-deliver events are being lost at the queue (i.e. priority lanes
// would help); "lossy" drops are strokes and are expected under load.
func (f *FanOutDispatcher) enqueueNonBlocking(s *PlayerSession, payload []byte, class string) {
	select {
	case s.SendCh <- payload:
		f.deliveredCount.Add(1)
		RecordFanoutDelivered(class)
		if traceEnabled {
			tracef("[trace] GW_FANOUT_DELIVER player=%s class=%s", s.PlayerID, class)
		}
	default:
		// Channel full — drop message to avoid head-of-line blocking
		f.droppedCount.Add(1)
		RecordFanoutDropped(class)
		debugf("[fanout] dropped message for player=%s room=%s class=%s: SendCh full", s.PlayerID, s.RoomCode, class)
	}
}

// DeliveredCount returns the total number of messages successfully enqueued.
func (f *FanOutDispatcher) DeliveredCount() uint64 {
	return f.deliveredCount.Load()
}

// DroppedCount returns the total number of messages dropped due to full channels.
func (f *FanOutDispatcher) DroppedCount() uint64 {
	return f.droppedCount.Load()
}
