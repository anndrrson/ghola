FROM node:20-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir hyperliquid-python-sdk==0.23.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
CMD ["node", "src/server.js"]
