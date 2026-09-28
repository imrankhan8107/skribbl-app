#!/usr/bin/env python3
"""
Periodic Grafana Dashboard Screenshot Capture Tool

Captures high-resolution snapshots of your Grafana dashboard at a configurable interval
(e.g., every 30 seconds) using Playwright.

Prerequisites:
    pip install playwright
    playwright install chromium

Usage:
    python scripts/capture_grafana.py --url "http://<lb-ip>:3000/d/skribbl-overview/skribbl-overview-dashboard?kiosk" --interval 30
"""

import argparse
import os
import sys
import time
from datetime import datetime


def main():
    parser = argparse.ArgumentParser(description="Capture periodic screenshots of a Grafana dashboard.")
    parser.add_argument(
        "--url",
        default="http://localhost:3000/d/skribbl-overview/skribbl-overview-dashboard?kiosk",
        help="Full Grafana dashboard URL. Tip: Append '?kiosk' to hide sidebars and headers.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=30,
        help="Capture interval in seconds (default: 30).",
    )
    parser.add_argument(
        "--output-dir",
        default="screenshots",
        help="Directory to store captured screenshots (default: ./screenshots).",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=1920,
        help="Browser viewport width (default: 1920).",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=1080,
        help="Browser viewport height (default: 1080).",
    )
    parser.add_argument(
        "--wait",
        type=float,
        default=3.0,
        help="Seconds to wait after navigation/refresh for panels to render (default: 3.0).",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=0,
        help="Number of screenshots to take before exiting (default: 0 = continuous until Ctrl+C).",
    )

    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("\n[ERROR] Playwright is not installed.")
        print("Please install it with:")
        print("    pip install playwright")
        print("    playwright install chromium\n")
        sys.exit(1)

    # Ensure output directory exists
    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 65)
    print(" Grafana Periodic Screenshot Capturer")
    print(f" URL:        {args.url}")
    print(f" Interval:   {args.interval}s")
    print(f" Resolution: {args.width}x{args.height}")
    print(f" Output Dir: {os.path.abspath(args.output_dir)}")
    print("=" * 65)
    print("Press Ctrl+C to stop.\n")

    captured = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": args.width, "height": args.height})
        page = context.new_page()

        print(f"Navigating to Grafana dashboard...")
        page.goto(args.url, wait_until="networkidle")
        time.sleep(args.wait)

        try:
            while True:
                timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                filename = f"grafana_{timestamp}.png"
                filepath = os.path.join(args.output_dir, filename)

                # Capture snapshot
                page.screenshot(path=filepath, full_page=False)
                captured += 1
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Saved #{captured}: {filepath}")

                if args.count > 0 and captured >= args.count:
                    print(f"\nReached target count of {args.count} screenshots. Exiting.")
                    break

                # Wait for next cycle
                time.sleep(args.interval)

                # Refresh or let live auto-refresh update data
                page.reload(wait_until="networkidle")
                time.sleep(args.wait)

        except KeyboardInterrupt:
            print("\nStopped by user.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
