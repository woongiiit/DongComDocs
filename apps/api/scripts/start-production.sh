#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Railway: add PostgreSQL, then API service Variables -> DATABASE_URL = \${{Postgres.DATABASE_URL}}"
  exit 1
fi

npx prisma db push
exec node dist/index.js
