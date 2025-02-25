const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const logger = require('./logger'); // Verwende den Logger für Debug-Ausgaben

// ------------------------------------
// Settings
// ------------------------------------

// Default cooldown for newly used or successful proxies (example: 10s)
const DEFAULT_LOCK_DURATION_MS = 15 * 60 * 1000; 

// Maximum lock duration (e.g., 12 hours)
const MAX_LOCK_DURATION_MS = 12 * 60 * 60 * 1000; 

// Factor by which cooldown extends on failure
const FAILURE_MULTIPLIER = 2;

// Where we save stats about each proxy
const PROXY_STATS_FILE = path.join(process.cwd(), 'proxyStats.json');

// The path to your proxies.txt
const PROXIES_TXT_FILE = path.join(process.cwd(), 'proxies.txt');

// ------------------------------------
// Global Variables
// ------------------------------------

/** 
 * Array of all proxies (read from proxies.txt).
 * Example lines:
 *   http://user:pass@host:port
 *   http://host:port
 *   or just host:port (we'll fix it to http://host:port)
 */
let proxyList = [];

/**
 * Tracks lock status for each proxy.
 *   lockedProxies[proxyUrl] = timestamp_in_ms_until_unlocked
 */
const lockedProxies = {};

/**
 * Stats for each proxy, e.g.:
 * {
 *   "http://user:pass@1.2.3.4:8080": {
 *       cooldown: 10000,
 *       successCount: 5,
 *       failCount: 2
 *   },
 *   ...
 * }
 */
let proxyStats = {};

