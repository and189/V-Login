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

  // Attempt #1 with the given proxy or local IP.
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // Check if we must handle IP_BLOCKED or NAVIGATION_TIMEOUT
  if (result.error === "IP_BLOCKED" || result.error === "NAVIGATION_TIMEOUT") {
    logger.warn(
      `Error type "${result.error}" detected. Attempting immediate switch to another proxy...`
    );

    // Fetch a new proxy from the pool
    const newProxy = await getNextProxy();
    if (!newProxy) {
      logger.error("No more proxies available in the pool. Aborting.");
      return result; // We can't do anything else
    }

    logger.info(`Switching to new proxy: ${newProxy}`);
    // Attempt #2 with the new proxy
    result = await launchAndConnectToBrowser(url, username, password, newProxy);
  } else {
    // If there's no IP_BLOCKED or NAVIGATION_TIMEOUT error,
    // we don't need to switch proxies.
    logger.debug("No IP_BLOCKED/NAVIGATION_TIMEOUT error. No switch needed.");
  }

  return result;
}

module.exports = { loginWithRetry };
