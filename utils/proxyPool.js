const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const logger = require('./logger');

// ------------------------------------
// Settings
// ------------------------------------
const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 Min
const MAX_LOCK_DURATION_MS = 12 * 60 * 60 * 1000; // 12 Stunden
const FAILURE_MULTIPLIER = 2;
const PROXY_STATS_FILE = 'proxy_data/proxyStats.json';
const PROXIES_TXT_FILE = path.join(process.cwd(), 'proxy_data/proxies.txt');

// ------------------------------------
// Global Variables
// ------------------------------------
let proxyList = [];
let proxyStats = {};

// Hilfsfunktion zum Warten
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ------------------------------------
// 1. Load Proxies
// ------------------------------------
function loadProxies() {
  logger.debug(`Loading proxies from ${PROXIES_TXT_FILE}`);
  try {
    const fileContent = fs.readFileSync(PROXIES_TXT_FILE, 'utf8');
    // Aufbereitung: Leerzeilen entfernen, trimmen und URL korrigieren
    proxyList = fileContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(proxy => fixProxyUrl(proxy));
    logger.debug(`Loaded ${proxyList.length} proxies from proxies.txt`);
  } catch (err) {
    logger.error('Error reading proxies.txt:', err);
    proxyList = [];
  }
}

// ------------------------------------
// 2. Load/Save Stats
// ------------------------------------
function loadProxyStats() {
  try {
    if (fs.existsSync(PROXY_STATS_FILE)) {
      const content = fs.readFileSync(PROXY_STATS_FILE, 'utf8');
      proxyStats = JSON.parse(content);
      logger.debug('Proxy stats loaded successfully');
      // Aktualisiere ggf. alte Einträge: Falls gespeicherter Cooldown kleiner als DEFAULT_LOCK_DURATION_MS ist
      Object.keys(proxyStats).forEach(proxy => {
        if (proxyStats[proxy].cooldown < DEFAULT_LOCK_DURATION_MS) {
          logger.debug(`Updating cooldown for ${proxy} from ${proxyStats[proxy].cooldown} to ${DEFAULT_LOCK_DURATION_MS}`);
          proxyStats[proxy].cooldown = DEFAULT_LOCK_DURATION_MS;
        }
      });
      saveProxyStats();
    } else {
      logger.debug('No proxy stats file found, starting with empty stats');
      proxyStats = {};
    }
  } catch (err) {
    logger.error('Error loading proxyStats:', err);
    proxyStats = {};
  }
}

function saveProxyStats() {
  logger.debug('Saving proxy stats...');
  try {
    // Schreibe zuerst in eine temporäre Datei
    const tempFile = PROXY_STATS_FILE + '.tmp';
    const data = JSON.stringify(proxyStats, null, 2);
    fs.writeFileSync(tempFile, data, { encoding: 'utf8' });
    // Check if the temp file exists and is not empty
    const tempFileStats = fs.statSync(tempFile);
    logger.debug(`Temp file ${tempFile} size: ${tempFileStats.size}`);
    // Atomarer Umzug der temporären Datei
    fs.renameSync(tempFile, PROXY_STATS_FILE);
    logger.debug('Proxy stats saved successfully');
  } catch (err) {
    logger.error('Error saving proxyStats:', err);
  }
}

// ------------------------------------
// 3. Choose a Proxy und Reporte jede Nutzung
// ------------------------------------
/**
 * Liefert oder initialisiert die Statistik für einen Proxy.
 */
function getStatsForProxy(proxy) {
  if (!proxyStats[proxy]) {
    proxyStats[proxy] = {
      cooldown: DEFAULT_LOCK_DURATION_MS,
      successCount: 0,
      failCount: 0,
      useCount: 0, // Zähler für jede Nutzung
      lastUsed: 0
    };
  }
  return proxyStats[proxy];
}

/**
 * Wählt einen aktuell entsperrten Proxy aus.
 * Ein Proxy gilt als "gesperrt", wenn (lastUsed + cooldown) noch in der Zukunft liegt.
 * Falls keine Proxies entsperrt sind, wartet die Funktion bis zum Ende des kürzesten Cooldowns.
 * In diesem Fall wird zusätzlich der Fail-Counter für den Kandidaten erhöht.
 * Die Nutzung wird gemeldet, indem useCount erhöht und lastUsed aktualisiert wird.
 */
async function getNextProxy() {
  logger.debug('getNextProxy: Attempting to choose an unlocked proxy');
  if (proxyList.length === 0) {
    logger.warn('getNextProxy: Proxy list is empty');
    return null;
  }

  const now = Date.now();

  // Filtere Proxies, deren Cooldown abgelaufen ist
  let unlockedProxies = proxyList.filter(proxy => {
    const stats = getStatsForProxy(proxy);
    return (stats.lastUsed + stats.cooldown) < now;
  });

  if (unlockedProxies.length === 0) {
    // Falls keine Proxies entsperrt sind, ermittele den minimal verbleibenden Zeitraum
    let minRemaining = Infinity;
    let candidate = null;
    proxyList.forEach(proxy => {
      const stats = getStatsForProxy(proxy);
      const remaining = (stats.lastUsed + stats.cooldown) - now;
      if (remaining < minRemaining) {
        minRemaining = remaining;
        candidate = proxy;
      }
    });
    logger.warn(`No unlocked proxies available. Waiting for ${minRemaining}ms...`);
    await sleep(minRemaining);
    const nowAfter = Date.now();
    unlockedProxies = proxyList.filter(proxy => {
      const stats = getStatsForProxy(proxy);
      return (stats.lastUsed + stats.cooldown) < nowAfter;
    });
    if (unlockedProxies.length === 0) {
      // Falls immer noch keine entsperrt sind, nutze den Kandidaten und vermerke den Fehler.
      logger.warn("Even after waiting, no proxy fully unlocked. Using candidate anyway.");
      reportProxyFailure(candidate); // Failcounter + 1 und Cooldown anpassen
      const stats = getStatsForProxy(candidate);
      stats.useCount++;
      stats.lastUsed = Date.now();
      saveProxyStats();
      logger.debug(`getNextProxy: Proxy ${candidate} used ${stats.useCount} times, locked until ${stats.lastUsed + stats.cooldown}`);
      return candidate;
    }
  }

  // Zufällige Auswahl aus den entsperrten Proxies
  const chosenProxy = unlockedProxies[Math.floor(Math.random() * unlockedProxies.length)];
  logger.debug(`getNextProxy: Chosen proxy: ${chosenProxy}`);
  const stats = getStatsForProxy(chosenProxy);
  stats.useCount++;
  stats.lastUsed = Date.now();
  saveProxyStats();
  logger.debug(`getNextProxy: Proxy ${chosenProxy} used ${stats.useCount} times, locked until ${stats.lastUsed + stats.cooldown}`);
  return chosenProxy;
}

