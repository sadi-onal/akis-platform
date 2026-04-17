# AKIS Backend Dockerfile
# Multi-stage build for minimal production image
# Optimized for OCI Free Tier ARM64 (Ampere A1)

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ wget

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy package files first (for layer caching)
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts

# Build TypeScript (also copies skill .md assets to dist/)
RUN pnpm run build

# Remove devDependencies
RUN pnpm prune --prod

# =============================================================================
# Stage 2: Production
# =============================================================================
FROM node:20-alpine AS production

# Build arguments for version info
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG APP_VERSION=0.2.0

# Set environment variables for build info
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}
ENV APP_VERSION=${APP_VERSION}

# Install runtime dependencies and pnpm (for migrations)
RUN apk add --no-cache wget dumb-init && \
    npm install -g pnpm@9

# Create non-root user with home directory (needed for drizzle-kit migrations)
RUN addgroup -g 1001 -S akis && \
    adduser -S -D -u 1001 -h /home/akis -s /sbin/nologin -G akis akis && \
    mkdir -p /home/akis/.local/share && \
    chown -R akis:akis /home/akis

WORKDIR /app

# Copy built files from builder
COPY --from=builder --chown=akis:akis /app/dist ./dist
COPY --from=builder --chown=akis:akis /app/node_modules ./node_modules
COPY --from=builder --chown=akis:akis /app/package.json ./

# Copy migrations (for runtime migration support)
COPY --chown=akis:akis migrations ./migrations
COPY --chown=akis:akis drizzle.config.ts ./

# Switch to non-root user
USER akis

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start server
CMD ["node", "dist/server.js"]
