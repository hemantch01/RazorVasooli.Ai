# RazorVasooli.Ai — Production Container (multi-stage)
# Build:  docker build -t razorvasooli .
# Run:    docker compose up -d   (app + postgres + redis + mailpit)

# ── Stage 1: build frontend + typecheck ──────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.server.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src
COPY server ./server
RUN npm run build

# ── Stage 2: lean runtime ────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# tini for proper signal handling (SIGTERM → graceful BullMQ/HTTP shutdown)
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/ready >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./docker-entrypoint.sh"]