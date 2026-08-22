"""Parse gateway logs and count occurrences of each log tag.

Usage:
    python parse_logs.py gateway_logs.txt
    python parse_logs.py gateway_logs.txt --errors-only
"""

import json
import re
import sys
from collections import Counter

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

pattern = re.compile(
    r"\[gateway\]\s+("
    + "|".join(TAGS)
    + r")\b"
)


def parse(filepath, errors_only=False):
    counts = Counter()
    dial_errors = Counter()  # Track specific dial error types

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = pattern.search(line)
            if m:
                tag = m.group(1)
                counts[tag] += 1

                # Extract dial error details
                if tag in ("DIAL_RETRY", "DIAL_FAILED"):
                    err_match = re.search(r"err=(.+?)(?:\s|$)", line)
                    if err_match:
                        err_text = err_match.group(1).strip()
                        # Normalize the error
                        if "connection refused" in err_text:
                            dial_errors["connection_refused"] += 1
                        elif "i/o timeout" in err_text:
                            dial_errors["io_timeout"] += 1
                        elif "connection reset" in err_text:
                            dial_errors["connection_reset"] += 1
                        elif "context deadline" in err_text:
                            dial_errors["context_deadline"] += 1
                        elif "EOF" in err_text:
                            dial_errors["eof"] += 1
                        else:
                            dial_errors[err_text[:80]] += 1

    result = {tag: counts.get(tag, 0) for tag in TAGS}

    if errors_only:
        result = {k: v for k, v in result.items() if v > 0 and k not in ("CONNECTED", "DIAL_OK", "SESSION_END")}

    if dial_errors:
        result["dial_error_breakdown"] = dict(dial_errors.most_common())

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_logs.py <logfile> [--errors-only]")
        sys.exit(1)

    filepath = sys.argv[1]
    errors_only = "--errors-only" in sys.argv

    result = parse(filepath, errors_only)
    print(json.dumps(result, indent=2))
