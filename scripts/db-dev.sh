#!/usr/bin/env bash
set -euo pipefail
name=knotcat-postgres-dev
if docker container inspect "$name" >/dev/null 2>&1; then
  docker start "$name" >/dev/null
else
  docker run --name "$name" \
    -e POSTGRES_USER=knotcat -e POSTGRES_PASSWORD=local-development-only \
    -e POSTGRES_DB=knotcat -p 127.0.0.1:55432:5432 \
    -d postgres:18 >/dev/null
fi
for attempt in {1..30}; do
  if docker exec "$name" pg_isready -U knotcat >/dev/null; then
    echo 'Development PostgreSQL ready on 127.0.0.1:55432'
    exit 0
  fi
  sleep 1
done
echo 'PostgreSQL did not become ready' >&2
exit 1
