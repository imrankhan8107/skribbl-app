package main

import (
	"context"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// GatewayRegistry provides room-sticky routing across horizontally scaled
// gateways (Path A). Each gateway has a stable ID and advertises itself in
// Redis. When a room is created, the owning gateway records
// `room_gateway:<CODE> -> gatewayID` so that any joiner who lands on a
// DIFFERENT gateway (LB hash mismatch) can be redirected to the owner.
//
// Design notes (kept intentionally B-ready):
//   - The ownership key is the same primitive Path B (Redis pub/sub relay) would
//     need to know which gateways hold a room. Building it now means B layers
//     "subscribe + publish around local fan-out" on top rather than a rewrite.
//   - Fan-out stays entirely in-process (a room's players all live on one
//     gateway), so the syscall-bound fan-out path the pprof profile identified
//     is unchanged — we just run N gateways, each on its own cores.
//
// Redis keys:
//   gateway_addr:<ID>      -> client-reachable address for redirects (TTL 30s heartbeat)
//   room_gateway:<CODE>    -> owning gateway ID (TTL 1h, refreshed on activity)
type GatewayRegistry struct {
	redis     *redis.Client
	gatewayID string
	// selfAddr is the client-reachable address other gateways redirect to,
	// e.g. "gw-2.internal:9000" or a public hostname. Advertised in Redis.
	selfAddr string
}

const (
	gatewayHeartbeatTTL = 30 * time.Second
	gatewayHeartbeatInt = 10 * time.Second
	roomOwnerTTL        = 1 * time.Hour
)

// NewGatewayRegistry builds a registry. gatewayID and selfAddr default from the
// GATEWAY_ID and GATEWAY_ADDR env vars; gatewayID falls back to the hostname.
// Returns nil if redis is nil (single-gateway mode needs no registry).
func NewGatewayRegistry(rdb *redis.Client) *GatewayRegistry {
	if rdb == nil {
		return nil
	}
	id := os.Getenv("GATEWAY_ID")
	if id == "" {
		if h, err := os.Hostname(); err == nil && h != "" {
			id = h
		} else {
			id = "gateway"
		}
	}
	// selfAddr is advertised as this gateway's liveness marker. Since redirects
	// route back through the LB via ?gw=<id> (not a raw address), the value only
	// needs to be non-empty to signal "alive". Default to the gateway ID.
	addr := os.Getenv("GATEWAY_ADDR")
	if addr == "" {
		addr = id
	}
	return &GatewayRegistry{redis: rdb, gatewayID: id, selfAddr: addr}
}

// StartHeartbeat advertises this gateway's liveness on a periodic TTL refresh so
// peers can tell whether a room's owning gateway is still alive (and thus
// whether to redirect to it or reclaim the room). Runs until ctx is cancelled.
func (gr *GatewayRegistry) StartHeartbeat(ctx context.Context) {
	if gr == nil {
		return
	}
	gr.beat(ctx)
	ticker := time.NewTicker(gatewayHeartbeatInt)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			gr.unregister()
			return
		case <-ticker.C:
			gr.beat(ctx)
		}
	}
}

func (gr *GatewayRegistry) beat(ctx context.Context) {
	c, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	gr.redis.Set(c, "gateway_addr:"+gr.gatewayID, gr.selfAddr, gatewayHeartbeatTTL)
}

func (gr *GatewayRegistry) unregister() {
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	gr.redis.Del(c, "gateway_addr:"+gr.gatewayID)
}

// ClaimRoom records this gateway as the owner of a room. Called when a
// room_created response is observed. Idempotent; refreshes the TTL.
func (gr *GatewayRegistry) ClaimRoom(roomCode string) {
	if gr == nil || roomCode == "" {
		return
	}
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	gr.redis.Set(c, "room_gateway:"+roomCode, gr.gatewayID, roomOwnerTTL)
}

// RefreshRoom extends the ownership TTL for an active room (called on join so a
// long-lived room's key doesn't expire mid-game).
func (gr *GatewayRegistry) RefreshRoom(roomCode string) {
	if gr == nil || roomCode == "" {
		return
	}
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	gr.redis.Expire(c, "room_gateway:"+roomCode, roomOwnerTTL)
}

// OwnerOf returns the gateway ID that owns a room, or "" if unknown.
func (gr *GatewayRegistry) OwnerOf(roomCode string) string {
	if gr == nil || roomCode == "" {
		return ""
	}
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	owner, err := gr.redis.Get(c, "room_gateway:"+roomCode).Result()
	if err != nil {
		return ""
	}
	return owner
}

// AddrOf resolves a gateway ID to its client-reachable address, or "" if the
// gateway is unknown/dead (its heartbeat key expired).
func (gr *GatewayRegistry) AddrOf(gatewayID string) string {
	if gr == nil || gatewayID == "" {
		return ""
	}
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	addr, err := gr.redis.Get(c, "gateway_addr:"+gatewayID).Result()
	if err != nil {
		return ""
	}
	return addr
}

// IsOwner reports whether this gateway owns the room. Returns true when
// ownership is unknown (owner == "") so a fresh/uncoordinated room is served
// locally rather than bouncing the client — the create path will claim it.
func (gr *GatewayRegistry) IsOwner(roomCode string) bool {
	if gr == nil {
		return true // single-gateway mode: always the owner
	}
	owner := gr.OwnerOf(roomCode)
	return owner == "" || owner == gr.gatewayID
}
