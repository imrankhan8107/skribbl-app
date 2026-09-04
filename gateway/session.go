package main

import (
	"bytes"
	"sync"

	"github.com/gorilla/websocket"
)

// maxBatch caps how many queued messages are combined into a single WebSocket
// frame. Bounds the batched frame size and per-write work.
const maxBatch = 64

// batchPrefix/batchSuffix wrap concatenated raw JSON messages into a single
// envelope the frontend unwraps: {"type":"batch","messages":[<m1>,<m2>,...]}.
var (
	batchPrefix = []byte(`{"type":"batch","messages":[`)
	batchSuffix = []byte(`]}`)
)

// sendChBufferSize is the capacity of each PlayerSession's outbound queue.
// A buffer of 256 messages prevents blocking during fan-out delivery while
// providing backpressure if a client is too slow to consume messages.
const sendChBufferSize = 256

// PlayerSession represents a connected player's session state in the gateway.
// Each session holds the player's identity, room association, WebSocket connection,
// and a non-blocking outbound message queue drained by a dedicated writePump goroutine.
type PlayerSession struct {
	PlayerID string
	RoomCode string
	Conn     *websocket.Conn
	SendCh   chan []byte // Non-blocking outbound queue
	done     chan struct{}
}

// SessionRegistry tracks (player_id, room_code, WebSocket connection) associations.
// It maintains a dual-index for O(1) lookups by player_id and by room_code.
// All methods are safe for concurrent use from multiple goroutines.
type SessionRegistry struct {
	mu       sync.RWMutex
	sessions map[string]*PlayerSession            // player_id -> session
	byRoom   map[string]map[string]*PlayerSession // room_code -> {player_id -> session}
}

// NewSessionRegistry creates an initialized SessionRegistry ready for use.
func NewSessionRegistry() *SessionRegistry {
	return &SessionRegistry{
		sessions: make(map[string]*PlayerSession),
		byRoom:   make(map[string]map[string]*PlayerSession),
	}
}

// Register adds a new player session to the registry and starts a writePump
// goroutine that drains SendCh to the WebSocket connection. If a session already
// exists for the given playerID, it is unregistered first.
func (sr *SessionRegistry) Register(playerID, roomCode string, conn *websocket.Conn) {
	sr.mu.Lock()

	// If a session already exists for this player, clean it up
	if existing, ok := sr.sessions[playerID]; ok {
		sr.removeLocked(existing)
	}

	session := &PlayerSession{
		PlayerID: playerID,
		RoomCode: roomCode,
		Conn:     conn,
		SendCh:   make(chan []byte, sendChBufferSize),
		done:     make(chan struct{}),
	}

	sr.sessions[playerID] = session

	if sr.byRoom[roomCode] == nil {
		sr.byRoom[roomCode] = make(map[string]*PlayerSession)
	}
	sr.byRoom[roomCode][playerID] = session

	sr.mu.Unlock()

	// Start the writePump goroutine for this session
	go sr.writePump(session)
}

// Unregister removes a player session from the registry and signals the
// writePump goroutine to stop. The WebSocket connection is NOT closed here;
// the caller is responsible for connection lifecycle management.
func (sr *SessionRegistry) Unregister(playerID string) {
	sr.mu.Lock()
	defer sr.mu.Unlock()

	session, ok := sr.sessions[playerID]
	if !ok {
		return
	}

	sr.removeLocked(session)
}

// Update replaces the WebSocket connection for an existing player session.
// This is used during reconnection: the player keeps their identity and room,
// but gets a new underlying connection. The old writePump is stopped and a new
// one is started for the new connection.
func (sr *SessionRegistry) Update(playerID string, conn *websocket.Conn) {
	sr.mu.Lock()

	session, ok := sr.sessions[playerID]
	if !ok {
		sr.mu.Unlock()
		return
	}

	// Stop the old writePump
	close(session.done)

	// Create a new session with the updated connection but same identity
	newSession := &PlayerSession{
		PlayerID: playerID,
		RoomCode: session.RoomCode,
		Conn:     conn,
		SendCh:   make(chan []byte, sendChBufferSize),
		done:     make(chan struct{}),
	}

	// Update indices
	sr.sessions[playerID] = newSession
	if roomMap := sr.byRoom[newSession.RoomCode]; roomMap != nil {
		roomMap[playerID] = newSession
	}

	sr.mu.Unlock()

	// Start a new writePump for the updated session
	go sr.writePump(newSession)
}

