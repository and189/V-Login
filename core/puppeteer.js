const puppeteer = require('puppeteer-core');
const logger = require('../utils/logger');
const { bypassPuppeteerDetection } = require('./detection');
const { v4: uuidv4 } = require('uuid');
const { IMPERVA_CHECK_TEXT, DEFAULT_NAVIGATION_TIMEOUT_MS } = require('../config/constants');
const axios = require('axios');
const FormData = require('form-data');
const { performLogin } = require('./login_handler');
const { reportProxyFailure } = require('../utils/proxyPool');

class Browser {
  constructor(options = {}) {
    // Optionen – der Proxy wird nun direkt aus dem Pool bezogen, daher keine statische Liste mehr.
    this.options = {
      useUserAgent: true,
      overrideNavigator: true,
      useBrowserless: true,
      waitForSelectors: true,
      takeScreenshots: true,
      handleShadowDOM: false,
      ...options
    };

    this.browser = null;
    this.page = null;
  }

  /**
   * Stellt sicher, dass localhost/127.0.0.1 nicht über einen Proxy geleitet werden.
   */
  static fixNoProxyForLocalhost() {
    const existingNoProxy = process.env.NO_PROXY || '';
    const localHosts = ['localhost', '127.0.0.1'];
    const noProxyList = existingNoProxy.split(',').map(item => item.trim()).filter(Boolean);
    localHosts.forEach(host => {
      if (!noProxyList.includes(host)) {
        noProxyList.push(host);
      }
    });
    process.env.NO_PROXY = noProxyList.join(',');
  }

  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async postDiscordText(message) {
    const webhookUrl = process.env.DISCORD_WEBHOOK;
    const discordEnabled = process.env.DISCORD_WEBHOOK_ENABLED === 'true';
    if (!webhookUrl || !discordEnabled) {
      if (!webhookUrl) {
        logger.warn("No Discord webhook URL configured in .env");
      } else {
        logger.warn("Discord webhook is disabled via .env");
      }
      return;
    }
    try {
      await axios.post(webhookUrl, { content: message });
      logger.info("Discord text message posted successfully");
    } catch (err) {
      logger.error("Failed to post Discord message: " + err.message);
    }
  }

