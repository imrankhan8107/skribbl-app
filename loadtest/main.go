package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Configuration ──────────────────────────────────────────────────────────

type Config struct {
	VUs                        int
	PlayersPerRoom             int
	StrokeHz                   int
	StrokePoints               int
	RampSeconds                int
	HoldSeconds                int
	VuOffset                   int
	Hosts                      []string
	Port                       string
	CoordHosts                 []string
	CoordPort                  string
	CoordViaLB                 bool
	CoordURLs                  []string
	HealthURLs                 []string
	TurnDuration               int
	NumRounds                  int
	PerTurnSlack               int
	HoldFixedBuffer            int
	ConnectTimeoutMs           int
	MinPlayersToStart          int
	StartGraceMs               int
	LobbyTimeoutMs             int
	Strict                     bool
	HealthPollSeconds          int
	AutoStopConsecutiveZeros   int
	AutoStopMinElapsedS        int
}

func loadConfig() *Config {
	cfg := &Config{}

	vusEnv := getEnvInt("VUS", 100)
	playersEnv := getEnvInt("PLAYERS_PER_ROOM", 2)
	strokeHzEnv := getEnvInt("STROKE_HZ", 30) // Script 1 default: 30
	rampEnv := getEnvInt("RAMP_SECONDS", 0)
	offsetEnv := getEnvInt("VU_OFFSET", 0)

	cfg.StrokePoints = getEnvInt("STROKE_POINTS", 4)
	cfg.TurnDuration = getEnvInt("TURN_DURATION", 80) // Script 1 default: 80s
	cfg.NumRounds = getEnvInt("NUM_ROUNDS", 3)
	cfg.PerTurnSlack = getEnvInt("PER_TURN_SLACK", 70)
	cfg.HoldFixedBuffer = getEnvInt("HOLD_FIXED_BUFFER", 300)
	cfg.ConnectTimeoutMs = getEnvInt("CONNECT_TIMEOUT_MS", 60000)
	cfg.MinPlayersToStart = getEnvInt("MIN_PLAYERS_TO_START", 2)
	cfg.StartGraceMs = getEnvInt("START_GRACE_MS", 15000)
	cfg.HealthPollSeconds = getEnvInt("HEALTH_POLL_SECONDS", 15)
	cfg.AutoStopConsecutiveZeros = getEnvInt("AUTO_STOP_ZEROS", 2)
	cfg.AutoStopMinElapsedS = getEnvInt("AUTO_STOP_MIN_S", 300)

	defaultHold := cfg.NumRounds * playersEnv * (cfg.TurnDuration + cfg.PerTurnSlack) + cfg.HoldFixedBuffer
	holdEnv := getEnvInt("HOLD_SECONDS", defaultHold)

	flagVUs := flag.Int("vus", vusEnv, "Total virtual users")
	flagPlayers := flag.Int("players", playersEnv, "Players per room")
	flagHz := flag.Int("hz", strokeHzEnv, "Stroke frequency (Hz)")
	flagRamp := flag.Int("ramp", rampEnv, "Arrival ramp duration (seconds)")
	flagHold := flag.Int("hold", holdEnv, "Hold/game duration (seconds)")
	flagOffset := flag.Int("offset", offsetEnv, "VU index offset for multi-runner tests")
	flagStrict := flag.Bool("strict", os.Getenv("STRICT") == "1", "Enforce strict acceptance thresholds")

	flag.Parse()

	args := flag.Args()
	if len(args) > 0 {
		if v, err := strconv.Atoi(args[0]); err == nil {
			*flagVUs = v
		}
	}
	if len(args) > 1 {
		if v, err := strconv.Atoi(args[1]); err == nil {
			*flagPlayers = v
		}
	}
	if len(args) > 2 {
		if v, err := strconv.Atoi(args[2]); err == nil {
			*flagHz = v
		}
	}
	if len(args) > 3 {
		if v, err := strconv.Atoi(args[3]); err == nil {
			*flagRamp = v
		}
	}
	if len(args) > 4 {
		if v, err := strconv.Atoi(args[4]); err == nil {
			*flagHold = v
		}
	}
	if len(args) > 5 {
		if v, err := strconv.Atoi(args[5]); err == nil {
			*flagOffset = v
		}
	}

	cfg.VUs = *flagVUs
	cfg.PlayersPerRoom = *flagPlayers
	cfg.StrokeHz = *flagHz
	cfg.RampSeconds = *flagRamp
	cfg.HoldSeconds = *flagHold
	cfg.VuOffset = *flagOffset
	cfg.Strict = *flagStrict

	defaultLobbyTimeout := 240000
	if (cfg.RampSeconds+60)*1000 > defaultLobbyTimeout {
		defaultLobbyTimeout = (cfg.RampSeconds + 60) * 1000
	}
	cfg.LobbyTimeoutMs = getEnvInt("LOBBY_TIMEOUT_MS", defaultLobbyTimeout)

	// Host & Network resolution
	rawHosts := os.Getenv("HOSTS")
	if rawHosts == "" {
		rawHosts = os.Getenv("HOST")
	}
	if rawHosts == "" {
		rawHosts = "localhost"
	}
	for _, h := range strings.Split(rawHosts, ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			cfg.Hosts = append(cfg.Hosts, h)
		}
	}

	cfg.Port = os.Getenv("PORT")
	if cfg.Port == "" {
		cfg.Port = "9000" // Script 1 default: 9000
	}

	rawCoordHosts := os.Getenv("COORD_HOSTS")
	if rawCoordHosts == "" {
		rawCoordHosts = os.Getenv("COORD_HOST")
	}
	if rawCoordHosts == "" {
		rawCoordHosts = cfg.Hosts[0]
	}
	for _, h := range strings.Split(rawCoordHosts, ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			cfg.CoordHosts = append(cfg.CoordHosts, h)
		}
	}

	cfg.CoordPort = os.Getenv("COORD_PORT")
	if cfg.CoordPort == "" {
		cfg.CoordPort = "9100"
	}

	cfg.CoordViaLB = os.Getenv("COORD_VIA_LB") != "0"

	rawCoordURLs := os.Getenv("COORD_URLS")
	if rawCoordURLs != "" {
		for _, u := range strings.Split(rawCoordURLs, ",") {
			u = strings.TrimSpace(u)
			if u != "" {
				cfg.CoordURLs = append(cfg.CoordURLs, u)
			}
		}
	} else {
		for _, h := range cfg.CoordHosts {
			cfg.CoordURLs = append(cfg.CoordURLs, fmt.Sprintf("%s:%s", h, cfg.CoordPort))
		}
	}

	rawHealthURLs := os.Getenv("HEALTH_URLS")
	if rawHealthURLs != "" {
		for _, u := range strings.Split(rawHealthURLs, ",") {
			u = strings.TrimSpace(u)
			if u != "" {
				cfg.HealthURLs = append(cfg.HealthURLs, u)
			}
		}
	} else {
		for _, h := range cfg.Hosts {
			cfg.HealthURLs = append(cfg.HealthURLs, fmt.Sprintf("http://%s:%s/health", h, cfg.Port))
		}
	}

	return cfg
}

