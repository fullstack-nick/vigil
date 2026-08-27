#!/usr/bin/env bash
set -euo pipefail

mkdir -p /srv/hls/live
rm -f /srv/hls/live/*

ffmpeg \
  -hide_banner -loglevel warning -nostdin -re \
  -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -g 60 -keyint_min 60 -sc_threshold 0 -b:v 1800k -maxrate 2000k -bufsize 3600k \
  -c:a aac -b:a 128k -ar 48000 \
  -f hls -hls_time 2 -hls_list_size 8 \
  -hls_flags delete_segments+append_list+independent_segments+temp_file \
  -hls_segment_filename "/srv/hls/live/segment-%09d.ts" \
  /srv/hls/live/index.m3u8 &
ffmpeg_pid=$!

nginx -c /etc/nginx/nginx.conf -g "daemon off;" &
nginx_pid=$!

terminate() {
  kill -TERM "$ffmpeg_pid" "$nginx_pid" 2>/dev/null || true
  wait "$ffmpeg_pid" "$nginx_pid" 2>/dev/null || true
}
trap terminate EXIT INT TERM

while kill -0 "$ffmpeg_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do
  sleep 1
done
exit 1

