// core/puppeteer.js
const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { IMPERVA_CHECK_TEXT } = require('../config/constants');
const { performLogin } = require('./login_handler');
const { isIpBanned } = require('../utils/ipUtils');

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

async function runPuppeteer(initialAuthUrl, username, password, wsEndpoint) {
  let browser = null;
  let page = null;
  const uniqueSessionId = uuidv4();

  try {
    logger.info(`Starting Puppeteer session - Session ID: ${uniqueSessionId}`);
    const { browser: br, page: pg } = await initBrowser(wsEndpoint);
    browser = br;
    page = pg;

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
    if (browserIp && await isIpBanned(browserIp)) {
      logger.error(`Browser IP ${browserIp} is banned.`);
      return { error: "IP_BLOCKED" };
    }

    logger.debug(`Navigating to ${initialAuthUrl} - Session ID: ${uniqueSessionId}`);
    await page.goto(initialAuthUrl, { waitUntil: 'networkidle2' });
    logger.debug(`Navigation completed to ${page.url()} - Session ID: ${uniqueSessionId}`);

    const pageSource = await page.content();
    if (pageSource.includes(IMPERVA_CHECK_TEXT)) {
      logger.error(`IP ban triggered by Imperva for Session ID: ${uniqueSessionId}`);
      return { error: "IP_BLOCKED" };
    }

    const loginResult = await performLogin(page, username, password, uniqueSessionId);
    // Zuerst prüfen, ob ein bekannter Fehlercode zurückgegeben wurde…
    if (loginResult === "IP_BLOCKED") {
      logger.warn(`[${uniqueSessionId}] IP blocked detected during login`);
      return { error: "IP_BLOCKED" };
    } else if (loginResult === "ACCOUNT_BANNED") {
      logger.warn(`[${uniqueSessionId}] Account banned detected during login`);
      return { error: "ACCOUNT_BANNED" };
    } else if (typeof loginResult === "string") {
      // …nur dann wird der String als gültiger Token interpretiert.
      logger.info(`[${uniqueSessionId}] Final code => ${loginResult}`);
      return { token: loginResult };
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
    name: 'testProfile',
    once: true,
    platform: 'windows',
    kernel: 'chromium',
    incognito: true,
    kernelMilestone: '130',
    skipProxyChecking: true,
    autoClose: true,
    clearCacheOnClose: true,
    fingerprint: {
      flags: {
        timezone: 'BasedOnIp',
        screen: 'Custom'
      },
      screen: {
        width: 1000,
        height: 1000
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.85 Safari/537.36'
    },
    args: {
      '--proxy-bypass-list': 'domain1,domain2',
    }
  };

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

  const browserWSEndpoint = `ws://${host}/devtool/launch?config=${encodeURIComponent(JSON.stringify(config))}`;
  logger.info(`Browser WS Endpoint: ${browserWSEndpoint}`);

  return await runPuppeteer(initialAuthUrl, username, password, browserWSEndpoint);
}

module.exports = { runPuppeteer, launchAndConnectToBrowser };