/**
 * Meldet einen Proxy-Fehler:
 * - Erhöht failCount und verdoppelt den Cooldown (bis zu einem Maximum)
 * - Aktualisiert lastUsed
 */
function reportProxyFailure(proxy) {
  logger.debug(`reportProxyFailure: Reporting failure for proxy: ${proxy}`);
  const now = Date.now();
  const stats = getStatsForProxy(proxy);
  logger.info(`reportProxyFailure: Proxy ${proxy}. Current failCount: ${stats.failCount}`);
  stats.failCount += 1;
  logger.info(`reportProxyFailure: Proxy ${proxy}. New failCount: ${stats.failCount}`);
  let newCooldown = (stats.cooldown || DEFAULT_LOCK_DURATION_MS) * FAILURE_MULTIPLIER;
  if (newCooldown > MAX_LOCK_DURATION_MS) {
    newCooldown = MAX_LOCK_DURATION_MS;
  }
  stats.cooldown = newCooldown;
  stats.lastUsed = now;
  logger.debug(`reportProxyFailure: Proxy ${proxy} new cooldown: ${newCooldown}ms until ${stats.lastUsed + newCooldown}`);
  saveProxyStats();
}

/**
 * Meldet einen Proxy-Erfolg:
 * - Erhöht successCount
 * - Setzt den Cooldown auf den Standardwert zurück
 * - Aktualisiert lastUsed
 */
function reportProxySuccess(proxy) {
  logger.debug(`reportProxySuccess: Reporting success for proxy: ${proxy}`);
  const now = Date.now();
  const stats = getStatsForProxy(proxy);
  logger.info(`reportProxySuccess: Reporting success for proxy: ${proxy}. Current successCount: ${stats.successCount}`);
  stats.successCount += 1;
  logger.info(`reportProxySuccess: Proxy ${proxy}. New successCount: ${stats.successCount}`);
  stats.cooldown = DEFAULT_LOCK_DURATION_MS;
  stats.lastUsed = now;
  logger.debug(`reportProxySuccess: Proxy ${proxy} cooldown reset to ${DEFAULT_LOCK_DURATION_MS}ms`);
  saveProxyStats();
}

// ------------------------------------
// 4. Proxy URL / Auth
// ------------------------------------
/**
 * Korrigiert die Proxy-URL:
 * - Fügt ggf. "http://" hinzu
 * - Codiert Benutzername und Passwort, falls vorhanden
 */
function fixProxyUrl(proxyUrl) {
  if (!proxyUrl.includes('://')) {
    proxyUrl = 'http://' + proxyUrl;
  }
  const protocolSeparator = '://';
  const protocolEnd = proxyUrl.indexOf(protocolSeparator) + protocolSeparator.length;
  const protocol = proxyUrl.slice(0, protocolEnd);
  const remainder = proxyUrl.slice(protocolEnd);
  const atIndex = remainder.lastIndexOf('@');
  if (atIndex === -1) {
    return proxyUrl;
  }
  const credentials = remainder.slice(0, atIndex);
  const hostPart = remainder.slice(atIndex + 1);
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    const encodedUsername = encodeURIComponent(credentials);
    const fixedUrl = protocol + encodedUsername + '@' + hostPart;
    return fixedUrl;
  } else {
    const username = credentials.slice(0, colonIndex);
    const password = credentials.slice(colonIndex + 1);
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    const fixedUrl = protocol + encodedUsername + ':' + encodedPassword + '@' + hostPart;
    return fixedUrl;
  }
}

/**
 * Gibt die Proxy-Authentifizierungs-Header zurück, falls Benutzername/Passwort vorhanden sind.
 */
function getProxyAuthHeaders(proxyUrl) {
  logger.debug(`getProxyAuthHeaders: Getting auth headers for proxy: ${proxyUrl}`);
  try {
    const fixedUrl = fixProxyUrl(proxyUrl);
    const parsed = new URL(fixedUrl);
    if (parsed.username || parsed.password) {
      const credentials = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
      logger.debug(`getProxyAuthHeaders: Credentials found, returning headers`);
      return { 'Proxy-Authorization': `Basic ${credentials}` };
    }
  } catch (err) {
    logger.error('getProxyAuthHeaders: Error parsing proxy URL:', err);
  }
  logger.debug(`getProxyAuthHeaders: No credentials found, returning empty headers`);
  return {};
}

// ------------------------------------
// Initialization
// ------------------------------------
logger.debug('Initializing proxy pool: Loading proxies and proxy stats');
loadProxies();
loadProxyStats();

module.exports = {
  getNextProxy,
  reportProxyFailure,
  reportProxySuccess,
  getProxyAuthHeaders,
  fixProxyUrl
};
