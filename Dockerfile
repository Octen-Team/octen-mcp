# Runtime image for the remote HTTP entry (octen-mcp-http).
#
# The stdio entry stays an npm package spawned by MCP clients; this image
# exists only for the hosted deployment (mcp.octen.ai) and self-hosters.
# Health checks are NOT declared here: the target platform is Kubernetes,
# which ignores Dockerfile HEALTHCHECK and uses the probes in deploy/k8s/.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Non-root: the process needs nothing beyond an outbound socket.
USER node
EXPOSE 8080
# Structured logs by default in the container; unset OCTEN_MCP_LOG to get the
# human-readable format back when debugging a container locally.
ENV OCTEN_MCP_LOG=json
CMD ["node", "dist/httpServer.js"]
