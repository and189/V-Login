// core/puppeteer.js
const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { IMPERVA_CHECK_TEXT } = require('../config/constants');
const { performLogin } = require('./login_handler');
const { getCurrentIp, isIpBanned } = require('../utils/ipUtils'); // neu importieren

async function initBrowser(wsEndpoint) {
  logger.debug(`Connecting to browser via WebSocket endpoint: ${wsEndpoint}`);
  let browser = null;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    // Kurze Wartezeit, um die Verbindung zu stabilisieren
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

async function runPuppeteer(initialAuthUrl, username, password, wsEndpoint) {
  let browser = null;
  let page = null;
  const uniqueSessionId = uuidv4();

  try {
    logger.info(`Starting Puppeteer session - Session ID: ${uniqueSessionId}`);
    const { browser: br, page: pg } = await initBrowser(wsEndpoint);
    browser = br;
    page = pg;

    // --- Neuer IP-Check beim Session-Start ---
    const currentIp = await getCurrentIp();
    logger.info(`Public IP at session start: ${currentIp}`);
    if (await isIpBanned(currentIp)) {
      logger.error(`Public IP ${currentIp} is banned at session start.`);
      return { error: "IP_BLOCKED" };
    }
    // -------------------------------------------

    logger.debug(`Navigating to ${initialAuthUrl} - Session ID: ${uniqueSessionId}`);
    await page.goto(initialAuthUrl, { waitUntil: 'networkidle2' });
    logger.debug(`Navigation completed to ${page.url()} - Session ID: ${uniqueSessionId}`);

    // Imperva-Check
    const pageSource = await page.content();
    if (pageSource.includes(IMPERVA_CHECK_TEXT)) {
      logger.error(`IP Bann from Imperva triggered for Session ID: ${uniqueSessionId}`);
      return { error: "IP_BLOCKED" };
    }

    // Login durchführen
    const loginResult = await performLogin(page, username, password, uniqueSessionId);

    if (typeof loginResult === "string") {
      logger.info(`[${uniqueSessionId}] Final code => ${loginResult}`);
      return { token: loginResult };
    } else if (loginResult === "IP_BLOCKED") {
      logger.warn(`[${uniqueSessionId}] IP blocked detected during login`);
      return { error: "IP_BLOCKED" };
    } else if (loginResult === "ACCOUNT_BANNED") {
      logger.warn(`[${uniqueSessionId}] Account banned`);
      return { error: "ACCOUNT_BANNED" };
    } else {
      logger.warn(`[${uniqueSessionId}] Login failed`);
      return { error: "LOGIN_FAILED" };
    }
  } catch (error) {
    logger.error(`Critical error in session ${uniqueSessionId}: ${error.message}`);
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

async function launchAndConnectToBrowser(initialAuthUrl, username, password, proxyIndicator) {
  const host = 'localhost:8848';
  const config = {
    once: true,
    headless: true, // Headless-Modus aktivieren
    autoClose: true,
    args: { '--disable-gpu': '', '--no-sandbox': '' },
    fingerprint: {
      name: '',
      platform: 'mac',
      kernel: 'chromium',
      kernelMilestone: 130,
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
  };

  // Falls ein Proxy genutzt werden soll, wird er hier eingebaut.
  if (proxyIndicator && proxyIndicator.trim().length > 0) {
    const { getNextProxy } = require('../utils/proxyPool');
    const selectedProxy = getNextProxy();
    if (selectedProxy) {
      config.args["--proxy-server"] = selectedProxy;
      logger.debug(`Using proxy: ${selectedProxy}`);
    } else {
      logger.debug("No available proxies; using local IP");
    }
  }

  const browserWSEndpoint = `ws://${host}/connect?${encodeURIComponent(JSON.stringify(config))}`;
  logger.debug(`Browser WS Endpoint: ${browserWSEndpoint}`);

  return await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);
}

module.exports = { runPuppeteer, launchAndConnectToBrowser };
