# V-Login

V-Login ist eine Anwendung, die in Docker ausgeführt werden kann. Diese README-Datei beschreibt die Schritte zur Installation und Ausführung der Anwendung.

## Voraussetzungen

Stelle sicher, dass die folgenden Voraussetzungen auf deinem System erfüllt sind:

- Node.js (empfohlen: die neueste LTS-Version)
- Docker

## Installation

Führe die folgenden Befehle in der angegebenen Reihenfolge aus, um die Anwendung zu installieren und auszuführen:

# Installiere pnpm
npm install -g pnpm@latest-10

# Abhängigkeiten installieren
pnpm install

# Browserless Docker-Container starten
sudo docker run -it -e TOKEN=110e2d21-efc4-44e5-853a-9ce4099c81e1 -e PORT=8848 -p 8848:8848 --name browserless nstbrowser/browserless:130-202411051500.v2

# V-Login Docker-Image erstellen
sudo docker build -t v-login .

# V-Login Docker-Container starten
sudo docker run --rm --network="host" v-login
