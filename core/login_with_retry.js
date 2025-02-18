// core/login_with_retry.js

const { getCurrentIp } = require('../utils/ipUtils');
const { setTimeoutPromise } = require('../utils/helpers');
const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');
const { getNextProxy } = require('../utils/proxyPool');

/**
 * Waits until the public IP changes from the given previousIp.
 * @param {string} previousIp - The currently blocked (local) IP.
 * @param {number} checkIntervalMs - How often (in ms) the IP is checked (default: 60000 ms).
 * @returns {Promise<string>} - The new IP as soon as it changes.
 */
async function waitForNewIp(previousIp, checkIntervalMs = 60000) {
  let currentIp = previousIp;
  logger.info(`Local IP blocked. Waiting for a new IP (current IP: ${previousIp})...`);

  // Polling loop: keep checking if the IP has changed.
  while (currentIp === previousIp) {
    await setTimeoutPromise(checkIntervalMs);
    try {
      currentIp = await getCurrentIp();
      logger.info(`Checked current IP: ${currentIp}`);
    } catch (error) {
      logger.warn(`Error retrieving current IP: ${error.message}`);
    }
  }

  logger.info(`New IP detected: ${currentIp}`);
  return currentIp;
}

/**
 * Attempts to log in. If an "IP_BLOCKED" error occurs:
 *  - Without a proxy (local IP), it waits for the IP to change, then retries.
 *  - With a proxy, it immediately skips to the next proxy in the pool (if available).
 *
 * @param {string} url - The login URL.
 * @param {string} username - The username.
 * @param {string} password - The password.
 * @param {string} [proxy] - (Optional) If provided, this proxy will be used.
 * @returns {Promise<Object>} - The result of the login process.
 */
async function loginWithRetry(url, username, password, proxy) {
  logger.info("Starting first login attempt...");
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // Check if an IP_BLOCKED error was encountered
  if (result.error === "IP_BLOCKED") {
    // Case A: Local IP is blocked (no proxy specified or empty)
    if (!proxy || !proxy.trim()) {
      logger.warn("Local IP is blocked. Waiting for IP to change...");
      try {
        const previousIp = await getCurrentIp();
        // Wait for IP to change
        await waitForNewIp(previousIp);

        // Retry login attempt (still without proxy)
        logger.info("Retrying after local IP change...");
        result = await launchAndConnectToBrowser(url, username, password);
      } catch (error) {
        logger.error(`Error during IP change wait: ${error.message}`);
      }

    // Case B: Proxy is blocked -> skip directly to another proxy
    } else {
      logger.warn(`Proxy is blocked: ${proxy}. Trying to get a different proxy from the pool...`);
      const newProxy = getNextProxy();

      if (!newProxy) {
        logger.error("No additional proxies available in the pool. Aborting.");
        return result; // or throw an error, or handle as you prefer
      }

      logger.info(`Chosen new proxy: ${newProxy}. Retrying login...`);
      result = await launchAndConnectToBrowser(url, username, password, newProxy);
    }
  } else {
    logger.debug("No IP_BLOCKED error detected or proxy was already in use. No action needed.");
  }

  return result;
}

module.exports = { loginWithRetry };
