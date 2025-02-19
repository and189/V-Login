const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ------------------------------------
// Einstellungen
// ------------------------------------

// Standard-Cooldown (für Proxys, die zum ersten Mal verwendet werden
// oder erfolgreich waren)
const DEFAULT_LOCK_DURATION_MS = 10 * 1000; // z.B. 10 Sekunden als Beispiel
// Statt 10 Minuten – passe an, wie du möchtest

// Längster möglicher Lock (z.B. 12 Stunden)
const MAX_LOCK_DURATION_MS = 12 * 60 * 60 * 1000; // 12 Stunden

// Faktor, mit dem der Lock bei einem Fehlschlag verlängert wird
const FAILURE_MULTIPLIER = 2; 

// Dateiname, in dem wir Proxy-Statistiken speichern
const PROXY_STATS_FILE = path.join(process.cwd(), 'proxyStats.json');

// Pfad zu deiner proxies.txt
const PROXIES_TXT_FILE = path.join(process.cwd(), 'proxies.txt');

// ------------------------------------
// Globale Variablen
// ------------------------------------

/** 
 * Array mit allen Proxys (gelesen aus proxies.txt).
 * Format pro Zeile: 
 *  http://user:pass@host:port 
 */
let proxyList = [];

/**
 * Sperr-Status: speichert für jeden Proxy, bis wann er gesperrt ist (timestamp in ms).
 * Beispiel: lockedProxies[proxy] = 1675000000000 (Zeit in Zukunft)
 */
const lockedProxies = {};

/**
 * Enthält Stats pro Proxy, z.B.:
 * {
 *   [proxyUrl]: {
 *       cooldown: number,   // Aktueller Lock/Cooldown in ms
 *       successCount: number,
 *       failCount: number
 *   },
 *   ...
 * }
 */
let proxyStats = {};

// ------------------------------------
// 1. Proxys laden
// ------------------------------------
function loadProxies() {
  try {
    const fileContent = fs.readFileSync(PROXIES_TXT_FILE, 'utf8');
    proxyList = fileContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    console.log(`Loaded ${proxyList.length} proxies from proxies.txt`);
  } catch (err) {
    console.error('Error reading proxies.txt:', err);
    proxyList = [];
  }
}

// ------------------------------------
// 2. Stats laden/speichern
// ------------------------------------
function loadProxyStats() {
  try {
    if (fs.existsSync(PROXY_STATS_FILE)) {
      const content = fs.readFileSync(PROXY_STATS_FILE, 'utf8');
      proxyStats = JSON.parse(content);
    } else {
      proxyStats = {};
    }
  } catch (err) {
    console.error('Error loading proxyStats:', err);
    proxyStats = {};
  }
}

