FROM node:22-slim
WORKDIR /repo/apps/private-agent-worker
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir \
    hyperliquid-python-sdk==0.23.0 \
    https://github.com/elliottech/lighter-python/archive/4fedf1648ea032dd9437d6c6e82b0533eadc3c4c.tar.gz
RUN python3 -c 'import lighter; api=lighter.OrderApi; assert callable(getattr(api, "account_active_orders", None)); assert callable(getattr(api, "account_inactive_orders", None))'
COPY apps/private-agent-worker/package.json apps/private-agent-worker/package-lock.json ./
COPY packages/execution-core /repo/packages/execution-core
COPY packages/perps-core /repo/packages/perps-core
RUN npm ci --omit=dev
COPY apps/private-agent-worker/src ./src
RUN node --input-type=module -e 'await import("./src/server.js"); process.exit(0)'
RUN mkdir -p /data && chown -R node:node /data /repo
USER node
EXPOSE 8787
CMD ["node", "src/server.js"]
