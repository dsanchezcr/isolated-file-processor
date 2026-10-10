FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
RUN apk add --no-cache git openssh-client bash
USER node
# Docker-backed exploit tests run on a dedicated CI runner, never through a
# mounted host socket in this interactive/public-facing development container.