func getEnvInt(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	if n, err := strconv.Atoi(v); err == nil {
		return n
	}
	return defaultVal
}

// ─── Metrics Collection ─────────────────────────────────────────────────────

func percentile(sorted []float64, pct float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0.0
	}
	if n == 1 {
		return sorted[0]
	}
	rank := (pct / 100.0) * float64(n-1)
	lo := int(rank)
	hi := lo + 1
	if hi >= n {
		hi = n - 1
	}
	frac := rank - float64(lo)
	return sorted[lo] + (sorted[hi]-sorted[lo])*frac
}

type TrendMetric struct {
	mu      sync.Mutex
	samples []float64
}

func (t *TrendMetric) Add(val float64) {
	t.mu.Lock()
	t.samples = append(t.samples, val)
	t.mu.Unlock()
}

type TrendStats struct {
	Count float64
	Min   float64
	Max   float64
	Avg   float64
	Med   float64
	P90   float64
	P95   float64
}

func (t *TrendMetric) Snapshot() TrendStats {
	t.mu.Lock()
	defer t.mu.Unlock()

	n := len(t.samples)
	if n == 0 {
		return TrendStats{}
	}

	sorted := make([]float64, n)
	copy(sorted, t.samples)
	sort.Float64s(sorted)

	var sum float64
	for _, v := range sorted {
		sum += v
	}

	return TrendStats{
		Count: float64(n),
		Min:   sorted[0],
		Max:   sorted[n-1],
		Avg:   sum / float64(n),
		Med:   percentile(sorted, 50.0),
		P90:   percentile(sorted, 90.0),
		P95:   percentile(sorted, 95.0),
	}
}

type AtomicUint64 struct {
	val uint64
}

func (a *AtomicUint64) Add(delta uint64) uint64 {
	return atomic.AddUint64(&a.val, delta)
}

func (a *AtomicUint64) Load() uint64 {
	return atomic.LoadUint64(&a.val)
}

func (a *AtomicUint64) Store(val uint64) {
	atomic.StoreUint64(&a.val, val)
}

type AtomicBool struct {
	val uint32
}

func (a *AtomicBool) Load() bool {
	return atomic.LoadUint32(&a.val) != 0
}

func (a *AtomicBool) Store(val bool) {
	var v uint32
	if val {
		v = 1
	}
	atomic.StoreUint32(&a.val, v)
}

type Metrics struct {
	DataReceived AtomicUint64
	DataSent     AtomicUint64

	MsgsReceived AtomicUint64
	MsgsSent     AtomicUint64

	// Connection Accounting
	WSConnectionsOpened  AtomicUint64
	WSConnectionsClosed  AtomicUint64
	WSConnectionFailures AtomicUint64
	RedirectsFollowed    AtomicUint64

	// Definitive Per-Player Initial Connect Outcome (1 sample per VU)
	PlayersAttempted AtomicUint64
	PlayersConnected AtomicUint64

	// Room Creation / Join
	RoomsCreated              AtomicUint64
	RoomsJoined               AtomicUint64
	RoomCreateErrors          AtomicUint64
	RoomJoinErrors            AtomicUint64
	RoomCodeDiscoveryFailures AtomicUint64
	CoordFailures             AtomicUint64

	// Server Errors
	ServerErrors       AtomicUint64
	ServerCreateErrors AtomicUint64
	ServerJoinErrors   AtomicUint64

	// Game Lifecycle
	GameStartRequests AtomicUint64
	GamesStarted      AtomicUint64
	GamesCompleted    AtomicUint64
	GamesAborted      AtomicUint64

	// Session Outcomes
	SessionsCompleted AtomicUint64
	SessionsAborted   AtomicUint64

	// Error Categorization
	ErrorsConnect  AtomicUint64
	ErrorsRoom     AtomicUint64
	ErrorsProtocol AtomicUint64
	ErrorsGame     AtomicUint64
	ErrorsTimeout  AtomicUint64

	// Gateway Observability
	GatewayHealthFailures AtomicUint64
	GatewayControlDrops    AtomicUint64
	GatewayLossyDrops      AtomicUint64
	GatewaySendDrops       AtomicUint64
	GatewayActiveClients   AtomicUint64
	GatewayStreamsActive   AtomicUint64
	GatewayMaxStreamsPerGW AtomicUint64

	// Trend Latencies
	WSOpenRTT       TrendMetric
	MessageLatency  TrendMetric
	RoomCreateRTT   TrendMetric
	RoomJoinRTT     TrendMetric
	SessionDuration TrendMetric
}

var globalMetrics = &Metrics{}

func recordError(category string) {
	switch category {
	case "connect":
		globalMetrics.ErrorsConnect.Add(1)
	case "room":
		globalMetrics.ErrorsRoom.Add(1)
	case "protocol":
		globalMetrics.ErrorsProtocol.Add(1)
	case "game":
		globalMetrics.ErrorsGame.Add(1)
	case "timeout":
		globalMetrics.ErrorsTimeout.Add(1)
	}
}

// ─── Network Helpers ────────────────────────────────────────────────────────

var httpClient = &http.Client{
	Timeout: 5 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        20000,
		MaxIdleConnsPerHost: 5000,
		IdleConnTimeout:     90 * time.Second,
		DisableKeepAlives:   false,
	},
}

func getCoordURL(cfg *Config, roomIndex int) string {
	if cfg.CoordViaLB {
		host := cfg.Hosts[roomIndex%len(cfg.Hosts)]
		return fmt.Sprintf("http://%s:%s/rooms", host, cfg.Port)
	}
	endpoint := cfg.CoordURLs[roomIndex%len(cfg.CoordURLs)]
	return fmt.Sprintf("http://%s/rooms", endpoint)
}

