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
	VUs               int
	PlayersPerRoom    int
	StrokeHz          int
	StrokePoints      int
	RampSeconds       int
	HoldSeconds       int
	VuOffset          int
	Hosts             []string
	Port              string
	CoordHosts        []string
	CoordPort         string
	CoordViaLB        bool
	CoordURLs         []string
	HealthURLs        []string
	TurnDuration      int
	NumRounds         int
	ConnectTimeoutMs  int
	MinPlayersToStart int
	StartGraceMs      int
	LobbyTimeoutMs    int
	Strict            bool
}

func loadConfig() *Config {
	cfg := &Config{}

	// Defaults from Env or fallbacks
	vusEnv := getEnvInt("VUS", 100)
	playersEnv := getEnvInt("PLAYERS_PER_ROOM", 2)
	strokeHzEnv := getEnvInt("STROKE_HZ", 20)
	rampEnv := getEnvInt("RAMP_SECONDS", 0)
	holdEnv := getEnvInt("HOLD_SECONDS", 2400)
	offsetEnv := getEnvInt("VU_OFFSET", 0)

	// CLI flags
	flagVUs := flag.Int("vus", vusEnv, "Total virtual users")
	flagPlayers := flag.Int("players", playersEnv, "Players per room")
	flagHz := flag.Int("hz", strokeHzEnv, "Stroke frequency (Hz)")
	flagRamp := flag.Int("ramp", rampEnv, "Arrival ramp duration (seconds)")
	flagHold := flag.Int("hold", holdEnv, "Hold/game duration (seconds)")
	flagOffset := flag.Int("offset", offsetEnv, "VU index offset for multi-runner tests")
	flagStrict := flag.Bool("strict", os.Getenv("STRICT") == "1", "Enforce strict acceptance thresholds")

	flag.Parse()

	// Positional arguments override flags if supplied (matching run-test.sh: $1 $2 $3 $4 $5 $6)
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
	cfg.StrokePoints = getEnvInt("STROKE_POINTS", 4)
	cfg.TurnDuration = getEnvInt("TURN_DURATION", 30)
	cfg.NumRounds = getEnvInt("NUM_ROUNDS", 3)
	cfg.ConnectTimeoutMs = getEnvInt("CONNECT_TIMEOUT_MS", 60000)
	cfg.MinPlayersToStart = getEnvInt("MIN_PLAYERS_TO_START", 2)
	cfg.StartGraceMs = getEnvInt("START_GRACE_MS", 15000)

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
		cfg.Port = "80"
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
	}

	rawHealthURLs := os.Getenv("HEALTH_URLS")
	if rawHealthURLs != "" {
		for _, u := range strings.Split(rawHealthURLs, ",") {
			u = strings.TrimSpace(u)
			if u != "" {
				cfg.HealthURLs = append(cfg.HealthURLs, u)
			}
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
		Med:   sorted[n/2],
		P90:   sorted[int(float64(n)*0.90)],
		P95:   sorted[int(float64(n)*0.95)],
	}
}

type Metrics struct {
	DataReceived atomic.Uint64
	DataSent     atomic.Uint64

	MsgsReceived atomic.Uint64
	MsgsSent     atomic.Uint64

	WSConnectionsOpened  atomic.Uint64
	WSConnectionsClosed  atomic.Uint64
	WSConnectionFailures atomic.Uint64
	RedirectsFollowed    atomic.Uint64

	RoomsCreated     atomic.Uint64
	RoomsJoined      atomic.Uint64
	RoomCreateErrors atomic.Uint64
	RoomJoinErrors   atomic.Uint64
	CoordFailures    atomic.Uint64

	GameStartRequests atomic.Uint64
	GamesStarted      atomic.Uint64
	GamesCompleted    atomic.Uint64
	GamesAborted      atomic.Uint64

	SessionsCompleted atomic.Uint64
	SessionsAborted   atomic.Uint64

	ErrorsConnect  atomic.Uint64
	ErrorsRoom     atomic.Uint64
	ErrorsProtocol atomic.Uint64
	ErrorsGame     atomic.Uint64
	ErrorsTimeout  atomic.Uint64

	WSOpenRTT        TrendMetric
	MessageLatency   TrendMetric
	RoomCreateRTT    TrendMetric
	RoomJoinRTT      TrendMetric
	SessionDuration  TrendMetric
}

