// Skribbl Go load generator — behavioural port of scripts/k6_grpc_load_test.js
//
// Run (env vars mirror the k6 script; flags override env):
//
//	HOSTS=10.0.0.5 PORT=9000 go run . -vus 100 -players 5 -hz 5 -ramp 30
//	HOSTS=lb1,lb2 HEALTH_URLS=http://gw1:9000/health,http://gw2:9000/health STRICT=1 ./loadgen -vus 15000 -players 5 -hz 20 -ramp 90
//
// Positional args (optional, legacy): vus players hz ramp hold offset
//
// Parity-related knobs (defaults chosen to match the k6 script):
//
//	STROKE_FORMAT=binary|json     wire format for strokes (k6 likely used json; see notes)
//	HTTP_TIMEOUT_SECONDS=60       coord HTTP timeout (k6 default is 60s)
//	COORD_PUBLISH_ATTEMPTS=1      publish attempts (k6 does one, no retry)
//
// Exit codes: 0 = acceptance PASS, 1 = acceptance FAIL, 2 = invalid configuration.
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
	VUs                      int
	PlayersPerRoom           int
	StrokeHz                 int
	StrokePoints             int
	StrokeFormat             string // "binary" | "json"
	RampSeconds              int
	HoldSeconds              int
	VuOffset                 int
	Hosts                    []string
	Port                     string
	CoordHosts               []string
	CoordPort                string
	CoordViaLB               bool
	CoordURLs                []string
	HealthURLs               []string
	TurnDuration             int
	NumRounds                int
	PerTurnSlack             int
	HoldFixedBuffer          int
	ConnectTimeoutMs         int
	MinPlayersToStart        int
	StartGraceMs             int
	LobbyTimeoutMs           int
	Strict                   bool
	HealthPollSeconds        int
	AutoStopConsecutiveZeros int
	AutoStopMinElapsedS      int
	HTTPTimeoutSeconds       int
	PublishAttempts          int
	TargetStreamsTotal       int
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

func getEnvStr(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func parseList(raw string) []string {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func loadConfig() *Config {
	cfg := &Config{}

	vusEnv := getEnvInt("VUS", 100)
	playersEnv := getEnvInt("PLAYERS_PER_ROOM", 2)
	strokeHzEnv := getEnvInt("STROKE_HZ", 30)
	rampEnv := getEnvInt("RAMP_SECONDS", 0)
	offsetEnv := getEnvInt("VU_OFFSET", 0)

	cfg.StrokePoints = getEnvInt("STROKE_POINTS", 4)
	cfg.StrokeFormat = strings.ToLower(getEnvStr("STROKE_FORMAT", "binary"))
	cfg.TurnDuration = getEnvInt("TURN_DURATION", 80)
	cfg.NumRounds = getEnvInt("NUM_ROUNDS", 3)
	cfg.PerTurnSlack = getEnvInt("PER_TURN_SLACK", 70)
	cfg.HoldFixedBuffer = getEnvInt("HOLD_FIXED_BUFFER", 300)
	cfg.ConnectTimeoutMs = getEnvInt("CONNECT_TIMEOUT_MS", 60000)
	cfg.MinPlayersToStart = getEnvInt("MIN_PLAYERS_TO_START", 2)
	cfg.StartGraceMs = getEnvInt("START_GRACE_MS", 15000)
	cfg.HealthPollSeconds = getEnvInt("HEALTH_POLL_SECONDS", 15)
	cfg.AutoStopConsecutiveZeros = getEnvInt("AUTO_STOP_ZEROS", 2)
	cfg.AutoStopMinElapsedS = getEnvInt("AUTO_STOP_MIN_S", 300)
	cfg.HTTPTimeoutSeconds = getEnvInt("HTTP_TIMEOUT_SECONDS", 60)
	cfg.PublishAttempts = getEnvInt("COORD_PUBLISH_ATTEMPTS", 1)

	holdExplicit := false
	holdEnv := 0
	if hStr := os.Getenv("HOLD_SECONDS"); hStr != "" {
		if hVal, err := strconv.Atoi(hStr); err == nil {
			holdEnv = hVal
			holdExplicit = true
		}
	}

	flagVUs := flag.Int("vus", vusEnv, "Total virtual users")
	flagPlayers := flag.Int("players", playersEnv, "Players per room")
	flagHz := flag.Int("hz", strokeHzEnv, "Stroke frequency (Hz); 0 = slow JSON strokes (k6 parity)")
	flagRamp := flag.Int("ramp", rampEnv, "Arrival ramp duration (seconds)")
	flagHold := flag.Int("hold", 0, "Hold/game duration (seconds)")
	flagOffset := flag.Int("offset", offsetEnv, "VU index offset for multi-runner tests")
	flagStrict := flag.Bool("strict", os.Getenv("STRICT") == "1", "Enforce strict acceptance thresholds")
	flagFmt := flag.String("stroke-format", cfg.StrokeFormat, "Stroke wire format: binary | json")
	flagStreamsTarget := flag.Int("streams-target", 0, "Acceptance target for peak total gRPC streams (default auto-scaled)")

	flag.Parse()

	holdArgPassed := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "hold" {
			holdArgPassed = true
		}
	})

	args := flag.Args()
	argInt := func(i int, dst *int) {
		if len(args) > i {
			if v, err := strconv.Atoi(args[i]); err == nil {
				*dst = v
			}
		}
	}
	argInt(0, flagVUs)
	argInt(1, flagPlayers)
	argInt(2, flagHz)
	argInt(3, flagRamp)
	if len(args) > 4 {
		if v, err := strconv.Atoi(args[4]); err == nil {
			*flagHold = v
			holdArgPassed = true
		}
	}
	argInt(5, flagOffset)

	cfg.VUs = *flagVUs
	cfg.PlayersPerRoom = *flagPlayers
	cfg.StrokeHz = *flagHz
	cfg.RampSeconds = *flagRamp
	cfg.VuOffset = *flagOffset
	cfg.Strict = *flagStrict
	cfg.StrokeFormat = strings.ToLower(*flagFmt)

	// Hold default is computed from the RESOLVED players-per-room.
	if holdArgPassed && *flagHold > 0 {
		cfg.HoldSeconds = *flagHold
	} else if holdExplicit && holdEnv > 0 {
		cfg.HoldSeconds = holdEnv
	} else {
		cfg.HoldSeconds = cfg.NumRounds*cfg.PlayersPerRoom*(cfg.TurnDuration+cfg.PerTurnSlack) + cfg.HoldFixedBuffer
	}

	defaultLobbyTimeout := 240000
	if (cfg.RampSeconds+60)*1000 > defaultLobbyTimeout {
		defaultLobbyTimeout = (cfg.RampSeconds + 60) * 1000
	}
	cfg.LobbyTimeoutMs = getEnvInt("LOBBY_TIMEOUT_MS", defaultLobbyTimeout)

	// Hosts & network
	rawHosts := os.Getenv("HOSTS")
	if rawHosts == "" {
		rawHosts = os.Getenv("HOST")
	}
	if rawHosts == "" {
		rawHosts = "localhost"
	}
	cfg.Hosts = parseList(rawHosts)
	cfg.Port = getEnvStr("PORT", "9000")

	rawCoordHosts := os.Getenv("COORD_HOSTS")
	if rawCoordHosts == "" {
		rawCoordHosts = os.Getenv("COORD_HOST")
	}
	cfg.CoordHosts = parseList(rawCoordHosts)
	if len(cfg.CoordHosts) == 0 && len(cfg.Hosts) > 0 {
		cfg.CoordHosts = []string{cfg.Hosts[0]}
	}

	cfg.CoordPort = getEnvStr("COORD_PORT", "9100")
	effectiveCoordPort := cfg.CoordPort
	if effectiveCoordPort == "0" { // k6 parity: COORD_PORT=0 means "use PORT"
		effectiveCoordPort = cfg.Port
	}
	cfg.CoordViaLB = os.Getenv("COORD_VIA_LB") != "0"

	if raw := os.Getenv("COORD_URLS"); raw != "" {
		cfg.CoordURLs = parseList(raw)
	} else {
		for _, h := range cfg.CoordHosts {
			cfg.CoordURLs = append(cfg.CoordURLs, fmt.Sprintf("%s:%s", h, effectiveCoordPort))
		}
	}

	if raw := os.Getenv("HEALTH_URLS"); raw != "" {
		cfg.HealthURLs = parseList(raw)
	} else {
		for _, h := range cfg.Hosts {
			cfg.HealthURLs = append(cfg.HealthURLs, fmt.Sprintf("http://%s:%s/health", h, cfg.Port))
		}
	}

	defaultStreamsTarget := 1500
	if len(cfg.HealthURLs) > 0 {
		probedTarget := len(cfg.HealthURLs) * 150
		if probedTarget > defaultStreamsTarget {
			defaultStreamsTarget = probedTarget
		}
	}
	cfg.TargetStreamsTotal = getEnvInt("TARGET_STREAMS_TOTAL", defaultStreamsTarget)
	if *flagStreamsTarget > 0 {
		cfg.TargetStreamsTotal = *flagStreamsTarget
	}

	return cfg
}

