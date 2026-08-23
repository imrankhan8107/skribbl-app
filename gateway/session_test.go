package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newTestConn creates a real WebSocket connection pair for testing.
// Returns (client-side conn, server-side conn, cleanup func).
func newTestConn(t *testing.T) (*websocket.Conn, *websocket.Conn, func()) {
	t.Helper()

	var serverConn *websocket.Conn
	var serverMu sync.Mutex
	serverReady := make(chan struct{})

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade failed: %v", err)
			return
		}
		serverMu.Lock()
		serverConn = conn
		serverMu.Unlock()
		close(serverReady)
		// Keep the handler alive until test is done
		select {}
	}))

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/"
	clientConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		server.Close()
		t.Fatalf("dial failed: %v", err)
	}

	<-serverReady

	serverMu.Lock()
	sc := serverConn
	serverMu.Unlock()

	cleanup := func() {
		clientConn.Close()
		sc.Close()
		server.Close()
	}

	return clientConn, sc, cleanup
}

func TestNewSessionRegistry(t *testing.T) {
	sr := NewSessionRegistry()
	if sr == nil {
		t.Fatal("NewSessionRegistry returned nil")
	}
	if sr.Count() != 0 {
		t.Fatalf("expected empty registry, got %d sessions", sr.Count())
	}
}

func TestRegisterAndGetByPlayer(t *testing.T) {
	sr := NewSessionRegistry()
	_, serverConn, cleanup := newTestConn(t)
	defer cleanup()

	sr.Register("player-1", "ROOM01", serverConn)
	defer sr.Unregister("player-1")

	session := sr.GetByPlayer("player-1")
	if session == nil {
		t.Fatal("expected session, got nil")
	}
	if session.PlayerID != "player-1" {
		t.Errorf("expected PlayerID=player-1, got %s", session.PlayerID)
	}
	if session.RoomCode != "ROOM01" {
		t.Errorf("expected RoomCode=ROOM01, got %s", session.RoomCode)
	}
	if session.Conn != serverConn {
		t.Error("expected stored conn to match registered conn")
	}
	if sr.Count() != 1 {
		t.Errorf("expected count=1, got %d", sr.Count())
	}
}

func TestGetByRoom(t *testing.T) {
	sr := NewSessionRegistry()

	_, conn1, cleanup1 := newTestConn(t)
	defer cleanup1()
	_, conn2, cleanup2 := newTestConn(t)
	defer cleanup2()
	_, conn3, cleanup3 := newTestConn(t)
	defer cleanup3()

	sr.Register("player-1", "ROOM01", conn1)
	sr.Register("player-2", "ROOM01", conn2)
	sr.Register("player-3", "ROOM02", conn3)
	defer sr.Unregister("player-1")
	defer sr.Unregister("player-2")
	defer sr.Unregister("player-3")

	room1Sessions := sr.GetByRoom("ROOM01")
	if len(room1Sessions) != 2 {
		t.Fatalf("expected 2 sessions in ROOM01, got %d", len(room1Sessions))
	}

	room2Sessions := sr.GetByRoom("ROOM02")
	if len(room2Sessions) != 1 {
		t.Fatalf("expected 1 session in ROOM02, got %d", len(room2Sessions))
	}

	emptyRoom := sr.GetByRoom("NOROOM")
	if emptyRoom != nil {
		t.Fatalf("expected nil for non-existent room, got %d sessions", len(emptyRoom))
	}
}

func TestUnregister(t *testing.T) {
	sr := NewSessionRegistry()
	_, serverConn, cleanup := newTestConn(t)
	defer cleanup()

	sr.Register("player-1", "ROOM01", serverConn)
	sr.Unregister("player-1")

	if sr.GetByPlayer("player-1") != nil {
		t.Error("expected nil after unregister")
	}
	if sr.Count() != 0 {
		t.Errorf("expected count=0, got %d", sr.Count())
	}
	if sessions := sr.GetByRoom("ROOM01"); sessions != nil {
		t.Errorf("expected room map cleaned up, got %d sessions", len(sessions))
	}
}

func TestUnregisterNonExistent(t *testing.T) {
	sr := NewSessionRegistry()
	// Should not panic
	sr.Unregister("nonexistent-player")
}

