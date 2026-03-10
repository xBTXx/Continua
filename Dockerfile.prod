FROM node:24.12.0-bookworm AS base

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

FROM base AS deps

COPY package*.json ./
RUN npm ci

FROM deps AS builder

COPY . .

ARG NEXT_PUBLIC_BASE_PATH=
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

RUN npm run build

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app /app

EXPOSE 3000

CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