var globalMetrics = &Metrics{}

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
	if len(cfg.CoordURLs) > 0 {
		return fmt.Sprintf("http://%s/rooms", cfg.CoordURLs[roomIndex%len(cfg.CoordURLs)])
	}
	host := cfg.CoordHosts[roomIndex%len(cfg.CoordHosts)]
	return fmt.Sprintf("http://%s:%s/rooms", host, cfg.CoordPort)
}

func publishRoomCode(cfg *Config, roomIndex int, roomCode string) error {
	coordURL := fmt.Sprintf("%s/%d", getCoordURL(cfg, roomIndex), roomIndex)
	body, _ := json.Marshal(map[string]string{"room_code": roomCode})
	req, err := http.NewRequest("POST", coordURL, bytes.NewBuffer(body))
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
	coordURL := fmt.Sprintf("%s/%d", getCoordURL(cfg, roomIndex), roomIndex)
	for time.Since(start) < timeout {
		resp, err := httpClient.Get(coordURL)
		if err == nil && resp.StatusCode == 200 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var data struct {
				RoomCode string `json:"room_code"`
			}
			if err := json.Unmarshal(body, &data); err == nil && data.RoomCode != "" {
				return data.RoomCode
			}
		} else if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(time.Duration(1200+rand.Intn(800)) * time.Millisecond)
	}
	return ""
}

func buildWSURL(cfg *Config, vuID int, isHost bool, coordRoomCode string, redirectGW string) string {
	targetHost := cfg.Hosts[vuID%len(cfg.Hosts)]
	baseURL := fmt.Sprintf("ws://%s:%s/ws", targetHost, cfg.Port)
	params := url.Values{}

	if redirectGW != "" {
		params.Set("gw", redirectGW)
	} else if !isHost && coordRoomCode != "" {
		params.Set("room", coordRoomCode)
	} else {
		params.Set("cid", fmt.Sprintf("%d-%d", vuID, time.Now().UnixNano()))
	}

	return fmt.Sprintf("%s?%s", baseURL, params.Encode())
}

// ─── Binary Protocol Encoder ────────────────────────────────────────────────

type Point struct {
	X float64
	Y float64
}

func encodeBinaryStroke(points []Point, r, g, b, brushSize uint8) []byte {
	count := len(points)
	buf := make([]byte, 7+count*4)
	buf[0] = 0x01 // STROKE opcode
	buf[1] = r
	buf[2] = g
	buf[3] = b
	buf[4] = brushSize
	binary.BigEndian.PutUint16(buf[5:7], uint16(count))

	off := 7
	for _, pt := range points {
		x := uint16(math.Max(0, math.Min(65535, pt.X)))
		y := uint16(math.Max(0, math.Min(65535, pt.Y)))
		binary.BigEndian.PutUint16(buf[off:off+2], x)
		binary.BigEndian.PutUint16(buf[off+2:off+4], y)
		off += 4
	}
	return buf
}

