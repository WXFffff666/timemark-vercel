# TimeMark Docker Image
# Build: pnpm -r build && docker build -t timemark:latest .
# GitHub Actions handles the build step automatically

FROM node:20.18-alpine

# icu-data-full: Required for correct Chinese date formatting (Intl.DateTimeFormat)
# dumb-init: Proper PID 1 signal handling in containers
RUN apk add --no-cache dumb-init ca-certificates icu-data-full

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

# Install pnpm via corepack (smaller than npm install -g pnpm)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

# Copy package files and install production dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/

# Use shamefully-hoist to flatten node_modules (fixes pnpm symlink issues in Docker)
RUN echo "shamefully-hoist=true" > .npmrc && \
    pnpm install --prod --frozen-lockfile

# Copy pre-built artifacts (built by CI or locally via `pnpm -r build`)
COPY shared/dist ./shared/dist
COPY backend/dist ./backend/dist
COPY frontend/dist ./frontend/dist

# Copy schema for database initialization
COPY docker/schema.sql ./docker/schema.sql

# Create data directory with correct permissions for non-root user
RUN mkdir -p /app/data && chown -R app:app /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Switch to non-root user
USER app

CMD ["dumb-init", "node", "./backend/dist/backend/src/index.js"]
