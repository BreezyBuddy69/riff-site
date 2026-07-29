# Riff Sales & Redemption Platform
# Multi-Stage-Build. Der Server hat null npm-Dependencies (bewusste
# Entscheidung: minimale Angriffsfläche, kein Supply-Chain-Risiko,
# winziges Image) — die Build-Stage dient dem sauberen Datei-Zuschnitt.

# ── Stage 1: Zuschnitt ────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/

# ── Stage 2: Runtime ──────────────────────────────────────────────────
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# Non-Root: der Server braucht keinerlei Privilegien
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app

COPY --from=build --chown=node:node /app ./

# SQLite-Daten (Source of Truth!) liegen im Volume /data
VOLUME ["/data"]

EXPOSE 8080

# Healthcheck für Orchestrierung / Reverse Proxy (nutzt Node selbst — kein curl/wget nötig)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
