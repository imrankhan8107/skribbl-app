"""Unit tests for gRPC service discovery registration in Redis."""

import asyncio
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from backend.grpc_registry import (
    GRPC_PORT,
    _GRPC_ADDRESSES_HASH,
    _GRPC_ALIVE_KEY_PREFIX,
    _GRPC_ALIVE_TTL,
    _REFRESH_INTERVAL,
    _alive_key,
    register_grpc_worker,
    unregister_grpc_worker,
    is_grpc_registered,
)


@pytest.fixture(autouse=True)
def reset_module_state():
    """Reset module-level state between tests."""
    import backend.grpc_registry as mod
    mod._refresh_task = None
    mod._registered = False
    yield
    # Cleanup: cancel any lingering refresh tasks
    if mod._refresh_task and not mod._refresh_task.done():
        mod._refresh_task.cancel()
    mod._refresh_task = None
    mod._registered = False


class TestAliveKey:
    """Tests for the liveness key builder."""

    def test_alive_key_format(self):
        assert _alive_key("worker-123") == "worker_grpc_alive:worker-123"

    def test_alive_key_with_uuid(self):
        worker_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        assert _alive_key(worker_id) == f"worker_grpc_alive:{worker_id}"


class TestConstants:
    """Verify constants match requirements."""

    def test_default_grpc_port(self):
        # Default port is 50051 unless overridden by env
        assert GRPC_PORT == 50051

    def test_alive_ttl_is_30_seconds(self):
        assert _GRPC_ALIVE_TTL == 30

    def test_refresh_interval_is_10_seconds(self):
        assert _REFRESH_INTERVAL == 10


class TestRegisterGrpcWorker:
    """Tests for register_grpc_worker."""

    @pytest.mark.asyncio
    async def test_register_sets_hash_and_alive_key(self):
        """Registration should set the address hash and liveness key."""
        mock_redis = AsyncMock()

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=True):
            await register_grpc_worker("worker-1", "my-host", 50051)

            # Verify hash set
            mock_redis.hset.assert_called_once_with(
                _GRPC_ADDRESSES_HASH, "worker-1", "my-host:50051"
            )
            # Verify liveness key set with TTL
            mock_redis.set.assert_called_once_with(
                "worker_grpc_alive:worker-1", "1", ex=30
            )
            assert is_grpc_registered()

        # Cleanup refresh task
        import backend.grpc_registry as mod
        if mod._refresh_task:
            mod._refresh_task.cancel()
            try:
                await mod._refresh_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_register_uses_default_port_from_env(self):
        """Registration should use GRPC_PORT env default when no port provided."""
        mock_redis = AsyncMock()

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=True):
            await register_grpc_worker("worker-1", "container-7")

            mock_redis.hset.assert_called_once_with(
                _GRPC_ADDRESSES_HASH, "worker-1", f"container-7:{GRPC_PORT}"
            )

        import backend.grpc_registry as mod
        if mod._refresh_task:
            mod._refresh_task.cancel()
            try:
                await mod._refresh_task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_register_skips_when_redis_disabled(self):
        """Registration should be a no-op when Redis is not enabled."""
        with patch("backend.redis_pubsub._redis_client", None), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=False):
            await register_grpc_worker("worker-1", "host-1")
            assert not is_grpc_registered()

    @pytest.mark.asyncio
    async def test_register_handles_redis_error(self):
        """Registration should log error and not crash on Redis failure."""
        mock_redis = AsyncMock()
        mock_redis.hset.side_effect = Exception("Connection refused")

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=True):
            await register_grpc_worker("worker-1", "host-1")
            assert not is_grpc_registered()

    @pytest.mark.asyncio
    async def test_register_starts_refresh_task(self):
        """Registration should start a background refresh task."""
        mock_redis = AsyncMock()

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=True):
            await register_grpc_worker("worker-1", "host-1")

            import backend.grpc_registry as mod
            assert mod._refresh_task is not None
            assert not mod._refresh_task.done()

            # Cleanup
            mod._refresh_task.cancel()
            try:
                await mod._refresh_task
            except asyncio.CancelledError:
                pass


class TestUnregisterGrpcWorker:
    """Tests for unregister_grpc_worker."""

    @pytest.mark.asyncio
    async def test_unregister_removes_hash_and_alive_key(self):
        """Unregistration should remove address hash entry and liveness key."""
        mock_redis = AsyncMock()

        import backend.grpc_registry as mod
        mod._registered = True

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=True):
            await unregister_grpc_worker("worker-1")

            mock_redis.hdel.assert_called_once_with(
                _GRPC_ADDRESSES_HASH, "worker-1"
            )
            mock_redis.delete.assert_called_once_with(
                "worker_grpc_alive:worker-1"
            )
            assert not is_grpc_registered()

    @pytest.mark.asyncio
    async def test_unregister_cancels_refresh_task(self):
        """Unregistration should cancel the background refresh task."""
        mock_redis = AsyncMock()

        import backend.grpc_registry as mod
        mod._registered = True
        # Create a dummy task
        mod._refresh_task = asyncio.create_task(asyncio.sleep(999))

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.redis_pubsub.is_redis_enabled", return_value=True):
            await unregister_grpc_worker("worker-1")

            assert mod._refresh_task is None

    @pytest.mark.asyncio
    async def test_unregister_noop_when_not_registered(self):
        """Unregistration should be safe when worker was never registered."""
        mock_redis = AsyncMock()

        with patch("backend.redis_pubsub._redis_client", mock_redis):
            await unregister_grpc_worker("worker-1")
            # Should not call Redis
            mock_redis.hdel.assert_not_called()
            mock_redis.delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_unregister_handles_redis_error(self):
        """Unregistration should not crash on Redis failure."""
        mock_redis = AsyncMock()
        mock_redis.hdel.side_effect = Exception("Connection lost")

        import backend.grpc_registry as mod
        mod._registered = True

        with patch("backend.redis_pubsub._redis_client", mock_redis):
            # Should not raise
            await unregister_grpc_worker("worker-1")


class TestRefreshLiveness:
    """Tests for the background liveness refresh loop."""

    @pytest.mark.asyncio
    async def test_refresh_loop_sets_key_periodically(self):
        """The refresh loop should re-set the alive key every interval."""
        mock_redis = AsyncMock()
        call_count = 0
        original_set = mock_redis.set

        async def counting_set(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return await original_set(*args, **kwargs)

        mock_redis.set = counting_set

        with patch("backend.redis_pubsub._redis_client", mock_redis), \
             patch("backend.grpc_registry._REFRESH_INTERVAL", 0.05):
            import backend.grpc_registry as mod
            from backend.grpc_registry import _refresh_liveness_loop
            task = asyncio.create_task(_refresh_liveness_loop("worker-1"))

            # Wait for a couple of refreshes
            await asyncio.sleep(0.15)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            # Should have been called at least twice
            assert call_count >= 2
