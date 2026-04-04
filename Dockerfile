FROM node:20-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV PNPM_HOME=/root/.local/share/pnpm
ENV NODE_PATH=/app/node_modules:/app/backend/node_modules

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/

# Copy dist folders (already built locally)
COPY shared/dist ./shared/dist
COPY backend/dist ./backend/dist
COPY frontend/dist ./frontend/dist

# Enable corepack and install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["dumb-init", "node", "backend/dist/backend/src/index.js"]
