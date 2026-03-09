FROM node:24.12.0-bookworm

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    pandoc \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/requirements-arxiv.txt /app/scripts/requirements-arxiv.txt
RUN python3 -m venv /opt/arxiv-venv \
  && /opt/arxiv-venv/bin/pip install --no-cache-dir -r /app/scripts/requirements-arxiv.txt

ENV ARXIV_PYTHON_BIN=/opt/arxiv-venv/bin/python

EXPOSE 3000
