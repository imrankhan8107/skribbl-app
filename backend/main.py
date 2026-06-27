"""FastAPI application entry point.

Mounts static files for the frontend and registers the WebSocket route.
Manages Redis pub/sub lifecycle for multi-worker deployment.
"""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from backend.ws_handler import websocket_handler
from backend import redis_pubsub

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialize Redis on startup, shutdown on exit."""
    from backend.ws_handler import room_manager
    await redis_pubsub.init_redis(room_manager.handle_redis_message)
    logger.info("Application started (worker_id=%s)", redis_pubsub.get_worker_id())
    yield
    await redis_pubsub.shutdown_redis()
    logger.info("Application shutdown (worker_id=%s)", redis_pubsub.get_worker_id())


app = FastAPI(title="Pictionary Game", lifespan=lifespan)

# CORS middleware for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StickySessionMiddleware(BaseHTTPMiddleware):
    """Sets a worker_id cookie so load balancers can route to the same worker.

    On first request, the response gets a `worker_id` cookie with this
    worker's unique ID. Subsequent requests from the client include this
    cookie, which the load balancer (nginx, Azure Front Door, etc.) can
    use for sticky session routing.
    """

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        # Set the worker_id cookie if not already present in the request
        if "worker_id" not in request.cookies:
            response.set_cookie(
                key="worker_id",
                value=redis_pubsub.get_worker_id(),
                httponly=True,
                samesite="lax",
                max_age=86400,  # 24 hours
            )
        return response


# Only add sticky session middleware when Redis is configured (multi-worker mode)
if redis_pubsub.REDIS_URL:
    app.add_middleware(StickySessionMiddleware)


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
