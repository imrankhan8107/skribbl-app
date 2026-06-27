"""FastAPI application entry point.

Mounts static files for the frontend and registers the WebSocket route.
"""

import os

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.ws_handler import websocket_handler

app = FastAPI(title="Pictionary Game")

# CORS middleware for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# WebSocket endpoint — delegates to ws_handler for full message dispatch
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket_handler(websocket)


# Mount static files for the built frontend
# The frontend build output goes to frontend/dist
# Serve at root "/" so the SPA works in production (must be LAST mount)
static_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
