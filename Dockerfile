# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# SingulariTree Go core — ONE multistage image serving both CI and runtime.
#
#   target "build"   -> CI image: toolchain + full sources, so
#                       `docker run --rm <img> sh -c 'cd apps/go-core && go vet ./... && go test ./...'`
#                       works. This is the CI target.
#   target "runtime" -> minimal runtime: static binary + git, no toolchain.
#
# The build context is the monorepo root so the go.work workspace resolves
# (./apps/go-core + ./libs/contracts/gen). Generated contracts are committed,
# so NO `buf` step is ever run here.
# ---------------------------------------------------------------------------

FROM golang:1.27-alpine AS build

# GOTOOLCHAIN=local: modules target go 1.25/1.26; never download another toolchain.
# CGO_ENABLED=0:  modernc.org/sqlite is pure Go -> fully static binary.
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0

# git is needed by the core's GitPort read path (`exec git`) and by its tests.
# ca-certificates is needed for `go mod download` over HTTPS.
RUN apk add --no-cache git ca-certificates

WORKDIR /src

# Workspace + module manifests first so `go mod download` stays cached across
# source-only changes. libs/contracts/gen is required: apps/go-core replaces
# github.com/SingulariTree/go-core/gen => ../../libs/contracts/gen.
COPY go.work ./
COPY apps/go-core/go.mod apps/go-core/go.sum ./apps/go-core/
COPY libs/contracts/gen/go.mod libs/contracts/gen/go.sum ./libs/contracts/gen/
RUN cd apps/go-core && go mod download \
    && cd /src/libs/contracts/gen && go mod download

# Full sources. Migrations are embedded via //go:embed from
# apps/go-core/internal/repository/migrations/*.sql, so they must be present.
COPY apps/go-core/ ./apps/go-core/
COPY libs/contracts/gen/ ./libs/contracts/gen/

# Static, stripped binary at a stable path for the runtime stage.
RUN cd apps/go-core \
    && go build -trimpath -ldflags="-s -w" -o /out/go-core ./cmd/go-core

# ---------------------------------------------------------------------------
FROM alpine:3.21 AS runtime

# git:              required by the core's `exec git` adapter.
# ca-certificates:  remote Git over HTTPS.
# su-exec:          drop root in the entrypoint (host-owned socket/DB mounts).
RUN apk add --no-cache git ca-certificates su-exec

# Host UID/GID that must own the mounts so the host user can connect to the
# 0600 unix socket the core creates (ADR-004 / ipc-strategy §2.7).
ENV CORE_UID=1000 \
    CORE_GID=1000

COPY tools/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY --from=build /out/go-core /usr/local/bin/go-core

# /run/singularitree (bind, host-visible gRPC socket) and /data (named volume,
# SQLite + WAL) are provided by compose. Declared here for documentation only.
VOLUME ["/data"]

# No EXPOSE: transport stays loopback-only (HTTP fallback) / unix socket (gRPC).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--headless", \
     "--grpc-addr=unix:///run/singularitree/go-core.sock", \
     "--http-fallback-addr=127.0.0.1:0", \
     "--db=/data/cache.db"]
