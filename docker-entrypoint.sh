#!/bin/sh
# RazorVasooli.Ai container entrypoint — apply migrations, then boot.
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[Entrypoint] Applying Prisma migrations..."
  npx prisma migrate deploy || exit 1
fi

exec npx tsx server/index.ts
