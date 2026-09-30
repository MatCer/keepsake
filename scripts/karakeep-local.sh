#!/usr/bin/env bash
# Throwaway Karakeep on 127.0.0.1:3999, pinned to the deployed version, for adapter tests.
# Crawler and video workers are disabled and outbound crawl traffic goes to a dead proxy,
# so bookmarking a YouTube URL here never makes a request to YouTube.
#
#   scripts/karakeep-local.sh up     # start, create a test user, write .karakeep-local/env
#   scripts/karakeep-local.sh down   # stop and delete all local data
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=0.32.0
NAME=keepsake-karakeep
PORT=3999
DIR=.karakeep-local
ADDR="http://127.0.0.1:$PORT"
EMAIL=test@keepsake.local
PASSWORD=keepsake-test-password

trpc() { curl -fsS -X POST "$ADDR/api/trpc/$1" -H 'content-type: application/json' -d "{\"json\":$2}"; }

case "${1:-}" in
  up)
    mkdir -p "$DIR/data"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" \
      -v "$PWD/$DIR/data:/data" \
      -e DATA_DIR=/data -e NEXTAUTH_URL="$ADDR" -e NEXTAUTH_SECRET=keepsake-local-only \
      -e WORKERS_DISABLED_WORKERS=crawler,lowPriorityCrawler,video,inference,feed,webhook \
      -e CRAWLER_HTTP_PROXY=http://127.0.0.1:9 -e CRAWLER_HTTPS_PROXY=http://127.0.0.1:9 \
      "ghcr.io/karakeep-app/karakeep:$VERSION" >/dev/null
    for _ in $(seq 60); do curl -fsS "$ADDR/api/health" >/dev/null 2>&1 && break; sleep 2; done
    curl -fsS "$ADDR/api/version"; echo
    trpc users.create "{\"name\":\"Keepsake Test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"confirmPassword\":\"$PASSWORD\"}" >/dev/null 2>&1 || true
    KEY=$(trpc apiKeys.exchange "{\"keyName\":\"keepsake-test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" |
      python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["data"]["json"]["key"])')
    printf 'KARAKEEP_ADDR=%s\nKARAKEEP_API_KEY=%s\nKARAKEEP_EMAIL=%s\nKARAKEEP_PASSWORD=%s\n' "$ADDR" "$KEY" "$EMAIL" "$PASSWORD" >| "$DIR/env"
    echo "Karakeep $VERSION on $ADDR; credentials in $DIR/env"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$DIR"
    ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