func publishRoomCode(cfg *Config, roomIndex int, roomCode string) error {
	u := fmt.Sprintf("%s/%d", getCoordURL(cfg, roomIndex), roomIndex)
	b, _ := json.Marshal(map[string]string{"room_code": roomCode})
	req, err := http.NewRequest("POST", u, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return nil
}

func pollRoomCode(cfg *Config, roomIndex int, timeout time.Duration) string {
	start := time.Now()
	u := fmt.Sprintf("%s/%d", getCoordURL(cfg, roomIndex), roomIndex)

	for time.Since(start) < timeout {
		req, err := http.NewRequest("GET", u, nil)
		if err == nil {
			resp, err := httpClient.Do(req)
			if err == nil {
				if resp.Status == "200 OK" || resp.StatusCode == 200 {
					var res struct {
						RoomCode string `json:"room_code"`
					}
					if err := json.NewDecoder(resp.Body).Decode(&res); err == nil && res.RoomCode != "" {
						resp.Body.Close()
						return res.RoomCode
					}
				}
				resp.Body.Close()
			}
		}
		jitter := time.Duration(1200+rand.Intn(800)) * time.Millisecond
		time.Sleep(jitter)
	}
	return ""
}

func buildWSURL(cfg *Config, vuID int, isHost bool, roomCode, redirectGW string) string {
	targetHost := cfg.Hosts[vuID%len(cfg.Hosts)]
	base := fmt.Sprintf("ws://%s:%s/ws", targetHost, cfg.Port)

	params := url.Values{}
	if redirectGW != "" {
		params.Set("gw", redirectGW)
	} else if !isHost && roomCode != "" {
		params.Set("room", roomCode)
	} else {
		params.Set("cid", fmt.Sprintf("%d-%x", vuID, rand.Int63()))
	}

	return fmt.Sprintf("%s?%s", base, params.Encode())
}

// ─── Drawing Protocols ──────────────────────────────────────────────────────

type Point struct {
	X float64
	Y float64
}

func encodeBinaryStroke(points []Point, r, g, b, size uint8) []byte {
	count := len(points)
	buf := make([]byte, 7+count*4)
	buf[0] = 0x01 // STROKE opcode
	buf[1] = r
	buf[2] = g
	buf[3] = b
	buf[4] = size
	binary.BigEndian.PutUint16(buf[5:7], uint16(count))

	off := 7
	for _, p := range points {
		x := uint16(math.Max(0, math.Min(65535, p.X)))
		y := uint16(math.Max(0, math.Min(65535, p.Y)))
		binary.BigEndian.PutUint16(buf[off:off+2], x)
		binary.BigEndian.PutUint16(buf[off+2:off+4], y)
		off += 4
	}
	return buf
}

// ─── Word Dictionary ────────────────────────────────────────────────────────

var wordPacks = map[string][]string{
	"general": {
		"cat", "sun", "cup", "hat", "tree", "fish", "star", "bird", "book", "cake",
		"frog", "door", "kite", "ship", "bell", "sock", "bear", "duck", "leaf", "ring",
		"apple", "bread", "chair", "clock", "cloud", "glass", "grape", "heart", "house", "lemon",
		"mouse", "plane", "plant", "shirt", "spoon", "table", "train", "truck", "watch", "whale",
		"banana", "bridge", "camera", "candle", "castle", "cheese", "cookie", "flower", "guitar", "hammer",
		"island", "monkey", "orange", "pencil", "pocket", "rabbit", "rocket", "spider", "window", "wizard",
	},
	"animals": {
		"ant", "bat", "bee", "cow", "dog", "fox", "owl", "pig", "rat", "deer",
		"bear", "duck", "frog", "goat", "hare", "lion", "seal", "swan", "wolf", "crab",
		"camel", "eagle", "horse", "koala", "otter", "panda", "shark", "sheep", "snake", "tiger",
		"whale", "zebra", "skunk", "sloth", "bison", "badger", "beaver", "baboon", "donkey", "walrus",
		"falcon", "lizard", "monkey", "parrot", "pigeon", "rabbit", "spider", "turtle", "dolphin", "giraffe",
		"gorilla", "hamster", "leopard", "lobster", "octopus", "ostrich", "panther", "pelican", "penguin", "raccoon",
	},
	"food": {
		"pie", "tea", "egg", "jam", "nut", "fig", "ham", "ice", "pea", "bun",
		"beef", "cake", "corn", "fish", "lime", "meat", "milk", "pear", "plum", "rice",
		"soup", "taco", "toast", "chip", "pork", "salt", "bean", "kiwi", "beet", "curry",
		"apple", "bread", "candy", "grape", "lemon", "mango", "onion", "peach", "pizza", "salad",
		"steak", "sugar", "sushi", "melon", "bacon", "toast", "flour", "guava", "pasta", "berry",
		"banana", "burger", "butter", "carrot", "cereal", "cheese", "coffee", "cookie", "garlic", "muffin",
		"orange", "potato", "tomato", "waffle", "yogurt", "cherry", "peanut", "pepper", "radish", "walnut",
	},
}

var allWordsList []string

func init() {
	seen := make(map[string]bool)
	for _, ws := range wordPacks {
		for _, w := range ws {
			if !seen[w] {
				seen[w] = true
				allWordsList = append(allWordsList, w)
			}
		}
	}
}

// ─── VU Execution Loop ──────────────────────────────────────────────────────

func isGameStartSignal(msgType string) bool {
	return msgType == "game_started" || msgType == "turn_started" ||
		msgType == "word_choices" || msgType == "drawer_selecting"
}

func runVU(ctx context.Context, cfg *Config, localVUID int, wg *sync.WaitGroup) {
	defer wg.Done()

	vuID := localVUID + cfg.VuOffset
	roomIndex := (vuID - 1) / cfg.PlayersPerRoom
	isHost := ((vuID - 1) % cfg.PlayersPerRoom) == 0
	playerName := fmt.Sprintf("k%s", strconv.FormatInt(int64(vuID), 36))

	totalRooms := int(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	if cfg.RampSeconds > 0 && totalRooms > 0 {
		localRoomIndex := (localVUID - 1) / cfg.PlayersPerRoom
		rampOffset := time.Duration(float64(localRoomIndex)/float64(totalRooms)*float64(cfg.RampSeconds)) * time.Second
		select {
		case <-ctx.Done():
			return
		case <-time.After(rampOffset):
		}
	}

	var coordRoomCode string
	if isHost {
		time.Sleep(time.Duration(rand.Intn(200)) * time.Millisecond)
	} else {
		time.Sleep(time.Duration(1000+rand.Intn(500)) * time.Millisecond)
		coordRoomCode = pollRoomCode(cfg, roomIndex, time.Duration(cfg.LobbyTimeoutMs)*time.Millisecond)
		if coordRoomCode == "" {
			globalMetrics.CoordFailures.Add(1)
			globalMetrics.RoomJoinErrors.Add(1)
			globalMetrics.RoomCodeDiscoveryFailures.Add(1)
			recordError("room")
			globalMetrics.SessionsAborted.Add(1)
			return
		}
	}

	sessionStart := time.Now()
	defer func() {
		globalMetrics.SessionDuration.Add(float64(time.Since(sessionStart).Milliseconds()))
	}()

	var initialConnectOutcomeRecorded bool
	var initialConnectSucceeded bool

	dialer := websocket.Dialer{
		HandshakeTimeout: time.Duration(cfg.ConnectTimeoutMs) * time.Millisecond,
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
	}

	globalMetrics.PlayersAttempted.Add(1)

	// Session State across redirects (protected by sessionMu)
	var sessionMu sync.Mutex
	var roomCode = coordRoomCode
	var redirectGW string
	var redirectAttempts int
	const maxRedirects = 3
	var playerID string
	var state = "connecting" // connecting -> lobby -> waiting_start -> playing
	var isDrawer AtomicBool
	var turnActive AtomicBool
	var startArmed bool
	var gameStartedCounted bool
	var sessionEnded bool
	var gameCompleted bool
	var reconnectForRedirect bool

	var pendingReadyAt time.Time
	var pendingReadyMu sync.Mutex

	var turnCancel context.CancelFunc
	var turnMu sync.Mutex

	stopTurnLoops := func() {
		turnMu.Lock()
		defer turnMu.Unlock()
		turnActive.Store(false)
		if turnCancel != nil {
			turnCancel()
			turnCancel = nil
		}
	}

	// Session-level cancellable context
	sessionCtx, cancelSession := context.WithCancel(ctx)
	defer cancelSession()

	recordConnectSuccess := func() {
		if !initialConnectOutcomeRecorded {
			initialConnectOutcomeRecorded = true
			initialConnectSucceeded = true
			globalMetrics.PlayersConnected.Add(1)
		}
	}

	recordConnectFailure := func() {
		if !initialConnectOutcomeRecorded {
			initialConnectOutcomeRecorded = true
			globalMetrics.WSConnectionFailures.Add(1)
			recordError("connect")
		}
	}

	endSession := func(reason string) {
		sessionMu.Lock()
		if sessionEnded {
			sessionMu.Unlock()
			return
		}
		sessionEnded = true
		completed := reason == "completed"
		if completed {
			gameCompleted = true
		}
		sessionMu.Unlock()

		stopTurnLoops()

		if completed {
			globalMetrics.SessionsCompleted.Add(1)
			if isHost {
				globalMetrics.GamesCompleted.Add(1)
			}
		} else {
			globalMetrics.SessionsAborted.Add(1)
			if isHost {
				globalMetrics.GamesAborted.Add(1)
			}
		}
		cancelSession()
	}

	// ─── Connection Loop (Handles Initial Dial & Application-level Redirects) ───
	for {
		sessionMu.Lock()
		ended := sessionEnded
		curRoomCode := roomCode
		curRedirectGW := redirectGW
		sessionMu.Unlock()

		if ended || sessionCtx.Err() != nil {
			break
		}

		wsURL := buildWSURL(cfg, vuID, isHost, curRoomCode, curRedirectGW)
		openStart := time.Now()
		conn, _, err := dialer.Dial(wsURL, nil)
		if err != nil {
			if !initialConnectSucceeded {
				recordConnectFailure()
			}
			endSession("error")
			return
		}

		globalMetrics.WSConnectionsOpened.Add(1)
		globalMetrics.WSOpenRTT.Add(float64(time.Since(openStart).Milliseconds()))
		recordConnectSuccess()

		var writeMu sync.Mutex
		sendJSON := func(msgType string, payload any) error {
			b, err := json.Marshal(map[string]any{
				"type":    msgType,
				"payload": payload,
			})
			if err != nil {
				return err
			}
			globalMetrics.DataSent.Add(uint64(len(b)))
			globalMetrics.MsgsSent.Add(1)
			writeMu.Lock()
			defer writeMu.Unlock()
			return conn.WriteMessage(websocket.TextMessage, b)
		}

		sendBinary := func(data []byte) error {
			globalMetrics.DataSent.Add(uint64(len(data)))
			globalMetrics.MsgsSent.Add(1)
			writeMu.Lock()
			defer writeMu.Unlock()
			return conn.WriteMessage(websocket.BinaryMessage, data)
		}

		sendClose := func(code int, text string) {
			writeMu.Lock()
			defer writeMu.Unlock()
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, text))
		}

		sendReady := func() {
			pendingReadyMu.Lock()
			pendingReadyAt = time.Now()
			pendingReadyMu.Unlock()
			_ = sendJSON("toggle_ready", map[string]any{})
		}

		startDrawing := func(tCtx context.Context) {
			if cfg.StrokeHz <= 0 {
				return
			}
			interval := time.Duration(1000/cfg.StrokeHz) * time.Millisecond
			ticker := time.NewTicker(interval)
			go func() {
				defer ticker.Stop()
				lastX := float64(rand.Intn(800))
				lastY := float64(rand.Intn(600))
				for {
					select {
					case <-tCtx.Done():
						return
					case <-sessionCtx.Done():
						return
					case <-ticker.C:
						if !turnActive.Load() || !isDrawer.Load() {
							return
						}
						pts := make([]Point, cfg.StrokePoints)
						for i := 0; i < cfg.StrokePoints; i++ {
							lastX = math.Max(0, math.Min(800, lastX+float64(rand.Intn(31)-15)))
							lastY = math.Max(0, math.Min(600, lastY+float64(rand.Intn(31)-15)))
							pts[i] = Point{X: lastX, Y: lastY}
						}
						bin := encodeBinaryStroke(pts, 0, 0, 0, 3)
						_ = sendBinary(bin)
					}
				}
			}()
		}

		startGuessing := func(tCtx context.Context, themeID string, wordLen int) {
			candidatePool := allWordsList
			if themeID != "" {
				if ws, ok := wordPacks[themeID]; ok {
					candidatePool = ws
				}
			}
			if wordLen > 0 {
				var lenMatched []string
				for _, w := range candidatePool {
					if len(w) == wordLen {
						lenMatched = append(lenMatched, w)
					}
				}
				if len(lenMatched) > 0 {
					candidatePool = lenMatched
				}
			}

			ticker := time.NewTicker(time.Duration(1500+rand.Intn(1500)) * time.Millisecond)
			go func() {
				defer ticker.Stop()
				idx := rand.Intn(len(candidatePool))
				for {
					select {
					case <-tCtx.Done():
						return
					case <-sessionCtx.Done():
						return
					case <-ticker.C:
						if !turnActive.Load() || isDrawer.Load() {
							return
						}
						w := candidatePool[idx%len(candidatePool)]
						idx++
						_ = sendJSON("guess", map[string]string{"text": w})
					}
				}
			}()
		}

		createJoinStart := time.Now()
		sessionMu.Lock()
		curRoomCode = roomCode
		sessionMu.Unlock()

		if isHost && curRoomCode == "" {
			_ = sendJSON("create_room", map[string]string{
				"name":   playerName,
				"avatar": "bear",
			})
			time.AfterFunc(time.Duration(cfg.ConnectTimeoutMs)*time.Millisecond, func() {
				sessionMu.Lock()
				st := state
				ended := sessionEnded
				sessionMu.Unlock()
				if st == "connecting" && !ended {
					globalMetrics.RoomCreateErrors.Add(1)
					recordError("timeout")
					endSession("error")
				}
			})
		} else {
			_ = sendJSON("join_room", map[string]string{
				"name":      playerName,
				"room_code": curRoomCode,
				"avatar":    "bear",
			})
			time.AfterFunc(time.Duration(cfg.ConnectTimeoutMs)*time.Millisecond, func() {
				sessionMu.Lock()
				st := state
				ended := sessionEnded
				sessionMu.Unlock()
				if st == "connecting" && !ended {
					globalMetrics.RoomJoinErrors.Add(1)
					recordError("timeout")
					endSession("error")
				}
			})
		}

		// Pre-defined frame handler to avoid initialization data race
		processFrame := func(frameData []byte) {
			sessionMu.Lock()
			if sessionEnded {
				sessionMu.Unlock()
				return
			}
			sessionMu.Unlock()

			var f struct {
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(frameData, &f); err != nil {
				return
			}

			if f.Type == "ping" {
				_ = sendJSON("pong", map[string]any{})
				return
			}

			// Latency probe: matched on toggle_ready -> player_list
			if f.Type == "player_list" {
				pendingReadyMu.Lock()
				if !pendingReadyAt.IsZero() {
					lat := float64(time.Since(pendingReadyAt).Milliseconds())
					globalMetrics.MessageLatency.Add(lat)
					pendingReadyAt = time.Time{}
				}
				pendingReadyMu.Unlock()
			}

			// ─── P0: Application-Level Sticky Redirect Handler ───
			if f.Type == "redirect" {
				var p struct {
					GatewayID string `json:"gateway_id"`
					RoomCode  string `json:"room_code"`
				}
				_ = json.Unmarshal(f.Payload, &p)
				if p.GatewayID != "" && redirectAttempts < maxRedirects {
					sessionMu.Lock()
					redirectGW = p.GatewayID
					if p.RoomCode != "" {
						roomCode = p.RoomCode
					}
					redirectAttempts++
					reconnectForRedirect = true
					sessionMu.Unlock()

					globalMetrics.RedirectsFollowed.Add(1)
					_ = conn.Close()
					return
				}
				endSession("error")
				return
			}

			sessionMu.Lock()
			currentState := state
			sessionMu.Unlock()

			switch currentState {
			case "connecting":
				switch f.Type {
				case "room_created":
					globalMetrics.RoomCreateRTT.Add(float64(time.Since(createJoinStart).Milliseconds()))
					globalMetrics.RoomsCreated.Add(1)
					var p struct {
						RoomCode string `json:"room_code"`
						PlayerID string `json:"player_id"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					sessionMu.Lock()
					roomCode = p.RoomCode
					playerID = p.PlayerID
					state = "lobby"
					sessionMu.Unlock()
					_ = publishRoomCode(cfg, roomIndex, p.RoomCode)

					time.AfterFunc(time.Duration(cfg.LobbyTimeoutMs)*time.Millisecond, func() {
						sessionMu.Lock()
						st := state
						ended := sessionEnded
						sessionMu.Unlock()
						if (st == "lobby" || st == "waiting_start") && !ended {
							recordError("timeout")
							endSession("aborted")
						}
					})

				case "room_joined":
					globalMetrics.RoomJoinRTT.Add(float64(time.Since(createJoinStart).Milliseconds()))
					globalMetrics.RoomsJoined.Add(1)
					var p struct {
						RoomCode string `json:"room_code"`
						PlayerID string `json:"player_id"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					sessionMu.Lock()
					if p.RoomCode != "" {
						roomCode = p.RoomCode
					}
					playerID = p.PlayerID
					state = "lobby"
					sessionMu.Unlock()

					time.AfterFunc(time.Duration(1000+rand.Intn(1000))*time.Millisecond, func() {
						sessionMu.Lock()
						st := state
						ended := sessionEnded
						sessionMu.Unlock()
						if st == "lobby" && !ended {
							sendReady()
						}
					})

					time.AfterFunc(time.Duration(cfg.LobbyTimeoutMs)*time.Millisecond, func() {
						sessionMu.Lock()
						st := state
						ended := sessionEnded
						sessionMu.Unlock()
						if (st == "lobby" || st == "waiting_start") && !ended {
							recordError("timeout")
							endSession("aborted")
						}
					})

				case "error":
					var p struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					globalMetrics.ServerErrors.Add(1)
					if isHost {
						globalMetrics.ServerCreateErrors.Add(1)
						globalMetrics.RoomCreateErrors.Add(1)
					} else {
						globalMetrics.ServerJoinErrors.Add(1)
						globalMetrics.RoomJoinErrors.Add(1)
					}
					recordError("protocol")
					endSession("error")
				}

			case "lobby", "waiting_start":
				if f.Type == "player_list" && currentState == "lobby" {
					var p struct {
						Players []struct {
							ID string `json:"id"`
						} `json:"players"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					sessionMu.Lock()
					armed := startArmed
					if isHost && !armed && len(p.Players) >= cfg.MinPlayersToStart {
						startArmed = true
						sessionMu.Unlock()

						_ = sendJSON("update_settings", map[string]any{
							"num_rounds":    cfg.NumRounds,
							"turn_duration": cfg.TurnDuration,
							"max_players":   cfg.PlayersPerRoom,
						})
						sendReady()

						time.AfterFunc(time.Duration(cfg.StartGraceMs)*time.Millisecond, func() {
							sessionMu.Lock()
							st := state
							ended := sessionEnded
							if st == "lobby" && !ended {
								state = "waiting_start"
								sessionMu.Unlock()
								_ = sendJSON("start_game", map[string]any{})
								globalMetrics.GameStartRequests.Add(1)
							} else {
								sessionMu.Unlock()
							}
						})
					} else {
						sessionMu.Unlock()
					}
				} else if isGameStartSignal(f.Type) {
					sessionMu.Lock()
					started := gameStartedCounted
					if f.Type == "game_started" && isHost && !started {
						gameStartedCounted = true
						globalMetrics.GamesStarted.Add(1)
					}
					state = "playing"
					sessionMu.Unlock()
				} else if f.Type == "game_over" {
					sessionMu.Lock()
					started := gameStartedCounted
					sessionMu.Unlock()
					if isHost && !started {
						recordError("game")
						endSession("aborted")
					} else {
						endSession("completed")
					}
					return
				} else if f.Type == "game_ended_insufficient_players" {
					recordError("game")
					endSession("aborted")
					return
				} else if f.Type == "error" {
					recordError("protocol")
					endSession("error")
					return
				}

			case "playing":
				switch f.Type {
				case "drawer_selecting":
					stopTurnLoops()
					var p struct {
						DrawerID string `json:"drawer_id"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					sessionMu.Lock()
					myID := playerID
					sessionMu.Unlock()
					isDrawer.Store(p.DrawerID == myID)

				case "word_choices":
					isDrawer.Store(true)
					var p struct {
						Choices []string `json:"choices"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					if len(p.Choices) > 0 {
						choice := p.Choices[rand.Intn(len(p.Choices))]
						time.AfterFunc(time.Duration(1000+rand.Intn(2000))*time.Millisecond, func() {
							sessionMu.Lock()
							ended := sessionEnded
							sessionMu.Unlock()
							if !ended {
								_ = sendJSON("select_word", map[string]string{"word": choice})
							}
						})
					}

				case "turn_started":
					stopTurnLoops()
					var p struct {
						DrawerID string   `json:"drawer_id"`
						Hint     []string `json:"hint"`
						Theme    struct {
							ID string `json:"id"`
						} `json:"theme"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					sessionMu.Lock()
					myID := playerID
					sessionMu.Unlock()

					turnMu.Lock()
					turnActive.Store(true)
					isDrawer.Store(p.DrawerID == myID)
					var tCtx context.Context
					tCtx, turnCancel = context.WithCancel(sessionCtx)
					turnMu.Unlock()

					if isDrawer.Load() {
						startDrawing(tCtx)
					} else {
						startGuessing(tCtx, p.Theme.ID, len(p.Hint))
					}

				case "turn_ended":
					stopTurnLoops()

				case "game_over":
					stopTurnLoops()
					sendClose(websocket.CloseNormalClosure, "done")
					endSession("completed")

				case "game_ended_insufficient_players":
					stopTurnLoops()
					recordError("game")
					sendClose(websocket.CloseNormalClosure, "aborted")
					endSession("aborted")
				}
			}
		}

		// Read loop for this connection
		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				msgType, data, err := conn.ReadMessage()
				if err != nil {
					return
				}
				globalMetrics.DataReceived.Add(uint64(len(data)))
				globalMetrics.MsgsReceived.Add(1)

				if msgType == websocket.BinaryMessage {
					continue
				}

				var rawSlice []json.RawMessage
				if err := json.Unmarshal(data, &rawSlice); err == nil {
					for _, r := range rawSlice {
						processFrame(r)
					}
					continue
				}

				var single struct {
					Type    string          `json:"type"`
					Payload json.RawMessage `json:"payload"`
				}
				if err := json.Unmarshal(data, &single); err == nil {
					if single.Type == "batch" {
						var batchItems []json.RawMessage
						if err := json.Unmarshal(single.Payload, &batchItems); err == nil {
							for _, item := range batchItems {
								processFrame(item)
							}
							continue
						}
					}
					processFrame(data)
				}
			}
		}()

		select {
		case <-readDone:
			// Connection closed
			conn.Close()
			globalMetrics.WSConnectionsClosed.Add(1)
			sessionMu.Lock()
			reconn := reconnectForRedirect
			reconnectForRedirect = false
			ended := sessionEnded
			sessionMu.Unlock()
			if reconn {
				continue // Reconnect with ?gw=<redirectGW>
			}
			if !ended {
				endSession("closed")
			}
			return

		case <-time.After(time.Duration(cfg.HoldSeconds) * time.Second):
			// Client patience expired
			conn.Close()
			globalMetrics.WSConnectionsClosed.Add(1)
			sessionMu.Lock()
			done := gameCompleted
			sessionMu.Unlock()
			if !done {
				recordError("timeout")
				endSession("timeout")
			}
			return

		case <-sessionCtx.Done():
			conn.Close()
			globalMetrics.WSConnectionsClosed.Add(1)
			return
		}
	}
}

// ─── Gateway Observability & Health Polling ─────────────────────────────────

type gwHealthSnapshot struct {
	activeClients int
	streamsActive int
	controlDrops  uint64
	lossyDrops    uint64
	sendDrops     uint64
}

func runHealthProbe(ctx context.Context, cfg *Config, autoStopCh chan struct{}) {
	if len(cfg.HealthURLs) == 0 {
		return
	}

	startTime := time.Now()
	ticker := time.NewTicker(time.Duration(cfg.HealthPollSeconds) * time.Second)
	defer ticker.Stop()

	snapshots := make(map[string]gwHealthSnapshot)
	consecutiveZeroPolls := 0

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, u := range cfg.HealthURLs {
				resp, err := httpClient.Get(u)
				if err != nil {
					globalMetrics.GatewayHealthFailures.Add(1)
					continue
				}

				var health struct {
					ActiveClients     int `json:"active_clients"`
					GRPCStreamsActive int `json:"grpc_streams_active"`
					FanoutDropped     struct {
						Control int `json:"control"`
						Lossy   int `json:"lossy"`
					} `json:"fanout_dropped"`
					SendDropped struct {
						Stroke int `json:"stroke"`
						Fill   int `json:"fill"`
						Guess  int `json:"guess"`
					} `json:"send_dropped"`
				}

				body, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()

				if readErr == nil && json.Unmarshal(body, &health) == nil {
					snapshots[u] = gwHealthSnapshot{
						activeClients: health.ActiveClients,
						streamsActive: health.GRPCStreamsActive,
						controlDrops:  uint64(health.FanoutDropped.Control),
						lossyDrops:    uint64(health.FanoutDropped.Lossy),
						sendDrops:     uint64(health.SendDropped.Stroke + health.SendDropped.Fill + health.SendDropped.Guess),
					}
				} else {
					globalMetrics.GatewayHealthFailures.Add(1)
				}
			}

			// Aggregate across latest snapshots from all probed gateways
			var sumActiveClients uint64
			var sumStreamsActive uint64
			var maxStreamsPerGW uint64
			var sumControlDrops uint64
			var sumLossyDrops uint64
			var sumSendDrops uint64

			for _, s := range snapshots {
				sumActiveClients += uint64(s.activeClients)
				sumStreamsActive += uint64(s.streamsActive)
				if uint64(s.streamsActive) > maxStreamsPerGW {
					maxStreamsPerGW = uint64(s.streamsActive)
				}
				sumControlDrops += s.controlDrops
				sumLossyDrops += s.lossyDrops
				sumSendDrops += s.sendDrops
			}

			globalMetrics.GatewayActiveClients.Store(sumActiveClients)
			globalMetrics.GatewayStreamsActive.Store(sumStreamsActive)
			globalMetrics.GatewayMaxStreamsPerGW.Store(maxStreamsPerGW)
			globalMetrics.GatewayControlDrops.Store(sumControlDrops)
			globalMetrics.GatewayLossyDrops.Store(sumLossyDrops)
			globalMetrics.GatewaySendDrops.Store(sumSendDrops)

			elapsed := time.Since(startTime).Seconds()
			allZero := len(snapshots) > 0 && sumActiveClients == 0
			if elapsed >= float64(cfg.AutoStopMinElapsedS) && allZero {
				consecutiveZeroPolls++
				if consecutiveZeroPolls >= cfg.AutoStopConsecutiveZeros {
					fmt.Println("[GATEWAY_HEALTH] All gateways drained — auto-stopping test to print results.")
					select {
					case autoStopCh <- struct{}{}:
					default:
					}
					return
				}
			} else {
				consecutiveZeroPolls = 0
			}
		}
	}
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

func main() {
	cfg := loadConfig()

	totalRooms := int(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	fmt.Println("==========================================================")
	fmt.Printf(" Skribbl High-Performance Go Load Generator\n")
	fmt.Printf(" Target LBs: %s (Port %s)\n", strings.Join(cfg.Hosts, ","), cfg.Port)
	fmt.Printf(" VUs: %d (Offset: %d) | Players/Room: %d | Rooms: %d\n", cfg.VUs, cfg.VuOffset, cfg.PlayersPerRoom, totalRooms)
	fmt.Printf(" Game: %d rounds, %ds turns, hold=%ds | Stroke: %dHz\n", cfg.NumRounds, cfg.TurnDuration, cfg.HoldSeconds, cfg.StrokeHz)
	fmt.Println("==========================================================")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	autoStopCh := make(chan struct{}, 1)

	go func() {
		select {
		case <-sigCh:
			fmt.Println("\nReceived interrupt signal. Gracefully shutting down VUs...")
			cancel()
		case <-autoStopCh:
			cancel()
		}
	}()

	// Launch Gateway Health Observability scenario
	go runHealthProbe(ctx, cfg, autoStopCh)

	startTime := time.Now()
	var wg sync.WaitGroup

	// Status reporter
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				elapsed := time.Since(startTime).Truncate(time.Second)
				opened := globalMetrics.WSConnectionsOpened.Load()
				closed := globalMetrics.WSConnectionsClosed.Load()
				active := opened - closed
				msgsRecv := globalMetrics.MsgsReceived.Load()
				msgsSent := globalMetrics.MsgsSent.Load()
				completed := globalMetrics.GamesCompleted.Load()
				errors := globalMetrics.ErrorsConnect.Load() + globalMetrics.ErrorsRoom.Load() + globalMetrics.ErrorsTimeout.Load()

				latSnapshot := globalMetrics.MessageLatency.Snapshot()
				fmt.Printf("[%s] Active VUs: %d | Msgs R/S: %d/%d | Games Done: %d | Err: %d | p95 Lat: %.1fms\n",
					elapsed, active, msgsRecv, msgsSent, completed, errors, latSnapshot.P95)
			}
		}
	}()

	// Launch VUs
	for i := 1; i <= cfg.VUs; i++ {
		wg.Add(1)
		go runVU(ctx, cfg, i, &wg)
	}

	wg.Wait()
	duration := time.Since(startTime)

	printSummaryReport(cfg, duration)
}

