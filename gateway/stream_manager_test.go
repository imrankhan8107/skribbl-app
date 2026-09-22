package main

import (
	"os"
	"testing"
	"time"

	"github.com/skribbl-app/gateway/proto"
)

func TestDefaultStreamConfig(t *testing.T) {
	// Test default without env var
	os.Unsetenv("GRPC_STREAM_BUFFER_SIZE")
	cfg := DefaultStreamConfig()
	if cfg.BufferSize != 4096 {
		t.Fatalf("expected default BufferSize 4096, got %d", cfg.BufferSize)
	}

	// Test with env var override
	os.Setenv("GRPC_STREAM_BUFFER_SIZE", "8192")
	defer os.Unsetenv("GRPC_STREAM_BUFFER_SIZE")
	cfg2 := DefaultStreamConfig()
	if cfg2.BufferSize != 8192 {
		t.Fatalf("expected BufferSize 8192 from env, got %d", cfg2.BufferSize)
	}
}

func TestIsLossyClientMessage(t *testing.T) {
	lossy := []string{"stroke", "draw_stroke", "cursor_move"}
	for _, mt := range lossy {
		if !isLossyClientMessage(mt) {
			t.Errorf("expected %s to be classified as lossy", mt)
		}
	}

	control := []string{"create_room", "join_room", "start_game", "toggle_ready", "guess", "select_word", "update_settings"}
	for _, mt := range control {
		if isLossyClientMessage(mt) {
			t.Errorf("expected %s to NOT be classified as lossy", mt)
		}
	}
}

func TestStreamManagerSendLossyVsControl(t *testing.T) {
	sm := NewStreamManager(nil, nil, StreamConfig{BufferSize: 1})
	workerID := "worker-test-1"

	// Create a mock RoomStream with a buffer of 1
	rs := &RoomStream{
		workerID: workerID,
		roomCode: workerID,
		sendCh:   make(chan *proto.GameMessage, 1),
	}
	rs.state.Store(streamStateHealthy)

	sm.mu.Lock()
	sm.streams[workerID] = rs
	sm.mu.Unlock()

	// 1. Send first message — should succeed immediately and fill buffer
	msg1 := &proto.GameMessage{MessageType: "create_room", PlayerId: "p1"}
	if err := sm.Send(workerID, msg1); err != nil {
		t.Fatalf("expected first message to send cleanly, got err: %v", err)
	}

	// Buffer is now full (1/1).
	// 2. Send a lossy stroke message — should fail immediately without blocking
	start := time.Now()
	strokeMsg := &proto.GameMessage{MessageType: "stroke", PlayerId: "p1"}
	err := sm.Send(workerID, strokeMsg)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("expected lossy message to fail when buffer full, but got nil")
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("expected lossy message to drop immediately, took %v", elapsed)
	}

	// 3. Send a control message with concurrent drain — should wait briefly and succeed
	done := make(chan error, 1)
	controlMsg := &proto.GameMessage{MessageType: "join_room", PlayerId: "p2"}

	go func() {
		done <- sm.Send(workerID, controlMsg)
	}()

	// Simulate drain after 50ms
	time.Sleep(50 * time.Millisecond)
	drained := <-rs.sendCh
	if drained.GetMessageType() != "create_room" {
		t.Errorf("expected drained message to be create_room, got %s", drained.GetMessageType())
	}

	select {
	case sendErr := <-done:
		if sendErr != nil {
			t.Fatalf("expected control message to succeed after drain, got err: %v", sendErr)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("control message send timed out")
	}

	// Verify the control message was placed into the channel
	select {
	case queued := <-rs.sendCh:
		if queued.GetMessageType() != "join_room" {
			t.Errorf("expected join_room in queue, got %s", queued.GetMessageType())
		}
	default:
		t.Fatalf("expected join_room to be queued in sendCh")
	}
}
