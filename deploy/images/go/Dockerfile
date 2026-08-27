FROM golang:1.26.7-bookworm@sha256:e8c859f5632dcfde7b32d2012b4351728f6437930887c2f6a91ea242459e5514 AS build

WORKDIR /src
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/scheduler ./cmd/scheduler \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/recorder ./cmd/recorder

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 vigil \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vigil \
    && mkdir -p /app /spool \
    && chown -R 65532:65532 /app /spool
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/scheduler /out/recorder /app/
USER 65532:65532
ENTRYPOINT ["/app/scheduler"]

