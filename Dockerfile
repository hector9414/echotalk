# EchoTalk runs as a self-hosted server on the presenter's own machine (see
# SPEC.md) - this image is an optional, easier way to run it than installing
# Node locally. See README.md "Correr con Docker" for a networking caveat:
# on Linux, run with --network host so the LAN-IP banner shows an address
# the audience's phones can actually reach.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