// validate fails fast instead of silently coercing bad values.
func (c *Config) validate() []string {
	var errs []string
	bad := func(format string, a ...any) { errs = append(errs, fmt.Sprintf(format, a...)) }

	if c.VUs <= 0 {
		bad("VUS must be > 0 (got %d)", c.VUs)
	}
	if c.PlayersPerRoom <= 0 {
		bad("PLAYERS_PER_ROOM must be > 0 (got %d)", c.PlayersPerRoom)
	}
	if c.StrokeHz < 0 || c.StrokeHz > 1000 {
		bad("STROKE_HZ must be in [0,1000] (got %d)", c.StrokeHz)
	}
	if c.StrokePoints < 1 {
		bad("STROKE_POINTS must be >= 1 (got %d)", c.StrokePoints)
	}
	if c.StrokeFormat != "binary" && c.StrokeFormat != "json" {
		bad("STROKE_FORMAT must be 'binary' or 'json' (got %q)", c.StrokeFormat)
	}
	if c.NumRounds < 1 {
		bad("NUM_ROUNDS must be >= 1 (got %d)", c.NumRounds)
	}
	if c.TurnDuration < 1 {
		bad("TURN_DURATION must be >= 1 (got %d)", c.TurnDuration)
	}
	if c.HoldSeconds < 1 {
		bad("HOLD_SECONDS must be >= 1 (got %d)", c.HoldSeconds)
	}
	if c.RampSeconds < 0 {
		bad("RAMP_SECONDS must be >= 0 (got %d)", c.RampSeconds)
	}
	if c.VuOffset < 0 {
		bad("VU_OFFSET must be >= 0 (got %d)", c.VuOffset)
	}
	if c.MinPlayersToStart < 1 {
		bad("MIN_PLAYERS_TO_START must be >= 1 (got %d)", c.MinPlayersToStart)
	}
	if c.PlayersPerRoom > 0 && c.MinPlayersToStart > c.PlayersPerRoom {
		bad("MIN_PLAYERS_TO_START (%d) exceeds PLAYERS_PER_ROOM (%d): games could never start", c.MinPlayersToStart, c.PlayersPerRoom)
	}
	if c.ConnectTimeoutMs < 1 || c.LobbyTimeoutMs < 1 || c.StartGraceMs < 0 {
		bad("CONNECT_TIMEOUT_MS/LOBBY_TIMEOUT_MS must be > 0 and START_GRACE_MS >= 0")
	}
	if len(c.Hosts) == 0 {
		bad("HOSTS/HOST resolved to an empty list")
	}
	if !c.CoordViaLB && len(c.CoordURLs) == 0 {
		bad("COORD_VIA_LB=0 requires COORD_URLS or COORD_HOSTS")
	}
	if c.HealthPollSeconds < 1 {
		bad("HEALTH_POLL_SECONDS must be >= 1 (got %d)", c.HealthPollSeconds)
	}
	if c.HTTPTimeoutSeconds < 1 {
		bad("HTTP_TIMEOUT_SECONDS must be >= 1 (got %d)", c.HTTPTimeoutSeconds)
	}
	if c.PublishAttempts < 1 {
		bad("COORD_PUBLISH_ATTEMPTS must be >= 1 (got %d)", c.PublishAttempts)
	}
	return errs
}

// ─── Per-VU RNG (own seed, no global lock, no determinism across runners) ────

type lockedRand struct {
	mu sync.Mutex
	r  *rand.Rand
}

func newLockedRand(vuID int) *lockedRand {
	seed := int64(uint64(time.Now().UnixNano()) ^ (uint64(vuID) * 0x9E3779B97F4A7C15) ^ (uint64(os.Getpid()) << 32))
	return &lockedRand{r: rand.New(rand.NewSource(seed))}
}

func (l *lockedRand) Intn(n int) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.r.Intn(n)
}

func (l *lockedRand) Int63() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.r.Int63()
}

// Between returns a float in [min,max).
func (l *lockedRand) Between(min, max float64) float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return min + l.r.Float64()*(max-min)
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
	n := len(t.samples)
	if n == 0 {
		t.mu.Unlock()
		return TrendStats{}
	}
	sorted := make([]float64, n)
	copy(sorted, t.samples)
	t.mu.Unlock()

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

type AtomicUint64 struct{ val uint64 }

func (a *AtomicUint64) Add(delta uint64) uint64 { return atomic.AddUint64(&a.val, delta) }
func (a *AtomicUint64) Load() uint64            { return atomic.LoadUint64(&a.val) }
func (a *AtomicUint64) Store(val uint64)        { atomic.StoreUint64(&a.val, val) }

type AtomicBool struct{ val uint32 }

func (a *AtomicBool) Load() bool { return atomic.LoadUint32(&a.val) != 0 }
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

	// Messages: received is counted per INNER message (batches unpacked, binary
	// drawing ops counted) to match the k6 script.
	MsgsReceived AtomicUint64
	MsgsSent     AtomicUint64

	WSConnectionsOpened  AtomicUint64
	WSConnectionsClosed  AtomicUint64
	WSConnectionFailures AtomicUint64
	RedirectsFollowed    AtomicUint64

	PlayersPlanned   AtomicUint64 // every VU that started (incl. coordinator failures)
	PlayersAttempted AtomicUint64 // VUs that reached the first WebSocket dial (k6 parity)
	PlayersConnected AtomicUint64

	RoomsCreated              AtomicUint64
	RoomsJoined               AtomicUint64
	RoomCreateErrors          AtomicUint64
	RoomJoinErrors            AtomicUint64
	RoomCodeDiscoveryFailures AtomicUint64
	CoordPublishFailures      AtomicUint64

	ServerErrors       AtomicUint64
	ServerCreateErrors AtomicUint64
	ServerJoinErrors   AtomicUint64

	GameStartRequests AtomicUint64
	GamesStarted      AtomicUint64
	GamesCompleted    AtomicUint64
	GamesAborted      AtomicUint64

	SessionsCompleted AtomicUint64
	SessionsAborted   AtomicUint64

	ErrorsConnect  AtomicUint64
	ErrorsRoom     AtomicUint64
	ErrorsProtocol AtomicUint64
	ErrorsGame     AtomicUint64
	ErrorsTimeout  AtomicUint64

	GatewayHealthFailures    AtomicUint64
	GatewayHealthPollsDone   AtomicUint64 // complete polls (every URL answered validly)
	GatewayHealthPartialPoll AtomicUint64
	GatewayControlDrops      AtomicUint64
	GatewayLossyDrops        AtomicUint64
	GatewaySendDrops         AtomicUint64
	GatewayActiveClients     AtomicUint64
	GatewayStreamsActive     AtomicUint64
	GatewayPeakActiveClients AtomicUint64
	GatewayPeakStreamsTotal  AtomicUint64
	GatewayPeakStreamsPerGW  AtomicUint64

	WSOpenRTT            TrendMetric
	MessageLatency       TrendMetric // toggle_ready -> next player_list (approximation)
	RoomCreateRTT        TrendMetric
	RoomJoinRTT          TrendMetric
	WSConnectionDuration TrendMetric // per socket
	SessionDuration      TrendMetric // per VU lifetime
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

func totalErrors() uint64 {
	m := globalMetrics
	return m.ErrorsConnect.Load() + m.ErrorsRoom.Load() + m.ErrorsProtocol.Load() +
		m.ErrorsGame.Load() + m.ErrorsTimeout.Load()
}

// ─── Network Helpers ────────────────────────────────────────────────────────

var (
	httpClient   *http.Client
	healthClient *http.Client
)

func initHTTPClients(cfg *Config) {
	transport := &http.Transport{
		MaxIdleConns:        20000,
		MaxIdleConnsPerHost: 5000,
		IdleConnTimeout:     90 * time.Second,
	}
	httpClient = &http.Client{
		Timeout:   time.Duration(cfg.HTTPTimeoutSeconds) * time.Second,
		Transport: transport,
	}
	healthClient = &http.Client{Timeout: 5 * time.Second}
}

