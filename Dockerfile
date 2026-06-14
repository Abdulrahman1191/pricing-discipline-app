FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src/
COPY assets ./assets/

EXPOSE 3000
# Use 127.0.0.1 (not localhost — Alpine may resolve it to ::1 while the app binds IPv4),
# fetch instead of --spider, and a generous start window so the container isn't marked
# unhealthy (and dropped from routing) during startup.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/server.js"]
