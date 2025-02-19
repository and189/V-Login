// core/login_with_retry.js

const { getCurrentIp } = require('../utils/ipUtils');
const { setTimeoutPromise } = require('../utils/helpers');
const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');
const { getNextProxy } = require('../utils/proxyPool');

/**
 * Waits for the local IP to change from the previousIp.
 * @param {string} previousIp - The currently banned (local) IP.
 * @param {number} checkIntervalMs - How often (in ms) to check the IP (default: 60000 ms).
 * @returns {Promise<string>} - The new IP once it changes.
 */
async function waitForNewIp(previousIp, checkIntervalMs = 60000) {
  let currentIp = previousIp;
  logger.info(`Local IP is blocked. Waiting for a new IP (current IP: ${previousIp})...`);

  // Polling loop: Check every checkIntervalMs if the IP has changed.
  while (currentIp === previousIp) {
    await setTimeoutPromise(checkIntervalMs);
    try {
      currentIp = await getCurrentIp();
      logger.info(`Re-checked current IP: ${currentIp}`);
    } catch (error) {
      logger.warn(`Error retrieving current IP: ${error.message}`);
    }
  }

  logger.info(`New IP detected: ${currentIp}`);
  return currentIp;
}

/**
 * Tries to log in using `launchAndConnectToBrowser`.
 * Handles "IP_BLOCKED" and "NAVIGATION_TIMEOUT" errors:
 *   - If no proxy is used (local IP): wait for new IP, then retry.
 *   - If a proxy is used: immediately pick another proxy from the pool.
 *
 * @param {string} url - The login/authentication URL.
 * @param {string} username - The username for login.
 * @param {string} password - The password for login.
 * @param {string} [proxy] - (Optional) If provided, this proxy is used first.
 * @returns {Promise<Object>} - The result of the login process ({ token: <string> } or { error: <string> }).
 */
async function loginWithRetry(url, username, password, proxy) {
  logger.info("Starting initial login attempt...");

  // First attempt with the provided proxy (or no proxy if none is given).
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // Check if we must handle IP_BLOCKED or NAVIGATION_TIMEOUT
  if (result.error === "IP_BLOCKED" || result.error === "NAVIGATION_TIMEOUT") {
    // If no proxy is used => local IP is blocked or timed out
    if (!proxy || !proxy.trim()) {
      logger.warn(`Local IP issue ("${result.error}"). We'll wait for a new IP...`);
      try {
        const previousIp = await getCurrentIp();
        // Wait for local IP to change
        await waitForNewIp(previousIp);
        
        // Retry login attempt (still local IP)
        logger.info("Retrying login after local IP changed...");
        result = await launchAndConnectToBrowser(url, username, password);
      } catch (error) {
        logger.error(`Error while waiting for IP change: ${error.message}`);
      }

    // Otherwise, we used a proxy => pick a new proxy right away
    } else {
      logger.warn(`Proxy issue ("${result.error}") for proxy: ${proxy}. Attempting another proxy...`);
      const newProxy = await getNextProxy();

      if (!newProxy) {
        logger.error("No more proxies available in the pool. Aborting.");
        return result; // Or throw an error, if that's your desired behavior.
      }

      logger.info(`New proxy selected: ${newProxy}. Starting a new login attempt...`);
      result = await launchAndConnectToBrowser(url, username, password, newProxy);
    }
  } else {
    // If there's no IP_BLOCKED or NAVIGATION_TIMEOUT error, nothing special to do.
    logger.debug("No IP_BLOCKED/NAVIGATION_TIMEOUT error. No switch needed.");
  }

  return result;
}

module.exports = { loginWithRetry };
