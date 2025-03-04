# Basis-Image auf Alpine-Basis (Base image based on Alpine)
FROM node:lts-alpine AS base

# Define build arguments for user and group IDs
ARG DOCKER_USER_ID=1000
ARG DOCKER_GROUP_ID=1000

# Arbeitsverzeichnis festlegen (Set working directory)
WORKDIR /app

# Create non-root user and group, set /app ownership, switch to non-root user in base stage (Create user, set permissions, switch user)
RUN mkdir proxy_data && addgroup appuser \
    && adduser -G appuser -s /bin/sh -D appuser \
    && chown -R appuser:appuser /app \
    && chown -R appuser:appuser proxy_data # Ensure proxy_data ownership early

# Spiegel-Repository für APK (optional) und npm/pnpm Setup in one RUN command to minimize layers (Mirror and npm/pnpm setup)
RUN set -eux \
    && sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories \
    && apk add --no-cache libc6-compat \
    && npm config set registry https://registry.npmmirror.com/ \
    && npm install -g pnpm

# Kopiere package.json und pnpm-lock.yaml und installiere Abhängigkeiten with --chown (Copy package files and install dependencies)
USER appuser
COPY --chown=appuser:appuser package*.json pnpm-lock.yaml ./
RUN pnpm install

# Kopiere den Rest des Quellcodes with --chown (Copy the rest of the source code)
COPY --chown=appuser:appuser . .


# Runner-Stage: Definiere die Runner-Stage für kleinere finale Images (Runner stage for smaller final image)
FROM node:lts-alpine AS runner
WORKDIR /app
RUN addgroup appuser && adduser -G appuser -s /bin/sh -D appuser
COPY --from=base /app/node_modules ./node_modules
# Copy only necessary application files, explicitly listing directories and files (Copy only necessary files)
COPY --from=base /app/app.js ./
COPY --from=base /app/api ./api
COPY --from=base /app/config ./config
COPY --from=base /app/core ./core
COPY --from=base /app/proxy_data ./proxy_data
COPY --from=base /app/squid ./squid
COPY --from=base /app/utils ./utils
COPY --from=base /app/package.json ./
COPY --from=base /app/pnpm-lock.yaml ./


# Switch to the non-root user to run the application in runner stage as well (redundant but explicit) (Switch user in runner stage)
USER appuser

# Exponiere den Port, auf dem deine App lauscht (hier 5090) (Expose port)
EXPOSE 5090

# Standard-Startbefehl (Default command)
CMD ["node", "app.js"]
