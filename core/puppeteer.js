// core/puppeteer.js
// This module manages Puppeteer sessions for automated login processes.
// It handles connecting to a browser via WebSocket, setting up pages with randomized viewports,
// bypassing detection mechanisms, and performing login routines with error handling.

const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { IMPERVA_CHECK_TEXT } = require('../config/constants');
const { performLogin } = require('./login_handler');
const { isIpBanned } = require('../utils/ipUtils');

/**
 * Function: initBrowser
 *
 * Purpose:
 *   Connects to an existing Puppeteer browser instance via a provided WebSocket endpoint,
 *   creates a new page with a randomized viewport, and applies anti-detection modifications.
 *
 * Parameters:
 *   - wsEndpoint (string): The WebSocket endpoint for connecting to the browser.
 *
 * Returns:
 *   - An object containing:
 *       { browser, page }
 *
 * Process:
 *   1. Logs the attempt to connect to the browser.
 *   2. Uses puppeteer.connect to establish a connection with the given WebSocket endpoint.
 *   3. Waits for a brief moment to ensure connection stability.
 *   4. Opens a new page.
 *   5. Randomizes the viewport dimensions to mimic natural user behavior.
 *   6. Sets the new viewport dimensions for the page.
 *   7. Calls bypassPuppeteerDetection to modify page properties and avoid bot detection.
 *   8. Returns the browser and page objects.
 *
 * Error Handling:
 *   - Logs and rethrows any errors encountered during the process.
 */
async function initBrowser(wsEndpoint) {
  logger.debug(`Connecting to browser via WebSocket endpoint: ${wsEndpoint}`);
  let browser = null;
  try {
    // Connect to the browser instance using the provided WebSocket endpoint.
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    // Wait for 1 second to ensure the connection is stable.
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Create a new page in the browser.
    const page = await browser.newPage();
    // Generate random viewport dimensions for width and height.
    const viewportWidth = 1200 + Math.floor(Math.random() * 200);
    const viewportHeight = 700 + Math.floor(Math.random() * 100);
    logger.debug(`Setting viewport to width: ${viewportWidth}, height: ${viewportHeight}`);
    // Set the viewport for the new page.
    await page.setViewport({ width: viewportWidth, height: viewportHeight });
    // Apply modifications to bypass Puppeteer detection mechanisms.
    await bypassPuppeteerDetection(page);
    // Return the connected browser and the initialized page.
    return { browser, page };
  } catch (error) {
    logger.error(`Error initializing browser: ${error.message}`);
    throw error;
  }
}

/**
 * Function: runPuppeteer
 *
 * Purpose:
 *   Orchestrates a complete Puppeteer session including:
 *   - Browser connection,
 *   - Public IP verification,
 *   - Navigation to the authentication URL,
 *   - Detection of IP blocking,
 *   - Performing login,
 *   - And handling any errors during the process.
 *
 * Parameters:
 *   - initialAuthUrl (string): The URL for the initial authentication.
 *   - username (string): The username used for login.
 *   - password (string): The password used for login.
 *   - wsEndpoint (string): The WebSocket endpoint for connecting to the browser.
 *
 * Returns:
 *   - An object with either:
 *       { token: <authentication token> } on successful login,
 *       or { error: <error code> } if an error occurs.
 *
 * Process:
 *   1. Generates a unique session ID for logging and tracking.
 *   2. Initializes the browser and page using initBrowser.
 *   3. Retrieves the public IP address from the browser context.
 *   4. Checks if the IP is banned; if banned, returns an "IP_BLOCKED" error.
 *   5. Navigates to the authentication URL and waits until the network is idle.
 *   6. Checks the page content for specific text indicating IP blocking (e.g., Imperva).
 *   7. Performs the login using performLogin with the provided credentials.
 *   8. Interprets the login result:
 *        - Returns an error if known issues occur (IP blocked, account banned, etc.).
 *        - Returns a token if a valid authentication token is received.
 *   9. Closes the browser in a finally block to ensure cleanup.
 *
 * Error Handling:
 *   - Logs and returns specific error codes for different failure scenarios.
 */
