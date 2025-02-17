// core/login_with_retry.js

const { getCurrentIp } = require('../utils/ipUtils');
const { setTimeoutPromise } = require('../utils/helpers');
const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');

/**
 * Waits for the public IP to change from the previousIp.
 *
 * @param {string} previousIp - The currently banned IP.
 * @param {number} checkIntervalMs - How often (in ms) to check the IP (default: 60000 ms).
 * @returns {Promise<string>} - Returns the new IP as soon as it changes.
 */
async function waitForNewIp(previousIp, checkIntervalMs = 60000) {
  let currentIp = previousIp;
  logger.info(`Local IP banned. Waiting for a new IP (current IP: ${previousIp})...`);
  
  // Polling loop: Check every checkIntervalMs if the IP has changed.
  while (currentIp === previousIp) {
    await setTimeoutPromise(checkIntervalMs);
    try {
      currentIp = await getCurrentIp();
      logger.info(`Checked current IP: ${currentIp}`);
    } catch (error) {
      logger.warn(`Error retrieving IP: ${error.message}`);
    }
  }
  logger.info(`New IP detected: ${currentIp}`);
  return currentIp;
}

/**
 * Attempts to log in. If a local IP ban ("IP_BLOCKED" error) is detected
 * and no proxy is used, waits for the public IP to change before retrying.
 *
 * @param {string} url - The authentication URL.
 * @param {string} username - The username.
 * @param {string} password - The password.
 * @param {string} [proxy] - (Optional) If provided, the IP-wait mechanism is skipped.
 * @returns {Promise<Object>} - The result of the login process.
 */
async function loginWithRetry(url, username, password, proxy) {
  // First login attempt
  logger.info("Starting first login attempt...");
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // If no proxy is used and an IP ban (local or Imperva) is detected:
  if (result.error === "IP_BLOCKED" && (!proxy || proxy.trim() === "")) {
    try {
      logger.warn("Detected IP_BLOCKED error. Initiating wait for new IP...");
      const previousIp = await getCurrentIp();
      logger.info(`Current IP before waiting: ${previousIp}`);
      // Wait for the IP to change.
      await waitForNewIp(previousIp);
      
      // Retry the login attempt after the IP change.
      logger.info("Retrying login after IP change...");
      result = await launchAndConnectToBrowser(url, username, password, proxy);
    } catch (error) {
      logger.error(`Error during IP wait and retry: ${error.message}`);
    }
  } else {
    logger.debug("No IP_BLOCKED error detected or proxy in use. Not retrying based on IP.");
  }

  return result;
}

module.exports = { loginWithRetry };
