const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { IMPERVA_CHECK_TEXT, DEFAULT_NAVIGATION_TIMEOUT_MS } = require('../config/constants');
const { performLogin } = require('./login_handler');
const { isIpBanned } = require('../utils/ipUtils');
const axios = require('axios');
const FormData = require('form-data');

// Globaler Cookie-Cache und Nutzungszähler
let cookieCache = null;
let cookieUsageCount = 0;

/**
 * Sendet eine einfache Textnachricht an den Discord-Webhook.
 *
 * @param {string} message - Die Nachricht, die gesendet werden soll.
 */
async function postDiscordText(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    logger.warn("No Discord webhook URL configured in .env");
    return;
  }
  try {
    await axios.post(webhookUrl, { content: message });
    logger.info("Discord text message posted successfully");
  } catch (err) {
    logger.error("Failed to post Discord message: " + err.message);
  }
}

/**
 * Sendet einen Screenshot samt Nachricht an den Discord-Webhook.
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
 * Wartet die angegebene Anzahl von Millisekunden.
 *
 * @param {number} ms - Anzahl der Millisekunden.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Realisiert eine Wartezeit.
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
 * Überprüft, ob die Seite einen Captcha-/Bann-Hinweis anzeigt.
 *
 * @param {object} page - Die Puppeteer-Seite.
 * @returns {Promise<boolean>}
 */
