#!/bin/sh
# RazorVasooli.Ai container entrypoint — apply migrations, then boot.
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[Entrypoint] Applying Prisma migrations..."
  npx prisma migrate deploy || echo "[Entrypoint] ⚠️ migrate deploy failed (first run without migrations?) — continuing"
fi

exec npx tsx server/index.ts
