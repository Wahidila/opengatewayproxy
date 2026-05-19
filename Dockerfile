FROM node:20-alpine

WORKDIR /app

# Copy source (no deps to install — proxy uses zero external packages)
COPY package.json ./
COPY server.js ./
COPY public/ ./public/

# Persist config in /data so volume can mount it
ENV CONFIG_DIR=/data
RUN mkdir -p /data

EXPOSE 8787

# Healthcheck via /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8787/health > /dev/null || exit 1

CMD ["node", "server.js"]
