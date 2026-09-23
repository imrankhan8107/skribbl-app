"""Tests for the Prometheus metrics endpoint."""

import pytest
from fastapi.testclient import TestClient
from backend.main import app
from backend.metrics_exporter import (
    record_message,
    record_guess,
    set_active_rooms,
    set_active_players,
    set_grpc_streams,
)


@pytest.fixture
def client():
    return TestClient(app)


def test_metrics_endpoint_returns_prometheus_format(client):
    """Test that /metrics returns 200 and valid Prometheus exposition format."""
    set_active_rooms(5)
    set_active_players(25)
    set_grpc_streams(10)
    record_message("stroke", "inbound")
    record_message("chat", "inbound")
    record_guess("correct")
    record_guess("close")

    response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers.get("content-type", "")

    content = response.text
    assert "skribbl_worker_active_rooms" in content
    assert "skribbl_worker_active_players" in content
    assert "skribbl_worker_grpc_streams_serving" in content
    assert "skribbl_worker_messages_total" in content
    assert "skribbl_worker_guesses_total" in content

