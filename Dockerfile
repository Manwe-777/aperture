# -----------------------------
# Stage 1: Dependencies
# -----------------------------
FROM oven/bun:latest AS deps

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# -----------------------------
# Stage 2: Builder
# -----------------------------
FROM oven/bun:latest AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build the Next.js app
RUN bun run build

# -----------------------------
# Stage 3: Runner (Production)
# -----------------------------
FROM oven/bun:latest AS runner

WORKDIR /app

ENV NODE_ENV=production

# Server-side settings (Seerr / OpenSubtitles config) are written here.
# Mount a volume on /data so they survive container rebuilds.
ENV APERTURE_DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

# Copy package.json for reference
COPY --chown=bun:bun package.json ./

# Copy node_modules
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules

# Copy built app from builder
COPY --from=builder --chown=bun:bun /app/.next ./.next
COPY --from=builder --chown=bun:bun /app/public ./public

# Run unprivileged as the image's built-in bun user (uid/gid 1000). The
# settings file it writes to /data then belongs to the host user rather than
# root, so host-side backups of the data volume can actually read it.
# Ownership of the copied trees is set by the --chown flags above; only the two
# directories themselves are left, so no recursive chown (which would duplicate
# all of node_modules into another layer) is needed. `next start` writes its
# runtime cache under .next, which the COPY --chown already covers.
RUN chown bun:bun /app /data
USER bun

# Expose port 3000
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD bun run -e "fetch('http://localhost:3000').then(() => process.exit(0)).catch(() => process.exit(1))" || exit 1

# Start the Next.js app
CMD ["bun", "run", "start"]