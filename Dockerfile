# Basis-Image auf Alpine-Basis
FROM node:18-alpine AS base

# Abhängigkeiten nur installieren, wenn sie benötigt werden
FROM base AS deps
# Spiegel-Repository für APK (optional, hier z. B. USTC)
RUN set -eux && sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
# Zusatzpaket, falls benötigt
RUN apk add --no-cache libc6-compat

# Wechsel zum npm-Registry-Spiegel (optional)
RUN npm config set registry https://registry.npmmirror.com/
# Verwende pnpm als Paketmanager
RUN npm install -g pnpm

# Arbeitsverzeichnis festlegen
WORKDIR /app

# Kopiere package.json und pnpm-lock.yaml und installiere Abhängigkeiten
COPY package*.json pnpm-lock.yaml ./
RUN pnpm install

# Kopiere den Rest des Quellcodes
COPY . .

# Basis-Image für den Runner
FROM base AS runner
# Kopiere die installierten node_modules vom deps-Stage
COPY --from=deps /app/node_modules ./node_modules
# Kopiere den gesamten Quellcode
COPY --from=deps /app .

# Exponiere den Port, auf dem deine App lauscht (z. B. 5090)
EXPOSE 5090

# Standard-Startbefehl: Passe den Eintragspunkt ggf. an (z.B. "app.js" statt "index.mjs")
CMD ["node", "app.js"]