// sleepCtx sleeps for d, returning false early if ctx is cancelled.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func getCoordURL(cfg *Config, roomIndex int) string {
	if cfg.CoordViaLB {
		host := cfg.Hosts[roomIndex%len(cfg.Hosts)]
		return fmt.Sprintf("http://%s:%s/rooms", host, cfg.Port)
	}
	endpoint := cfg.CoordURLs[roomIndex%len(cfg.CoordURLs)]
	return fmt.Sprintf("http://%s/rooms", endpoint)
}

func publishRoomCode(ctx context.Context, cfg *Config, roomIndex int, roomCode string) error {
	u := fmt.Sprintf("%s/%d", getCoordURL(cfg, roomIndex), roomIndex)
	b, _ := json.Marshal(map[string]string{"room_code": roomCode})

	var lastErr error
	for attempt := 0; attempt < cfg.PublishAttempts; attempt++ {
		if attempt > 0 {
			if !sleepCtx(ctx, time.Duration(100*(1<<uint(attempt-1)))*time.Millisecond) {
				return ctx.Err()
			}
		}
		req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(b))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("status %d", resp.StatusCode)
	}
	return lastErr
}

// pollRoomCode polls the coord endpoint until the host's code appears, the
// timeout elapses, or ctx is cancelled. A 404 simply means "not published yet".
func pollRoomCode(ctx context.Context, cfg *Config, rng *lockedRand, roomIndex int, timeout time.Duration) string {
	start := time.Now()
	u := fmt.Sprintf("%s/%d", getCoordURL(cfg, roomIndex), roomIndex)

	for time.Since(start) < timeout {
		if ctx.Err() != nil {
			return ""
		}
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err == nil {
			resp, err := httpClient.Do(req)
			if err == nil {
				if resp.StatusCode == 200 {
					var res struct {
						RoomCode string `json:"room_code"`
					}
					if jerr := json.NewDecoder(resp.Body).Decode(&res); jerr == nil && res.RoomCode != "" {
						resp.Body.Close()
						return res.RoomCode
					}
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}
		if !sleepCtx(ctx, time.Duration(1200+rng.Intn(800))*time.Millisecond) {
			return ""
		}
	}
	return ""
}

func buildWSURL(cfg *Config, rng *lockedRand, vuID int, isHost bool, roomCode, redirectGW string) string {
	targetHost := cfg.Hosts[vuID%len(cfg.Hosts)]
	base := fmt.Sprintf("ws://%s:%s/ws", targetHost, cfg.Port)

	params := url.Values{}
	if redirectGW != "" {
		params.Set("gw", redirectGW)
	} else if !isHost && roomCode != "" {
		params.Set("room", roomCode)
	} else {
		params.Set("cid", fmt.Sprintf("%d-%x", vuID, rng.Int63()))
	}
	return fmt.Sprintf("%s?%s", base, params.Encode())
}

// ─── Drawing Protocols ──────────────────────────────────────────────────────

type Point struct {
	X float64
	Y float64
}

type strokePointJSON struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type strokeJSON struct {
	Points    []strokePointJSON `json:"points"`
	Color     string            `json:"color"`
	LineWidth int               `json:"lineWidth"`
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// encodeBinaryStroke: [0x01][r][g][b][size][u16 count BE]{[u16 x BE][u16 y BE]}*
func encodeBinaryStroke(points []Point, r, g, b, size uint8) []byte {
	count := len(points)
	buf := make([]byte, 7+count*4)
	buf[0] = 0x01
	buf[1] = r
	buf[2] = g
	buf[3] = b
	buf[4] = size
	binary.BigEndian.PutUint16(buf[5:7], uint16(count))
	off := 7
	for _, p := range points {
		binary.BigEndian.PutUint16(buf[off:off+2], uint16(math.Round(clamp(p.X, 0, 65535))))
		binary.BigEndian.PutUint16(buf[off+2:off+4], uint16(math.Round(clamp(p.Y, 0, 65535))))
		off += 4
	}
	return buf
}

// countBinaryOps mirrors the k6 receive-side parser so messages_received is
// comparable (one count per drawing op, minimum 1 per frame).
func countBinaryOps(data []byte) int {
	off, count := 0, 0
	for off < len(data) {
		count++
		switch data[off] {
		case 0x01, 0x04:
			if off+7 > len(data) {
				goto done
			}
			ptCount := int(binary.BigEndian.Uint16(data[off+5 : off+7]))
			off += 7 + ptCount*4
		case 0x02:
			off++
		case 0x03:
			off += 8
		default:
			goto done
		}
	}
done:
	if count < 1 {
		count = 1
	}
	return count
}

// ─── Word Dictionary (matches backend/words.py as copied into the k6 script) ─

var wordPacks = map[string][]string{
	"animals": {
		"dog", "elephant", "whale", "zebra", "eagle", "kangaroo", "octopus", "penguin", "giraffe", "jellyfish",
		"owl", "dinosaur", "wolf", "butterfly", "lion", "parrot", "rabbit", "snake", "tiger", "dolphin",
		"frog", "horse", "koala", "spider", "turtle", "gorilla", "insect", "lobster", "ostrich", "peacock",
		"caterpillar", "flamingo", "grasshopper", "goldfish", "iguana", "dragonfly", "starfish", "bear", "camel", "cat",
		"cheetah", "chameleon", "chimpanzee", "crab", "crocodile", "deer", "duck", "fox", "hedgehog", "hippo",
		"mouse", "panda", "rhino", "seagull", "seal", "shark", "sheep", "sloth", "snail", "squirrel",
		"swan", "walrus", "badger", "hamster", "raccoon", "otter", "beaver", "skunk",
	},
	"food": {
		"apple", "banana", "lemon", "mushroom", "orange", "grapes", "onion", "bread", "cherry", "olive",
		"pumpkin", "tomato", "waffle", "pretzel", "donut", "jellybean", "lollipop", "sandwich", "hamburger", "icecream",
		"avocado", "bacon", "bagel", "cake", "cheese", "chocolate", "cookie", "corn", "croissant", "cupcake",
		"egg", "hotdog", "noodles", "pancake", "peach", "peanut", "pear", "pie", "pineapple", "pizza",
		"popcorn", "potato", "salad", "sausage", "soup", "spaghetti", "steak", "strawberry", "sushi", "taco",
		"toast", "watermelon", "muffin", "honey", "butter", "carrot", "mango", "coconut", "dumpling", "broccoli",
	},
	"objects": {
		"jacket", "kite", "lamp", "notebook", "piano", "umbrella", "violin", "xylophone", "diamond", "globe",
		"hammer", "quilt", "window", "anchor", "balloon", "candle", "envelope", "feather", "key", "ladder",
		"magnet", "necklace", "scissors", "telescope", "vase", "camera", "helmet", "compass", "jewel", "knot",
		"ring", "skull", "arrow", "clock", "drum", "flag", "heart", "ink", "jar", "mirror",
		"wheel", "needle", "suitcase", "zipper", "harp", "jigsaw", "kettle", "napkin", "trophy", "battery",
		"dominoes", "jukebox", "lantern", "microscope", "newspaper", "origami", "ukulele", "blanket", "crayon", "keyboard",
		"mailbox", "nutcracker", "paintbrush", "toothbrush", "wrench", "backpack", "chandelier", "earring", "glasses", "iron",
		"horseshoe", "uniform", "lanyard", "book", "bottle", "bucket", "chair", "couch", "cup", "dice",
		"fork", "headphones", "knife", "lock", "mug", "pencil", "pillow", "plate", "radio", "rope",
		"soap", "spoon", "table", "towel", "watch",
	},
	"nature": {
		"flower", "mountain", "ocean", "rainbow", "sun", "tree", "forest", "moon", "nest", "snowflake",
		"tornado", "volcano", "waterfall", "iceberg", "leaf", "rose", "cactus", "acorn", "icicle", "quicksand",
		"earth", "garden", "blizzard", "cave", "cliff", "cloud", "comet", "desert", "eclipse", "fire",
		"galaxy", "island", "jungle", "lightning", "meteor", "puddle", "rain", "river", "rock", "smoke",
		"star", "storm", "sunrise", "sunset", "thunder", "valley", "wave", "wind",
	},
	"places": {
		"house", "bridge", "castle", "igloo", "lighthouse", "village", "throne", "beach", "fountain", "maze",
		"windmill", "elevator", "escalator", "fireplace", "airport", "aquarium", "bakery", "bank", "barn", "cabin",
		"church", "circus", "cottage", "factory", "farm", "fort", "gym", "hospital", "hotel", "library",
		"mall", "market", "museum", "palace", "park", "playground", "prison", "pyramid", "school", "skyscraper",
		"stadium", "station", "supermarket", "temple", "theater", "tower", "zoo",
	},
	"vehicles": {
		"car", "yacht", "airplane", "rocket", "helicopter", "parachute", "surfboard", "engine", "kayak", "hammock",
		"trampoline", "football", "volleyball", "ambulance", "bicycle", "blimp", "boat", "bulldozer", "bus", "canoe",
		"carriage", "ferry", "firetruck", "forklift", "hoverboard", "jetski", "limousine", "motorcycle", "raft", "scooter",
		"skateboard", "sled", "snowboard", "spaceship", "submarine", "tank", "taxi", "tractor", "train", "truck", "van",
	},
	"fantasy": {
		"queen", "unicorn", "dragon", "robot", "wizard", "firework", "ghost", "treasure", "vampire", "king",
		"angel", "mermaid", "witch", "emerald", "radar", "satellite", "alien", "cauldron", "crystal", "cyborg",
		"demon", "dungeon", "elf", "fairy", "flying carpet", "genie", "giant", "goblin", "laser", "magic wand",
		"monster", "mummy", "pegasus", "phoenix", "portal", "potion", "shield", "spellbook", "sword", "time machine", "zombie",
	},
	"characters": {
		"ninja", "pirate", "nurse", "judge", "astronaut", "dentist", "scarecrow", "actor", "artist", "athlete",
		"baby", "baker", "barber", "builder", "captain", "carpenter", "chef", "clown", "detective", "diver",
		"doctor", "farmer", "firefighter", "guard", "hunter", "knight", "lifeguard", "magician", "mailman", "mechanic",
		"musician", "painter", "pilot", "police", "prince", "princess", "sailor", "scientist", "singer", "soldier",
		"spy", "superhero",
	},
}

var allWordsList []string

func init() {
	// Deterministic order (map iteration is random) so runs are comparable.
	names := make([]string, 0, len(wordPacks))
	for k := range wordPacks {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		allWordsList = append(allWordsList, wordPacks[k]...)
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
	rng := newLockedRand(vuID)
	roomIndex := (vuID - 1) / cfg.PlayersPerRoom
	isHost := ((vuID - 1) % cfg.PlayersPerRoom) == 0
	playerName := "k" + strconv.FormatInt(int64(vuID), 36)

	globalMetrics.PlayersPlanned.Add(1)

	// Arrival ramp, staggered per ROOM (runner-local room index, k6 parity).
	totalRooms := int(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	if cfg.RampSeconds > 0 && totalRooms > 0 {
		localRoomIndex := (localVUID - 1) / cfg.PlayersPerRoom
		rampOffset := time.Duration(float64(localRoomIndex) / float64(totalRooms) * float64(cfg.RampSeconds) * float64(time.Second))
		if !sleepCtx(ctx, rampOffset) {
			return
		}
	}

	var coordRoomCode string
	if isHost {
		if !sleepCtx(ctx, time.Duration(rng.Intn(200))*time.Millisecond) {
			return
		}
	} else {
		if !sleepCtx(ctx, time.Duration(1000+rng.Intn(500))*time.Millisecond) {
			return
		}
		coordRoomCode = pollRoomCode(ctx, cfg, rng, roomIndex, time.Duration(cfg.LobbyTimeoutMs)*time.Millisecond)
		if coordRoomCode == "" {
			if ctx.Err() != nil {
				return // cancelled, not a real failure
			}
			globalMetrics.RoomJoinErrors.Add(1)
			globalMetrics.RoomCodeDiscoveryFailures.Add(1)
			recordError("room")
			globalMetrics.SessionsAborted.Add(1)
			return
		}
	}

	sessionStart := time.Now()
	connectStart := sessionStart
	defer func() {
		globalMetrics.SessionDuration.Add(float64(time.Since(sessionStart).Milliseconds()))
	}()

	dialer := websocket.Dialer{
		HandshakeTimeout: time.Duration(cfg.ConnectTimeoutMs) * time.Millisecond,
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
	}

	globalMetrics.PlayersAttempted.Add(1)

	// Session state (persists across redirect reconnects), guarded by sessionMu
	// unless noted.
	var sessionMu sync.Mutex
	roomCode := coordRoomCode
	var redirectGW string
	redirectAttempts := 0
	const maxRedirects = 3
	var playerID string
	state := "connecting" // connecting -> lobby -> waiting_start -> playing
	var isDrawer AtomicBool
	var turnActive AtomicBool
	var endedFlag AtomicBool // lock-free mirror of sessionEnded
	startArmed := false
	gameStartedCounted := false
	sessionEnded := false
	gameCompleted := false
	reconnectForRedirect := false

	var pendingReadyAt time.Time
	var pendingReadyMu sync.Mutex

	var turnCancel context.CancelFunc
	var turnMu sync.Mutex

	// Only touched from the connection-loop goroutine.
	initialConnectOutcomeRecorded := false
	initialConnectSucceeded := false

	sessionCtx, cancelSession := context.WithCancel(ctx)
	defer cancelSession()

	// Tracked timers so none outlive the session.
	var timersMu sync.Mutex
	var timers []*time.Timer
	afterFunc := func(d time.Duration, fn func()) {
		if endedFlag.Load() {
			return
		}
		t := time.AfterFunc(d, fn)
		timersMu.Lock()
		timers = append(timers, t)
		timersMu.Unlock()
	}
	defer func() {
		timersMu.Lock()
		for _, t := range timers {
			t.Stop()
		}
		timers = nil
		timersMu.Unlock()
	}()

	stopTurnLoops := func() {
		turnMu.Lock()
		defer turnMu.Unlock()
		turnActive.Store(false)
		if turnCancel != nil {
			turnCancel()
			turnCancel = nil
		}
	}

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
		endedFlag.Store(true)
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

	// ─── Connection loop (initial dial + application-level redirects) ───
	for {
		sessionMu.Lock()
		ended := sessionEnded
		curRoomCode := roomCode
		curRedirectGW := redirectGW
		sessionMu.Unlock()

		if ended || sessionCtx.Err() != nil {
			return
		}

		wsURL := buildWSURL(cfg, rng, vuID, isHost, curRoomCode, curRedirectGW)
		conn, _, err := dialer.DialContext(sessionCtx, wsURL, nil)
		if err != nil {
			if sessionCtx.Err() != nil {
				return // cancelled mid-dial
			}
			recordConnectFailure()
			endSession("error")
			return
		}

		socketOpenedAt := time.Now()
		globalMetrics.WSConnectionsOpened.Add(1)
		if !initialConnectSucceeded {
			globalMetrics.WSOpenRTT.Add(float64(time.Since(connectStart).Milliseconds()))
		}
		recordConnectSuccess()

		var writeMu sync.Mutex
		recordSendError := func() {
			if !endedFlag.Load() {
				recordError("connect")
			}
		}
		sendJSON := func(msgType string, payload any) error {
			b, err := json.Marshal(map[string]any{"type": msgType, "payload": payload})
			if err != nil {
				return err
			}
			globalMetrics.DataSent.Add(uint64(len(b)))
			globalMetrics.MsgsSent.Add(1)
			writeMu.Lock()
			err = conn.WriteMessage(websocket.TextMessage, b)
			writeMu.Unlock()
			if err != nil {
				recordSendError()
			}
			return err
		}
		sendBinary := func(data []byte) error {
			globalMetrics.DataSent.Add(uint64(len(data)))
			globalMetrics.MsgsSent.Add(1)
			writeMu.Lock()
			err := conn.WriteMessage(websocket.BinaryMessage, data)
			writeMu.Unlock()
			if err != nil {
				recordSendError()
			}
			return err
		}
		sendClose := func(code int, text string) {
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, text))
			writeMu.Unlock()
		}
		sendReady := func() {
			pendingReadyMu.Lock()
			pendingReadyAt = time.Now()
			pendingReadyMu.Unlock()
			_ = sendJSON("toggle_ready", map[string]any{})
		}

		sendJSONStroke := func(pts []Point) {
			sp := make([]strokePointJSON, len(pts))
			for i, p := range pts {
				sp[i] = strokePointJSON{X: p.X, Y: p.Y}
			}
			_ = sendJSON("stroke", strokeJSON{Points: sp, Color: "#000", LineWidth: 3})
		}

		startDrawing := func(tCtx context.Context) {
			if cfg.StrokeHz <= 0 {
				// k6 parity: slow JSON strokes (2 random points every 2-5s).
				ticker := time.NewTicker(time.Duration(rng.Between(2000, 5000)) * time.Millisecond)
				go func() {
					defer ticker.Stop()
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
							sendJSONStroke([]Point{
								{X: rng.Between(0, 800), Y: rng.Between(0, 600)},
								{X: rng.Between(0, 800), Y: rng.Between(0, 600)},
							})
						}
					}
				}()
				return
			}

			interval := time.Duration(float64(time.Second) / float64(cfg.StrokeHz))
			if interval < time.Millisecond {
				interval = time.Millisecond
			}
			ticker := time.NewTicker(interval)
			go func() {
				defer ticker.Stop()
				lastX := rng.Between(0, 800)
				lastY := rng.Between(0, 600)
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
						for i := range pts {
							lastX = clamp(lastX+rng.Between(-15, 15), 0, 800)
							lastY = clamp(lastY+rng.Between(-15, 15), 0, 600)
							pts[i] = Point{X: lastX, Y: lastY}
						}
						if cfg.StrokeFormat == "json" {
							sendJSONStroke(pts)
						} else {
							_ = sendBinary(encodeBinaryStroke(pts, 0, 0, 0, 3))
						}
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

			ticker := time.NewTicker(time.Duration(rng.Between(2000, 4000)) * time.Millisecond)
			idx := rng.Intn(len(candidatePool))
			go func() {
				defer ticker.Stop()
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

		// Timers shared by create/join paths.
		connectTimeout := func(onFail func()) {
			afterFunc(time.Duration(cfg.ConnectTimeoutMs)*time.Millisecond, func() {
				sessionMu.Lock()
				st := state
				ended := sessionEnded
				sessionMu.Unlock()
				if st == "connecting" && !ended {
					onFail()
					recordError("timeout")
					endSession("error")
				}
			})
		}
		lobbyTimeout := func() {
			afterFunc(time.Duration(cfg.LobbyTimeoutMs)*time.Millisecond, func() {
				sessionMu.Lock()
				st := state
				ended := sessionEnded
				sessionMu.Unlock()
				if (st == "lobby" || st == "waiting_start") && !ended {
					recordError("timeout")
					endSession("aborted")
				}
			})
		}

		// k6 parity: hosts ALWAYS create_room, joiners ALWAYS join_room.
		if isHost {
			_ = sendJSON("create_room", map[string]string{"name": playerName})
			connectTimeout(func() { globalMetrics.RoomCreateErrors.Add(1) })
		} else {
			_ = sendJSON("join_room", map[string]string{"name": playerName, "room_code": curRoomCode})
			connectTimeout(func() { globalMetrics.RoomJoinErrors.Add(1) })
		}

		// Playing-state handler (also invoked on the frame that triggers the
		// transition so a missed game_started doesn't stall the turn).
		handlePlaying := func(fType string, fPayload json.RawMessage) {
			switch fType {
			case "drawer_selecting":
				stopTurnLoops()
				var p struct {
					DrawerID string `json:"drawer_id"`
				}
				_ = json.Unmarshal(fPayload, &p)
				sessionMu.Lock()
				myID := playerID
				sessionMu.Unlock()
				isDrawer.Store(p.DrawerID == myID)

			case "word_choices":
				isDrawer.Store(true)
				var p struct {
					Choices []string `json:"choices"`
				}
				_ = json.Unmarshal(fPayload, &p)
				if len(p.Choices) > 0 {
					choice := p.Choices[rng.Intn(len(p.Choices))]
					afterFunc(time.Duration(1000+rng.Intn(2000))*time.Millisecond, func() {
						if !endedFlag.Load() {
							_ = sendJSON("select_word", map[string]string{"word": choice})
						}
					})
				}

			case "turn_started":
				stopTurnLoops()
				var p struct {
					DrawerID string            `json:"drawer_id"`
					Hint     []json.RawMessage `json:"hint"` // element type agnostic
					Theme    struct {
						ID string `json:"id"`
					} `json:"theme"`
				}
				_ = json.Unmarshal(fPayload, &p)
				sessionMu.Lock()
				myID := playerID
				sessionMu.Unlock()

				turnMu.Lock()
				turnActive.Store(true)
				drawer := p.DrawerID == myID
				isDrawer.Store(drawer)
				tCtx, cancel := context.WithCancel(sessionCtx)
				turnCancel = cancel
				turnMu.Unlock()

				if drawer {
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

		onGameStart := func(t string, payload json.RawMessage) {
			sessionMu.Lock()
			if t == "game_started" && isHost && !gameStartedCounted {
				gameStartedCounted = true
				globalMetrics.GamesStarted.Add(1)
			}
			state = "playing"
			sessionMu.Unlock()
			handlePlaying(t, payload)
		}
		onPreStartGameOver := func() {
			sessionMu.Lock()
			started := gameStartedCounted
			sessionMu.Unlock()
			if isHost && !started {
				recordError("game")
				endSession("aborted")
			} else {
				endSession("completed")
			}
		}

		processFrame := func(frameData []byte) {
			if endedFlag.Load() {
				return
			}
			var f struct {
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(frameData, &f); err != nil {
				return
			}
			globalMetrics.MsgsReceived.Add(1)

			if f.Type == "ping" {
				_ = sendJSON("pong", map[string]any{})
				return
			}

			// Latency probe: first player_list after OUR toggle_ready.
			if f.Type == "player_list" {
				pendingReadyMu.Lock()
				if !pendingReadyAt.IsZero() {
					globalMetrics.MessageLatency.Add(float64(time.Since(pendingReadyAt).Milliseconds()))
					pendingReadyAt = time.Time{}
				}
				pendingReadyMu.Unlock()
			}

			// Application-level sticky redirect.
			if f.Type == "redirect" {
				var p struct {
					GatewayID string `json:"gateway_id"`
					RoomCode  string `json:"room_code"`
				}
				_ = json.Unmarshal(f.Payload, &p)
				sessionMu.Lock()
				canRedirect := p.GatewayID != "" && redirectAttempts < maxRedirects
				if canRedirect {
					redirectGW = p.GatewayID
					if p.RoomCode != "" && !isHost { // hosts always re-create
						roomCode = p.RoomCode
					}
					redirectAttempts++
					reconnectForRedirect = true
				}
				sessionMu.Unlock()
				if canRedirect {
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
					globalMetrics.RoomCreateRTT.Add(float64(time.Since(connectStart).Milliseconds()))
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
					// Don't block the read loop on coordinator HTTP.
					go func(code string) {
						if err := publishRoomCode(sessionCtx, cfg, roomIndex, code); err != nil && sessionCtx.Err() == nil {
							globalMetrics.CoordPublishFailures.Add(1)
						}
					}(p.RoomCode)
					lobbyTimeout()

				case "room_joined":
					globalMetrics.RoomJoinRTT.Add(float64(time.Since(connectStart).Milliseconds()))
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
					afterFunc(time.Duration(1000+rng.Intn(1000))*time.Millisecond, func() {
						sessionMu.Lock()
						st := state
						sessionMu.Unlock()
						if st == "lobby" && !endedFlag.Load() {
							sendReady()
						}
					})
					lobbyTimeout()

				case "error":
					globalMetrics.ServerErrors.Add(1)
					if isHost {
						globalMetrics.ServerCreateErrors.Add(1)
						globalMetrics.RoomCreateErrors.Add(1)
					} else {
						globalMetrics.ServerJoinErrors.Add(1)
						globalMetrics.RoomJoinErrors.Add(1)
					}
					var p struct {
						Code    string `json:"code"`
						Message string `json:"message"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					fmt.Fprintf(os.Stderr, "[SERVER_ERROR] vu=%d host=%v code=%q message=%q\n", vuID, isHost, p.Code, p.Message)
					recordError("protocol")
					endSession("error")
				}

			case "lobby":
				// k6 parity: `error` and `game_ended_insufficient_players` are
				// NOT acted on in the lobby (only after start_game was sent).
				switch {
				case f.Type == "player_list":
					if !isHost {
						return
					}
					var p struct {
						Players []json.RawMessage `json:"players"`
					}
					_ = json.Unmarshal(f.Payload, &p)
					sessionMu.Lock()
					arm := !startArmed && len(p.Players) >= cfg.MinPlayersToStart
					if arm {
						startArmed = true
					}
					sessionMu.Unlock()
					if arm {
						_ = sendJSON("update_settings", map[string]any{
							"num_rounds":    cfg.NumRounds,
							"turn_duration": cfg.TurnDuration,
							"max_players":   cfg.PlayersPerRoom,
						})
						sendReady()
						afterFunc(time.Duration(cfg.StartGraceMs)*time.Millisecond, func() {
							sessionMu.Lock()
							if state != "lobby" || sessionEnded {
								sessionMu.Unlock()
								return
							}
							state = "waiting_start"
							sessionMu.Unlock()
							_ = sendJSON("start_game", map[string]any{})
							globalMetrics.GameStartRequests.Add(1)
						})
					}
				case isGameStartSignal(f.Type):
					onGameStart(f.Type, f.Payload)
				case f.Type == "game_over":
					onPreStartGameOver()
				}

			case "waiting_start":
				switch {
				case isGameStartSignal(f.Type):
					onGameStart(f.Type, f.Payload)
				case f.Type == "game_over":
					onPreStartGameOver()
				case f.Type == "game_ended_insufficient_players":
					recordError("game")
					endSession("aborted")
				case f.Type == "error":
					recordError("protocol")
					endSession("error")
				}

			case "playing":
				handlePlaying(f.Type, f.Payload)
			}
		}

		// Read loop for this connection.
		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				msgType, data, err := conn.ReadMessage()
				if err != nil {
					sessionMu.Lock()
					redirecting := reconnectForRedirect
					sessionMu.Unlock()
					if !redirecting && !endedFlag.Load() &&
						!websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
						recordError("connect")
					}
					return
				}
				globalMetrics.DataReceived.Add(uint64(len(data)))

				if msgType == websocket.BinaryMessage {
					globalMetrics.MsgsReceived.Add(uint64(countBinaryOps(data)))
					continue
				}

				// Gateway may coalesce bursts: JSON array, or {type:"batch",payload:[...]}.
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
						var items []json.RawMessage
						if err := json.Unmarshal(single.Payload, &items); err == nil {
							for _, item := range items {
								processFrame(item)
							}
							continue
						}
					}
					processFrame(data)
				}
			}
		}()

		hold := time.NewTimer(time.Duration(cfg.HoldSeconds) * time.Second)
		select {
		case <-readDone:
			hold.Stop()
			conn.Close()
			globalMetrics.WSConnectionsClosed.Add(1)
			globalMetrics.WSConnectionDuration.Add(float64(time.Since(socketOpenedAt).Milliseconds()))
			sessionMu.Lock()
			reconn := reconnectForRedirect
			reconnectForRedirect = false
			ended := sessionEnded
			sessionMu.Unlock()
			if reconn {
				continue // reconnect pinned to ?gw=<redirectGW>
			}
			if !ended {
				endSession("closed")
			}
			return

		case <-hold.C:
			conn.Close()
			globalMetrics.WSConnectionsClosed.Add(1)
			globalMetrics.WSConnectionDuration.Add(float64(time.Since(socketOpenedAt).Milliseconds()))
			sessionMu.Lock()
			done := gameCompleted
			sessionMu.Unlock()
			if !done {
				recordError("timeout")
				endSession("aborted")
			}
			return

		case <-sessionCtx.Done():
			hold.Stop()
			conn.Close()
			globalMetrics.WSConnectionsClosed.Add(1)
			globalMetrics.WSConnectionDuration.Add(float64(time.Since(socketOpenedAt).Milliseconds()))
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

// healthPayload uses pointers for the fields acceptance depends on, so a
// renamed/missing field is detected instead of silently reading as 0.
type healthPayload struct {
	ActiveClients     *int `json:"active_clients"`
	GRPCStreamsActive *int `json:"grpc_streams_active"`
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

func fetchHealth(ctx context.Context, u string) (gwHealthSnapshot, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return gwHealthSnapshot{}, err
	}
	resp, err := healthClient.Do(req)
	if err != nil {
		return gwHealthSnapshot{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return gwHealthSnapshot{}, err
	}
	if resp.StatusCode != 200 {
		return gwHealthSnapshot{}, fmt.Errorf("status %d", resp.StatusCode)
	}
	var h healthPayload
	if err := json.Unmarshal(body, &h); err != nil {
		return gwHealthSnapshot{}, fmt.Errorf("invalid_json: %v", err)
	}
	if h.ActiveClients == nil || h.GRPCStreamsActive == nil {
		return gwHealthSnapshot{}, fmt.Errorf("missing active_clients/grpc_streams_active fields")
	}
	return gwHealthSnapshot{
		activeClients: *h.ActiveClients,
		streamsActive: *h.GRPCStreamsActive,
		controlDrops:  uint64(h.FanoutDropped.Control),
		lossyDrops:    uint64(h.FanoutDropped.Lossy),
		sendDrops:     uint64(h.SendDropped.Stroke + h.SendDropped.Fill + h.SendDropped.Guess),
	}, nil
}

func runHealthProbe(ctx context.Context, cfg *Config, autoStopCh chan struct{}) {
	if len(cfg.HealthURLs) == 0 {
		return
	}

	startTime := time.Now()
	consecutiveZeroPolls := 0
	var peakActive, peakStreamsTotal, peakStreamsPerGW uint64

	// poll returns true when the probe should stop.
	poll := func() bool {
		snapshots := make(map[string]gwHealthSnapshot, len(cfg.HealthURLs))
		for _, u := range cfg.HealthURLs {
			s, err := fetchHealth(ctx, u)
			if err != nil {
				if ctx.Err() != nil {
					return true
				}
				globalMetrics.GatewayHealthFailures.Add(1)
				fmt.Fprintf(os.Stderr, "[GATEWAY_HEALTH_ERROR] url=%s err=%v\n", u, err)
				continue
			}
			snapshots[u] = s
			// fmt.Printf("[GATEWAY_HEALTH] url=%s active_clients=%d streams=%d control_drops=%d lossy_drops=%d send_drops=%d\n",
			// 	u, s.activeClients, s.streamsActive, s.controlDrops, s.lossyDrops, s.sendDrops)
		}

		var sumActive, sumStreams, maxStreams, sumCtl, sumLossy, sumSend uint64
		for _, s := range snapshots {
			sumActive += uint64(s.activeClients)
			sumStreams += uint64(s.streamsActive)
			if uint64(s.streamsActive) > maxStreams {
				maxStreams = uint64(s.streamsActive)
			}
			sumCtl += s.controlDrops
			sumLossy += s.lossyDrops
			sumSend += s.sendDrops
		}

		// "Latest" values reflect whatever answered; PEAKS are only updated on
		// complete polls so a missing gateway can't under-report.
		globalMetrics.GatewayActiveClients.Store(sumActive)
		globalMetrics.GatewayStreamsActive.Store(sumStreams)
		globalMetrics.GatewayControlDrops.Store(sumCtl)
		globalMetrics.GatewayLossyDrops.Store(sumLossy)
		globalMetrics.GatewaySendDrops.Store(sumSend)

		complete := len(snapshots) == len(cfg.HealthURLs)
		if complete {
			globalMetrics.GatewayHealthPollsDone.Add(1)
			if sumActive > peakActive {
				peakActive = sumActive
				globalMetrics.GatewayPeakActiveClients.Store(peakActive)
			}
			if sumStreams > peakStreamsTotal {
				peakStreamsTotal = sumStreams
				globalMetrics.GatewayPeakStreamsTotal.Store(peakStreamsTotal)
			}
			if maxStreams > peakStreamsPerGW {
				peakStreamsPerGW = maxStreams
				globalMetrics.GatewayPeakStreamsPerGW.Store(peakStreamsPerGW)
			}
		} else {
			globalMetrics.GatewayHealthPartialPoll.Add(1)
		}

		elapsed := time.Since(startTime).Seconds()
		if complete && sumActive == 0 && elapsed >= float64(cfg.AutoStopMinElapsedS) {
			consecutiveZeroPolls++
			fmt.Printf("[GATEWAY_HEALTH] all gateways at 0 active_clients (%d/%d consecutive), elapsed %.0fs\n",
				consecutiveZeroPolls, cfg.AutoStopConsecutiveZeros, elapsed)
			if consecutiveZeroPolls >= cfg.AutoStopConsecutiveZeros {
				fmt.Println("[GATEWAY_HEALTH] all gateways drained — auto-stopping test to print results.")
				select {
				case autoStopCh <- struct{}{}:
				default:
				}
				return true
			}
		} else {
			consecutiveZeroPolls = 0
		}
		return false
	}

	// Immediate baseline poll (k6 parity), then on the ticker.
	if poll() {
		return
	}
	ticker := time.NewTicker(time.Duration(cfg.HealthPollSeconds) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if poll() {
				return
			}
		}
	}
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

func main() {
	cfg := loadConfig()
	if errs := cfg.validate(); len(errs) > 0 {
		fmt.Fprintln(os.Stderr, "Invalid configuration:")
		for _, e := range errs {
			fmt.Fprintln(os.Stderr, "  - "+e)
		}
		os.Exit(2)
	}
	initHTTPClients(cfg)

	totalRooms := int(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	fmt.Println("==========================================================")
	fmt.Printf(" Skribbl Go Load Generator (k6 parity build)\n")
	fmt.Printf(" Target LBs: %s (port %s)\n", strings.Join(cfg.Hosts, ","), cfg.Port)
	fmt.Printf(" VUs: %d (offset %d) | players/room: %d | rooms: %d | ramp: %ds\n", cfg.VUs, cfg.VuOffset, cfg.PlayersPerRoom, totalRooms, cfg.RampSeconds)
	fmt.Printf(" Game: %d rounds, %ds turns, hold=%ds | strokes: %dHz x %d pts [%s]\n", cfg.NumRounds, cfg.TurnDuration, cfg.HoldSeconds, cfg.StrokeHz, cfg.StrokePoints, cfg.StrokeFormat)
	if cfg.StrokeHz > 0 {
		fanout := totalRooms * cfg.StrokeHz * (cfg.PlayersPerRoom - 1)
		fmt.Printf(" Peak fan-out: ~%d broadcast writes/s at gateways (all rooms drawing)\n", fanout)
	}
	fmt.Printf(" Coord: %s | publish attempts: %d | HTTP timeout: %ds\n", map[bool]string{true: "via LB", false: "direct"}[cfg.CoordViaLB], cfg.PublishAttempts, cfg.HTTPTimeoutSeconds)
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
		case <-ctx.Done():
		}
	}()

	go runHealthProbe(ctx, cfg, autoStopCh)

	startTime := time.Now()
	var wg sync.WaitGroup

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				elapsed := time.Since(startTime).Truncate(time.Second)
				opened := globalMetrics.WSConnectionsOpened.Load()
				closed := globalMetrics.WSConnectionsClosed.Load()
				var active uint64
				if opened > closed {
					active = opened - closed
				}
				lat := globalMetrics.MessageLatency.Snapshot()
				fmt.Printf("[%s] Active sockets: %d | Msgs R/S: %d/%d | Games done: %d | Err: %d | p95 lat: %.1fms\n",
					elapsed, active, globalMetrics.MsgsReceived.Load(), globalMetrics.MsgsSent.Load(),
					globalMetrics.GamesCompleted.Load(), totalErrors(), lat.P95)
			}
		}
	}()

	for i := 1; i <= cfg.VUs; i++ {
		wg.Add(1)
		go runVU(ctx, cfg, i, &wg)
	}

	wg.Wait()
	duration := time.Since(startTime)
	cancel()

	if ok := printSummaryReport(cfg, duration); !ok {
		os.Exit(1)
	}
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
		return "NOT MEASURED"
	}
	return fmt.Sprintf("%.1fms", t.P95)
}

func printTrend(name string, t TrendStats, unit string) {
	fmt.Printf("     %-34s: avg=%.2f%s min=%.1f%s med=%.1f%s max=%.1f%s p(90)=%.1f%s p(95)=%.1f%s (n=%.0f)\n",
		name, t.Avg, unit, t.Min, unit, t.Med, unit, t.Max, unit, t.P90, unit, t.P95, unit, t.Count)
}

func formatBytes(b uint64) string {
	switch {
	case b < 1024:
		return fmt.Sprintf("%d B", b)
	case b < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(b)/1024)
	case b < 1024*1024*1024:
		return fmt.Sprintf("%.1f MB", float64(b)/(1024*1024))
	default:
		return fmt.Sprintf("%.2f GB", float64(b)/(1024*1024*1024))
	}
}

func sub0(a, b uint64) uint64 {
	if a > b {
		return a - b
	}
	return 0
}

// printSummaryReport prints the report and returns true when acceptance passes.
func printSummaryReport(cfg *Config, duration time.Duration) bool {
	m := globalMetrics
	fmt.Println("\nLoad test complete.")
	fmt.Println("==========================================================")

	durSec := duration.Seconds()
	if durSec <= 0 {
		durSec = 1
	}
	perSec := func(n uint64) float64 { return float64(n) / durSec }

	dataRecv, dataSent := m.DataReceived.Load(), m.DataSent.Load()
	msgsRecv, msgsSent := m.MsgsReceived.Load(), m.MsgsSent.Load()
	opened, closed := m.WSConnectionsOpened.Load(), m.WSConnectionsClosed.Load()

	// Connection success — two views.
	planned := m.PlayersPlanned.Load()
	attempted := m.PlayersAttempted.Load()
	connected := m.PlayersConnected.Load()
	connRateK6 := 100.0 // k6 parity: attempts = VUs that reached the dial
	if attempted > 0 {
		connRateK6 = float64(connected) / float64(attempted) * 100.0
	}
	connRateE2E := 0.0 // end-to-end: every planned VU, incl. coordinator failures
	if planned > 0 {
		connRateE2E = float64(connected) / float64(planned) * 100.0
	}

	// Game completion — two views.
	plannedRooms := uint64(math.Ceil(float64(cfg.VUs) / float64(cfg.PlayersPerRoom)))
	gamesDone, gamesAborted := m.GamesCompleted.Load(), m.GamesAborted.Load()
	gameRatePlanned := 0.0
	if plannedRooms > 0 {
		gameRatePlanned = float64(gamesDone) / float64(plannedRooms) * 100.0
	}
	gameRateObserved := 0.0
	if gamesDone+gamesAborted > 0 {
		gameRateObserved = float64(gamesDone) / float64(gamesDone+gamesAborted) * 100.0
	}

	plannedPlayers := uint64(cfg.VUs)
	sessDone, sessAborted := m.SessionsCompleted.Load(), m.SessionsAborted.Load()
	sessRate := 0.0
	if plannedPlayers > 0 {
		sessRate = float64(sessDone) / float64(plannedPlayers) * 100.0
	}

	fmt.Printf("     data_received....................: %s   %s/s\n", formatBytes(dataRecv), formatBytes(uint64(float64(dataRecv)/durSec)))
	fmt.Printf("     data_sent........................: %s   %s/s\n", formatBytes(dataSent), formatBytes(uint64(float64(dataSent)/durSec)))
	fmt.Printf("     errors (total)...................: %d   %.6f/s\n", totalErrors(), float64(totalErrors())/durSec)
	for _, e := range []struct {
		name string
		v    uint64
	}{
		{"errors_connect", m.ErrorsConnect.Load()},
		{"errors_room", m.ErrorsRoom.Load()},
		{"errors_protocol", m.ErrorsProtocol.Load()},
		{"errors_game", m.ErrorsGame.Load()},
		{"errors_timeout", m.ErrorsTimeout.Load()},
	} {
		if e.v > 0 {
			fmt.Printf("     %-32s: %d   %.6f/s\n", e.name, e.v, perSec(e.v))
		}
	}
	if v := m.RoomCodeDiscoveryFailures.Load(); v > 0 {
		fmt.Printf("     room_code_discovery_failures.....: %d (joiners that never opened a socket)\n", v)
	}
	if v := m.CoordPublishFailures.Load(); v > 0 {
		fmt.Printf("     coord_publish_failures...........: %d (host could not publish its room code)\n", v)
	}
	if v := m.ServerErrors.Load(); v > 0 {
		fmt.Printf("     server_errors....................: %d (create=%d join=%d)\n", v, m.ServerCreateErrors.Load(), m.ServerJoinErrors.Load())
	}
	if v := m.RedirectsFollowed.Load(); v > 0 {
		fmt.Printf("     redirects_followed...............: %d\n", v)
	}

	fmt.Printf("   ✓ game_completion_rate (planned)...: %.2f%%   ✓ %d   ✗ %d (planned rooms: %d)\n", gameRatePlanned, gamesDone, sub0(plannedRooms, gamesDone), plannedRooms)
	fmt.Printf("     game_completion_rate (observed)..: %.2f%%   ✓ %d   ✗ %d (k6-comparable: completed / (completed+aborted))\n", gameRateObserved, gamesDone, gamesAborted)
	fmt.Printf("     game_start_requests..............: %d   %.6f/s\n", m.GameStartRequests.Load(), perSec(m.GameStartRequests.Load()))
	fmt.Printf("     games_started....................: %d   %.6f/s\n", m.GamesStarted.Load(), perSec(m.GamesStarted.Load()))
	fmt.Printf("     games_completed / aborted........: %d / %d\n", gamesDone, gamesAborted)

	fmt.Printf("     gateway_active_clients (latest)..: %d   peak: %d\n", m.GatewayActiveClients.Load(), m.GatewayPeakActiveClients.Load())
	fmt.Printf("     gateway_grpc_streams (latest)....: %d   peak total: %d   peak per-gateway: %d\n", m.GatewayStreamsActive.Load(), m.GatewayPeakStreamsTotal.Load(), m.GatewayPeakStreamsPerGW.Load())
	fmt.Printf("     gateway_fanout_control_drops.....: %d\n", m.GatewayControlDrops.Load())
	fmt.Printf("     gateway_fanout_lossy_drops.......: %d\n", m.GatewayLossyDrops.Load())
	fmt.Printf("     gateway_send_drops...............: %d\n", m.GatewaySendDrops.Load())
	fmt.Printf("     gateway_health polls ok/partial/err: %d / %d / %d\n", m.GatewayHealthPollsDone.Load(), m.GatewayHealthPartialPoll.Load(), m.GatewayHealthFailures.Load())

	latSnap := m.MessageLatency.Snapshot()
	printTrend("toggle_ready->player_list latency", latSnap, "ms")
	fmt.Printf("     messages_received (inner msgs)...: %d   %.1f/s\n", msgsRecv, float64(msgsRecv)/durSec)
	fmt.Printf("     messages_sent....................: %d   %.1f/s\n", msgsSent, float64(msgsSent)/durSec)
	fmt.Printf("   ✓ player_session_completion_rate...: %.2f%%   ✓ %d   ✗ %d\n", sessRate, sessDone, sub0(plannedPlayers, sessDone))
	fmt.Printf("     sessions_aborted.................: %d\n", sessAborted)

	createSnap := m.RoomCreateRTT.Snapshot()
	joinSnap := m.RoomJoinRTT.Snapshot()
	printTrend("room_create_rtt", createSnap, "ms")
	printTrend("room_join_rtt", joinSnap, "ms")
	fmt.Printf("     rooms_created....................: %d\n", m.RoomsCreated.Load())
	fmt.Printf("     rooms_joined.....................: %d\n", m.RoomsJoined.Load())

	printTrend("ws_connection_duration (socket)", m.WSConnectionDuration.Snapshot(), "ms")
	printTrend("session_duration (VU lifetime)", m.SessionDuration.Snapshot(), "ms")
	fmt.Printf("   ✓ ws_connection_success (k6 view)..: %.2f%%   ✓ %d   ✗ %d (attempts exclude coordinator failures)\n", connRateK6, connected, sub0(attempted, connected))
	fmt.Printf("   ✓ player_connect (end-to-end)......: %.2f%%   ✓ %d   ✗ %d (planned VUs: %d)\n", connRateE2E, connected, sub0(planned, connected), planned)
	fmt.Printf("     ws_connections_opened/closed.....: %d / %d\n", opened, closed)
	printTrend("ws_open_rtt", m.WSOpenRTT.Snapshot(), "ms")

	// ── Guardrail thresholds ──
	fmt.Println("\n════ THRESHOLDS (guardrails vs strict mode) ════")
	var targetConn, targetGame, targetSess float64
	if cfg.Strict {
		targetConn, targetGame, targetSess = 99.0, 80.0, 80.0
		fmt.Println("  [MODE: STRICT=1 — acceptance requirements enforced as hard thresholds]")
	} else {
		targetConn, targetGame, targetSess = 95.0, 70.0, 70.0
		fmt.Println("  [MODE: STRICT=0 — looser engineering guardrails; run with STRICT=1 for hard requirements]")
	}
	joinNeeded := cfg.PlayersPerRoom > 1
	threshConn := connRateE2E >= targetConn
	threshGame := gameRatePlanned >= targetGame
	threshSess := sessRate >= targetSess
	threshCreate := createSnap.Count > 0 && createSnap.P95 < 5000.0
	threshJoin := !joinNeeded || (joinSnap.Count > 0 && joinSnap.P95 < 5000.0)
	threshLat := latSnap.Count > 0 && latSnap.P95 <= 50.0

	fmt.Printf("  [%s] player_connect end-to-end: %.2f%% (>=%.0f%%)\n", passFailStr(threshConn), connRateE2E, targetConn)
	fmt.Printf("  [%s] game_completion_rate (planned): %.2f%% (>=%.0f%%)\n", passFailStr(threshGame), gameRatePlanned, targetGame)
	fmt.Printf("  [%s] player_session_completion_rate: %.2f%% (>=%.0f%%)\n", passFailStr(threshSess), sessRate, targetSess)
	fmt.Printf("  [%s] room_create_rtt p95: %s (<5000ms)\n", passFailStr(threshCreate), formatLatStr(createSnap))
	if joinNeeded {
		fmt.Printf("  [%s] room_join_rtt p95: %s (<5000ms)\n", passFailStr(threshJoin), formatLatStr(joinSnap))
	}
	fmt.Printf("  [%s] toggle_ready->player_list p95: %s (<=50ms)\n", passFailStr(threshLat), formatLatStr(latSnap))

	// ── Acceptance ──
	fmt.Println("\n════ ACCEPTANCE (requirements, not guardrails) ════")
	req91 := connRateE2E >= 99.0
	req92 := latSnap.Count > 0 && latSnap.P95 <= 50.0
	req93 := gameRatePlanned >= 80.0
	fmt.Printf("  [%s] 9.1 connection success (end-to-end): %.2f%% (target >=99%%)\n", passFailStr(req91), connRateE2E)
	fmt.Printf("  [%s] 9.2 toggle_ready->player_list p95: %s (target <=50ms; proxy for message latency)\n", passFailStr(req92), formatLatStr(latSnap))
	fmt.Printf("  [%s] 9.3 game completion (planned rooms): %.2f%% (target >=80%%)\n", passFailStr(req93), gameRatePlanned)

	pollsDone := m.GatewayHealthPollsDone.Load()
	peakTotal := m.GatewayPeakStreamsTotal.Load()
	peakPerGW := m.GatewayPeakStreamsPerGW.Load()
	targetTotalStreams := uint64(cfg.TargetStreamsTotal)
	if targetTotalStreams == 0 {
		targetTotalStreams = 1500
		if len(cfg.HealthURLs)*150 > 1500 {
			targetTotalStreams = uint64(len(cfg.HealthURLs) * 150)
		}
	}

	// Measured only if at least one complete, valid poll saw streams > 0 under load.
	measured := len(cfg.HealthURLs) > 0 && pollsDone > 0 && peakTotal > 0
	req94, req95 := false, false
	s94, s95 := "NOT MEASURED", "NOT MEASURED"
	if measured {
		req94 = peakTotal < targetTotalStreams
		req95 = peakPerGW < 200
		s94 = strconv.FormatUint(peakTotal, 10)
		s95 = strconv.FormatUint(peakPerGW, 10)
	}
	fmt.Printf("  [%s] 9.4 total gRPC streams (peak): %s (target <%d)\n", passFailStr(req94), s94, targetTotalStreams)
	fmt.Printf("  [%s] 9.5 per-GATEWAY streams (peak): %s (target <200) — proxy for per-worker; confirm on worker /metrics\n", passFailStr(req95), s95)
	if !measured {
		fmt.Println("        (9.4/9.5 unmeasured: need >=1 complete health poll with streams > 0; check HEALTH_URLS and field names)")
	}

	allReq := req91 && req92 && req93 && req94 && req95
	allThresh := threshConn && threshGame && threshSess && threshCreate && threshJoin && threshLat
	overall := allReq
	if cfg.Strict {
		overall = overall && allThresh
	}

	if overall {
		fmt.Println("  ── OVERALL ACCEPTANCE: PASS ──")
	} else {
		fmt.Println("  ── OVERALL ACCEPTANCE: FAIL ──")
	}
	if !cfg.Strict {
		fmt.Println("  (guardrails above are looser; STRICT=1 also enforces them as hard thresholds)")
	}
	fmt.Println("==========================================================")
	return overall
}
