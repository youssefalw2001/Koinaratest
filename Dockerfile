FROM node:22-slim

# Install pnpm
RUN npm install -g pnpm@latest

WORKDIR /app

# Copy workspace config files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./

# Copy all packages
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
COPY scripts/ ./scripts/

# Install all dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build the API server (compiles TypeScript -> dist/index.mjs)
RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
