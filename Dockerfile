# syntax=docker/dockerfile:1

# Stage 1: Dependencies and Build
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json* ./

# Use BuildKit cache mount for npm to speed up re-installs
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source code
COPY . .

ENV NODE_ENV=production
# Disable Next.js telemetry for faster builds
ENV NEXT_TELEMETRY_DISABLED=1

# Use BuildKit cache mount for Next.js cache
# This is the biggest time saver for subsequent builds
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# Stage 2: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only what is needed for production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
