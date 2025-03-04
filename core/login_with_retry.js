const logger = require('../utils/logger');
const Browser = require('./puppeteer');
const { getNextProxy, reportProxyFailure, reportProxySuccess } = require('../utils/proxyPool');

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

  // Attempt #1 with provided proxy or local IP.
  logger.debug("Attempt #1: Creating Browser instance and starting browser...");
  const browser1 = new Browser(); // Instantiate Browser class
  await browser1.startBrowser(); // Start the browser
  logger.debug("Attempt #1: Calling loginFlow...");
  let result = await browser1.loginFlow(url, username, password); // Call loginFlow
  logger.debug(`Attempt #1 result: ${JSON.stringify(result)}`);
  await browser1.stopBrowser(); // Stop browser after attempt

  // If a proxy was used, we report the result here.
  // If the login attempt returns a token or an error code that indicates working proxy operation (200, 418 or 400), the proxy is considered successful.
  if (proxy) {
    if (result.token || ["ACCOUNT_BANNED", "INVALID_CREDENTIALS", "LOGIN_FAILED", "ACCOUNT_DISABLED"].includes(result.error)) {
      reportProxySuccess(proxy);
      logger.debug(`Proxy ${proxy} marked as success on attempt #1.`);
    } else {
      reportProxyFailure(proxy);
      logger.debug(`Proxy ${proxy} marked as failure on attempt #1.`);
    }
  }

  
    // Check if errors such as "IP_BLOCKED", "NAVIGATION_TIMEOUT", or "SERVICE_UNAVAILABLE" exist.
    if (result.error === "IP_BLOCKED" || result.error === "NAVIGATION_TIMEOUT" || result.serviceUnavailable) {
      logger.warn(`Error type "${result.error}" detected. Attempting immediate switch to another proxy...`);
    // Get a new proxy from the pool.
    logger.debug("Fetching a new proxy from the proxy pool...");
    const newProxy = await getNextProxy();
    if (!newProxy) {
      logger.error("No more proxies available in the pool. Aborting login retry.");
      return result; // No further proxy available - return original result.
    }

    logger.info(`Switching to new proxy: ${newProxy}`);
    // Attempt #2 with new proxy.
    logger.debug("Attempt #2: Creating Browser instance with new proxy and starting browser...");
    const browser2 = new Browser({ proxy: newProxy }); // Instantiate Browser with proxy
    await browser2.startBrowser(); // Start browser
    logger.debug("Attempt #2: Calling loginFlow with new proxy...");
    result = await browser2.loginFlow(url, username, password); // Call loginFlow
    logger.debug(`Attempt #2 result: ${JSON.stringify(result)}`);
    await browser2.stopBrowser(); // Stop browser after attempt

    // Here, too, we report the result based on the proxy used.
    if (result.token || ["ACCOUNT_BANNED", "INVALID_CREDENTIALS", "LOGIN_FAILED", "ACCOUNT_DISABLED"].includes(result.error)) {
      reportProxySuccess(newProxy);
      logger.debug(`Proxy ${newProxy} marked as success on attempt #2.`);
    } else {
      reportProxyFailure(newProxy);
      logger.debug(`Proxy ${newProxy} marked as failure on attempt #2.`);
    }
  } else {
    logger.debug("No IP_BLOCKED or NAVIGATION_TIMEOUT error detected. Continuing with initial result.");
  }

  logger.info("Login attempt completed.");
  return { result, attempts: proxy ? 2 : 1 };
}

module.exports = { loginWithRetry };
