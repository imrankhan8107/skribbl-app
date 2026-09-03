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
	//   "broadcast_lossy" / "targeted_lossy" → strokes/draw events, safe to drop
	//                                           under backpressure.
	//   everything else                      → must-deliver control/game events.
	// Both a room-wide (broadcast) and per-player (targeted) stroke must map to
	// "lossy" — a room may span multiple streams, in which case the worker sends
	// strokes as targeted_lossy rather than broadcast_lossy.
	class := "control"
	mt := msg.GetMessageType()
	if mt == "broadcast_lossy" || mt == "targeted_lossy" {
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

// enqueueNonBlocking delivers the payload to the player's SendCh with
// CLASS-AWARE backpressure:
//
//   - lossy (strokes/draw): non-blocking. If SendCh is full, drop it — a
//     dropped stroke is superseded by the next one, so this is harmless.
//
//   - control (game_over, turn_started, chat, ...): MUST be delivered. If
//     SendCh is full, evict one already-queued message to make room, then
//     enqueue the control message. Under a stroke flood the queue is full of
//     strokes, so the evicted message is almost always a stroke — we trade a
//     droppable stroke for a must-deliver event. Only if the queue somehow
//     can't be drained at all do we record a control drop (which should now
//     stay ~0; a nonzero value means genuine saturation beyond eviction).
//
// This is what stops games from failing under load: previously a full SendCh
// dropped whatever arrived next, including game_over. Now control survives.
func (f *FanOutDispatcher) enqueueNonBlocking(s *PlayerSession, payload []byte, class string) {
	// Fast path: try a plain non-blocking send for any class.
	select {
	case s.SendCh <- payload:
		f.deliveredCount.Add(1)
		RecordFanoutDelivered(class)
		if traceEnabled {
			tracef("[trace] GW_FANOUT_DELIVER player=%s class=%s", s.PlayerID, class)
		}
		return
	default:
	}

	// Channel full.
	if class != "control" {
		// Lossy — drop it. Next stroke supersedes it.
		f.droppedCount.Add(1)
		RecordFanoutDropped(class)
		debugf("[fanout] dropped lossy for player=%s room=%s: SendCh full", s.PlayerID, s.RoomCode)
		return
	}

	// Control message on a full channel: evict one queued message (a stale
	// stroke, in the common case) to make room, then enqueue the control msg.
	select {
	case <-s.SendCh:
		// Evicted one queued message; that eviction is a lossy drop.
		RecordFanoutDropped("lossy")
	default:
		// Nothing to evict (drained concurrently by writePump) — that's fine,
		// there should now be room.
	}
	select {
	case s.SendCh <- payload:
		f.deliveredCount.Add(1)
		RecordFanoutDelivered(class)
	default:
		// Still couldn't enqueue (writePump not keeping up at all) — genuine
		// saturation. Record a control drop as a red flag.
		f.droppedCount.Add(1)
		RecordFanoutDropped("control")
		debugf("[fanout] DROPPED CONTROL for player=%s room=%s: SendCh full after evict", s.PlayerID, s.RoomCode)
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
