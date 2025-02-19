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

// External dependencies for sending Discord webhook messages
const axios = require('axios');
const FormData = require('form-data');

/**
 * Helper function to send a screenshot along with a message to a Discord webhook.
 * The webhook URL is read from process.env.DISCORD_WEBHOOK.
 *
 * @param {string} message - The message to send.
 * @param {Buffer} screenshotBuffer - The screenshot image buffer.
 */
async function sendDiscordScreenshot(message, screenshotBuffer) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    logger.warn("No Discord webhook URL configured in .env");
    return;
  }
  const form = new FormData();
  form.append('content', message);
  form.append('file', screenshotBuffer, {
    filename: 'screenshot.png',
    contentType: 'image/png'
  });
  try {
    await axios.post(webhookUrl, form, { headers: form.getHeaders() });
    logger.info("Screenshot sent to Discord webhook");
  } catch (err) {
    logger.error("Failed to send screenshot to Discord: " + err.message);
  }
}

/**
 * Helper function to wait for a given time.
 * Uses page.waitForTimeout if available, otherwise page.waitFor, else falls back to setTimeout.
 *
 * @param {object} page - The Puppeteer page instance.
 * @param {number} ms - Milliseconds to wait.
 */
async function waitFor(page, ms) {
  if (page.waitForTimeout) {
    await page.waitForTimeout(ms);
  } else if (page.waitFor) {
    await page.waitFor(ms);
  } else {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Helper function to capture a screenshot from the page and send it to Discord.
 *
 * @param {object} page - The Puppeteer page instance.
 * @param {string} message - The message to include with the screenshot.
 */
async function captureAndSendScreenshot(page, message) {
  if (page) {
    try {
      // Wait 3 seconds before taking the screenshot.
      await waitFor(page, 3000);
      // Optional: try waiting for the 'body' selector, but don't fail if it times out.
      try {
        await page.waitForSelector('body', { timeout: 5000 });
      } catch (e) {
        logger.warn("Waiting for selector 'body' failed, proceeding with screenshot: " + e.message);
      }
      // Capture the screenshot without an encoding option, so a Buffer is returned.
      let screenshotBuffer = await page.screenshot();
      if (!Buffer.isBuffer(screenshotBuffer)) {
        screenshotBuffer = Buffer.from(screenshotBuffer, 'binary');
      }
      await sendDiscordScreenshot(message, screenshotBuffer);
    } catch (err) {
      logger.error("Failed to capture screenshot: " + err.message);
    }
  }
}

/**
 * Initializes the browser by connecting to a Puppeteer WebSocket endpoint.
 * Sets up a new page, randomizes viewport, and applies anti-detection measures.
 *
 * @param {string} wsEndpoint - The WebSocket endpoint for connecting to the browser
 * @returns {Promise<{ browser: object, page: object }>}
 */
async function initBrowser(wsEndpoint) {
  logger.debug(`Connecting to browser via WebSocket endpoint: ${wsEndpoint}`);
  let browser = null;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const page = await browser.newPage();
    const viewportWidth = 1200 + Math.floor(Math.random() * 200);
    const viewportHeight = 700 + Math.floor(Math.random() * 100);
    logger.debug(`Setting viewport to width: ${viewportWidth}, height: ${viewportHeight}`);
    await page.setViewport({ width: viewportWidth, height: viewportHeight });
    await bypassPuppeteerDetection(page);
    return { browser, page };
  } catch (error) {
    logger.error(`Error initializing browser: ${error.message}`);
    throw error;
  }
}

/**
 * Orchestrates a Puppeteer session to:
 *   - Connect to the browser,
 *   - Check IP ban status,
 *   - Navigate to the login URL (max 5s timeout),
 *   - Check for Imperva ban text,
 *   - Perform login,
 *   - Return ory-code or error codes accordingly,
 *   - Capture screenshots on errors,
 *   - Close browser on completion.
 *
 * @param {string} initialAuthUrl - The URL for initial authentication
 * @param {string} username - The username used for login
 * @param {string} password - The password used for login
 * @param {string} wsEndpoint - The WebSocket endpoint for connecting to the browser
 * @returns {Promise<{ token?: string, error?: string, description?: string }>}
 */
async function runPuppeteer(initialAuthUrl, username, password, wsEndpoint) {
  let browser = null;
  let page = null;
  const uniqueSessionId = uuidv4();

  try {
    logger.info(`Starting Puppeteer session - Session ID: ${uniqueSessionId}`);
    const { browser: br, page: pg } = await initBrowser(wsEndpoint);
    browser = br;
    page = pg;

    // 1) Check the public IP from within the browser
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

    // 2) Check if the IP is banned (custom logic from isIpBanned)
    if (browserIp && await isIpBanned(browserIp)) {
      const msg = `Browser IP ${browserIp} is banned for session ${uniqueSessionId}`;
      logger.error(msg);
      await captureAndSendScreenshot(page, msg);
      return { error: "IP_BLOCKED" };
    }

    // 3) Attempt navigation with a 5-second timeout
    logger.debug(`Navigating to ${initialAuthUrl} - Session ID: ${uniqueSessionId}`);
    try {
      await page.goto(initialAuthUrl, {
        waitUntil: 'networkidle2',
        timeout: 5000 // 5 seconds max
      });
    } catch (err) {
      // If navigation doesn't complete in 5s, we abort here
      const msg = `Navigation failed or timed out after 5 seconds: ${err.message}`;
      logger.warn(`[${uniqueSessionId}] ${msg}`);
      await captureAndSendScreenshot(page, msg);

      // Return "NAVIGATION_TIMEOUT" so the caller can switch proxies or handle differently
      return { error: "NAVIGATION_TIMEOUT" };
    }

    logger.debug(`Navigation completed to ${page.url()} - Session ID: ${uniqueSessionId}`);

    // 4) Check if Imperva blocking text is present
    const pageSource = await page.content();
    if (pageSource.includes(IMPERVA_CHECK_TEXT)) {
      const msg = `Imperva triggered IP ban for session ${uniqueSessionId}`;
      logger.error(msg);
      await captureAndSendScreenshot(page, msg);
      return { error: "IP_BLOCKED" };
    }

    // 5) Perform the actual login
    const loginResult = await performLogin(page, username, password, uniqueSessionId);

    // 6) Handle known return values from performLogin
    if (loginResult === "IP_BLOCKED") {
      const msg = `Login attempt resulted in IP_BLOCKED for session ${uniqueSessionId}`;
      logger.warn(msg);
      await captureAndSendScreenshot(page, msg);
      return { error: "IP_BLOCKED" };
    } else if (loginResult === "ACCOUNT_BANNED") {
      logger.warn(`[${uniqueSessionId}] Account banned detected during login`);
      return { error: "ACCOUNT_BANNED" };
    } else if (loginResult === "INVALID_CREDENTIALS") {
      logger.warn(`[${uniqueSessionId}] Invalid credentials detected => 400`);
      return { error: "INVALID_CREDENTIALS" };
    } else if (loginResult === "ACCOUNT_DISABLED") {
      logger.warn(`[${uniqueSessionId}] Account temporarily disabled => 400`);
      return { error: "ACCOUNT_DISABLED" };
    } else if (typeof loginResult === "string") {
      // If it's a valid ory_ac_ code
      logger.info(`[${uniqueSessionId}] Final code => ${loginResult}`);
      return { token: loginResult };
    } else {
      // loginResult was false or an unknown result
      logger.warn(`[${uniqueSessionId}] Login failed`);
      return { error: "LOGIN_FAILED" };
    }
  } catch (error) {
    // 7) Catch any critical or unexpected errors
    const msg = `Critical error in session ${uniqueSessionId}: ${error.message}`;
    logger.error(msg);
    if (page) {
      await captureAndSendScreenshot(page, msg);
    }
    return { error: "CRITICAL_ERROR", description: error.message };
  } finally {
    // 8) Clean up: close the browser
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
 * Simplified entry point that configures and launches a browser instance with (optionally) a proxy.
 * Then connects to it via WebSocket and performs the login flow with runPuppeteer.
 *
 * @param {string} initialAuthUrl - The URL to navigate to for authentication
 * @param {string} username - The username for login
 * @param {string} password - The password for login
 * @param {string} proxyIndicator - Proxy string (if provided, it is used; otherwise fallback to a proxy pool)
 * @returns {Promise<{ token?: string, error?: string, description?: string }>}
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
    clearCacheOnClose: true,
  };

  const { isProxyWorking } = require('../utils/proxyCheck');

  // If a proxy string is provided, test it first
  if (typeof proxyIndicator === 'string' && proxyIndicator.trim().length > 0) {
    const working = await isProxyWorking(proxyIndicator);
    if (!working) {
      throw new Error(`Provided proxy ${proxyIndicator} is not working`);
    }
    config.proxy = proxyIndicator;
    logger.debug(`Using provided proxy: ${proxyIndicator}`);
  } else {
    // Otherwise, pick a proxy from the pool
    const { getNextProxy } = require('../utils/proxyPool');
    let selectedProxy = null;
    let working = false;
    const maxAttempts = 5;
    let attempt = 0;
    while (!working && attempt < maxAttempts) {
      selectedProxy = await getNextProxy();
      if (!selectedProxy) {
        break;
      }
      working = await isProxyWorking(selectedProxy);
      if (!working) {
        logger.warn(`Proxy ${selectedProxy} failed health check, trying next proxy.`);
      }
      attempt++;
    }
    if (working && typeof selectedProxy === 'string') {
      config.proxy = selectedProxy;
      logger.debug(`Using proxy from proxyPool: ${selectedProxy}`);
    } else {
      logger.debug('No working proxies found; using local IP');
    }
  }

  const browserWSEndpoint = `ws://${host}/devtool/launch?config=${encodeURIComponent(JSON.stringify(config))}`;
  logger.debug(`Browser WS Endpoint: ${browserWSEndpoint}`);

  // Call runPuppeteer with the selected or local IP
  return await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);
}

module.exports = {
  runPuppeteer,
  launchAndConnectToBrowser
};
