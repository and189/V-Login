// core/login_handler.js
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * performLogin:
 * - Sucht in der URL nach einem "ory_ac_..."-Code.
 * - Prüft nach dem Login-Klick, ob ein Response mit Status 418 (Account banned) empfangen wird.
 * - Sobald entweder der Code gefunden wurde oder ein 418-Status erkannt wird, wird der Flow abgebrochen.
 *
 * @param {Object} page - Puppeteer Page-Instanz
 * @param {string} username - Benutzername
 * @param {string} password - Passwort
 * @param {string} [uniqueSessionId] - Optional: Eindeutige Session-ID (wird automatisch generiert, falls nicht angegeben)
 * @returns {Promise<string|false>} - Liefert den gefundenen Code, "ACCOUNT_BANNED" oder false bei Fehlern
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null;    // Speichert den ory-Code, sobald gefunden
  let bannedStatus = false; // Wird auf true gesetzt, wenn ein Response mit Status 418 empfangen wird

  // Regex zum Extrahieren des "ory_ac_..."-Codes aus der URL
  const oryRegex = /ory_ac_[^&#]+/i;

  // Response-Listener: Prüft, ob in Response-URLs der Code vorkommt oder ob ein 418-Status zurückkommt
  function responseListener(response) {
    try {
      if (response.status() === 418) {
        bannedStatus = true;
        logger.warn(`[${uniqueSessionId}] Received response with status 418 (Account banned)`);
      }
      if (!foundCode) {
        const url = response.url();
        const match = oryRegex.exec(url);
        if (match) {
          foundCode = match[0];
          logger.info(`[${uniqueSessionId}] Found ory-code => ${foundCode}`);
        }
      }
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Error in response listener: ${err.message}`);
    }
  }
  page.on('response', responseListener);

  // Globaler Timeout (90 Sekunden)
  let timeoutHandle;
  const globalTimeout = 90000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Global login timeout reached'));
    }, globalTimeout);
  });

  // Haupt-Login-Prozess
  const loginProcess = (async () => {
    logger.debug(`[${uniqueSessionId}] Waiting for username field`);
    await page.waitForSelector('input#email', { timeout: 10000 });
    await page.focus('input#email');
    await page.keyboard.type(username);

    logger.debug(`[${uniqueSessionId}] Waiting for password field`);
    await page.waitForSelector('input#password', { timeout: 10000 });
    await page.focus('input#password');
    await page.keyboard.type(password);

    logger.debug(`[${uniqueSessionId}] Waiting 1 second after entering credentials`);
    await setTimeoutPromise(1000);

    // Falls der Code bereits vor dem Klick gefunden wurde:
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found before login click => success`);
      return foundCode;
    }

    const loginButtonSelector = "#accept";
    logger.debug(`[${uniqueSessionId}] Waiting for login button`);
    await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
    logger.debug(`[${uniqueSessionId}] Clicking login button`);
    await page.click(loginButtonSelector, { delay: 100 });

    // Kurze Wartezeit, damit der Klick verarbeitet wird:
    await setTimeoutPromise(1000);

    if (bannedStatus) {
      logger.warn(`[${uniqueSessionId}] Aborting further actions due to 418 status`);
      return "ACCOUNT_BANNED";
    }

    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found immediately after login click => success`);
      return foundCode;
    }

    let currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] URL after login click: ${currentUrl}`);

    // Falls eine Consent-Seite erkannt wird, versuche den Allow-Flow:
    if (currentUrl.includes("consent") && !foundCode && !bannedStatus) {
      logger.info(`[${uniqueSessionId}] Consent page detected. Processing allow step.`);
      try {
        logger.debug(`[${uniqueSessionId}] Waiting for allow button on consent page`);
        await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });
        logger.debug(`[${uniqueSessionId}] Clicking allow button on consent page`);
        await page.click(loginButtonSelector, { delay: 100 });
        await page.waitForNavigation({ timeout: 30000 });
      } catch (allowErr) {
        logger.warn(`[${uniqueSessionId}] Error during consent allow step: ${allowErr.message}`);
      }
    }

    await setTimeoutPromise(1000);
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found after consent allow => success`);
      return foundCode;
    }

    currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] Final URL: ${currentUrl}`);
    const finalMatch = oryRegex.exec(currentUrl);
    if (finalMatch) {
      logger.info(`[${uniqueSessionId}] Found ory-code in final URL => ${finalMatch[0]}`);
      return finalMatch[0];
    }

    logger.warn(`[${uniqueSessionId}] No code found => login failed`);
    return false;
  })();

  try {
    const result = await Promise.race([loginProcess, timeoutPromise]);
    clearTimeout(timeoutHandle);
    return result;
  } catch (error) {
    logger.error(`[${uniqueSessionId}] Global login error: ${error.message}`);
    return false;
  } finally {
    // Entferne den Response-Listener, um Speicherlecks zu vermeiden
    page.off('response', responseListener);
  }
}

module.exports = { performLogin };
