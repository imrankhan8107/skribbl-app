# Multi-stage build: build frontend, then serve everything from Python

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend + built frontend
FROM python:3.12-slim
WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Copy proto definition and regenerate Python stubs to match installed protobuf version
COPY proto/ ./proto/
RUN python -m grpc_tools.protoc \
    --python_out=backend/proto \
    --grpc_python_out=backend/proto \
    --proto_path=proto \
    proto/game.proto \
    && touch backend/proto/__init__.py \
    && sed -i 's/import game_pb2/from backend.proto import game_pb2/' backend/proto/game_pb2_grpc.py

# Copy built frontend from stage 1
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Expose ports (8000 = HTTP/WS, 50051 = gRPC)
EXPOSE 8000 50051

# Run with uvicorn — tuned for high connection bursts
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --backlog 4096 --timeout-keep-alive 120 --loop uvloop"]
