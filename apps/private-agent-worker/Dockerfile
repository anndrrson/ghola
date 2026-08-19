FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG PRIVATE_AGENT_BUILD_GIT_SHA
LABEL org.opencontainers.image.revision="${PRIVATE_AGENT_BUILD_GIT_SHA}"
WORKDIR /app
RUN case "${PRIVATE_AGENT_BUILD_GIT_SHA}" in \
    *[!0-9a-f]*|'') echo "PRIVATE_AGENT_BUILD_GIT_SHA must be a lowercase 40-character commit SHA" >&2; exit 1 ;; \
  esac \
  && test "${#PRIVATE_AGENT_BUILD_GIT_SHA}" -eq 40 \
  && printf '{"git_sha":"%s"}\n' "${PRIVATE_AGENT_BUILD_GIT_SHA}" > /app/build-identity.json
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir hyperliquid-python-sdk==0.23.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
CMD ["node", "src/server.js"]
