# syntax=docker/dockerfile:1.6

# Node.js 24.21.0 on Debian 12 (bookworm), pinned by digest so every build starts from the same base.
# To update: pick a new tag on Docker Hub, copy its digest here and test it in development first.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# Set working directory
WORKDIR /src

# Environment
ENV NODE_ENV=production
ENV MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies (cache npm)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Avoid recursive chown, which duplicates /src into a costly overlayfs layer.
# Dependencies remain root-owned and readable; application files are owned by node.
COPY --chown=node:node app ./app
COPY --chown=node:node public ./public

# Copy config template → config
COPY --chown=node:node app/src/config.template.js app/src/config.js

# Which commit this image was built from (the CI passes it): the server stamps it on its health records and /config
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_DATE=unknown
RUN printf '{"sha":"%s","ref":"%s","date":"%s"}\n' "$GIT_SHA" "$GIT_REF" "$BUILD_DATE" > /src/build-info.json

# Run as the non-root "node" user (uid/gid 1000) shipped with the base image
USER node

# Default command
CMD ["npm", "start"]