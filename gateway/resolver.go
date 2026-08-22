package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// WorkerResolver resolves worker IDs to reachable network addresses
// using a local cache backed by Redis lookups.
type WorkerResolver struct {
	redis    *redis.Client
	cache    sync.Map      // map[workerID]*cacheEntry
	cacheTTL time.Duration // how long to trust cached addresses
}

// cacheEntry stores a resolved worker address with timestamp.
type cacheEntry struct {
	Address   string
	FetchedAt time.Time
}

// NewWorkerResolver creates a resolver with the given Redis client and cache TTL.
func NewWorkerResolver(rdb *redis.Client, cacheTTL time.Duration) *WorkerResolver {
	return &WorkerResolver{
		redis:    rdb,
		cacheTTL: cacheTTL,
	}
}

// Resolve returns the reachable address (hostname:port) for a worker ID.
// Checks local cache first (O(1)), falls back to Redis HGET on miss/stale.
func (wr *WorkerResolver) Resolve(ctx context.Context, workerID string) (string, error) {
	// Check local cache first
	if entry, ok := wr.cache.Load(workerID); ok {
		cached := entry.(*cacheEntry)
		if time.Since(cached.FetchedAt) < wr.cacheTTL {
			return cached.Address, nil
		}
		// Cache entry is stale — fall through to Redis
	}

	// Cache miss or stale — fetch from Redis
	if wr.redis == nil {
		return "", fmt.Errorf("redis not configured")
	}

	addr, err := wr.redis.HGet(ctx, "worker_addresses", workerID).Result()
	if err == redis.Nil {
		return "", fmt.Errorf("worker %s not registered", workerID)
	}
	if err != nil {
		return "", fmt.Errorf("redis lookup failed: %w", err)
	}

	// Update cache
	wr.cache.Store(workerID, &cacheEntry{
		Address:   addr,
		FetchedAt: time.Now(),
	})

	return addr, nil
}

// IsAlive checks whether a worker's liveness key exists in Redis.
// Returns true if the worker has refreshed its heartbeat within 30 seconds.
func (wr *WorkerResolver) IsAlive(ctx context.Context, workerID string) (bool, error) {
	if wr.redis == nil {
		return false, fmt.Errorf("redis not configured")
	}

	exists, err := wr.redis.Exists(ctx, "worker_alive:"+workerID).Result()
	if err != nil {
		return false, fmt.Errorf("redis exists check failed: %w", err)
	}

	return exists > 0, nil
}

// Evict removes a worker from the local cache.
// Called when a dial to that worker fails, forcing a fresh Redis lookup next time.
func (wr *WorkerResolver) Evict(workerID string) {
	wr.cache.Delete(workerID)
}

// CleanupDeadWorker removes a dead worker's entries from Redis.
// Called when IsAlive returns false — clears worker_addresses and worker_load.
func (wr *WorkerResolver) CleanupDeadWorker(ctx context.Context, workerID string) {
	if wr.redis == nil {
		return
	}
	wr.redis.HDel(ctx, "worker_addresses", workerID)
	wr.redis.ZRem(ctx, "worker_load", workerID)
	wr.cache.Delete(workerID)
	log.Printf("[resolver] Cleaned up dead worker: %s", workerID)
}

// StartCleanup runs a background goroutine that prunes stale cache entries
// every 10 seconds. Entries older than 2x the cache TTL are removed.
func (wr *WorkerResolver) StartCleanup(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pruneThreshold := 2 * wr.cacheTTL
			wr.cache.Range(func(key, value interface{}) bool {
				entry := value.(*cacheEntry)
				if time.Since(entry.FetchedAt) > pruneThreshold {
					wr.cache.Delete(key)
				}
				return true
			})
		}
	}
}