  async sendDiscordScreenshot(message, screenshotBuffer) {
    const webhookUrl = process.env.DISCORD_WEBHOOK;
    const discordEnabled = process.env.DISCORD_WEBHOOK_ENABLED === 'true';
    if (!webhookUrl || !discordEnabled) {
      if (!webhookUrl) {
        logger.warn("No Discord webhook URL configured in .env");
      } else {
        logger.warn("Discord webhook is disabled via .env");
      }
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

  async captureAndSendScreenshot(message) {
    if (this.page) {
      try {
        await this.wait(7000);
        try {
          await this.page.waitForSelector('body', { timeout: 15000 });
        } catch (e) {
          logger.warn("Waiting for selector 'body' failed, proceeding with screenshot: " + e.message);
        }
        let screenshotBuffer = await this.page.screenshot();
        if (!Buffer.isBuffer(screenshotBuffer)) {
          screenshotBuffer = Buffer.from(screenshotBuffer, 'binary');
        }
        await this.sendDiscordScreenshot(message, screenshotBuffer);
      } catch (err) {
        logger.error("Failed to capture screenshot: " + err.message);
      }
    }
  }

  async checkForCaptchaBan() {
    await this.wait(30000);
    const content = await this.page.content();
    return content.includes("Additional security check is required");
  }

  /**
   * Startet den Browser:
   * - Holt einen Proxy direkt aus dem Proxy-Pool.
   * - Baut den Browserless-WebSocket-Endpunkt mit dem Proxy zusammen.
   * - Verbindet sich, erstellt eine neue Seite und führt Anti-Erkennungsmaßnahmen (Canvas-Manipulation, UserAgent, Navigator) aus.
   */
  async startBrowser() {
    console.log("Starting browser...");
    Browser.fixNoProxyForLocalhost();

    // Proxy direkt aus dem Pool beziehen
    const { getNextProxy } = require('../utils/proxyPool');
    const selectedProxy = await getNextProxy();
    if (selectedProxy) {
      console.log(`Using proxy from pool: ${selectedProxy}`);
    } else {
      console.log("No proxy available from pool, using local IP");
    }

    // Browserless-WebSocket-Endpunkt – nur mit Proxy-Parameter, keine weiteren Systemparameter
    let wsEndpoint = "ws://localhost:8848";
    if (selectedProxy) {
      wsEndpoint += `?--proxy-server=${encodeURIComponent(selectedProxy)}`;
    }

    this.browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null
    });

    this.page = await this.browser.newPage();

    // Falls Proxy-Authentifizierung nötig, kann hier `this.page.authenticate({ username, password })` aufgerufen werden

    // Canvas-Fingerprint manipulieren (Rauschen hinzufügen)
    await this.page.evaluateOnNewDocument(() => {
      const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
      const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
      function addNoiseToPixelValue(value) {
        const shift = Math.floor(Math.random() * 9) - 4;
        let newVal = value + shift;
        if (newVal > 255) newVal = 255;
        if (newVal < 0) newVal = 0;
        return newVal;
      }
      CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
        const imageData = _getImageData.call(this, x, y, w, h);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = addNoiseToPixelValue(imageData.data[i]);
          imageData.data[i + 1] = addNoiseToPixelValue(imageData.data[i + 1]);
          imageData.data[i + 2] = addNoiseToPixelValue(imageData.data[i + 2]);
        }
        return imageData;
      };
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        const ctx = this.getContext("2d");
        if (ctx) {
          const { width, height } = this;
          const imageData = ctx.getImageData(0, 0, width, height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] = addNoiseToPixelValue(imageData.data[i]);
            imageData.data[i + 1] = addNoiseToPixelValue(imageData.data[i + 1]);
            imageData.data[i + 2] = addNoiseToPixelValue(imageData.data[i + 2]);
          }
          ctx.putImageData(imageData, 0, 0);
        }
        return _toDataURL.apply(this, args);
      };
    });

    if (this.options.useUserAgent) {
      const USER_AGENT =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
      await this.page.setUserAgent(USER_AGENT);
    }

    if (this.options.overrideNavigator) {
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });
    }

    await bypassPuppeteerDetection(this.page);
  }

  async waitForSelectorIfEnabled(selector, timeout = 10000) {
    if (this.options.waitForSelectors) {
      await this.page.waitForSelector(selector, { timeout });
    }
  }

  async takeScreenshotIfEnabled(filePath) {
    if (this.options.takeScreenshots) {
      await this.page.screenshot({ path: filePath, fullPage: true });
      console.log(`Screenshot ${filePath} erstellt`);
    }
  }

  async healthCheck() {
    if (!this.page) {
      this.page = await this.browser.newPage();
    }
    const version = await this.browser.version();
    console.log(`Health Check - Browser version: ${version}`);
  }

  async logIP() {
    await this.page.goto("https://api.ipify.org/");
    const ipHtml = await this.page.content();
    const ipMatch = ipHtml.match(/\d+\.\d+\.\d+\.\d+/);
    const ipAddress = ipMatch ? ipMatch[0] : "Browser IP check failed"; // Store IP or failure message
    logger.info(ipMatch ? `Public IP address: ${ipMatch[0]}` : "Browser IP check failed"); // Log to logger.info
    console.log(ipMatch ? `Browser IP check: ${ipMatch[0]}` : "Browser IP check failed"); // Keep console.log for direct output
    return ipAddress; // Return the IP address or failure message
  }

  async logCanvasFingerprint() {
    await this.page.goto("https://browserleaks.com/canvas", { waitUntil: 'networkidle0' });
    await this.waitForSelectorIfEnabled("#canvas-hash");
    const content = await this.page.content();
    content.split("\n").forEach(line => {
      if (line.includes('id="canvas-hash"')) {
        console.log(`Canvas fingerprint: ${line}`);
      }
    });
  }

  /**
   * Führt den Login-Flow durch:
   * 1. Prüft den Canvas-Fingerprint und erstellt ggf. einen Screenshot.
   * 2. Navigiert zur Login-URL und ruft den performLogin-Prozess auf.
   * 3. Liefert ein Ergebnisobjekt zurück, das entweder ein Token (bei Erfolg) oder einen Error-Code enthält.
   */
  async loginFlow(initialAuthUrl, username, password) {
    // Schritt 1: Canvas-Fingerprint prüfen & Screenshot
    await this.page.goto("https://browserleaks.com/canvas", { waitUntil: 'networkidle0' });
    await this.waitForSelectorIfEnabled("#canvas-hash");
    await this.takeScreenshotIfEnabled("step1-browserleaks.png");
    let content = await this.page.content();
    let match = content.match(/id="canvas-hash".*?>(.*?)<\/td>/);
    console.log(match ? `Canvas fingerprint: ${match[1]}` : "Canvas fingerprint not found.");
    // Log public IP address after canvas fingerprint
    const publicIp = await this.logIP();
    logger.info(`[${uuidv4()}] Public IP address: ${publicIp}`);

    // --- Proxy Check ---
    logger.info(`[${uuidv4()}] Performing proxy IP check...`);
    const ipAddress = await this.logIP(); // Call logIP to check and log the IP
    logger.info(`[${uuidv4()}] Proxy IP check completed. IP address: ${ipAddress}`); // Include IP in log message
    // --- End Proxy Check ---


    // Schritt 2: Navigiere zur Login-URL
    const uniqueSessionId = uuidv4();
    logger.info(`[${uniqueSessionId}] Navigating to login URL: ${initialAuthUrl}`);

    try {
      await this.page.goto(initialAuthUrl, { waitUntil: 'networkidle0' });
      logger.info(`[${uniqueSessionId}] Navigation to login URL completed.`);
    } catch (navigationError) {
      logger.error(`[${uniqueSessionId}] Navigation to login URL failed: ${navigationError.message}`);
      return { error: "NAVIGATION_TIMEOUT", description: navigationError.message };
    }
    
    // Schritt 3: Führe den Login-Vorgang aus
    const loginResult = await performLogin(this.page, username, password, uniqueSessionId);
    if (loginResult.error) {
      console.error(`Login fehlgeschlagen: ${loginResult.error}`);
      await this.captureAndSendScreenshot(`Login fehlgeschlagen: ${loginResult.error}`);
      return { error: loginResult.error };
    } else if (loginResult.token) {
      console.log(`Login erfolgreich, Token: ${loginResult.token}`);
      await this.captureAndSendScreenshot("Login erfolgreich");
      return { token: loginResult.token };
    } else {
      console.error("Unbekannter Fehler während des Logins");
      await this.captureAndSendScreenshot("Unbekannter Fehler während des Logins");
      return { error: "UNKNOWN_ERROR" };
    }
  }

  async newTab() {
    console.log("Opening new tab");
    const newPage = await this.browser.newPage();
    if (this.page) {
      await this.page.close();
    }
    this.page = newPage;
  }

  async newPrivateWindow() {
    const context = await this.browser.createIncognitoBrowserContext();
    const newPage = await context.newPage();
    if (this.page) {
      await this.page.close();
    }
    this.page = newPage;
  }

  async stopBrowser() {
    if (this.browser) {
      await this.browser.disconnect();
      this.page = null;
      this.browser = null;
    }
  }

  async fetchBrowserStatus() {
    try {
      const response = await axios.get("http://browserless:8848/api/agent/browser/running");
      console.log(`Browser status response: ${JSON.stringify(response.data)}`);
      if (response.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
        const browserInfo = response.data.data[0];
        console.log(`Browser Info - ProfileID: ${browserInfo.profileId}, Port: ${browserInfo.remoteDebuggingPort}`);
        return browserInfo;
      }
    } catch (error) {
      console.error('Error fetching Browser status: ' + error.message);
    }
    return null;
  }
}

module.exports = Browser;