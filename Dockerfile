FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Zero runtime dependencies: no npm install step is required.
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

EXPOSE 3000
CMD ["node", "src/server.js"]
