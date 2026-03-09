FROM node:18-alpine

RUN apk add --no-cache sqlite curl

WORKDIR /usr/src/app

# Create data directory
RUN mkdir -p /app/data && \
    chown -R node:node /app/data && \
    chown -R node:node /usr/src/app

# Copy package files
COPY package*.json ./

# CHANGE THIS LINE - use npm install instead of npm ci
RUN npm install && \
    npm cache clean --force

# Copy app source
COPY --chown=node:node . .

USER node

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/bingo.db

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD [ "node", "index.js" ]