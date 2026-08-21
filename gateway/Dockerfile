FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /gateway .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=builder /gateway /gateway
EXPOSE 9000
ENTRYPOINT ["/gateway"]
