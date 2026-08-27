FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg nginx \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 vigil \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vigil \
    && mkdir -p /srv/hls /tmp/nginx \
    && chown -R 65532:65532 /srv/hls /tmp/nginx
COPY --chown=65532:65532 deploy/images/synthetic-hls/nginx.conf /etc/nginx/nginx.conf
COPY --chown=65532:65532 deploy/images/synthetic-hls/start.sh /app/start.sh
RUN chmod 0555 /app/start.sh
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]

