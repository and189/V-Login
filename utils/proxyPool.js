// utils/proxyPool.js
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Read proxies from proxies.txt in the root directory.
// Expected format: one proxy per line, e.g.:
// http://user:password@proxy1.com:8080
// http://user:password@proxy2.com:8080
let proxyList = [];
try {
  const proxiesFilePath = path.join(process.cwd(), 'proxies.txt');
  const fileContent = fs.readFileSync(proxiesFilePath, 'utf8');
  // Split the file into lines, remove empty lines, and trim each entry.
  proxyList = fileContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  console.log(`Loaded ${proxyList.length} proxies from proxies.txt`);
} catch (err) {
  console.error("Error reading proxies.txt:", err);
  // If an error occurs, the proxyList remains empty.
  proxyList = [];
}

// Object to store until when a proxy is locked.
const lockedProxies = {};

// Object to store the current cooldown for each proxy.
const proxyCooldowns = {};

// Default cooldown: 10 minutes
const DEFAULT_LOCK_DURATION_MS = 10 * 60 * 1000;

// Maximum lock duration: 12 hours
const MAX_LOCK_DURATION_MS = 12 * 60 * 60 * 1000;

/**
 * Returns the next available proxy and locks it for its current cooldown.
 * If all proxies are locked or none are configured, returns null.
 */
function getNextProxy() {
  if (proxyList.length === 0) {
    return null;
  }
  
  const now = Date.now();

  for (const proxy of proxyList) {
    const lockedUntil = lockedProxies[proxy];
    if (!lockedUntil || lockedUntil < now) {
      // Use the currently stored cooldown or the default value.
      const cooldown = proxyCooldowns[proxy] || DEFAULT_LOCK_DURATION_MS;
      lockedProxies[proxy] = now + cooldown;
      return proxy;
    }
  }
  
  // If all proxies are locked, return null (local IP will be used)
  return null;
}

/**
 * Reports a proxy failure (IP ban) and doubles its cooldown (up to MAX_LOCK_DURATION_MS).
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
 * Reports a successful use of the proxy and resets its cooldown.
 */
function reportProxySuccess(proxy) {
  proxyCooldowns[proxy] = DEFAULT_LOCK_DURATION_MS;
  // Optional: If desired, the proxy can be locked again.
}

/**
 * Fixes a proxy URL by encoding the credentials (username and password),
 * so that special characters (like "@") do not break URL parsing.
 * @param {string} proxyUrl - The original proxy URL.
 * @returns {string} - The fixed proxy URL with encoded credentials.
 */
function fixProxyUrl(proxyUrl) {
  const protocolSeparator = '://';
  const protocolEnd = proxyUrl.indexOf(protocolSeparator);
  if (protocolEnd === -1) {
    // No protocol found; return original URL.
    return proxyUrl;
  }
  
  const protocol = proxyUrl.slice(0, protocolEnd + protocolSeparator.length);
  const remainder = proxyUrl.slice(protocolEnd + protocolSeparator.length);
  
  // If there's no '@', then there's no credentials to fix.
  const atIndex = remainder.lastIndexOf('@');
  if (atIndex === -1) {
    return proxyUrl;
  }
  
  const credentials = remainder.slice(0, atIndex);
  const hostPart = remainder.slice(atIndex + 1);
  
  // Split credentials into username and password.
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    // Only username provided.
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
 * Extracts the "Proxy-Authorization" header from the proxy URL.
 * @param {string} proxyUrl - The proxy URL in the format http://user:password@host:port
 * @returns {object} - An object with the header, e.g. { "Proxy-Authorization": "Basic <credentials>" }.
 */
function getProxyAuthHeaders(proxyUrl) {
  try {
    // Fix the URL to ensure credentials are encoded.
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

module.exports = {
  getNextProxy,
  reportProxyFailure,
  reportProxySuccess,
  getProxyAuthHeaders
};
