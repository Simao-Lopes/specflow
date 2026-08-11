FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# Web UI
COPY web/package*.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

FROM node:22-slim
WORKDIR /app
# git for the git layer, plus ssh keys mount for pushes
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/dist ./web/dist
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
COPY config.example.yaml ./
ENV NODE_ENV=production
EXPOSE 9120
CMD ["node", "src/api/server-entry.js"]