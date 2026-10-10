# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The index digests retain amd64 and arm64 support. Dependabot updates these pins.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG HOST_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
ARG DOCKER_CLI_IMAGE=docker:28.5.1-cli@sha256:9190b0613792e658a7783cf14b2d5ace5941bb68ede7276922ea36ee457d76ad

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS host-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# No Alpine native parser dependencies enter the Debian gateway/worker hosts.
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
    && npm uninstall --omit=dev --omit=optional --ignore-scripts --no-save sharp pdf-lib yauzl \
    && rm -rf node_modules/@img \
    && test ! -d node_modules/sharp \
    && test -z "$(find node_modules -name '*.node' -print -quit)"

FROM ${DOCKER_CLI_IMAGE} AS docker-cli
USER root
RUN apk add --no-cache file \
    && file /usr/local/bin/docker | grep -q 'statically linked'
# This official Go CLI is static on each target architecture: it needs neither
# Alpine's musl loader nor a shell in the distroless Debian runtime.

FROM ${HOST_IMAGE} AS host
WORKDIR /app
ENV NODE_ENV=production
ENV MSGPACKR_NATIVE_ACCELERATION_DISABLED=1
COPY --from=host-dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --from=build --chown=65532:65532 /build/dist ./dist
USER 65532:65532

FROM host AS gateway
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node", "dist/gateway/index.js"]

FROM host AS worker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ENV SANDBOX_IMAGE=sandbox-runner:local
ENTRYPOINT ["/nodejs/bin/node", "dist/worker/index.js"]

FROM ${NODE_IMAGE} AS sandbox-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# npm selects @img/sharp-linuxmusl-* for this Alpine target, NOT glibc.
RUN npm ci --omit=dev --ignore-scripts \
    && node --input-type=module -e 'import sharp from "sharp"; if (!sharp.versions.vips) process.exit(1)'

FROM ${NODE_IMAGE} AS sandbox-runner
RUN apk add --no-cache poppler-utils \
    && addgroup -g 65532 sandbox \
    && adduser -D -H -u 65532 -G sandbox sandbox
WORKDIR /app
ENV NODE_ENV=production
COPY --from=sandbox-dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --from=build --chown=65532:65532 /build/dist ./dist
USER 65532:65532
# The worker supplies parser arguments; input is bounded stdin, never a bind mount.
ENTRYPOINT ["node", "dist/worker/runner/sandbox-supervisor.js"]