async function runPuppeteer(initialAuthUrl, username, password, wsEndpoint) {
  let browser = null;
  let page = null;
  // Generate a unique session ID to track this Puppeteer session.
  const uniqueSessionId = uuidv4();

  try {
    logger.info(`Starting Puppeteer session - Session ID: ${uniqueSessionId}`);
    // Initialize the browser and page.
    const { browser: br, page: pg } = await initBrowser(wsEndpoint);
    browser = br;
    page = pg;

    // Retrieve the public IP address from the browser context.
    const browserIp = await page.evaluate(async () => {
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip;
      } catch (e) {
        return null;
      }
    });
    logger.info(`Public IP (browser-side): ${browserIp}`);
    // Check if the obtained IP is banned.
    if (browserIp && await isIpBanned(browserIp)) {
      logger.error(`Browser IP ${browserIp} is banned.`);
      return { error: "IP_BLOCKED" };
    }

    // Navigate to the authentication URL.
    logger.debug(`Navigating to ${initialAuthUrl} - Session ID: ${uniqueSessionId}`);
    await page.goto(initialAuthUrl, { waitUntil: 'networkidle2' });
    logger.debug(`Navigation completed to ${page.url()} - Session ID: ${uniqueSessionId}`);

    // Verify if the page content includes text that indicates an IP block by Imperva.
    const pageSource = await page.content();
    if (pageSource.includes(IMPERVA_CHECK_TEXT)) {
      logger.error(`IP ban triggered by Imperva for Session ID: ${uniqueSessionId}`);
      return { error: "IP_BLOCKED" };
    }

    // Attempt to log in using the provided username and password.
    const loginResult = await performLogin(page, username, password, uniqueSessionId);
    // Check if the login process returned known error codes.
    if (loginResult === "IP_BLOCKED") {
      logger.warn(`[${uniqueSessionId}] IP blocked detected during login`);
      return { error: "IP_BLOCKED" };
    } else if (loginResult === "ACCOUNT_BANNED") {
      logger.warn(`[${uniqueSessionId}] Account banned detected during login`);
      return { error: "ACCOUNT_BANNED" };
    } else if (typeof loginResult === "string") {
      // If the result is a string, interpret it as a valid authentication token.
      logger.info(`[${uniqueSessionId}] Final code => ${loginResult}`);
      return { token: loginResult };
    } else {
      logger.warn(`[${uniqueSessionId}] Login failed`);
      return { error: "LOGIN_FAILED" };
    }
  } catch (error) {
    // Log any critical errors encountered during the session.
    logger.error(`Critical error in session ${uniqueSessionId}: ${error.message}`);
    return { error: "CRITICAL_ERROR", description: error.message };
  } finally {
    // Ensure the browser is closed to free resources.
    if (browser) {
      logger.debug(`Closing browser - Session ID: ${uniqueSessionId}`);
      try {
        await browser.close();
      } catch (e) {
        logger.error(`Browser close error: ${e.message}`);
      }
    }
  }
}

/**
 * Function: launchAndConnectToBrowser
 *
 * Purpose:
 *   Prepares the configuration for launching a new browser instance with potential proxy settings,
 *   constructs the WebSocket endpoint, and initiates a Puppeteer session by calling runPuppeteer.
 *
 * Parameters:
 *   - initialAuthUrl (string): The URL to navigate to for authentication.
 *   - username (string): The username for login.
 *   - password (string): The password for login.
 *   - proxyIndicator (string): A provided proxy address. If non-empty, it is used; otherwise, a proxy is chosen from a proxy pool.
 *
 * Returns:
 *   - The result from runPuppeteer, which includes either an authentication token or an error code.
 *
 * Process:
 *   1. Defines the host where the browser instance will be launched.
 *   2. Constructs a configuration object with various browser settings including:
 *        - Profile name, platform, kernel type, and incognito mode.
 *        - Fingerprint settings such as timezone, screen dimensions, and user agent.
 *        - Additional arguments like proxy bypass rules.
 *   3. Determines which proxy to use:
 *        - Uses the provided proxy if available,
 *        - Otherwise, attempts to retrieve one from the proxy pool.
 *   4. Constructs the browser's WebSocket endpoint using the host and encoded configuration.
 *   5. Logs the WebSocket endpoint and calls runPuppeteer to start the session.
 */
async function launchAndConnectToBrowser(initialAuthUrl, username, password, proxyIndicator) {
  const host = 'browserless:8848';
  const config = {
    name: 'V-Login',
    once: true,
    platform: 'windows',
    kernel: 'chromium',
    timedCloseSec: 60,
    kernelMilestone: '130',
    skipProxyChecking: true,
    //autoClose: true,
    clearCacheOnClose: true,
  };

  // Determine whether to use a provided proxy or fetch one from the proxy pool.
  if (proxyIndicator && proxyIndicator.trim().length > 0) {
    config.proxy = proxyIndicator;
    logger.debug(`Using provided proxy: ${proxyIndicator}`);
  } else {
    const { getNextProxy } = require('../utils/proxyPool');
    const selectedProxy = getNextProxy();
    if (selectedProxy) {
      config.proxy = selectedProxy;
      logger.debug(`Using proxy from proxyPool: ${selectedProxy}`);
    } else {
      logger.debug('No available proxies; using local IP');
    }
  }

  // Construct the WebSocket endpoint URL with the encoded configuration.
  const browserWSEndpoint = `ws://${host}/devtool/launch?config=${encodeURIComponent(JSON.stringify(config))}`;
  logger.debug(`Browser WS Endpoint: ${browserWSEndpoint}`);

  // Initiate the Puppeteer session using the constructed WebSocket endpoint.
  return await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);
}

module.exports = { runPuppeteer, launchAndConnectToBrowser };
