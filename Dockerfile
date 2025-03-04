# Basis-Image auf Alpine-Basis (Base image based on Alpine)
FROM node:lts-alpine AS base

# Define build argument for the application ID
ARG APP_ID=your_default_app_id
ENV APP_ID=$APP_ID

# Define build arguments for mirrors
ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/

# Arbeitsverzeichnis festlegen (Set working directory)
WORKDIR /app

# Erstelle das Verzeichnis für proxy_data und setze die Besitzrechte auf den Standard-Nutzer "node"
RUN mkdir proxy_data && chown -R node:node /app

# Passe die apk-Repositories an, installiere libc6-compat und pnpm
RUN set -eux \
    && sed -i "s|https://dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories \
    && apk add --no-cache libc6-compat \
    && npm config set registry $NPM_REGISTRY \
    && npm install -g pnpm

# Wechsel zum nicht-root Standardnutzer "node"
USER node

# Kopiere package.json und pnpm-lock.yaml und installiere Abhängigkeiten (mit --chown=node:node)
COPY --chown=node:node package*.json pnpm-lock.yaml ./
RUN pnpm install

# Kopiere den Rest des Quellcodes (mit --chown=node:node)
COPY --chown=node:node .env .
COPY --chown=node:node . .

# Runner-Stage: Erstelle ein kleineres finales Image
FROM node:lts-alpine AS runner
WORKDIR /app

# Kopiere die notwendigen Dateien vom Base-Image
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/app.js ./
COPY --from=base /app/api ./api
COPY --from=base /app/config ./config
COPY --from=base /app/core ./core
COPY --from=base /app/proxy_data ./proxy_data
COPY --from=base /app/utils ./utils
COPY --from=base /app/package.json ./
COPY --from=base /app/pnpm-lock.yaml ./

# Wechsel zum nicht-root Standardnutzer "node"
USER node

# Exponiere den Port, auf dem deine App lauscht (hier 5090)
EXPOSE 5090

# Standard-Startbefehl
CMD ["node", "app.js"]
