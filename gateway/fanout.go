package main

import (
	"log"
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
	if len(msg.TargetPlayerIds) == 0 {
		// Broadcast to all players in the room
		sessions := f.registry.GetByRoom(msg.RoomCode)
		for _, s := range sessions {
			f.enqueueNonBlocking(s, msg.Payload)
		}
	} else {
		// Targeted delivery to specific players
		for _, pid := range msg.TargetPlayerIds {
			if s := f.registry.GetByPlayer(pid); s != nil {
				f.enqueueNonBlocking(s, msg.Payload)
			}
		}
	}
}

// enqueueNonBlocking attempts to send the payload to the player's SendCh
// without blocking. If the channel is full, the message is dropped and logged.
func (f *FanOutDispatcher) enqueueNonBlocking(s *PlayerSession, payload []byte) {
	select {
	case s.SendCh <- payload:
		f.deliveredCount.Add(1)
	default:
		// Channel full — drop message to avoid head-of-line blocking
		f.droppedCount.Add(1)
		log.Printf("[fanout] dropped message for player=%s room=%s: SendCh full", s.PlayerID, s.RoomCode)
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