var wordPacks = map[string][]string{
	"animals":    {"dog", "elephant", "whale", "zebra", "eagle", "kangaroo", "octopus", "penguin", "giraffe", "jellyfish", "owl", "dinosaur", "wolf", "butterfly", "lion", "parrot", "rabbit", "snake", "tiger", "dolphin", "frog", "horse", "koala", "spider", "turtle", "gorilla", "insect", "lobster", "ostrich", "peacock", "caterpillar", "flamingo", "grasshopper", "goldfish", "iguana", "dragonfly", "starfish", "bear", "camel", "cat", "cheetah", "chameleon", "chimpanzee", "crab", "crocodile", "deer", "duck", "fox", "hedgehog", "hippo", "mouse", "panda", "rhino", "seagull", "seal", "shark", "sheep", "sloth", "snail", "squirrel", "swan", "walrus", "badger", "hamster", "raccoon", "otter", "beaver", "skunk"},
	"food":       {"apple", "banana", "lemon", "mushroom", "orange", "grapes", "onion", "bread", "cherry", "olive", "pumpkin", "tomato", "waffle", "pretzel", "donut", "jellybean", "lollipop", "sandwich", "hamburger", "icecream", "avocado", "bacon", "bagel", "cake", "cheese", "chocolate", "cookie", "corn", "croissant", "cupcake", "egg", "hotdog", "noodles", "pancake", "peach", "peanut", "pear", "pie", "pineapple", "pizza", "popcorn", "potato", "salad", "sausage", "soup", "spaghetti", "steak", "strawberry", "sushi", "taco", "toast", "watermelon", "muffin", "honey", "butter", "carrot", "mango", "coconut", "dumpling", "broccoli"},
	"objects":    {"jacket", "kite", "lamp", "notebook", "piano", "umbrella", "violin", "xylophone", "diamond", "globe", "hammer", "quilt", "window", "anchor", "balloon", "candle", "envelope", "feather", "key", "ladder", "magnet", "necklace", "scissors", "telescope", "vase", "camera", "helmet", "compass", "jewel", "knot", "ring", "skull", "arrow", "clock", "drum", "flag", "heart", "ink", "jar", "mirror", "wheel", "needle", "suitcase", "zipper", "harp", "jigsaw", "kettle", "napkin", "trophy", "battery", "dominoes", "jukebox", "lantern", "microscope", "newspaper", "origami", "ukulele", "blanket", "crayon", "keyboard", "mailbox", "nutcracker", "paintbrush", "toothbrush", "wrench", "backpack", "chandelier", "earring", "glasses", "iron", "horseshoe", "uniform", "lanyard", "book", "bottle", "bucket", "chair", "couch", "cup", "dice", "fork", "headphones", "knife", "lock", "mug", "pencil", "pillow", "plate", "radio", "rope", "soap", "spoon", "table", "towel", "watch"},
	"nature":     {"flower", "mountain", "ocean", "rainbow", "sun", "tree", "forest", "moon", "nest", "snowflake", "tornado", "volcano", "waterfall", "iceberg", "leaf", "rose", "cactus", "acorn", "icicle", "quicksand", "earth", "garden", "blizzard", "cave", "cliff", "cloud", "comet", "desert", "eclipse", "fire", "galaxy", "island", "jungle", "lightning", "meteor", "puddle", "rain", "river", "rock", "smoke", "star", "storm", "sunrise", "sunset", "thunder", "valley", "wave", "wind"},
	"places":     {"house", "bridge", "castle", "igloo", "lighthouse", "village", "throne", "beach", "fountain", "maze", "windmill", "elevator", "escalator", "fireplace", "airport", "aquarium", "bakery", "bank", "barn", "cabin", "church", "circus", "cottage", "factory", "farm", "fort", "gym", "hospital", "hotel", "library", "mall", "market", "museum", "palace", "park", "playground", "prison", "pyramid", "school", "skyscraper", "stadium", "station", "supermarket", "temple", "theater", "tower", "zoo"},
	"vehicles":   {"car", "yacht", "airplane", "rocket", "helicopter", "parachute", "surfboard", "engine", "kayak", "hammock", "trampoline", "football", "volleyball", "ambulance", "bicycle", "blimp", "boat", "bulldozer", "bus", "canoe", "carriage", "ferry", "firetruck", "forklift", "hoverboard", "jetski", "limousine", "motorcycle", "raft", "scooter", "skateboard", "sled", "snowboard", "spaceship", "submarine", "tank", "taxi", "tractor", "train", "truck", "van"},
	"fantasy":    {"queen", "unicorn", "dragon", "robot", "wizard", "firework", "ghost", "treasure", "vampire", "king", "angel", "mermaid", "witch", "emerald", "radar", "satellite", "alien", "cauldron", "crystal", "cyborg", "demon", "dungeon", "elf", "fairy", "flying carpet", "genie", "giant", "goblin", "laser", "magic wand", "monster", "mummy", "pegasus", "phoenix", "portal", "potion", "shield", "spellbook", "sword", "time machine", "zombie"},
	"characters": {"ninja", "pirate", "nurse", "judge", "astronaut", "dentist", "scarecrow", "actor", "artist", "athlete", "baby", "baker", "barber", "builder", "captain", "carpenter", "chef", "clown", "detective", "diver", "doctor", "farmer", "firefighter", "guard", "hunter", "knight", "lifeguard", "magician", "mailman", "mechanic", "musician", "painter", "pilot", "police", "prince", "princess", "sailor", "scientist", "singer", "soldier", "spy", "superhero"},
}

