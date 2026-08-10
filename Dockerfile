FROM node:22-slim AS build

# Native dependencies such as better-sqlite3 may need a compiler when a
# matching prebuilt binary is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

# Copy only build inputs; local config, vault data, and secrets are excluded.
COPY tsconfig.json ./*.ts ./
COPY services/ ./services/
COPY scripts/ ./scripts/
COPY tools/ ./tools/
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    imagemagick \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config/*.example.yaml ./config/
COPY agents/templates/ ./agents/templates/
COPY agents/shared/ ./agents/shared/
COPY agents/examples/ ./agents/examples/

# Register only the bundled local server. Optional browser/email/flight/market
# MCPs require separate host setup and are deliberately not pulled from latest.
RUN claude mcp add --scope user --transport stdio letyclaw-tools -- \
    node /app/dist/tools/letyclaw-mcp/server.js

RUN mkdir -p /data/vault /data/sessions /app/logs

VOLUME ["/data/vault", "/data/sessions"]
ENV VAULT_PATH=/data/vault \
    SESSIONS_DIR=/data/sessions \
    LETYCLAW_PROJECT_ROOT=/app \
    NODE_ENV=production

CMD ["node", "dist/bot.js"]
