// core/puppeteer.js
// Dieses Modul verwaltet Puppeteer-Sessions für automatisierte Login-Prozesse.
// Es verbindet sich über einen WebSocket mit dem Browser, richtet Seiten mit
// randomisierten Viewports ein, wendet Anti-Erkennungsmechanismen an, führt den Login durch
// und speichert bei erfolgreichem Laden Cookies für die nächsten 5 Accounts.

const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { IMPERVA_CHECK_TEXT } = require('../config/constants');
const { performLogin } = require('./login_handler');
const { isIpBanned } = require('../utils/ipUtils');
const axios = require('axios');
const FormData = require('form-data');

// Globaler Cookie-Cache und Nutzungszähler
let cookieCache = null;
let cookieUsageCount = 0;

/**
 * Hilfsfunktion, um einen Screenshot samt Nachricht an einen Discord-Webhook zu senden.
 *
 * @param {string} message - Die zu sendende Nachricht.
 * @param {Buffer} screenshotBuffer - Der Screenshot als Buffer.
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
 * Hilfsfunktion, die eine Wartezeit realisiert.
 *
 * @param {object} page - Die Puppeteer-Seite.
 * @param {number} ms - Anzahl der Millisekunden.
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
 * Erfasst einen Screenshot der Seite und sendet ihn an Discord.
 *
 * @param {object} page - Die Puppeteer-Seite.
 * @param {string} message - Die Nachricht, die mit dem Screenshot gesendet wird.
 */
async function captureAndSendScreenshot(page, message) {
  if (page) {
    try {
      await waitFor(page, 3000);
      try {
        await page.waitForSelector('body', { timeout: 5000 });
      } catch (e) {
        logger.warn("Waiting for selector 'body' failed, proceeding with screenshot: " + e.message);
      }
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
 * Initialisiert den Browser über einen WebSocket-Endpunkt, richtet eine neue Seite ein,
 * setzt (falls vorhanden) den Cookie-Cache und wendet Anti-Erkennungsmethoden an.
 *
 * @param {string} wsEndpoint - Der WebSocket-Endpunkt.
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
 * Führt eine komplette Puppeteer-Session aus:
 *   - Verbindet sich mit dem Browser,
 *   - Prüft auf IP-Ban,
 *   - Navigiert zur Login-URL,
 *   - Falls die Navigation fehlschlägt (z.B. wegen Timeout) und ein Cookie-Cache vorhanden ist,
 *     wird der Vorgang abgebrochen, damit im Retry-Loop ein neuer Proxy gewählt werden kann,
 *   - Prüft auf Imperva-Blockierung,
 *   - Führt den Login durch,
 *   - Speichert (falls noch nicht vorhanden) die Cookies für künftige Logins,
 *   - Gibt den ory-code bzw. Fehlercodes zurück,
 *   - Schickt bei Fehlern Screenshots,
 *   - Schließt den Browser.
 *
 * @param {string} initialAuthUrl - URL für die Authentifizierung.
 * @param {string} username - Der Login-Benutzername.
 * @param {string} password - Das Login-Passwort.
 * @param {string} wsEndpoint - Der WebSocket-Endpunkt.
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

    logger.debug(`Navigating to ${initialAuthUrl} - Session ID: ${uniqueSessionId}`);
    // Setze das Standard-Navigationstiming auf 3 Sekunden
    page.setDefaultNavigationTimeout(3000);

    // Nutze Promise.race, um entweder den erfolgreichen Abschluss von page.goto oder einen manuellen Timeout zu erhalten
    const gotoPromise = page.goto(initialAuthUrl, { waitUntil: 'domcontentloaded' });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Navigation timeout exceeded")), 3000)
    );

    try {
      await Promise.race([gotoPromise, timeoutPromise]);
    } catch (err) {
      const msg = `Navigation timed out after 3 seconds: ${err.message}`;
      logger.warn(`[${uniqueSessionId}] ${msg}`);
      await captureAndSendScreenshot(page, msg);
      try {
        await page.close(); // Direktes Schließen der Seite beim Timeout
      } catch (e) {
        logger.error(`Error closing page on timeout: ${e.message}`);
      }
      return { error: "TIMEOUT", description: msg };
    }

    logger.debug(`Navigation completed to ${page.url()} - Session ID: ${uniqueSessionId}`);

    // Falls noch kein Cookie-Cache vorhanden ist, speichere die aktuellen Cookies für die nächsten 5 Accounts
    if (!cookieCache) {
      cookieCache = await page.cookies();
      cookieUsageCount = 5;
      logger.debug(`Cookie cache stored with ${cookieCache.length} cookies; will reuse for next ${cookieUsageCount} accounts`);
    }

    const pageSource = await page.content();
    if (pageSource.includes(IMPERVA_CHECK_TEXT)) {
      const msg = `Imperva triggered IP ban for session ${uniqueSessionId}`;
      logger.error(msg);
      await captureAndSendScreenshot(page, msg);
      return { error: "IP_BLOCKED" };
    }

    const loginResult = await performLogin(page, username, password, uniqueSessionId);

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
    } else if (loginResult === "LOGIN_FAILED") {
      logger.warn(`[${uniqueSessionId}] Login process failed (LOGIN_FAILED)`);
      return { error: "LOGIN_FAILED" };
    } else if (typeof loginResult === "string") {
      logger.info(`[${uniqueSessionId}] Final code => ${loginResult}`);
      return { token: loginResult };
    } else {
      logger.warn(`[${uniqueSessionId}] Login failed`);
      return { error: "LOGIN_FAILED" };
    }
  } catch (error) {
    const msg = `Critical error in session ${uniqueSessionId}: ${error.message}`;
    logger.error(msg);
    if (page) {
      await captureAndSendScreenshot(page, msg);
    }
    return { error: "CRITICAL_ERROR", description: error.message };
  } finally {
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
 * Einstiegspunkt, der den Browser mit (optional) Proxy-Konfiguration startet,
 * sich via WebSocket verbindet und den Login-Prozess durchführt.
 *
 * @param {string} initialAuthUrl - URL zur Authentifizierung.
 * @param {string} username - Der Login-Benutzername.
 * @param {string} password - Das Login-Passwort.
 * @param {string} proxyIndicator - Proxy-Zeichenkette (falls angegeben).
 * @returns {Promise<{ token?: string, error?: string, description?: string }>}
 */
async function launchAndConnectToBrowser(initialAuthUrl, username, password, proxyIndicator) {
  const host = 'browserless:8848';
  const config = {
    name: 'V-Login',
    once: true,
    platform: 'windows',
    kernel: 'chromium',
    disableImageLoading: true,
    timedCloseSec: 60,
    kernelMilestone: '130',
    startupUrls: [initialAuthUrl],
    skipProxyChecking: true,
    clearCacheOnClose: true,
    languages: ["en-US", "en"],
    args: {
      "--lang": "en-US"
    },
  };
  const { isProxyWorking } = require('../utils/proxyCheck');

  if (typeof proxyIndicator === 'string' && proxyIndicator.trim().length > 0) {
    const working = await isProxyWorking(proxyIndicator);
    if (!working) {
      throw new Error(`Provided proxy ${proxyIndicator} is not working`);
    }
    config.proxy = proxyIndicator;
    logger.debug(`Using provided proxy: ${proxyIndicator}`);
  } else {
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

  return await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);
}

module.exports = {
  runPuppeteer,
  launchAndConnectToBrowser
};
