// utils/proxyPool.js
const proxyList = [
  //'http://user:password@proxy1.com:8080',
  //'http://user:password@proxy2.com:8080',
  //'http://user:password@proxy3.com:8080',
  // weitere Proxies ...
];

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
  // Optional: Wenn gewünscht, kann der Proxy auch neu gesperrt werden.
}

module.exports = {
  getNextProxy,
  reportProxyFailure,
  reportProxySuccess,
};

