# syntax=docker/dockerfile:1
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY lib ./lib
COPY db ./db
COPY tsconfig.json ./
ENV WS_PORT=3001
EXPOSE 3001
CMD ["npx", "tsx", "server/ws.ts"]
