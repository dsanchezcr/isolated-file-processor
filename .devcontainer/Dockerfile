FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
RUN apk add --no-cache git openssh-client bash
USER node
# Docker-backed exploit tests run on a dedicated CI runner, never through a
# mounted host socket in this interactive/public-facing development container.