func TestUpdate(t *testing.T) {
	sr := NewSessionRegistry()
	_, conn1, cleanup1 := newTestConn(t)
	defer cleanup1()
	_, conn2, cleanup2 := newTestConn(t)
	defer cleanup2()

	sr.Register("player-1", "ROOM01", conn1)
	defer sr.Unregister("player-1")

	// Update with new connection (simulates reconnect)
	sr.Update("player-1", conn2)

	session := sr.GetByPlayer("player-1")
	if session == nil {
		t.Fatal("expected session after update, got nil")
	}
	if session.Conn != conn2 {
		t.Error("expected conn to be updated to new connection")
	}
	if session.RoomCode != "ROOM01" {
		t.Errorf("expected RoomCode preserved as ROOM01, got %s", session.RoomCode)
	}
	if sr.Count() != 1 {
		t.Errorf("expected count=1 after update, got %d", sr.Count())
	}

	// Verify byRoom still points to the updated session
	roomSessions := sr.GetByRoom("ROOM01")
	if len(roomSessions) != 1 {
		t.Fatalf("expected 1 session in room after update, got %d", len(roomSessions))
	}
	if roomSessions[0].Conn != conn2 {
		t.Error("room session should reference updated connection")
	}
}

func TestUpdateNonExistent(t *testing.T) {
	sr := NewSessionRegistry()
	_, conn, cleanup := newTestConn(t)
	defer cleanup()

	// Update on non-existent player should be a no-op
	sr.Update("nonexistent", conn)
	if sr.Count() != 0 {
		t.Errorf("expected count=0, got %d", sr.Count())
	}
}

func TestRegisterReplacesExisting(t *testing.T) {
	sr := NewSessionRegistry()
	_, conn1, cleanup1 := newTestConn(t)
	defer cleanup1()
	_, conn2, cleanup2 := newTestConn(t)
	defer cleanup2()

	sr.Register("player-1", "ROOM01", conn1)
	sr.Register("player-1", "ROOM02", conn2)
	defer sr.Unregister("player-1")

	session := sr.GetByPlayer("player-1")
	if session.RoomCode != "ROOM02" {
		t.Errorf("expected RoomCode=ROOM02 after re-register, got %s", session.RoomCode)
	}
	if session.Conn != conn2 {
		t.Error("expected conn updated after re-register")
	}
	if sr.Count() != 1 {
		t.Errorf("expected count=1, got %d", sr.Count())
	}

	// Old room should be empty
	if sessions := sr.GetByRoom("ROOM01"); sessions != nil {
		t.Errorf("expected old room cleaned up, got %d sessions", len(sessions))
	}
}

func TestWritePumpDelivery(t *testing.T) {
	sr := NewSessionRegistry()
	clientConn, serverConn, cleanup := newTestConn(t)
	defer cleanup()

	sr.Register("player-1", "ROOM01", serverConn)
	defer sr.Unregister("player-1")

	session := sr.GetByPlayer("player-1")

	// Send a message via SendCh
	testMsg := []byte(`{"type":"test","payload":"hello"}`)
	session.SendCh <- testMsg

	// Read from client side
	clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := clientConn.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read message: %v", err)
	}
	if string(msg) != string(testMsg) {
		t.Errorf("expected %s, got %s", testMsg, msg)
	}
}

func TestConcurrentAccess(t *testing.T) {
	sr := NewSessionRegistry()
	const numGoroutines = 50
	const numOpsPerGoroutine = 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	// Create connections for the test
	conns := make([]*websocket.Conn, numGoroutines)
	cleanups := make([]func(), numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		_, serverConn, cleanup := newTestConn(t)
		conns[i] = serverConn
		cleanups[i] = cleanup
	}
	defer func() {
		for _, c := range cleanups {
			c()
		}
	}()

	for i := 0; i < numGoroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			playerID := "player-" + string(rune('A'+idx%26)) + string(rune('0'+idx/26))
			roomCode := "ROOM0" + string(rune('1'+idx%5))

			for j := 0; j < numOpsPerGoroutine; j++ {
				switch j % 4 {
				case 0:
					sr.Register(playerID, roomCode, conns[idx])
				case 1:
					sr.GetByPlayer(playerID)
				case 2:
					sr.GetByRoom(roomCode)
				case 3:
					sr.Unregister(playerID)
				}
			}
		}(i)
	}

	wg.Wait()
	// If we get here without a race detector panic, concurrency is safe
}
