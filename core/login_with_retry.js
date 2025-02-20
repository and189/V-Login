// core/login_with_retry.js

const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');
const { getNextProxy } = require('../utils/proxyPool');

/**
 * Tries to log in using `launchAndConnectToBrowser`.
 * Handles "IP_BLOCKED" and "NAVIGATION_TIMEOUT" by
 * immediately switching to another proxy (if one exists),
 * whether you're on local IP or already using a proxy.
 *
 * @param {string} url      - The login/auth URL.
 * @param {string} username - The username for login.
 * @param {string} password - The password for login.
 * @param {string} [proxy]  - (Optional) If provided, use this proxy first.
 * @returns {Promise<Object>} - The result of the login process ({ token: <string> } or { error: <string> }).
 */
async function loginWithRetry(url, username, password, proxy) {
  logger.info("Starting initial login attempt...");

  if (proxy) {
    logger.debug(`Initial attempt will use provided proxy: ${proxy}`);
  } else {
    logger.debug("Initial attempt will use local IP (no proxy provided)");
  }

  // Attempt #1 with the given proxy or local IP.
  logger.debug("Attempt #1: Calling launchAndConnectToBrowser with initial parameters...");
  let result = await launchAndConnectToBrowser(url, username, password, proxy);
  logger.debug(`Attempt #1 result: ${JSON.stringify(result)}`);

  // Check if we must handle IP_BLOCKED or NAVIGATION_TIMEOUT
  if (result.error === "IP_BLOCKED" || result.error === "NAVIGATION_TIMEOUT") {
    logger.warn(`Error type "${result.error}" detected. Attempting immediate switch to another proxy...`);

    // Fetch a new proxy from the pool
    logger.debug("Fetching a new proxy from the proxy pool...");
    const newProxy = await getNextProxy();
    if (!newProxy) {
      logger.error("No more proxies available in the pool. Aborting login retry.");
      return result; // No further proxy available, also gibt das ursprüngliche Ergebnis zurück.
    }

    logger.info(`Switching to new proxy: ${newProxy}`);
    // Attempt #2 with the new proxy
    logger.debug("Attempt #2: Calling launchAndConnectToBrowser with new proxy...");
    result = await launchAndConnectToBrowser(url, username, password, newProxy);
    logger.debug(`Attempt #2 result: ${JSON.stringify(result)}`);
  } else {
    // Falls kein IP_BLOCKED oder NAVIGATION_TIMEOUT vorliegt, bleibt der ursprüngliche Versuch bestehen.
    logger.debug("No IP_BLOCKED or NAVIGATION_TIMEOUT error detected. Continuing with initial result.");
  }

  logger.info("Login attempt completed.");
  return result;
}

module.exports = { loginWithRetry };
