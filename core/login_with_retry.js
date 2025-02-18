// core/login_with_retry.js

const { getCurrentIp } = require('../utils/ipUtils');
const { setTimeoutPromise } = require('../utils/helpers');
const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');
const { getNextProxy } = require('../utils/proxyPool');

/**
 * Waits for the public IP to change from the previousIp.
 * @param {string} previousIp - The currently banned (local) IP.
 * @param {number} checkIntervalMs - How often (in ms) to check the IP (default: 60000 ms).
 * @returns {Promise<string>} - The new IP once it changes.
 */
async function waitForNewIp(previousIp, checkIntervalMs = 60000) {
  let currentIp = previousIp;
  logger.info(`Local IP is blocked. Waiting for new IP (current IP: ${previousIp})...`);
  
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
 * Attempts to log in. If an "IP_BLOCKED" error is detected:
 *  - Without proxy (local IP): waits for IP change and retries.
 *  - With proxy: immediately switches to another proxy from the pool.
 *
 * @param {string} url      - The login URL.
 * @param {string} username - The username.
 * @param {string} password - The password.
 * @param {string} [proxy]  - (Optional) If provided, this proxy is used.
 * @returns {Promise<Object>} - The result of the login process.
 */
async function loginWithRetry(url, username, password, proxy) {
  logger.info("Starting initial login attempt...");
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // Check if an IP block occurred.
  if (result.error === "IP_BLOCKED") {
    // Case A: Local IP is blocked (no proxy provided or empty)
    if (!proxy || !proxy.trim()) {
      logger.warn("Local IP is blocked. Waiting for IP change...");
      try {
        const previousIp = await getCurrentIp();
        // Wait for IP change.
        await waitForNewIp(previousIp);
        
        // Retry login attempt (still using local IP).
        logger.info("Retrying login after local IP change...");
        result = await launchAndConnectToBrowser(url, username, password);
      } catch (error) {
        logger.error(`Error during IP change waiting: ${error.message}`);
      }
    // Case B: Proxy is blocked -> immediately switch to another proxy.
    } else {
      logger.warn(`Proxy blocked: ${proxy}. Attempting to fetch another proxy from the pool...`);
      const newProxy = getNextProxy();
      
      if (!newProxy) {
        logger.error("No additional proxy available in the pool. Aborting.");
        return result; // Alternatively, you can throw an error or handle it differently.
      }

      logger.info(`New proxy selected: ${newProxy}. Starting a new login attempt...`);
      result = await launchAndConnectToBrowser(url, username, password, newProxy);
    }
  } else {
    logger.debug("No IP_BLOCKED error detected or no proxy error. No switch needed.");
  }

  return result;
}

module.exports = { loginWithRetry };
