FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production MILE_MCP_HOST=0.0.0.0 MILE_MCP_PORT=8000 MILE_MCP_DATABASE_PATH=/data/mile.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js", "http"]
