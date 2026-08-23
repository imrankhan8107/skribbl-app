# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go gateway
FROM golang:1.22-alpine AS go-build
WORKDIR /app
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/*.go ./
COPY gateway/proto/ ./proto/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /gateway .

# Stage 3: Runtime — gateway + frontend static files
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=go-build /gateway /gateway
COPY --from=frontend-build /app/frontend/dist /static
EXPOSE 9000
ENTRYPOINT ["/gateway"]
CMD ["-static", "/static"]
