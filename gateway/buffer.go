package main

import (
	"sync"

	"github.com/skribbl-app/gateway/proto"
)

// DefaultBufferSize is the maximum number of messages the buffer holds
// during stream reconnection. At peak drawing rate (~70 msgs/sec per room),
// 500 messages provides ~7 seconds of buffering — covering the full
// exponential backoff retry window (1s + 2s + 4s = 7s).
const DefaultBufferSize = 500

// MessageBuffer is a thread-safe FIFO queue that buffers outbound GameMessages
// while a Room_Stream is reconnecting. When the buffer reaches capacity, the
// oldest messages are dropped to make room for new ones.
type MessageBuffer struct {
	mu       sync.Mutex
	messages []*proto.GameMessage
	maxSize  int
	dropped  int
}

// NewMessageBuffer creates a MessageBuffer with the given maximum capacity.
func NewMessageBuffer(maxSize int) *MessageBuffer {
	return &MessageBuffer{
		messages: make([]*proto.GameMessage, 0, maxSize),
		maxSize:  maxSize,
	}
}

// Push adds a message to the buffer. If the buffer is at capacity, the oldest
// message is dropped and a warning is logged with the room_code and drop count.
func (b *MessageBuffer) Push(msg *proto.GameMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.messages) >= b.maxSize {
		// Drop the oldest message (index 0) to make room
		b.messages = b.messages[1:]
		b.dropped++
		debugf("[buffer] overflow room_code=%s dropped_total=%d: dropping oldest message to buffer new one",
			msg.GetRoomCode(), b.dropped)
	}

	b.messages = append(b.messages, msg)
}

// Drain returns all buffered messages in FIFO order and resets the buffer.
// The caller receives ownership of the returned slice.
func (b *MessageBuffer) Drain() []*proto.GameMessage {
	b.mu.Lock()
	defer b.mu.Unlock()

	msgs := b.messages
	b.messages = make([]*proto.GameMessage, 0, b.maxSize)
	return msgs
}

// Len returns the current number of messages in the buffer.
func (b *MessageBuffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	return len(b.messages)
}

// Dropped returns the total number of messages that were dropped due to overflow.
func (b *MessageBuffer) Dropped() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.dropped
}

// Reset clears the buffer and resets the dropped counter.
func (b *MessageBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.messages = make([]*proto.GameMessage, 0, b.maxSize)
	b.dropped = 0
}
