FROM node:22-slim

# System dependencies for optional integrations
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    imagemagick \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Data volumes
VOLUME /data/vault
VOLUME /data/sessions

ENV VAULT_PATH=/data/vault
ENV SESSIONS_DIR=/data/sessions
ENV LETYCLAW_PROJECT_ROOT=/app

EXPOSE 3100

CMD ["node", "dist/bot.js"]