async function checkForCaptchaBan(page) {
  await waitFor(page, 3000);
  const content = await page.content();
  return content.includes("Additional security check is required");
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
    await sleep(1000);
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
 * - Verbindet sich mit dem Browser,
 * - Navigiert zuerst kurz zu Google, macht einen Screenshot und sendet diesen an Discord,
 * - Navigiert anschließend zu https://www.pokemon.com/us, macht einen Screenshot und sendet diesen,
 * - Navigiert schließlich zur Haupt-URL (initialAuthUrl) und wartet bis geladen,
 * - Prüft auf Imperva-Blockierung,
 * - Führt den Login durch,
 * - Postet am Ende einen Discord-Post mit dem Ergebnis,
 * - Schließt den Browser.
 *
 * @param {string} initialAuthUrl - URL zur Authentifizierung (Haupt-URL).
 * @param {string} username - Login-Benutzername.
 * @param {string} password - Login-Passwort.
 * @param {string} wsEndpoint - WebSocket-Endpunkt.
 * @returns {Promise<{ token?: string, error?: string, description?: string }>}
 */
async function runPuppeteer(initialAuthUrl, username, password, wsEndpoint) {
  let browser = null;
  let page = null;
  const uniqueSessionId = uuidv4();
  let attemptOutcome = '';

  try {
    await postDiscordText(`Session ${uniqueSessionId}: Starting login attempt using wsEndpoint ${wsEndpoint}`);
    logger.info(`Starting Puppeteer session - Session ID: ${uniqueSessionId}`);
    const { browser: br, page: pg } = await initBrowser(wsEndpoint);
    browser = br;
    page = pg;

    // Sende Screenshot des initialen Browserzustands
    await captureAndSendScreenshot(page, `Session ${uniqueSessionId}: Browser launched`);

    // Zunächst kurz zu Google navigieren und Screenshot senden
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(2000);
    await captureAndSendScreenshot(page, `Session ${uniqueSessionId}: Google homepage loaded`);

    // Anschließend zu Pokémon US navigieren und Screenshot senden
    await page.goto('https://www.pokemon.com/us', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(2000);
    await captureAndSendScreenshot(page, `Session ${uniqueSessionId}: Pokémon US homepage loaded`);

    // Nun zur Haupt-URL navigieren
    logger.debug(`Session ${uniqueSessionId}: Navigating to ${initialAuthUrl}`);
    let baseTimeout = Number(DEFAULT_NAVIGATION_TIMEOUT_MS) || 10000;
    let navigationTimeout = wsEndpoint.toLowerCase().includes('proxy') ? baseTimeout * 3 : baseTimeout;
    logger.debug(`Session ${uniqueSessionId}: Navigation timeout set to ${navigationTimeout}ms`);
    page.setDefaultNavigationTimeout(navigationTimeout);

    // Quick-Response-Check: Warte bis zu 2000ms auf den ersten Netzwerk-Response
    const quickResponse = new Promise((resolve, reject) => {
      page.once('response', () => resolve());
      setTimeout(() => reject(new Error("No network response received within 2000ms")), 2000);
    });
    try {
      await quickResponse;
      logger.debug(`Session ${uniqueSessionId}: Quick response received, proceeding with navigation`);
    } catch (quickErr) {
      const msg = `Session ${uniqueSessionId}: Quick response check failed: ${quickErr.message}`;
      logger.warn(msg);
      await postDiscordText(msg);
      await captureAndSendScreenshot(page, msg);
      attemptOutcome = "NO_RESPONSE";
      return { error: "NO_RESPONSE", description: quickErr.message };
    }

    try {
      await page.goto(initialAuthUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    } catch (err) {
      const msg = `Session ${uniqueSessionId}: Navigation to main URL failed after ${navigationTimeout}ms: ${err.message}`;
      logger.warn(msg);
      await captureAndSendScreenshot(page, msg);
      await postDiscordText(msg);
      attemptOutcome = "TIMEOUT";
      return { error: "TIMEOUT", description: msg };
    }

    logger.debug(`Session ${uniqueSessionId}: Navigation completed to ${page.url()}`);

    if (!cookieCache) {
      cookieCache = await page.cookies();
      cookieUsageCount = 5;
      logger.debug(`Session ${uniqueSessionId}: Cookie cache stored with ${cookieCache.length} cookies`);
    }

    const pageSource = await page.content();
    if (pageSource.includes(IMPERVA_CHECK_TEXT)) {
      const msg = `Session ${uniqueSessionId}: Imperva triggered IP ban`;
      logger.error(msg);
      await captureAndSendScreenshot(page, msg);
      await postDiscordText(msg);
      attemptOutcome = "IP_BLOCKED";
      return { error: "IP_BLOCKED" };
    }

    const loginResult = await performLogin(page, username, password, uniqueSessionId);
    if (loginResult === "IP_BLOCKED") {
      const msg = `Session ${uniqueSessionId}: Login resulted in IP_BLOCKED`;
      logger.warn(msg);
      await captureAndSendScreenshot(page, msg);
      await postDiscordText(msg);
      attemptOutcome = "IP_BLOCKED";
      return { error: "IP_BLOCKED" };
    } else if (loginResult === "ACCOUNT_BANNED") {
      const msg = `Session ${uniqueSessionId}: Account banned during login`;
      logger.warn(msg);
      await postDiscordText(msg);
      attemptOutcome = "ACCOUNT_BANNED";
      return { error: "ACCOUNT_BANNED" };
    } else if (loginResult === "INVALID_CREDENTIALS") {
      const msg = `Session ${uniqueSessionId}: Invalid credentials`;
      logger.warn(msg);
      await postDiscordText(msg);
      attemptOutcome = "INVALID_CREDENTIALS";
      return { error: "INVALID_CREDENTIALS" };
    } else if (loginResult === "ACCOUNT_DISABLED") {
      const msg = `Session ${uniqueSessionId}: Account temporarily disabled`;
      logger.warn(msg);
      await postDiscordText(msg);
      attemptOutcome = "ACCOUNT_DISABLED";
      return { error: "ACCOUNT_DISABLED" };
    } else if (loginResult === "LOGIN_FAILED") {
      const msg = `Session ${uniqueSessionId}: Login process failed`;
      logger.warn(msg);
      await postDiscordText(msg);
      await captureAndSendScreenshot(page, msg);
      attemptOutcome = "LOGIN_FAILED";
      return { error: "LOGIN_FAILED" };
    } else if (typeof loginResult === "string") {
      const msg = `Session ${uniqueSessionId}: Login successful, final code: ${loginResult}`;
      logger.info(msg);
      await captureAndSendScreenshot(page, msg);
      await postDiscordText(msg);
      attemptOutcome = "SUCCESS";
      return { token: loginResult };
    } else {
      const msg = `Session ${uniqueSessionId}: Unknown error during login`;
      logger.warn(msg);
      await postDiscordText(msg);
      attemptOutcome = "LOGIN_FAILED";
      return { error: "LOGIN_FAILED" };
    }
  } catch (error) {
    const msg = `Session ${uniqueSessionId}: Critical error: ${error.message}`;
    logger.error(msg);
    if (page) {
      await captureAndSendScreenshot(page, msg);
    }
    await postDiscordText(msg);
    attemptOutcome = "CRITICAL_ERROR";
    return { error: "CRITICAL_ERROR", description: error.message };
  } finally {
    if (browser) {
      logger.debug(`Session ${uniqueSessionId}: Closing browser (Outcome: ${attemptOutcome})`);
      await postDiscordText(`Session ${uniqueSessionId} finished with outcome: ${attemptOutcome}`);
      try {
        await browser.close();
      } catch (e) {
        logger.error(`Session ${uniqueSessionId}: Error closing browser: ${e.message}`);
      }
    }
  }
}

/**
 * Einstiegspunkt, der den Browser mit (optional) Proxy-Konfiguration startet,
 * sich via WebSocket verbindet und den Login-Prozess durchführt.
 * Falls ein temporärer Fehler (z. B. NO_RESPONSE, CAPTCHA_BANNED, IP_BLOCKED, TIMEOUT oder LOGIN_FAILED)
 * auftritt, wird bis zu 3 Mal erneut versucht – jeweils mit einem neuen Proxy bzw. einem neuen Browser.
 *
 * Wichtig: Beim ersten Versuch wird ein übergebener Proxy (proxyIndicator) genutzt. Falls proxyIndicator ein Promise ist, wird er aufgelöst.
 *
 * @param {string} initialAuthUrl - URL zur Authentifizierung.
 * @param {string} username - Der Login-Benutzername.
 * @param {string} password - Das Login-Passwort.
 * @param {string|Promise<string>} proxyIndicator - (Optional) Ein initial zu nutzender Proxy oder ein Promise darauf.
 * @returns {Promise<{ token?: string, error?: string, description?: string }>}
 */
async function launchAndConnectToBrowser(initialAuthUrl, username, password, proxyIndicator) {
  const host = 'localhost:8848';
  const maxAttempts = 3;
  let attempt = 0;
  let result = null;
  let working = false;
  while (attempt < maxAttempts) {
    attempt++;
    const config = {
      name: 'V-Login',
      once: true,
      platform: 'windows',
      kernel: 'chromium',
      timedCloseSec: 60,
      kernelMilestone: '130',
      startupUrls: [initialAuthUrl],
      skipProxyChecking: true,
      clearCacheOnClose: true,
      languages: ["en-US", "en"],
      args: { "--disable-blink-features=AutomationControlled": "" },
    };

    let selectedProxy = null;
    if (attempt === 1 && proxyIndicator) {
      if (typeof proxyIndicator.then === 'function') {
        selectedProxy = await proxyIndicator;
      } else if (typeof proxyIndicator === 'string') {
        selectedProxy = proxyIndicator;
      }
      logger.debug(`Using provided proxy for first attempt: ${selectedProxy}`);
    } else {
      const { getNextProxy } = require('../utils/proxyPool');
      working = false;
      const maxProxyAttempts = 5;
      let proxyAttempt = 0;
      while (!working && proxyAttempt < maxProxyAttempts) {
        proxyAttempt++;
        selectedProxy = await getNextProxy();
        if (!selectedProxy) break;
        const { isProxyWorking } = require('../utils/proxyCheck');
        working = await isProxyWorking(selectedProxy);
        if (!working) {
          logger.warn(`Proxy ${selectedProxy} failed health check, trying next proxy.`);
        }
      }
      if (working && typeof selectedProxy === 'string') {
        logger.debug(`Using proxy from proxyPool: ${selectedProxy}`);
      } else {
        logger.debug('No working proxies found; using local IP');
      }
    }
    if (selectedProxy) {
      config.proxy = selectedProxy;
    }

    const browserWSEndpoint = `ws://${host}/devtool/launch?config=${encodeURIComponent(JSON.stringify(config))}`;
    logger.debug(`Browser WS Endpoint: ${browserWSEndpoint}`);

    result = await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);
    if (result.token) {
      return result;
    }
    if (
      result.error === "CAPTCHA_BANNED" ||
      result.error === "IP_BLOCKED" ||
      result.error === "TIMEOUT" ||
      result.error === "LOGIN_FAILED" ||
      result.error === "NO_RESPONSE"
    ) {
      logger.warn(`Attempt ${attempt} failed with error ${result.error}. Retrying with a new proxy...`);
      continue;
    } else {
      return result;
    }
  }
  return result;
}

module.exports = {
  runPuppeteer,
  launchAndConnectToBrowser
};
