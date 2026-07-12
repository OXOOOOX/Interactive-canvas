FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY --from=builder /app/src/utils/canvas-revision.js ./src/utils/canvas-revision.js
EXPOSE 8080
CMD ["node", "server/index.js"]
