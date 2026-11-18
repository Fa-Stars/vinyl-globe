FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    WORLD_VINYL_HOST=0.0.0.0 \
    WORLD_VINYL_DATA_DIR=/data \
    WORLD_VINYL_SERVER_MODE=1
WORKDIR /app
COPY --chown=node:node package.json runtime-cache.js ./
COPY --chown=node:node web/*.js web/*.json ./web/
COPY --chown=node:node web/public/ ./web/public/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "web/server.js"]
