# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /build

# Build tools required for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Compile TypeScript and copy spec/pipeline assets into dist/
RUN npm run build

# ---- production stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S mc && adduser -S mc -G mc

# Copy pre-compiled output and already-built native bindings from builder.
# Both stages use the same node:22-alpine base so the bindings are compatible.
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist        ./dist
COPY package.json ./

USER mc
EXPOSE 4747
CMD ["node", "dist/index.js"]
