# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# SVASTHA Automator — single-image build (API + worker + web UI)
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN cd server && npm install --no-audit --no-fund
RUN cd client && npm install --no-audit --no-fund

COPY server ./server
COPY client ./client

RUN cd server && npm run build
RUN cd client && npm run build

# Drop dev dependencies from the server before copying into the runtime image.
RUN cd server && npm prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

EXPOSE 8080

WORKDIR /app/server
CMD ["node", "dist/index.js"]
