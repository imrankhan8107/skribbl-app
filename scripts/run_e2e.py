#!/usr/bin/env python3
"""Cross-platform Cypress E2E runner for Skribbl.

Builds frontend/dist if missing, starts the FastAPI backend on 127.0.0.1:8000
in single-instance mode, waits for /health, runs `npx cypress run`, and cleans
up the server process on exit.
"""

import os
import subprocess
import sys
import tempfile
import time
import urllib.request


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")
DIST_INDEX = os.path.join(FRONTEND_DIR, "dist", "index.html")
PORT = os.environ.get("E2E_PORT", "8000")
BASE_URL = f"http://127.0.0.1:{PORT}"


def wait_for_health(timeout_s: float = 20.0) -> None:
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/health", timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception as exc:
            last_err = exc
        time.sleep(0.3)
    raise RuntimeError(f"Backend did not become healthy at {BASE_URL}/health: {last_err}")


def main() -> int:
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    npx_cmd = "npx.cmd" if os.name == "nt" else "npx"

    if not os.path.isfile(DIST_INDEX):
        print("Building frontend/dist for E2E test...")
        build = subprocess.run([npm_cmd, "run", "build"], cwd=FRONTEND_DIR)
        if build.returncode != 0:
            return build.returncode

    env = os.environ.copy()
    # Force single-instance mode (no external Redis required during local E2E)
    env["REDIS_URL"] = ""
    env["PORT"] = str(PORT)
    # Prevent parent Electron/IDE apps (e.g. VS Code) from forcing Cypress into Node mode
    env.pop("ELECTRON_RUN_AS_NODE", None)

    print(f"Starting FastAPI backend at {BASE_URL}...")
    log_file = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=ROOT_DIR,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    try:
        try:
            wait_for_health()
        except Exception:
            log_file.seek(0)
            print("--- FastAPI startup output ---")
            print(log_file.read())
            raise
        print("Backend is healthy. Running Cypress E2E suite...")
        result = subprocess.run([npx_cmd, "cypress", "run"], cwd=FRONTEND_DIR, env=env)
        return result.returncode
    finally:
        print("Stopping FastAPI backend...")
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        log_file.close()


if __name__ == "__main__":
    sys.exit(main())
