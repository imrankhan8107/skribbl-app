"""Parse gateway logs with full error messages and context.

Usage:
    python parse_logs_v2.py gateway_logs.txt
    python parse_logs_v2.py gateway_logs.txt --samples 5
"""

import json
import re
import sys
from collections import Counter, defaultdict

TAGS = [
    "UPGRADE_FAILED",
    "CONNECTED",
    "FIRST_MSG_FAILED",
    "NO_BACKEND",
    "DIAL_RETRY",
    "DIAL_FAILED",
    "DIAL_OK",
    "FORWARD_FAILED",
    "SESSION_END",
]

tag_pattern = re.compile(
    r"\[gateway\]\s+("
    + "|".join(TAGS)
    + r")\b"
)


def parse(filepath, max_samples=5):
    counts = Counter()
    dial_errors = Counter()
    full_error_messages = defaultdict(list)  # tag -> list of full error strings
    timing_data = defaultdict(list)  # tag -> list of timing values

    # Extract specific fields
    err_pattern = re.compile(r"err=(.+?)$")
    dial_ms_pattern = re.compile(r"dial_ms=(\d+)")
    elapsed_pattern = re.compile(r"elapsed=([^\s]+)")
    active_pattern = re.compile(r"active_backends=(\d+)")
    connid_pattern = re.compile(r"connID=(\d+)")
    attempts_pattern = re.compile(r"attempts?=(\d+)")
    total_ms_pattern = re.compile(r"total_ms=(\d+)")

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = tag_pattern.search(line)
            if not m:
                continue

            tag = m.group(1)
            counts[tag] += 1

            # Collect full error message for error tags
            if tag in ("DIAL_RETRY", "DIAL_FAILED", "UPGRADE_FAILED", "FIRST_MSG_FAILED", "FORWARD_FAILED", "NO_BACKEND"):
                err_match = err_pattern.search(line)
                if err_match:
                    err_text = err_match.group(1).strip()
                    # Normalize: strip port numbers and local addresses
                    normalized = re.sub(r"\[::1\]:\d+->", "[::1]:*->", err_text)
                    normalized = re.sub(r"127\.0\.0\.1:\d+->", "127.0.0.1:*->", normalized)
                    dial_errors[normalized] += 1
                    if len(full_error_messages[tag]) < max_samples:
                        full_error_messages[tag].append(err_text)

            # Collect timing for DIAL_OK
            if tag == "DIAL_OK":
                dm = dial_ms_pattern.search(line)
                if dm:
                    timing_data["dial_ms"].append(int(dm.group(1)))
                am = active_pattern.search(line)
                if am:
                    timing_data["active_backends_at_ok"].append(int(am.group(1)))

            # Collect timing for DIAL_FAILED
            if tag == "DIAL_FAILED":
                tm = total_ms_pattern.search(line)
                if tm:
                    timing_data["failed_total_ms"].append(int(tm.group(1)))
                am = active_pattern.search(line)
                if am:
                    timing_data["active_backends_at_fail"].append(int(am.group(1)))

            # Collect active_backends at first retry to see breaking point
            if tag == "DIAL_RETRY":
                att = attempts_pattern.search(line)
                if att and att.group(1) == "1":
                    am = active_pattern.search(line)
                    if am:
                        timing_data["active_backends_at_first_retry"].append(int(am.group(1)))

    # Build result
    result = {
        "counts": {tag: counts.get(tag, 0) for tag in TAGS},
        "dial_error_breakdown": dict(dial_errors.most_common(10)),
        "sample_errors": {tag: msgs for tag, msgs in full_error_messages.items()},
    }

    # Add timing stats
    timing_stats = {}
    for key, values in timing_data.items():
        if not values:
            continue
        values.sort()
        n = len(values)
        timing_stats[key] = {
            "count": n,
            "min": values[0],
            "max": values[-1],
            "median": values[n // 2],
            "p90": values[int(n * 0.9)] if n > 10 else values[-1],
            "p95": values[int(n * 0.95)] if n > 20 else values[-1],
            "avg": round(sum(values) / n, 1),
        }

    result["timing"] = timing_stats

    # Breaking point analysis
    if timing_data.get("active_backends_at_first_retry"):
        retries = timing_data["active_backends_at_first_retry"]
        result["breaking_point"] = {
            "first_error_at_backends": min(retries) if retries else None,
            "most_errors_around_backends": Counter(
                [v // 100 * 100 for v in retries]
            ).most_common(5),
        }

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_logs_v2.py <logfile> [--samples N]")
        sys.exit(1)

    filepath = sys.argv[1]
    max_samples = 5
    if "--samples" in sys.argv:
        idx = sys.argv.index("--samples")
        if idx + 1 < len(sys.argv):
            max_samples = int(sys.argv[idx + 1])

    result = parse(filepath, max_samples)
    print(json.dumps(result, indent=2))
