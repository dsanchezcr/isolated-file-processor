FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
RUN apk add --no-cache git openssh-client bash
USER node
# Docker-backed exploit tests run on a dedicated CI runner, never through a
# mounted host socket in this interactive/public-facing development container.
