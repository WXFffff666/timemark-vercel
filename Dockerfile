FROM node:20-alpine
RUN apk add --no-cache dumb-init git openssh-client
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

# Copy node_modules (pre-installed locally to avoid git SSH dependencies)
COPY backend/node_modules ./backend/node_modules
COPY shared/node_modules ./shared/node_modules
COPY node_modules ./node_modules

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["dumb-init", "node", "backend/dist/backend/src/index.js"]