var allWordsList = func() []string {
	var res []string
	for _, ws := range wordPacks {
		res = append(res, ws...)
	}
	return res
}()

// ─── Virtual User (VU) Execution ────────────────────────────────────────────

func runVU(ctx context.Context, cfg *Config, localVUID int, wg *sync.WaitGroup) {
	defer wg.Done()

	vuID := localVUID + cfg.VuOffset
	roomIndex := (vuID - 1) / cfg.PlayersPerRoom
	isHost := ((vuID - 1) % cfg.PlayersPerRoom) == 0
	playerName := fmt.Sprintf("k%s", strconv.FormatInt(int64(vuID), 36))

	// Arrival ramp staggered by room
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
			globalMetrics.ErrorsRoom.Add(1)
			globalMetrics.SessionsAborted.Add(1)
			return
		}
	}

	sessionStart := time.Now()
	var redirectGW string
	var conn *websocket.Conn
	var roomCode = coordRoomCode
	var playerID string

	dialer := websocket.Dialer{
		HandshakeTimeout: time.Duration(cfg.ConnectTimeoutMs) * time.Millisecond,
		ReadBufferSize:   2048,
		WriteBufferSize:  2048,
	}

	// Reconnect loop (for sticky redirect)
	connected := false
	for attempt := 0; attempt < 3; attempt++ {
		wsURL := buildWSURL(cfg, vuID, isHost, coordRoomCode, redirectGW)
		openStart := time.Now()
		c, _, err := dialer.Dial(wsURL, nil)
		if err != nil {
			if attempt == 0 {
				globalMetrics.WSConnectionFailures.Add(1)
				globalMetrics.ErrorsConnect.Add(1)
			}
			time.Sleep(500 * time.Millisecond)
			continue
		}

		globalMetrics.WSConnectionsOpened.Add(1)
		globalMetrics.WSOpenRTT.Add(float64(time.Since(openStart).Milliseconds()))
		conn = c
		connected = true
		break
	}

	if !connected {
		globalMetrics.SessionsAborted.Add(1)
		return
	}
	defer func() {
		conn.Close()
		globalMetrics.WSConnectionsClosed.Add(1)
		globalMetrics.SessionDuration.Add(float64(time.Since(sessionStart).Milliseconds()))
	}()

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
		return conn.WriteMessage(websocket.TextMessage, b)
	}

	sendBinary := func(data []byte) error {
		globalMetrics.DataSent.Add(uint64(len(data)))
		globalMetrics.MsgsSent.Add(1)
		return conn.WriteMessage(websocket.BinaryMessage, data)
	}

	// Identify: send create_room or join_room
	createJoinStart := time.Now()
	if isHost {
		_ = sendJSON("create_room", map[string]string{
			"name":   playerName,
			"avatar": "bear",
		})
	} else {
		_ = sendJSON("join_room", map[string]string{
			"name":      playerName,
			"room_code": coordRoomCode,
			"avatar":    "bear",
		})
	}

	var isDrawer atomic.Bool
	var turnActive atomic.Bool
	var gameStarted atomic.Bool
	var gameCompleted atomic.Bool
	var pendingReadyAt time.Time
	var pendingReadyMu sync.Mutex

	// Stroke loop ticker
	strokeStopCh := make(chan struct{})
	guessStopCh := make(chan struct{})

	startDrawing := func() {
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
				case <-strokeStopCh:
					return
				case <-ctx.Done():
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

	startGuessing := func(themeID string, wordLen int) {
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

		ticker := time.NewTicker(time.Duration(2000+rand.Intn(2000)) * time.Millisecond)
		go func() {
			defer ticker.Stop()
			idx := rand.Intn(len(candidatePool))
			for {
				select {
				case <-guessStopCh:
					return
				case <-ctx.Done():
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

	// Incoming message read loop
	holdTimeout := time.After(time.Duration(cfg.HoldSeconds) * time.Second)

	var processFrame func(frameData []byte)

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
				continue // Binary drawing frames
			}

			// Handle JSON frames (including batches)
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

	processFrame = func(frameData []byte) {
		var f struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(frameData, &f); err != nil {
			return
		}

		switch f.Type {
		case "room_created":
			var p struct {
				RoomCode string `json:"room_code"`
				PlayerID string `json:"player_id"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			roomCode = p.RoomCode
			playerID = p.PlayerID
			globalMetrics.RoomsCreated.Add(1)
			globalMetrics.RoomCreateRTT.Add(float64(time.Since(createJoinStart).Milliseconds()))
			_ = publishRoomCode(cfg, roomIndex, roomCode)

			// Send ready
			pendingReadyMu.Lock()
			pendingReadyAt = time.Now()
			pendingReadyMu.Unlock()
			_ = sendJSON("toggle_ready", map[string]any{})

		case "room_joined":
			var p struct {
				PlayerID string `json:"player_id"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			playerID = p.PlayerID
			globalMetrics.RoomsJoined.Add(1)
			globalMetrics.RoomJoinRTT.Add(float64(time.Since(createJoinStart).Milliseconds()))

			// Send ready
			pendingReadyMu.Lock()
			pendingReadyAt = time.Now()
			pendingReadyMu.Unlock()
			_ = sendJSON("toggle_ready", map[string]any{})

		case "redirect":
			globalMetrics.RedirectsFollowed.Add(1)

		case "player_list":
			pendingReadyMu.Lock()
			if !pendingReadyAt.IsZero() {
				lat := float64(time.Since(pendingReadyAt).Milliseconds())
				globalMetrics.MessageLatency.Add(lat)
				pendingReadyAt = time.Time{}
			}
			pendingReadyMu.Unlock()

			if isHost && !gameStarted.Load() {
				var p struct {
					Players []struct {
						ID      string `json:"id"`
						IsReady bool   `json:"isReady"`
					} `json:"players"`
				}
				_ = json.Unmarshal(f.Payload, &p)
				if len(p.Players) >= cfg.MinPlayersToStart {
					gameStarted.Store(true)
					globalMetrics.GameStartRequests.Add(1)
					time.AfterFunc(time.Duration(cfg.StartGraceMs)*time.Millisecond, func() {
						_ = sendJSON("start_game", map[string]any{})
					})
				}
			}

		case "game_started":
			globalMetrics.GamesStarted.Add(1)

		case "drawer_selecting":
			turnActive.Store(false)
			var p struct {
				DrawerID string `json:"drawer_id"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			isDrawer.Store(p.DrawerID == playerID)

		case "word_choices":
			isDrawer.Store(true)
			turnActive.Store(false)
			var p struct {
				Choices []string `json:"choices"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			if len(p.Choices) > 0 {
				chosen := p.Choices[rand.Intn(len(p.Choices))]
				time.AfterFunc(time.Duration(1000+rand.Intn(1500))*time.Millisecond, func() {
					_ = sendJSON("select_word", map[string]string{"word": chosen})
				})
			}

		case "word_selection":
			var p struct {
				DrawerID string `json:"drawer_id"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			isDrawer.Store(p.DrawerID == playerID)

		case "turn_started":
			var p struct {
				DrawerID string   `json:"drawer_id"`
				Hint     []string `json:"hint"`
				Theme    struct {
					ID string `json:"id"`
				} `json:"theme"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			turnActive.Store(true)
			if p.DrawerID == playerID {
				isDrawer.Store(true)
				startDrawing()
			} else {
				isDrawer.Store(false)
				startGuessing(p.Theme.ID, len(p.Hint))
			}

		case "turn_ended":
			turnActive.Store(false)

		case "game_over":
			turnActive.Store(false)
			isDrawer.Store(false)
			gameCompleted.Store(true)
			if isHost {
				globalMetrics.GamesCompleted.Add(1)
			}
			globalMetrics.SessionsCompleted.Add(1)
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"))
			conn.Close()

		case "game_ended_insufficient_players":
			turnActive.Store(false)
			isDrawer.Store(false)
			if isHost && !gameCompleted.Load() {
				globalMetrics.GamesAborted.Add(1)
			}
			globalMetrics.SessionsAborted.Add(1)
			globalMetrics.ErrorsGame.Add(1)
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "aborted"))
			conn.Close()
		}
	}

	select {
	case <-readDone:
	case <-holdTimeout:
		globalMetrics.ErrorsTimeout.Add(1)
		globalMetrics.SessionsAborted.Add(1)
		if isHost && !gameCompleted.Load() {
			globalMetrics.GamesAborted.Add(1)
		}
	case <-ctx.Done():
	}
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

func main() {
	cfg := loadConfig()

	fmt.Println("==========================================================")
	fmt.Printf(" Skribbl High-Performance Go Load Generator\n")
	fmt.Printf(" Target LBs: %s (Port %s)\n", strings.Join(cfg.Hosts, ","), cfg.Port)
	fmt.Printf(" VUs: %d (Offset: %d) | Players/Room: %d | Stroke: %dHz | Ramp: %ds | Hold: %ds\n",
		cfg.VUs, cfg.VuOffset, cfg.PlayersPerRoom, cfg.StrokeHz, cfg.RampSeconds, cfg.HoldSeconds)
	fmt.Println("==========================================================")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\nReceived interrupt signal. Gracefully shutting down VUs...")
		cancel()
	}()

	startTime := time.Now()
	var wg sync.WaitGroup

	// Periodic status reporter ticker
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

// ─── Reporting ──────────────────────────────────────────────────────────────

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
	failures := globalMetrics.WSConnectionFailures.Load()
	totalAttempts := opened + failures
	connSuccessRate := 100.0
	if totalAttempts > 0 {
		connSuccessRate = float64(opened) / float64(totalAttempts) * 100.0
	}

	totalRooms := uint64(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	gamesDone := globalMetrics.GamesCompleted.Load()
	gameCompletionRate := 0.0
	if totalRooms > 0 {
		gameCompletionRate = float64(gamesDone) / float64(totalRooms) * 100.0
	}

	sessDone := globalMetrics.SessionsCompleted.Load()
	sessAborted := globalMetrics.SessionsAborted.Load()
	sessTotal := sessDone + sessAborted
	sessRate := 100.0
	if sessTotal > 0 {
		sessRate = float64(sessDone) / float64(sessTotal) * 100.0
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

	fmt.Printf("   ✓ game_completion_rate.............: %.2f%%   ✓ %d   ✗ %d\n", gameCompletionRate, gamesDone, totalRooms-gamesDone)
	fmt.Printf("     game_start_requests..............: %d   %.6f/s\n", globalMetrics.GameStartRequests.Load(), float64(globalMetrics.GameStartRequests.Load())/durSec)
	fmt.Printf("     games_started....................: %d   %.6f/s\n", globalMetrics.GamesStarted.Load(), float64(globalMetrics.GamesStarted.Load())/durSec)
	fmt.Printf("     games_completed..................: %d   %.6f/s\n", gamesDone, float64(gamesDone)/durSec)
	fmt.Printf("     games_aborted....................: %d   %.6f/s\n", globalMetrics.GamesAborted.Load(), float64(globalMetrics.GamesAborted.Load())/durSec)

	printTrend("message_latency", globalMetrics.MessageLatency.Snapshot(), "ms")
	fmt.Printf("     messages_received................: %d   %.1f/s\n", msgsRecv, float64(msgsRecv)/durSec)
	fmt.Printf("     messages_sent....................: %d   %.1f/s\n", msgsSent, float64(msgsSent)/durSec)
	fmt.Printf("   ✓ player_session_completion_rate...: %.2f%%   ✓ %d   ✗ %d\n", sessRate, sessDone, sessAborted)

	printTrend("room_create_rtt", globalMetrics.RoomCreateRTT.Snapshot(), "ms")
	printTrend("room_join_rtt", globalMetrics.RoomJoinRTT.Snapshot(), "ms")
	fmt.Printf("     rooms_created....................: %d   %.6f/s\n", globalMetrics.RoomsCreated.Load(), float64(globalMetrics.RoomsCreated.Load())/durSec)
	fmt.Printf("     rooms_joined.....................: %d   %.6f/s\n", globalMetrics.RoomsJoined.Load(), float64(globalMetrics.RoomsJoined.Load())/durSec)

	printTrend("ws_connection_duration", globalMetrics.SessionDuration.Snapshot(), "ms")
	fmt.Printf("   ✓ ws_connection_success............: %.2f%%   ✓ %d   ✗ %d\n", connSuccessRate, opened, failures)
	fmt.Printf("     ws_connections_closed............: %d   %.1f/s\n", globalMetrics.WSConnectionsClosed.Load(), float64(globalMetrics.WSConnectionsClosed.Load())/durSec)
	fmt.Printf("     ws_connections_opened............: %d   %.1f/s\n", opened, float64(opened)/durSec)
	printTrend("ws_open_rtt", globalMetrics.WSOpenRTT.Snapshot(), "ms")

	fmt.Println("\n════ ACCEPTANCE (requirements, not guardrails) ════")

	passConn := connSuccessRate >= 99.0
	statusConn := "[FAIL]"
	if passConn {
		statusConn = "[PASS]"
	}
	fmt.Printf("  %s 9.1 connection success: %.2f%% (target >=99%%)\n", statusConn, connSuccessRate)

	latSnap := globalMetrics.MessageLatency.Snapshot()
	passLat := latSnap.P95 <= 50.0 || latSnap.Count == 0
	statusLat := "[FAIL]"
	if passLat {
		statusLat = "[PASS]"
	}
	fmt.Printf("  %s 9.2 message latency p95: %.1fms (target <=50ms)\n", statusLat, latSnap.P95)

	passGame := gameCompletionRate >= 80.0
	statusGame := "[FAIL]"
	if passGame {
		statusGame = "[PASS]"
	}
	fmt.Printf("  %s 9.3 game completion: %.2f%% (target >=80%%)\n", statusGame, gameCompletionRate)

	allPassed := passConn && passLat && passGame
	if allPassed {
		fmt.Println("  ── OVERALL ACCEPTANCE: PASS ──")
	} else {
		fmt.Println("  ── OVERALL ACCEPTANCE: FAIL ──")
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
