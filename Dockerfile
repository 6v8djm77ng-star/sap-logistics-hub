# Multi-stage Dockerfile - single container that runs backend + serves frontend.
# Builds frontend, then copies everything into a lean Node image.

# ============================================================================
# Stage 1: Build frontend
# ============================================================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ============================================================================
# Stage 2: Install backend production deps
# ============================================================================
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ============================================================================
# Stage 3: Final runtime image
# ============================================================================
FROM node:20-alpine
WORKDIR /app

# Install runtime deps for sharp/image processing if needed + curl for healthcheck
RUN apk add --no-cache curl tini

# Copy backend source + installed node_modules
COPY backend/ ./backend/
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy migrations (migrate.js looks up ../database)
COPY database/ ./database/

# Create dirs for uploads + logs
RUN mkdir -p /app/backend/uploads /app/backend/logs

EXPOSE 4000

# Use tini for proper signal handling (graceful shutdown of workers)
ENTRYPOINT ["/sbin/tini", "--"]

# Default: start the server
CMD ["node", "backend/src/server.js"]

# Healthcheck hits /health endpoint (returns 200 if SAP or DB are ok)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1
