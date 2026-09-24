FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3210 DATA_DIR=/app/data
EXPOSE 3210
VOLUME ["/app/data"]
CMD ["node", "--use-env-proxy", "server/index.js"]