// ------------------------------------
// 1. Load Proxies
// ------------------------------------
function loadProxies() {
  logger.debug(`Loading proxies from ${PROXIES_TXT_FILE}`);
  try {
    const fileContent = fs.readFileSync(PROXIES_TXT_FILE, 'utf8');
    // Split lines, trim, remove empty lines, and fix each proxy URL
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
  logger.debug(`Loading proxy stats from ${PROXY_STATS_FILE}`);
  try {
    if (fs.existsSync(PROXY_STATS_FILE)) {
      const content = fs.readFileSync(PROXY_STATS_FILE, 'utf8');
      const rawProxyStats = JSON.parse(content);
      // Fix proxy URLs to ensure consistency
      proxyStats = Object.keys(rawProxyStats).reduce((acc, proxyUrl) => {
        const fixedProxyUrl = fixProxyUrl(proxyUrl);
        const stats = rawProxyStats[proxyUrl];
        acc[fixedProxyUrl] = {
          ...stats,
          lastUsed: Number(stats.lastUsed) || 0, // Ensure lastUsed is a number
        };
        return acc;
      }, {});
      logger.debug('Proxy stats loaded successfully');
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
    fs.writeFileSync(PROXY_STATS_FILE, JSON.stringify(proxyStats, null, 2), 'utf8');
    logger.debug('Proxy stats saved successfully');
  } catch (err) {
    logger.error('Error saving proxyStats:', err);
  }
}

// ------------------------------------
// 3. Choose a Proxy
// ------------------------------------

/**
 * getNextProxy:
 *  - returns a currently-unlocked (not locked) proxy at random
 *  - immediately locks it for the current cooldown
 */
function getNextProxy() {
  logger.debug('getNextProxy: Attempting to choose an unlocked proxy');
  if (proxyList.length === 0) {
    logger.warn('getNextProxy: Proxy list is empty');
    return null;
  }

  const now = Date.now();

  // Filter out locked proxies
  const unlockedProxies = proxyList.filter(proxy => {
    const lockedUntil = lockedProxies[proxy];
    const currentStats = getStatsForProxy(proxy);
    const cooldown = currentStats.cooldown || DEFAULT_LOCK_DURATION_MS;
    const lastUsed = currentStats.lastUsed || 0;
    const unlockedAt = lastUsed + cooldown;
    const isUnlocked = !lockedUntil || lockedUntil <= now;
    logger.debug(`Proxy ${proxy} - lockedUntil: ${lockedUntil}, unlockedUntil: ${unlockedAt}, now: ${now}, isUnlocked: ${isUnlocked}`);
    return isUnlocked;
  });

  if (unlockedProxies.length === 0) {
    logger.warn('getNextProxy: No unlocked proxies available at the moment');
    return null;
  }

  // pick one at random
  const chosenProxy = unlockedProxies[Math.floor(Math.random() * unlockedProxies.length)];
  logger.debug(`getNextProxy: Chosen proxy: ${chosenProxy}`);

  // lock it for "cooldown" ms
  const currentStats = getStatsForProxy(chosenProxy);
  const cooldown = currentStats.cooldown || DEFAULT_LOCK_DURATION_MS;
  lockedProxies[chosenProxy] = now + cooldown;
  currentStats.lastUsed = now;
  logger.debug(`getNextProxy: Locked proxy ${chosenProxy} for ${cooldown}ms (until ${lockedProxies[chosenProxy]})`);
  logger.debug(`getNextProxy: Updated lastUsed for ${chosenProxy} to ${currentStats.lastUsed}`);

  return chosenProxy;
}

/**
 * reportProxyFailure:
 *  - increments failCount
 *  - doubles the cooldown up to a max
 *  - re-locks the proxy until now + newCooldown
 */
function reportProxyFailure(proxy) {
  logger.debug(`reportProxyFailure: Reporting failure for proxy: ${proxy}`);
  const now = Date.now();
  const stats = getStatsForProxy(proxy);

  stats.failCount += 1;
  logger.debug(`reportProxyFailure: Current failCount for ${proxy} is ${stats.failCount}`);

  let newCooldown = stats.cooldown
    ? stats.cooldown * FAILURE_MULTIPLIER
    : DEFAULT_LOCK_DURATION_MS * FAILURE_MULTIPLIER;

  if (newCooldown > MAX_LOCK_DURATION_MS) {
    newCooldown = MAX_LOCK_DURATION_MS;
  }
  stats.cooldown = newCooldown;
  logger.debug(`reportProxyFailure: New cooldown for ${proxy} is set to ${newCooldown}ms`);

  // re-lock
  lockedProxies[proxy] = now + newCooldown;
  stats.lastUsed = now;
  logger.debug(`reportProxyFailure: Proxy ${proxy} locked until ${lockedProxies[proxy]} (now + newCooldown)`);
  logger.debug(`reportProxyFailure: Updated lastUsed for ${proxy} to ${stats.lastUsed}`);
  reportToProxyPool(proxy, false);

  saveProxyStats();
}

/**
 * reportProxySuccess:
 *  - increments successCount
 *  - optionally resets failCount = 0
 *  - sets cooldown back to default
 *  - re-locks or unlocks the proxy
 */
function reportProxySuccess(proxy) {
  logger.debug(`reportProxySuccess: Reporting success for proxy: ${proxy}`);
  const now = Date.now();
  const stats = getStatsForProxy(proxy);

  stats.successCount += 1;
  logger.debug(`reportProxySuccess: Success count for ${proxy} is now ${stats.successCount}`);
  // stats.failCount = 0; // optional if you want to reset fails

  stats.cooldown = DEFAULT_LOCK_DURATION_MS;
  // if you want it immediately available:
  lockedProxies[proxy] = now;
  stats.lastUsed = now;
  logger.debug(`reportProxySuccess: Proxy ${proxy} unlocked`);
  logger.debug(`reportProxySuccess: Updated lastUsed for ${proxy} to ${stats.lastUsed}`);
  reportToProxyPool(proxy, true);

  saveProxyStats();
}

// ------------------------------------
// 4. Stats Helpers
// ------------------------------------
function getStatsForProxy(proxy) {
  if (!proxyStats[proxy]) {
    logger.debug(`getStatsForProxy: No stats for ${proxy}, initializing default stats`);
    proxyStats[proxy] = {
      cooldown: DEFAULT_LOCK_DURATION_MS,
      successCount: 0,
      failCount: 0,
      lastUsed: 0 // Timestamp of last use
    };
  }
  return proxyStats[proxy];
}

// ------------------------------------
// 5. Proxy URL / Auth
// ------------------------------------

/**
 * fixProxyUrl:
 *  - ensures we have a protocol, defaulting to http:// if missing
 *  - if there's '@', tries to encode user/pass
 */
function fixProxyUrl(proxyUrl) {
  logger.debug(`fixProxyUrl: Fixing proxy URL: ${proxyUrl}`);
  // If the user didn't provide "://", we prepend "http://"
  if (!proxyUrl.includes('://')) {
    proxyUrl = 'http://' + proxyUrl;
    logger.debug(`fixProxyUrl: Added protocol, new URL: ${proxyUrl}`);
  }

  // protocolEnd => where "://" finishes
  const protocolSeparator = '://';
  const protocolEnd = proxyUrl.indexOf(protocolSeparator) + protocolSeparator.length;
  const protocol = proxyUrl.slice(0, protocolEnd);
  const remainder = proxyUrl.slice(protocolEnd);

  // if no '@', no credentials => just return
  const atIndex = remainder.lastIndexOf('@');
  if (atIndex === -1) {
    logger.debug(`fixProxyUrl: No credentials found in URL: ${proxyUrl}`);
    return proxyUrl;
  }

  // we have credentials
  const credentials = remainder.slice(0, atIndex);
  const hostPart = remainder.slice(atIndex + 1);

  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    // only username
    const encodedUsername = encodeURIComponent(credentials);
    const fixedUrl = protocol + encodedUsername + '@' + hostPart;
    logger.debug(`fixProxyUrl: Encoded username only, fixed URL: ${fixedUrl}`);
    return fixedUrl;
  } else {
    const username = credentials.slice(0, colonIndex);
    const password = credentials.slice(colonIndex + 1);
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    const fixedUrl = protocol + encodedUsername + ':' + encodedPassword + '@' + hostPart;
    logger.debug(`fixProxyUrl: Encoded username and password, fixed URL: ${fixedUrl}`);
    return fixedUrl;
  }
}

/**
 * getProxyAuthHeaders:
 *  - uses fixProxyUrl to ensure protocol & encode credentials
 *  - if there's username/password, returns { "Proxy-Authorization": "Basic ..."}
 *  - else returns {}
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
  fixProxyUrl,
  reportToProxyPool,
};

/**
 * reportToProxyPool:
 *  - Reports proxy success/failure to an external proxypool service.
 *  - THIS FUNCTION NEEDS TO BE IMPLEMENTED WITH THE CORRECT ENDPOINT AND DATA FORMAT.
 */
function reportToProxyPool(proxy, success) {
  // TODO: Implement the reporting logic here.
  // Example:
  // const endpoint = 'YOUR_PROXYPOOL_ENDPOINT';
  // const data = { proxy: proxy, success: success };
  // try {
  //   await axios.post(endpoint, data);
  //   logger.debug(`Successfully reported proxy ${proxy} to proxypool`);
  // } catch (error) {
  //   logger.error(`Failed to report proxy ${proxy} to proxypool: ${error.message}`);
  // }
  logger.warn(`reportToProxyPool: Not implemented.  Need to implement the reporting logic here.`);
}
