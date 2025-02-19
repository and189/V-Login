const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ------------------------------------
// Settings
// ------------------------------------

// Default cooldown for newly used or successful proxies (example: 10s)
const DEFAULT_LOCK_DURATION_MS = 10 * 1000; 

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
  try {
    const fileContent = fs.readFileSync(PROXIES_TXT_FILE, 'utf8');
    // Split lines, trim, remove empty lines
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
// 2. Load/Save Stats
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
// 3. Choose a Proxy
// ------------------------------------

/**
 * getNextProxy:
 *  - returns a currently-unlocked (not locked) proxy at random
 *  - immediately locks it for the current cooldown
 */
function getNextProxy() {
  if (proxyList.length === 0) {
    return null;
  }

  const now = Date.now();

  // Filter out locked proxies
  const unlockedProxies = proxyList.filter(proxy => {
    const lockedUntil = lockedProxies[proxy];
    return !lockedUntil || lockedUntil < now;
  });

  if (unlockedProxies.length === 0) {
    // none available
    return null;
  }

  // pick one at random
  const chosenProxy = unlockedProxies[Math.floor(Math.random() * unlockedProxies.length)];

  // lock it for "cooldown" ms
  const currentStats = getStatsForProxy(chosenProxy);
  const cooldown = currentStats.cooldown || DEFAULT_LOCK_DURATION_MS;
  lockedProxies[chosenProxy] = now + cooldown;

  return chosenProxy;
}

/**
 * reportProxyFailure:
 *  - increments failCount
 *  - doubles the cooldown up to a max
 *  - re-locks the proxy until now + newCooldown
 */
function reportProxyFailure(proxy) {
  const now = Date.now();
  const stats = getStatsForProxy(proxy);

  stats.failCount += 1;

  let newCooldown = stats.cooldown
    ? stats.cooldown * FAILURE_MULTIPLIER
    : DEFAULT_LOCK_DURATION_MS * FAILURE_MULTIPLIER;

  if (newCooldown > MAX_LOCK_DURATION_MS) {
    newCooldown = MAX_LOCK_DURATION_MS;
  }
  stats.cooldown = newCooldown;

  // re-lock
  lockedProxies[proxy] = now + newCooldown;

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
  const now = Date.now();
  const stats = getStatsForProxy(proxy);

  stats.successCount += 1;
  // stats.failCount = 0; // optional if you want to reset fails

  stats.cooldown = DEFAULT_LOCK_DURATION_MS;
  // if you want it immediately available:
  lockedProxies[proxy] = now; 
  // else lockedProxies[proxy] = now + stats.cooldown;

  saveProxyStats();
}

// ------------------------------------
// 4. Stats Helpers
// ------------------------------------
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
// 5. Proxy URL / Auth
// ------------------------------------

/**
 * fixProxyUrl:
 *  - ensures we have a protocol, defaulting to http:// if missing
 *  - if there's '@', tries to encode user/pass
 */
function fixProxyUrl(proxyUrl) {
  // If the user didn't provide "://", we prepend "http://"
  if (!proxyUrl.includes('://')) {
    proxyUrl = 'http://' + proxyUrl;
  }

  // protocolEnd => where "://" finishes
  const protocolSeparator = '://';
  const protocolEnd = proxyUrl.indexOf(protocolSeparator) + protocolSeparator.length;
  const protocol = proxyUrl.slice(0, protocolEnd);
  const remainder = proxyUrl.slice(protocolEnd);

  // if no '@', no credentials => just return
  const atIndex = remainder.lastIndexOf('@');
  if (atIndex === -1) {
    return proxyUrl;
  }

  // we have credentials
  const credentials = remainder.slice(0, atIndex);
  const hostPart = remainder.slice(atIndex + 1);

  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    // only username
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

/**
 * getProxyAuthHeaders:
 *  - uses fixProxyUrl to ensure protocol & encode credentials
 *  - if there's username/password, returns { "Proxy-Authorization": "Basic ..."}
 *  - else returns {}
 */
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
// Initialization
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
