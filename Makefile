# Makefile for skribbl-app
# Proto compilation for Go gateway and Python backend

PROTO_SRC := proto/game.proto
GO_OUT := gateway/proto
PY_OUT := backend/proto

.PHONY: proto-gen clean-proto

proto-gen:
	@echo "==> Generating gRPC stubs from $(PROTO_SRC)..."
	@mkdir -p $(GO_OUT) $(PY_OUT)
	protoc \
		--go_out=$(GO_OUT) --go_opt=paths=source_relative \
		--go-grpc_out=$(GO_OUT) --go-grpc_opt=paths=source_relative \
		--proto_path=proto \
		proto/game.proto
	python -m grpc_tools.protoc \
		--python_out=$(PY_OUT) \
		--grpc_python_out=$(PY_OUT) \
		--proto_path=proto \
		proto/game.proto
	@touch $(PY_OUT)/__init__.py
	@echo "==> Proto generation complete."

clean-proto:
	@echo "==> Cleaning generated proto files..."
	rm -f $(GO_OUT)/game.pb.go $(GO_OUT)/game_grpc.pb.go
	rm -f $(PY_OUT)/game_pb2.py $(PY_OUT)/game_pb2_grpc.py $(PY_OUT)/__init__.py
	@echo "==> Clean complete."
