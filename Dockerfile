# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Install SQLite for debugging and health checks
RUN apk add --no-cache sqlite curl

# Create app directory
WORKDIR /usr/src/app

# Create data directory for persistent storage
RUN mkdir -p /app/data && \
    chown -R node:node /app/data && \
    chown -R node:node /usr/src/app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy app source
COPY --chown=node:node . .

# Switch to non-root user for security
USER node

# Expose port for web interface
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/bingo.db

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the bot
CMD [ "node", "index.js" ]