// UpdateIdentity re-indexes a session from an old player_id to a new player_id
// and/or room_code. This is used when the worker confirms identity after
// create_room/join_room — the session transitions from "pending_X" to the
// real player_id and room_code.
//
// The session's SendCh and writePump are preserved (no new goroutines).
// Only the registry indices are updated.
func (sr *SessionRegistry) UpdateIdentity(oldPlayerID, newPlayerID, newRoomCode string) {
	sr.mu.Lock()
	defer sr.mu.Unlock()

	session, ok := sr.sessions[oldPlayerID]
	if !ok {
		return
	}

	// Remove from old indices
	delete(sr.sessions, oldPlayerID)
	if roomMap := sr.byRoom[session.RoomCode]; roomMap != nil {
		delete(roomMap, oldPlayerID)
		if len(roomMap) == 0 {
			delete(sr.byRoom, session.RoomCode)
		}
	}

	// Update the session fields in-place
	session.PlayerID = newPlayerID
	if newRoomCode != "" {
		session.RoomCode = newRoomCode
	}

	// Re-insert under new indices
	sr.sessions[newPlayerID] = session
	if sr.byRoom[session.RoomCode] == nil {
		sr.byRoom[session.RoomCode] = make(map[string]*PlayerSession)
	}
	sr.byRoom[session.RoomCode][newPlayerID] = session
}

// GetByRoom returns a snapshot of all player sessions in the given room.
// Returns nil if the room has no sessions.
func (sr *SessionRegistry) GetByRoom(roomCode string) []*PlayerSession {
	sr.mu.RLock()
	defer sr.mu.RUnlock()

	roomMap := sr.byRoom[roomCode]
	if len(roomMap) == 0 {
		return nil
	}

	sessions := make([]*PlayerSession, 0, len(roomMap))
	for _, s := range roomMap {
		sessions = append(sessions, s)
	}
	return sessions
}

// GetByPlayer returns the session for the given player, or nil if not found.
func (sr *SessionRegistry) GetByPlayer(playerID string) *PlayerSession {
	sr.mu.RLock()
	defer sr.mu.RUnlock()

	return sr.sessions[playerID]
}

// Count returns the total number of active sessions in the registry.
func (sr *SessionRegistry) Count() int {
	sr.mu.RLock()
	defer sr.mu.RUnlock()

	return len(sr.sessions)
}

// removeLocked removes a session from both indices and signals its writePump
// to stop. Must be called with sr.mu held (write lock).
func (sr *SessionRegistry) removeLocked(session *PlayerSession) {
	// Signal the writePump to stop
	close(session.done)

	delete(sr.sessions, session.PlayerID)

	if roomMap := sr.byRoom[session.RoomCode]; roomMap != nil {
		delete(roomMap, session.PlayerID)
		if len(roomMap) == 0 {
			delete(sr.byRoom, session.RoomCode)
		}
	}
}

// writePump is a per-session goroutine that drains SendCh and writes messages
// to the WebSocket connection. It exits when the session's done channel is closed
// or when a write error occurs. Writes to a single connection are serialized here
// (no concurrent WriteMessage calls).
//
// WRITE-COALESCING (perf): the gateway is syscall-bound — pprof under load showed
// ~27% CPU in socket writes and ~30% in scheduler churn from one goroutine wakeup
// per message. So after taking one message, we opportunistically drain any
// additional messages ALREADY queued in SendCh (non-blocking) and, if there is
// more than one, write them all in a SINGLE WebSocket frame as
// {"type":"batch","messages":[...]}. This turns N write syscalls + N wakeups into
// 1. Under light load only one message is usually queued, so it's sent as-is and
// the client never sees a batch — the batch path self-activates exactly when the
// queue backs up (i.e. under the load where it matters).
func (sr *SessionRegistry) writePump(session *PlayerSession) {
	// Reused scratch buffer for building batch frames (per-goroutine, no sharing).
	var buf bytes.Buffer
	batch := make([][]byte, 0, maxBatch)

	writeFrame := func(msgs [][]byte) error {
		if len(msgs) == 1 {
			// Single message: write as-is (no batch envelope) — common low-load case.
			return session.Conn.WriteMessage(websocket.TextMessage, msgs[0])
		}
		// Multiple: combine into one {"type":"batch","messages":[...]} frame.
		buf.Reset()
		buf.Write(batchPrefix)
		for i, m := range msgs {
			if i > 0 {
				buf.WriteByte(',')
			}
			buf.Write(m) // each m is already-serialized JSON
		}
		buf.Write(batchSuffix)
		return session.Conn.WriteMessage(websocket.TextMessage, buf.Bytes())
	}

	for {
		select {
		case <-session.done:
			return
		case msg, ok := <-session.SendCh:
			if !ok {
				return
			}
			// Start a batch with this message, then drain whatever else is
			// already queued (non-blocking) up to maxBatch.
			batch = batch[:0]
			batch = append(batch, msg)
		drain:
			for len(batch) < maxBatch {
				select {
				case m, ok := <-session.SendCh:
					if !ok {
						break drain
					}
					batch = append(batch, m)
				default:
					break drain
				}
			}
			if err := writeFrame(batch); err != nil {
				debugf("[session] writePump error player=%s err=%v", session.PlayerID, err)
				return
			}
			continue
		}
	}
}