// ─── Reporting & Acceptance ─────────────────────────────────────────────────

func passFailStr(b bool) string {
	if b {
		return "PASS"
	}
	return "FAIL"
}

func formatLatStr(t TrendStats) string {
	if t.Count == 0 {
		return "no data"
	}
	return fmt.Sprintf("%.1fms", t.P95)
}

func printSummaryReport(cfg *Config, duration time.Duration) {
	fmt.Println("\nLoad test complete.")
	fmt.Println("==========================================================")

	durSec := duration.Seconds()
	if durSec <= 0 {
		durSec = 1
	}

	dataRecv := globalMetrics.DataReceived.Load()
	dataSent := globalMetrics.DataSent.Load()
	msgsRecv := globalMetrics.MsgsReceived.Load()
	msgsSent := globalMetrics.MsgsSent.Load()

	opened := globalMetrics.WSConnectionsOpened.Load()
	closed := globalMetrics.WSConnectionsClosed.Load()

	// Definitive Per-Player Connection Success Rate
	playersAttempted := globalMetrics.PlayersAttempted.Load()
	playersConnected := globalMetrics.PlayersConnected.Load()
	connFailures := playersAttempted - playersConnected
	connSuccessRate := 100.0
	if playersAttempted > 0 {
		connSuccessRate = float64(playersConnected) / float64(playersAttempted) * 100.0
	}

	// True Host-Tracked Game Completion Rate (Evaluated against all planned rooms)
	totalPlannedRooms := uint64(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	gamesDone := globalMetrics.GamesCompleted.Load()
	gamesAborted := globalMetrics.GamesAborted.Load()
	unobservedRooms := uint64(0)
	if totalPlannedRooms > (gamesDone + gamesAborted) {
		unobservedRooms = totalPlannedRooms - (gamesDone + gamesAborted)
	}
	gameCompletionRate := 0.0
	if totalPlannedRooms > 0 {
		gameCompletionRate = float64(gamesDone) / float64(totalPlannedRooms) * 100.0
	}

	totalPlannedPlayers := uint64(cfg.VUs)
	sessDone := globalMetrics.SessionsCompleted.Load()
	sessAborted := globalMetrics.SessionsAborted.Load()
	unobservedSess := uint64(0)
	if totalPlannedPlayers > (sessDone + sessAborted) {
		unobservedSess = totalPlannedPlayers - (sessDone + sessAborted)
	}
	sessRate := 100.0
	if totalPlannedPlayers > 0 {
		sessRate = float64(sessDone) / float64(totalPlannedPlayers) * 100.0
	}

	totalErrors := globalMetrics.ErrorsConnect.Load() + globalMetrics.ErrorsRoom.Load() + globalMetrics.ErrorsProtocol.Load() + globalMetrics.ErrorsTimeout.Load()
	fmt.Printf("     data_received....................: %s   %s/s\n", formatBytes(dataRecv), formatBytes(uint64(float64(dataRecv)/durSec)))
	fmt.Printf("     data_sent........................: %s   %s/s\n", formatBytes(dataSent), formatBytes(uint64(float64(dataSent)/durSec)))
	fmt.Printf("     errors...........................: %d   %.6f/s\n", totalErrors, float64(totalErrors)/durSec)
	if errTimeout := globalMetrics.ErrorsTimeout.Load(); errTimeout > 0 {
		fmt.Printf("     errors_timeout...................: %d   %.6f/s\n", errTimeout, float64(errTimeout)/durSec)
	}
	if errConn := globalMetrics.ErrorsConnect.Load(); errConn > 0 {
		fmt.Printf("     errors_connect...................: %d   %.6f/s\n", errConn, float64(errConn)/durSec)
	}
	if errRoom := globalMetrics.ErrorsRoom.Load(); errRoom > 0 {
		fmt.Printf("     errors_room......................: %d   %.6f/s\n", errRoom, float64(errRoom)/durSec)
	}
	if errProto := globalMetrics.ErrorsProtocol.Load(); errProto > 0 {
		fmt.Printf("     errors_protocol..................: %d   %.6f/s\n", errProto, float64(errProto)/durSec)
	}

	fmt.Printf("   ✓ game_completion_rate.............: %.2f%%   ✓ %d   ✗ %d", gameCompletionRate, gamesDone, gamesAborted+unobservedRooms)
	if unobservedRooms > 0 {
		fmt.Printf(" (unobserved: %d / planned: %d)\n", unobservedRooms, totalPlannedRooms)
	} else {
		fmt.Printf("\n")
	}
	fmt.Printf("     game_start_requests..............: %d   %.6f/s\n", globalMetrics.GameStartRequests.Load(), float64(globalMetrics.GameStartRequests.Load())/durSec)
	fmt.Printf("     games_started....................: %d   %.6f/s\n", globalMetrics.GamesStarted.Load(), float64(globalMetrics.GamesStarted.Load())/durSec)
	fmt.Printf("     games_completed..................: %d   %.6f/s\n", gamesDone, float64(gamesDone)/durSec)
	fmt.Printf("     games_aborted....................: %d   %.6f/s\n", gamesAborted, float64(gamesAborted)/durSec)

	// Gateway Observability metrics
	fmt.Printf("     gateway_active_clients...........: %d\n", globalMetrics.GatewayActiveClients.Load())
	fmt.Printf("     gateway_grpc_streams_total.......: %d\n", globalMetrics.GatewayStreamsActive.Load())
	fmt.Printf("     gateway_fanout_control_drops.....: %d\n", globalMetrics.GatewayControlDrops.Load())
	fmt.Printf("     gateway_fanout_lossy_drops.......: %d\n", globalMetrics.GatewayLossyDrops.Load())
	fmt.Printf("     gateway_send_drops...............: %d\n", globalMetrics.GatewaySendDrops.Load())

	latSnap := globalMetrics.MessageLatency.Snapshot()
	printTrend("message_latency", latSnap, "ms")
	fmt.Printf("     messages_received................: %d   %.1f/s\n", msgsRecv, float64(msgsRecv)/durSec)
	fmt.Printf("     messages_sent....................: %d   %.1f/s\n", msgsSent, float64(msgsSent)/durSec)
	fmt.Printf("   ✓ player_session_completion_rate...: %.2f%%   ✓ %d   ✗ %d", sessRate, sessDone, sessAborted+unobservedSess)
	if unobservedSess > 0 {
		fmt.Printf(" (unobserved: %d / planned: %d)\n", unobservedSess, totalPlannedPlayers)
	} else {
		fmt.Printf("\n")
	}

	createSnap := globalMetrics.RoomCreateRTT.Snapshot()
	joinSnap := globalMetrics.RoomJoinRTT.Snapshot()
	printTrend("room_create_rtt", createSnap, "ms")
	printTrend("room_join_rtt", joinSnap, "ms")
	fmt.Printf("     rooms_created....................: %d   %.6f/s\n", globalMetrics.RoomsCreated.Load(), float64(globalMetrics.RoomsCreated.Load())/durSec)
	fmt.Printf("     rooms_joined.....................: %d   %.6f/s\n", globalMetrics.RoomsJoined.Load(), float64(globalMetrics.RoomsJoined.Load())/durSec)

	printTrend("ws_connection_duration", globalMetrics.SessionDuration.Snapshot(), "ms")
	fmt.Printf("   ✓ ws_connection_success............: %.2f%%   ✓ %d   ✗ %d\n", connSuccessRate, playersConnected, connFailures)
	fmt.Printf("     ws_connections_closed............: %d   %.1f/s\n", closed, float64(closed)/durSec)
	fmt.Printf("     ws_connections_opened............: %d   %.1f/s\n", opened, float64(opened)/durSec)
	printTrend("ws_open_rtt", globalMetrics.WSOpenRTT.Snapshot(), "ms")

	fmt.Println("\n════ THRESHOLDS (guardrails vs strict mode) ════")
	var targetConn, targetGame, targetSess float64
	if cfg.Strict {
		targetConn = 99.0
		targetGame = 80.0
		targetSess = 80.0
		fmt.Println("  [MODE: STRICT=1 (acceptance requirements enforced as hard thresholds)]")
	} else {
		targetConn = 95.0
		targetGame = 70.0
		targetSess = 70.0
		fmt.Println("  [MODE: STRICT=0 (looser engineering guardrails; run with STRICT=1 for hard requirements)]")
	}

	threshConn := connSuccessRate >= targetConn
	threshGame := gameCompletionRate >= targetGame
	threshSess := sessRate >= targetSess
	threshCreate := createSnap.Count == 0 || createSnap.P95 < 5000.0
	threshJoin := joinSnap.Count == 0 || joinSnap.P95 < 5000.0
	threshLat := latSnap.Count > 0 && latSnap.P95 <= 50.0

	fmt.Printf("  [%s] ws_connection_success: %.2f%% (threshold >=%.0f%%)\n", passFailStr(threshConn), connSuccessRate, targetConn)
	fmt.Printf("  [%s] game_completion_rate: %.2f%% (threshold >=%.0f%%)\n", passFailStr(threshGame), gameCompletionRate, targetGame)
	fmt.Printf("  [%s] player_session_completion_rate: %.2f%% (threshold >=%.0f%%)\n", passFailStr(threshSess), sessRate, targetSess)
	fmt.Printf("  [%s] room_create_rtt p95: %.1fms (threshold <5000ms)\n", passFailStr(threshCreate), createSnap.P95)
	fmt.Printf("  [%s] room_join_rtt p95: %.1fms (threshold <5000ms)\n", passFailStr(threshJoin), joinSnap.P95)
	fmt.Printf("  [%s] message_latency p95: %s (threshold <=50ms)\n", passFailStr(threshLat), formatLatStr(latSnap))

	fmt.Println("\n════ ACCEPTANCE (requirements, not guardrails) ════")
	req91Pass := connSuccessRate >= 99.0
	req92Pass := latSnap.Count > 0 && latSnap.P95 <= 50.0
	req93Pass := gameCompletionRate >= 80.0

	fmt.Printf("  [%s] 9.1 connection success: %.2f%% (target >=99%%)\n", passFailStr(req91Pass), connSuccessRate)
	fmt.Printf("  [%s] 9.2 message latency p95: %s (target <=50ms)\n", passFailStr(req92Pass), formatLatStr(latSnap))
	fmt.Printf("  [%s] 9.3 game completion: %.2f%% (target >=80%%)\n", passFailStr(req93Pass), gameCompletionRate)

	streamsTotal := globalMetrics.GatewayStreamsActive.Load()
	streamsMaxGW := globalMetrics.GatewayMaxStreamsPerGW.Load()
	req94Pass := true
	req95Pass := true
	if len(cfg.HealthURLs) > 0 && streamsTotal > 0 {
		req94Pass = streamsTotal < 1500
		req95Pass = streamsMaxGW < 200
		fmt.Printf("  [%s] 9.4 total gRPC streams: %d (target <1500)\n", passFailStr(req94Pass), streamsTotal)
		fmt.Printf("  [%s] 9.5 per-worker/gateway streams: %d (target <200)\n", passFailStr(req95Pass), streamsMaxGW)
	}

	allRequirementsPassed := req91Pass && req92Pass && req93Pass && req94Pass && req95Pass
	allThresholdsPassed := threshConn && threshGame && threshSess && threshCreate && threshJoin && threshLat

	overallPassed := allRequirementsPassed
	if cfg.Strict {
		overallPassed = overallPassed && allThresholdsPassed
	}

	if overallPassed {
		fmt.Println("  ── OVERALL ACCEPTANCE: PASS ──")
	} else {
		fmt.Println("  ── OVERALL ACCEPTANCE: FAIL ──")
	}
	if !cfg.Strict {
		fmt.Println("  (thresholds above are looser guardrails; run with STRICT=1 to enforce these as hard thresholds)")
	}
	fmt.Println("==========================================================")
}

func printTrend(name string, t TrendStats, unit string) {
	fmt.Printf("     %-32s: avg=%.2f%s min=%.1f%s med=%.1f%s max=%.1f%s p(90)=%.1f%s p(95)=%.1f%s\n",
		name, t.Avg, unit, t.Min, unit, t.Med, unit, t.Max, unit, t.P90, unit, t.P95, unit)
}

func formatBytes(b uint64) string {
	if b < 1024 {
		return fmt.Sprintf("%d B", b)
	}
	if b < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(b)/1024)
	}
	if b < 1024*1024*1024 {
		return fmt.Sprintf("%.1f MB", float64(b)/(1024*1024))
	}
	return fmt.Sprintf("%.2f GB", float64(b)/(1024*1024*1024))
}
