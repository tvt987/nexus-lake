# Multi-Stage Production Dockerfile — Nexus Lake v4.0 Web Workbench (React 19 + DuckDB-WASM)

FROM node:22-alpine AS builder
WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine AS runtime
LABEL org.opencontainers.image.title="nexus-lake-web" \
      org.opencontainers.image.version="4.0.0" \
      org.opencontainers.image.authors="Truong Van Tinh <tinhkun102@gmail.com>"

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
