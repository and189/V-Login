// utils/proxyPool.js
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Lese die Proxys aus der proxys.json im Hauptverzeichnis ein.
// Erwartet wird ein JSON-Array, z.B.:
// [ "http://user:password@proxy1.com:8080", "http://user:password@proxy2.com:8080", ... ]
let proxyList = [];
try {
  const proxiesFilePath = path.join(process.cwd(), 'proxys.json');
  const fileContent = fs.readFileSync(proxiesFilePath, 'utf8');
  proxyList = JSON.parse(fileContent);
  console.log(`Loaded ${proxyList.length} proxies from proxys.json`);
} catch (err) {
  console.error("Error reading proxys.json:", err);
  // Falls ein Fehler auftritt, wird die proxyList leer gelassen.
  proxyList = [];
}

// Hier speichern wir, bis wann ein Proxy gesperrt ist.
const lockedProxies = {};

// Hier merken wir uns den aktuellen Cooldown pro Proxy.
const proxyCooldowns = {};

// Standard-Cooldown: 10 Minuten
const DEFAULT_LOCK_DURATION_MS = 10 * 60 * 1000;

// Maximale Sperrzeit: 12 Stunden
const MAX_LOCK_DURATION_MS = 12 * 60 * 60 * 1000;

/**
 * Liefert den nächsten verfügbaren Proxy und sperrt ihn für seinen aktuellen Cooldown.
 * Falls alle gesperrt sind oder keine Proxies konfiguriert sind, wird null zurückgegeben.
 */
function getNextProxy() {
  if (proxyList.length === 0) {
    return null;
  }
  
  const now = Date.now();

  for (const proxy of proxyList) {
    const lockedUntil = lockedProxies[proxy];
    if (!lockedUntil || lockedUntil < now) {
      // Verwende den aktuell gespeicherten Cooldown oder den Standardwert.
      const cooldown = proxyCooldowns[proxy] || DEFAULT_LOCK_DURATION_MS;
      lockedProxies[proxy] = now + cooldown;
      return proxy;
    }
  }
  
  // Falls alle Proxies gesperrt sind, wird null zurückgegeben (lokale IP verwenden)
  return null;
}

/**
 * Meldet einen Proxy-Fehler (IP-Ban) und verdoppelt seinen Cooldown (bis MAX_LOCK_DURATION_MS).
 */
function reportProxyFailure(proxy) {
  const now = Date.now();
  const currentCooldown = proxyCooldowns[proxy] || DEFAULT_LOCK_DURATION_MS;
  let newCooldown = currentCooldown * 2;
  if (newCooldown > MAX_LOCK_DURATION_MS) {
    newCooldown = MAX_LOCK_DURATION_MS;
  }
  proxyCooldowns[proxy] = newCooldown;
  lockedProxies[proxy] = now + newCooldown;
}

/**
 * Meldet einen erfolgreichen Einsatz des Proxys und setzt seinen Cooldown zurück.
 */
function reportProxySuccess(proxy) {
  proxyCooldowns[proxy] = DEFAULT_LOCK_DURATION_MS;
  // Optional: Falls gewünscht, kann der Proxy auch erneut gesperrt werden.
}

/**
 * Extrahiert aus der Proxy-URL den "Proxy-Authorization"-Header.
 * @param {string} proxyUrl - Die Proxy-URL im Format http://user:password@host:port
 * @returns {object} - Ein Objekt mit dem Header, z.B. { "Proxy-Authorization": "Basic <credentials>" }.
 */
function getProxyAuthHeaders(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username && parsed.password) {
      const credentials = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
      return { 'Proxy-Authorization': `Basic ${credentials}` };
    }
  } catch (err) {
    console.error('Fehler beim Parsen der Proxy-URL:', err);
  }
  return {};
}

module.exports = {
  getNextProxy,
  reportProxyFailure,
  reportProxySuccess,
  getProxyAuthHeaders
};
