FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
COPY shared/package.json ./shared/
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend ./frontend
COPY shared ./shared
RUN cd frontend && pnpm run build

FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY backend/package.json backend/pnpm-lock.yaml ./backend/
COPY shared/package.json ./shared/
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY backend ./backend
COPY shared ./shared
RUN cd backend && pnpm run build

FROM node:20-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/package.json ./backend/
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
CMD ["dumb-init", "node", "backend/dist/index.js"]
