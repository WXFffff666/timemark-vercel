FROM node:20-alpine
RUN apk add --no-cache dumb-init chromium chromium-chromedriver ca-certificates \
    g++ make python3 git
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy pnpm and package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/

# Install pnpm globally, then use it to install dependencies  
RUN npm install -g pnpm && \
    pnpm config set store-dir /root/.pnpm-store

# Copy dist folders (already built locally)
COPY shared/dist ./shared/dist
COPY backend/dist ./backend/dist
COPY frontend/dist ./frontend/dist

# Install dependencies inside container (to handle pnpm symlinks)
RUN pnpm install --ignore-scripts

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["dumb-init", "node", "./backend/dist/backend/src/index.js"]
