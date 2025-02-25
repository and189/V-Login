# Basis-Image auf Alpine-Basis
FROM node:18-alpine AS base

# Spiegel-Repository für APK (optional, hier z. B. USTC)
RUN set -eux && sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories && \
    apk add --no-cache libc6-compat

# Wechsel zum npm-Registry-Spiegel (optional)
RUN npm config set registry https://registry.npmmirror.com/ && \
    npm install -g pnpm

# Arbeitsverzeichnis festlegen
WORKDIR /app

# Kopiere package.json und pnpm-lock.yaml und installiere Abhängigkeiten
COPY package*.json pnpm-lock.yaml ./
RUN pnpm install

# Kopiere den Rest des Quellcodes
COPY . .



# Change ownership of proxy_data to user 1000:1000
RUN chown -R 1000:1000 proxy_data
# Runner-Stage: Verwende dasselbe Basis-Image und kopiere die notwendigen Dateien
FROM node:18-alpine AS runner
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app .

# Optional: Sicherstellen, dass der Container als root läuft
USER root

# Exponiere den Port, auf dem deine App lauscht (hier 5090)
EXPOSE 5090

# Standard-Startbefehl
CMD ["node", "app.js"]
