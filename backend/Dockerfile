# Multi-Stage Production Dockerfile — Nexus Lake v4.0 Python 3.12 FastAPI Analytical Backend

FROM python:3.12-slim AS builder
WORKDIR /build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim AS runtime
LABEL org.opencontainers.image.title="nexus-lake-api" \
      org.opencontainers.image.version="4.0.0" \
      org.opencontainers.image.authors="Truong Van Tinh <tinhkun102@gmail.com>"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NEXUS_DB_PATH=/tmp/nexus_lakehouse.sqlite3

RUN addgroup --system nexus && adduser --system --ingroup nexus nexus
WORKDIR /app

COPY --from=builder /install /usr/local
COPY nexus_api ./nexus_api

RUN chown -R nexus:nexus /app
USER nexus

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)" || exit 1

CMD ["uvicorn", "nexus_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
