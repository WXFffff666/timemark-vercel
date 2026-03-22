FROM node:20-alpine AS builder
WORKDIR /app
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter shared build
RUN pnpm --filter backend build
RUN pnpm --filter frontend build

FROM node:20-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/backend/package.json ./backend/
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist
RUN corepack enable && pnpm install --prod --frozen-lockfile
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["dumb-init", "node", "backend/dist/backend/src/index.js"]
