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
const DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 Stunde, nach der sich Fehlerraten etwas zurückbilden
const PROXY_STATS_FILE = 'proxy_data/proxyStats.json';
const PROXIES_TXT_FILE = path.join(process.cwd(), 'proxy_data/proxies.txt');

// ------------------------------------
// Global Variables
// ------------------------------------
let proxyList = [];
let proxyStats = {};

// Helper function to wait
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
      // Update old entries if necessary: Set the cooldown to at least the default value
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
    const tempFile = PROXY_STATS_FILE + '.tmp';
    const data = JSON.stringify(proxyStats, null, 2);
    fs.writeFileSync(tempFile, data, { encoding: 'utf8' });
    const tempFileStats = fs.statSync(tempFile);
    logger.debug(`Temp file ${tempFile} size: ${tempFileStats.size}`);
    fs.renameSync(tempFile, PROXY_STATS_FILE);
    logger.debug('Proxy stats saved successfully');
  } catch (err) {
    logger.error('Error saving proxyStats:', err);
  }
}

// ------------------------------------
// 2.5. Let error statistics expire (Decay)
// ------------------------------------
function decayProxyStats() {
  const now = Date.now();
  Object.keys(proxyStats).forEach(proxy => {
    const stats = proxyStats[proxy];
    if (now - stats.lastUsed > DECAY_INTERVAL_MS && stats.failCount > 0) {
      stats.failCount = Math.max(stats.failCount - 1, 0);
      // Optional: auch cooldown leicht zurücksetzen
      stats.cooldown = Math.max(DEFAULT_LOCK_DURATION_MS, stats.cooldown / FAILURE_MULTIPLIER);
    }
  });
  saveProxyStats();
  logger.debug('Decayed proxy stats');
}

// ------------------------------------
// 3. Auswahl und Reporting
// ------------------------------------
function getStatsForProxy(proxy) {
  if (!proxyStats[proxy]) {
    proxyStats[proxy] = {
      cooldown: DEFAULT_LOCK_DURATION_MS,
      successCount: 0,
      failCount: 0,
      useCount: 0,
      lastUsed: 0
    };
  }
  return proxyStats[proxy];
}

/**
 * Wählt einen Proxy basierend auf einem einfachen Gewichtungssystem aus.
 * Proxies mit kürzerem Cooldown und niedrigeren Fehlerraten werden bevorzugt.
 */
async function getNextProxy() {
  logger.debug('getNextProxy: Selecting an available proxy');
  if (proxyList.length === 0) {
    logger.warn('getNextProxy: Proxy list is empty');
    return null;
  }

  const now = Date.now();
  // Create a list of proxies that are unlocked.
  const unlockedProxies = proxyList.filter(proxy => {
    const stats = getStatsForProxy(proxy);
    return (stats.lastUsed + stats.cooldown) < now;
  });

  if (unlockedProxies.length === 0) {
    // Wait until the shortest cooldown expires
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
    return getNextProxy(); // Erneuter Aufruf
  }

  // Weighted selection: Proxies with lower cooldown values get a higher chance.
  const weightedProxies = [];
  unlockedProxies.forEach(proxy => {
    const stats = getStatsForProxy(proxy);
    // Gewicht: inverse des aktuellen Cooldown (kleiner = besser)
    const weight = DEFAULT_LOCK_DURATION_MS / stats.cooldown;
    const weightInt = Math.max(Math.floor(weight * 10), 1); // mind. 1
    for (let i = 0; i < weightInt; i++) {
      weightedProxies.push(proxy);
    }
  });
  const chosenProxy = weightedProxies[Math.floor(Math.random() * weightedProxies.length)];
  const stats = getStatsForProxy(chosenProxy);
  stats.useCount++;
  stats.lastUsed = Date.now();
  saveProxyStats();
  logger.debug(`getNextProxy: Chosen proxy: ${chosenProxy} (used ${stats.useCount} times)`);
  return chosenProxy;
}

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
  logger.debug(`reportProxyFailure: Proxy ${proxy} new cooldown: ${newCooldown}ms`);
  saveProxyStats();
}

function reportProxySuccess(proxy) {
  logger.debug(`reportProxySuccess: Reporting success for proxy: ${proxy}`);
  const now = Date.now();
  const stats = getStatsForProxy(proxy);
  logger.info(`reportProxySuccess: Proxy ${proxy}. Current successCount: ${stats.successCount}`);
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
// Optional: Regularly decay the proxy statistics (e.g. every hour)
setInterval(decayProxyStats, DECAY_INTERVAL_MS);

module.exports = {
  getNextProxy,
  reportProxyFailure,
  reportProxySuccess,
  getProxyAuthHeaders,
  fixProxyUrl
};
