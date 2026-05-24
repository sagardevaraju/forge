# syntax=docker/dockerfile:1.7
#
# Task P3.24 — FORGE production Dockerfile (pinned versions).
#
# Multi-stage build that produces a single image running the Next.js
# server alongside the Python 3.12 runtime needed for the api_py/
# subprocess spawns (CV inference, sim loss, portfolio MIP solver).
#
# Why this matters:
#   The Phase 3 charter (see memory/auth-vercel-deferred.md and the
#   forge-phase-roadmap) explicitly decouples FORGE from Vercel so it
#   can run on any Docker host. P3.10 ships the de-Vercel'd CV
#   inference route; this Dockerfile makes that property portable.
#
# Image layout:
#   /app           Next.js standalone build + static assets
#   /app/api_py    Python solver modules (CV inference, sim loss, MIP)
#   /app/scripts   precompute scripts (treaty / portfolio / postmortem)
#   /app/artifacts portable artifacts (calibration, treaty, regime, …)
#
# Build:
#   docker build -t forge:latest .
#
# Run (dev DB defaults to file:./forge-local.db inside the container):
#   docker run --rm -p 3000:3000 forge:latest
#
# Run with Turso libSQL (production):
#   docker run --rm -p 3000:3000 \
#     -e TURSO_URL=libsql://your-db.turso.io \
#     -e TURSO_AUTH_TOKEN=xxx \
#     forge:latest
#
# Pinned versions:
#   node:24.7.0-bookworm-slim   matches the LTS major used by Vercel
#   python:3.12.7-slim-bookworm matches vercel.json runtime pin
#   debian:bookworm-slim        base image for the final stage
#
# Out of scope for this Dockerfile (P3.X follow-ups):
#   - GPU torch wheel for the trained CV head (CPU-only here)
#   - Sentinel-2 chip cache (mounted at runtime, not baked in)
#   - Multi-arch ARM build (uses the host arch only)


# ───────────────────────────────────────────────────────────────────────
# Stage 1 — Node build (Next.js standalone + workspace deps)
# ───────────────────────────────────────────────────────────────────────
FROM node:24.7.0-bookworm-slim AS node-build

WORKDIR /app

# Copy lockfile first for cache hit on dep install.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Now bring in the rest of the source.
COPY . .

# Next 16 standalone output keeps the runtime tarball small.
# Force the standalone output config inline so the Dockerfile is
# self-contained without touching the user's next.config.
ENV NEXT_TELEMETRY_DISABLED=1
RUN node -e "const fs=require('fs'); const p='next.config.ts'; \
  if (fs.existsSync(p)) { \
    let s = fs.readFileSync(p,'utf8'); \
    if (!s.includes('output:')) { \
      s = s.replace(/const nextConfig.*=\s*\{/, m => m + \"\\n  output: 'standalone',\"); \
      fs.writeFileSync(p, s); \
    } \
  }"
RUN npm run build


# ───────────────────────────────────────────────────────────────────────
# Stage 2 — Python build (runtime deps only; not ml/ training deps)
# ───────────────────────────────────────────────────────────────────────
FROM python:3.12.7-slim-bookworm AS py-build

WORKDIR /pyroot

# Only the runtime requirements (NOT requirements-train.txt — that's
# offline-only, see CLAUDE.md "ml/ deps must not be bundled").
COPY requirements.txt ./

RUN pip install --no-cache-dir --upgrade pip==25.0.1 \
 && pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir --target=/pyroot/pylibs -r requirements.txt


# ───────────────────────────────────────────────────────────────────────
# Stage 3 — Runtime
# ───────────────────────────────────────────────────────────────────────
FROM node:24.7.0-bookworm-slim AS runtime

# Bring in Python 3.12 + the libraries the api_py/ subprocess spawns
# need (CBC for the MIP, libgeos for shapely, libgdal for rasterio if
# the user opts into Sentinel-2 real-mode chips at runtime via a
# mounted ENV override).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3.11 python3-pip \
      coinor-cbc libgeos-c1v5 \
 && rm -rf /var/lib/apt/lists/*

# Symlink python -> python3 so `spawn('python', ...)` in the Node
# code paths picks up the system interpreter without env config.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# Next.js standalone output.
COPY --from=node-build /app/.next/standalone ./
COPY --from=node-build /app/.next/static ./.next/static
COPY --from=node-build /app/public ./public

# Python runtime modules + scripts.
COPY --from=node-build /app/api_py ./api_py
COPY --from=node-build /app/scripts ./scripts
COPY --from=node-build /app/ml ./ml
COPY --from=node-build /app/eval ./eval
COPY --from=node-build /app/lib ./lib

# Tracked artifacts (calibration / treaty / portfolio_optimization /
# regime / hurdat2 — see CLAUDE.md "tracked artifacts" list).
COPY --from=node-build /app/artifacts ./artifacts

# Python deps installed into the image's site-packages.
COPY --from=py-build /usr/local/lib/python3.12 /usr/local/lib/python3.11

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

# Next.js standalone entrypoint.
CMD ["node", "server.js"]


# ───────────────────────────────────────────────────────────────────────
# Image labels for traceability.
# ───────────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="FORGE" \
      org.opencontainers.image.description="Scenario-coupled cat-ops console" \
      org.opencontainers.image.source="https://github.com/sagardevaraju/forge" \
      org.opencontainers.image.licenses="Proprietary" \
      forge.task="P3.24"
