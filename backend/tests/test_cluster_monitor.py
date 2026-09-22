"""Unit tests for cluster_monitor.py."""

import http.server
import json
import threading
import time
import urllib.request
import pytest

from scripts.cluster_monitor import (
    MetricAccumulator,
    create_http_handler,
    format_table,
    parse_nodes_arg,
    reset_node_metrics,
    fetch_node_summary,
)


def test_metric_accumulator_min_max_avg_and_totals():
    acc = MetricAccumulator(role="worker")
    assert acc.role == "worker"

    # Sample 1: 20% CPU, 1000MB, 10 Mbps RX, 50 Mbps TX, 100 conns
    acc.record_sample(
        cpu_pct=20.0,
        mem_mb=1000.0,
        mem_total_mb=16000.0,
        rx_mbps=10.0,
        tx_mbps=50.0,
        raw_rx_bytes=10_000_000,
        raw_tx_bytes=50_000_000,
        tcp_conns=100,
    )

    # Sample 2: 40% CPU, 2000MB, 30 Mbps RX, 150 Mbps TX, 300 conns
    acc.record_sample(
        cpu_pct=40.0,
        mem_mb=2000.0,
        mem_total_mb=16000.0,
        rx_mbps=30.0,
        tx_mbps=150.0,
        raw_rx_bytes=20_000_000,
        raw_tx_bytes=100_000_000,
        tcp_conns=300,
    )

    summary = acc.get_summary()
    assert summary["role"] == "worker"
    assert summary["samples_count"] == 2

    # CPU checks
    assert summary["cpu_percent"]["min"] == 20.0
    assert summary["cpu_percent"]["max"] == 40.0
    assert summary["cpu_percent"]["avg"] == 30.0

    # Memory checks
    assert summary["memory_mb"]["min"] == 1000.0
    assert summary["memory_mb"]["max"] == 2000.0
    assert summary["memory_mb"]["avg"] == 1500.0
    assert summary["memory_mb"]["total_mb"] == 16000.0

    # Network rate checks
    assert summary["network_rx_mbps"]["min"] == 10.0
    assert summary["network_rx_mbps"]["max"] == 30.0
    assert summary["network_rx_mbps"]["avg"] == 20.0

    assert summary["network_tx_mbps"]["min"] == 50.0
    assert summary["network_tx_mbps"]["max"] == 150.0
    assert summary["network_tx_mbps"]["avg"] == 100.0

    # Cumulative delta bytes: (20M - 10M) = 10M bytes RX; (100M - 50M) = 50M bytes TX
    assert summary["network_rx_mbps"]["total_mb"] == round(10_000_000 / (1024 * 1024), 2)
    assert summary["network_tx_mbps"]["total_mb"] == round(50_000_000 / (1024 * 1024), 2)

    # TCP checks
    assert summary["tcp_connections"]["min"] == 100
    assert summary["tcp_connections"]["max"] == 300
    assert summary["tcp_connections"]["avg"] == 200.0

    # Reset
    acc.reset()
    new_summary = acc.get_summary()
    assert new_summary["samples_count"] == 0


def test_parse_nodes_arg():
    arg = "lb:10.0.1.10,gw1:10.0.1.20:9101,worker1:10.0.1.30:9200,10.0.1.40"
    nodes = parse_nodes_arg(arg, default_port=9101)

    assert nodes == [
        ("lb", "10.0.1.10", 9101),
        ("gw1", "10.0.1.20", 9101),
        ("worker1", "10.0.1.30", 9200),
        ("node", "10.0.1.40", 9101),
    ]


def test_format_table():
    sample_data = {
        "role": "gateway",
        "cpu_percent": {"min": 5.0, "avg": 25.0, "max": 45.0},
        "memory_mb": {"min": 1000.0, "avg": 1500.0, "max": 2000.0},
        "network_rx_mbps": {"min": 10.0, "avg": 50.0, "max": 100.0, "total_gb": 5.25},
        "network_tx_mbps": {"min": 20.0, "avg": 120.0, "max": 250.0, "total_gb": 12.80},
    }

    results = [
        ("gw1", "10.0.1.20", sample_data),
        ("gw2", "10.0.1.21", None),  # Unreachable node test
    ]

    table = format_table(results)
    assert "CLUSTER INSTANCE LOAD & NETWORK TRAFFIC REPORT" in table
    assert "gw1 (10.0.1.20)" in table
    assert "gateway" in table
    assert "25.0%" in table
    assert "100.0 Mbps" in table
    assert "[AGENT UNREACHABLE]" in table
    assert "FLEET TOTAL / PEAK" in table


def test_http_agent_endpoints():
    acc = MetricAccumulator(role="test-node")
    acc.record_sample(
        cpu_pct=15.0,
        mem_mb=512.0,
        mem_total_mb=4096.0,
        rx_mbps=5.0,
        tx_mbps=10.0,
        raw_rx_bytes=1000,
        raw_tx_bytes=2000,
        tcp_conns=5,
    )

    handler_cls = create_http_handler(acc)
    # Bind to random ephemeral port on localhost
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    port = server.server_address[1]

    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    try:
        # Test fetch /summary
        summary = fetch_node_summary("127.0.0.1", port)
        assert summary is not None
        assert summary["role"] == "test-node"
        assert summary["cpu_percent"]["avg"] == 15.0

        # Test /reset
        ok = reset_node_metrics("127.0.0.1", port)
        assert ok is True

        # Verify summary reset
        after_reset = fetch_node_summary("127.0.0.1", port)
        assert after_reset["samples_count"] == 0

    finally:
        server.shutdown()
        server.server_close()

