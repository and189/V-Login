// core/puppeteer.js

const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { performLogin } = require('./login_handler');
const axios = require('axios');
const FormData = require('form-data');

// KEYWORDS zum Erkennen von Imperva/AccessDenied
const IMPERVA_KEYWORDS = ["Access Denied", "Error 15", "blocked by our security service"];

/**
 * Screenshot + Discord
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
 * Warte-Helfer
 */
async function waitFor(page, ms) {
  if (page.waitForTimeout) {
    await page.waitForTimeout(ms);
  } else {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Screenshot-Helfer
 */
async function captureAndSendScreenshot(page, message) {
  if (!page) return;
  try {
    await waitFor(page, 2000);
    try {
      await page.waitForSelector('body', { timeout: 2000 });
    } catch (e) {
      logger.warn(`No body found quickly => screenshot anyway: ${e.message}`);
    }
    let screenshotBuffer = await page.screenshot();
    if (!Buffer.isBuffer(screenshotBuffer)) {
      screenshotBuffer = Buffer.from(screenshotBuffer, 'binary');
    }
    await sendDiscordScreenshot(message, screenshotBuffer);
  } catch (err) {
    logger.error(`Failed to capture screenshot: ${err.message}`);
  }
}

/**
 * Browser & Seite initialisieren
 */
async function initBrowser(wsEndpoint) {
  logger.debug(`Connecting to browser via WebSocket endpoint: ${wsEndpoint}`);
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  await new Promise(resolve => setTimeout(resolve, 500));
  const page = await browser.newPage();

  // Zufällige Viewport-Größe
  const w = 1200 + Math.floor(Math.random() * 200);
  const h = 700 + Math.floor(Math.random() * 100);
  logger.debug(`Viewport: ${w}x${h}`);
  await page.setViewport({ width: w, height: h });

  await bypassPuppeteerDetection(page);

  return { browser, page };
}

/**
 * Führt Puppeteer-Session durch (mit sehr kurzem Navigation-Timeout).
 */
async function runPuppeteer(initialAuthUrl, username, password, wsEndpoint) {
  let browser;
  let page;
  const uniqueSessionId = uuidv4();

  try {
    logger.info(`[${uniqueSessionId}] Starting Puppeteer session`);
    const { browser: br, page: pg } = await initBrowser(wsEndpoint);
    browser = br;
    page = pg;

    // Sehr kurzer Timeout
    const NAV_TIMEOUT_MS = 2000;
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    logger.debug(`[${uniqueSessionId}] Goto => ${initialAuthUrl} (timeout ${NAV_TIMEOUT_MS}ms)`);
    const gotoPromise = page.goto(initialAuthUrl, { waitUntil: 'domcontentloaded' });
    const manualTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Manual navigation timeout")), NAV_TIMEOUT_MS)
    );

    try {
      await Promise.race([gotoPromise, manualTimeout]);
    } catch (err) {
      const msg = `Navigation timed out after ${NAV_TIMEOUT_MS}ms: ${err.message}`;
      logger.warn(`[${uniqueSessionId}] ${msg}`);
      await captureAndSendScreenshot(page, msg);
      return { error: "TIMEOUT", description: msg };
    }

    logger.debug(`[${uniqueSessionId}] Navigation OK => ${page.url()}`);

    // IP-Ban / Imperva-Check
    const pageText = await page.evaluate(() => document.body.innerText || "");
    if (IMPERVA_KEYWORDS.some(kw => pageText.includes(kw))) {
      const msg = `IP_BLOCKED (Imperva) => ${uniqueSessionId}`;
      logger.warn(msg);
      await captureAndSendScreenshot(page, msg);
      return { error: "IP_BLOCKED" };
    }

    // Login
    const loginResult = await performLogin(page, username, password, uniqueSessionId);
    if (typeof loginResult === "string") {
      logger.info(`[${uniqueSessionId}] Login success => token: ${loginResult}`);
      return { token: loginResult };
    } else {
      logger.warn(`[${uniqueSessionId}] Login error => ${loginResult}`);
      return { error: loginResult };
    }
  } catch (error) {
    const msg = `[${uniqueSessionId}] CRITICAL: ${error.message}`;
    logger.error(msg);
    if (page) {
      await captureAndSendScreenshot(page, msg);
    }
    return { error: "CRITICAL_ERROR", description: error.message };
  } finally {
    if (browser) {
      logger.debug(`[${uniqueSessionId}] Closing browser`);
      try {
        await browser.close();
      } catch (e) {
        logger.error(`[${uniqueSessionId}] Browser close error: ${e.message}`);
      }
    }
  }
}

/**
 * Ruft runPuppeteer mehrfach auf, bis keine TIMEOUT-Fehler mehr auftreten
 * oder wir die maximale Proxy-Anzahl überschreiten.
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
    }
  };

  const { isProxyWorking } = require('../utils/proxyCheck');
  const { getNextProxy } = require('../utils/proxyPool');

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    // Falls ein Proxy manuell übergeben wurde (proxyIndicator), nutze den
    // ansonsten hole einen Proxy aus dem Pool
    let selectedProxy = proxyIndicator;
    if (!selectedProxy) {
      selectedProxy = await getNextProxy();
    }

    if (selectedProxy) {
      const working = await isProxyWorking(selectedProxy);
      if (!working) {
        logger.warn(`Proxy ${selectedProxy} failed health check, trying next...`);
        continue; // Schleife neu => nächster Proxy
      }
      config.proxy = selectedProxy;
      logger.debug(`Using proxy: ${selectedProxy}`);
    } else {
      logger.debug("No proxy found => using local IP");
      delete config.proxy; // Kein Proxy => local IP
    }

    const browserWSEndpoint = `ws://${host}/devtool/launch?config=${encodeURIComponent(JSON.stringify(config))}`;
    logger.debug(`BrowserWSEndpoint => ${browserWSEndpoint}`);

    const result = await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);

    if (result.error === "TIMEOUT") {
      logger.warn(`Attempt #${attempts} => TIMEOUT => Trying next proxy...`);
      continue; // Nächster Versuch
    } else {
      // Entweder Erfolg oder anderer Fehler => direkt zurück
      return result;
    }
  }

  // Falls wir alle Versuche verbraucht haben
  return {
    error: "TIMEOUT",
    description: `All ${maxAttempts} attempts ended in TIMEOUT or proxy failure`
  };
}

module.exports = {
  runPuppeteer,
  launchAndConnectToBrowser
};