function saveProxyStats() {
  try {
    fs.writeFileSync(PROXY_STATS_FILE, JSON.stringify(proxyStats, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving proxyStats:', err);
  }
}

// ------------------------------------
// 3. Proxy-Auswahl
// ------------------------------------

/**
 *  getNextProxy:
 *  - gibt einen gerade nicht gesperrten Proxy zurück (per Zufall).
 *  - sperrt diesen Proxy sofort für dessen aktuellen "cooldown".
 */
function getNextProxy() {
  if (proxyList.length === 0) {
    return null;
  }

  const now = Date.now();

  // Liste der aktuell entsperrten (= benutzbaren) Proxys
  const unlockedProxies = proxyList.filter(proxy => {
    const lockedUntil = lockedProxies[proxy];
    return !lockedUntil || lockedUntil < now;
  });

  if (unlockedProxies.length === 0) {
    // Keine entsperrten Proxys verfügbar
    return null;
  }

  // Zufällig einen Proxy aus den entsperrten wählen
  const chosenProxy = unlockedProxies[Math.floor(Math.random() * unlockedProxies.length)];

  // Cooldown aus Stats holen oder Standard verwenden
  const currentStats = getStatsForProxy(chosenProxy);
  const cooldown = currentStats.cooldown || DEFAULT_LOCK_DURATION_MS;

  // Proxy sperren
  lockedProxies[chosenProxy] = now + cooldown;

  return chosenProxy;
}

/**
 * Wird aufgerufen, wenn ein Proxy fehlschlägt.
 * - erhöht die failCount
 * - verlängert den Cooldown (bis max. MAX_LOCK_DURATION_MS)
 * - sperrt den Proxy
 */
function reportProxyFailure(proxy) {
  const now = Date.now();
  const stats = getStatsForProxy(proxy);

  // Erhöhe failCount
  stats.failCount += 1;

  // Verdopple den bisherigen Cooldown (oder nimm DEFAULT, falls nichts vorhanden)
  let newCooldown = stats.cooldown ? stats.cooldown * FAILURE_MULTIPLIER : DEFAULT_LOCK_DURATION_MS * FAILURE_MULTIPLIER;
  if (newCooldown > MAX_LOCK_DURATION_MS) {
    newCooldown = MAX_LOCK_DURATION_MS;
  }
  stats.cooldown = newCooldown;

  // Sperren bis "now + newCooldown"
  lockedProxies[proxy] = now + newCooldown;

  saveProxyStats();
}

/**
 * Wird aufgerufen, wenn ein Proxy erfolgreich genutzt wurde.
 * - erhöht die successCount
 * - setzt die failCount zurück (optional)
 * - verringert den Cooldown auf den DEFAULT (oder noch weniger, z.B. 0)
 */
function reportProxySuccess(proxy) {
  const stats = getStatsForProxy(proxy);

  stats.successCount += 1;
  // Du könntest auch stats.failCount = 0 setzen, wenn du möchtest:
  // stats.failCount = 0;

  // Beispiel: Setze den Cooldown zurück auf sehr klein, damit
  // der Proxy möglichst schnell erneut genutzt werden kann.
  // Du kannst auch auf 0 setzen (wenn du nie warten willst),
  // oder z.B. 5 Sekunden, etc.
  stats.cooldown = DEFAULT_LOCK_DURATION_MS; 
  // lockedProxies[proxy] = Date.now() + stats.cooldown;
  // -> Falls du ihn direkt sperren willst, aber nur kurz.

  // Wenn du möchtest, dass er sofort wieder verfügbar ist:
  lockedProxies[proxy] = Date.now();

  saveProxyStats();
}

// ------------------------------------
// 4. Stats-Helferfunktionen
// ------------------------------------
/**
 * Holt das Stats-Objekt zu einem Proxy aus `proxyStats`.
 * Wenn es nicht existiert, wird es erzeugt.
 */
function getStatsForProxy(proxy) {
  if (!proxyStats[proxy]) {
    proxyStats[proxy] = {
      cooldown: DEFAULT_LOCK_DURATION_MS,
      successCount: 0,
      failCount: 0
    };
  }
  return proxyStats[proxy];
}

// ------------------------------------
// 5. Proxy-URL/Authentifizierung
// ------------------------------------
function fixProxyUrl(proxyUrl) {
  const protocolSeparator = '://';
  const protocolEnd = proxyUrl.indexOf(protocolSeparator);
  if (protocolEnd === -1) {
    // Kein Protokoll
    return proxyUrl;
  }

  const protocol = proxyUrl.slice(0, protocolEnd + protocolSeparator.length);
  const remainder = proxyUrl.slice(protocolEnd + protocolSeparator.length);

  const atIndex = remainder.lastIndexOf('@');
  if (atIndex === -1) {
    // Keine Credentials enthalten
    return proxyUrl;
  }

  const credentials = remainder.slice(0, atIndex);
  const hostPart = remainder.slice(atIndex + 1);

  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    // Nur Username
    const encodedUsername = encodeURIComponent(credentials);
    return protocol + encodedUsername + '@' + hostPart;
  } else {
    const username = credentials.slice(0, colonIndex);
    const password = credentials.slice(colonIndex + 1);
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    return protocol + encodedUsername + ':' + encodedPassword + '@' + hostPart;
  }
}

function getProxyAuthHeaders(proxyUrl) {
  try {
    const fixedUrl = fixProxyUrl(proxyUrl);
    const parsed = new URL(fixedUrl);
    if (parsed.username || parsed.password) {
      const credentials = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
      return { 'Proxy-Authorization': `Basic ${credentials}` };
    }
  } catch (err) {
    console.error('Error parsing proxy URL:', err);
  }
  return {};
}

// ------------------------------------
// Initialisierung beim Laden
// ------------------------------------
loadProxies();
loadProxyStats();

module.exports = {
  getNextProxy,
  reportProxyFailure,
  reportProxySuccess,
  getProxyAuthHeaders,
  fixProxyUrl
};
