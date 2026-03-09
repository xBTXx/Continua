#!/bin/sh
set -e

if [ ! -d "/app/node_modules" ] || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  npm install
else
  node -e "require.resolve('pg')" >/dev/null 2>&1 || npm install
  node -e "require.resolve('react-markdown')" >/dev/null 2>&1 || npm install
  node -e "require.resolve('remark-gfm')" >/dev/null 2>&1 || npm install
  node -e "require.resolve('fast-xml-parser')" >/dev/null 2>&1 || npm install
  [ -x "/app/node_modules/.bin/mcp-crawl4ai-ts" ] || npm install
fi

exec npm run dev
