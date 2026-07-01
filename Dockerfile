FROM node:22-slim

# Install dependencies for native pg module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source
COPY . .

# Build TypeScript (for production, we use tsx at runtime for simplicity in Phase 0)
# In production, compile: RUN npm run build

EXPOSE 3000

CMD ["node", "--import", "tsx/esm", "src/index.ts"]
