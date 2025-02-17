// core/login_handler.js
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * Login-Ablauf:
 * - Wir suchen nach "ory_ac_..."-Code via Regex (aus dem URL-String).
 * - Außerdem prüfen wir direkt nach dem Login-Klick, ob ein Response den Status 418 zurückliefert.
 * - Sobald der Code gefunden ist oder ein 418-Status empfangen wurde, brechen wir den Flow ab.
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null;   // Speichert den ory-Code, sobald gefunden
  let bannedStatus = false; // Wird true, wenn ein Response mit Status 418 kommt

  // Regex zum Extrahieren des "ory_ac_..." aus beliebiger Stelle der URL
  const oryRegex = /ory_ac_[^&#]+/i;

  // Response-Listener: Prüft sowohl auf den ory-Code als auch auf Status 418
  function responseListener(response) {
    try {
      // Statuscode prüfen: Wenn 418, dann Konto gesperrt
      if (response.status() === 418) {
        bannedStatus = true;
        logger.warn(`[${uniqueSessionId}] Received response with status 418 (Account banned)`);
      }
      // Prüfen, ob die URL den ory-Code enthält
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

  // Globaler Timeout (90s)
  let timeoutHandle;
  const globalTimeout = 90000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Global login timeout reached'));
    }, globalTimeout);
  });

  // Haupt-Login-Prozess
  const loginProcess = (async () => {
    // Schritt 1: Eingabe von Username und Passwort
    logger.debug(`[${uniqueSessionId}] Waiting for username field`);
    await page.waitForSelector('input#email', { timeout: 10000 });
    await page.focus('input#email');
    await page.keyboard.type(username);

    logger.debug(`[${uniqueSessionId}] Waiting for password field`);
    await page.waitForSelector('input#password', { timeout: 10000 });
    await page.focus('input#password');
    await page.keyboard.type(password);

    // Kurze Wartezeit nach Eingabe
    logger.debug(`[${uniqueSessionId}] Waiting 1 second after entering credentials`);
    await setTimeoutPromise(1000);

    // Vor dem Klick prüfen, ob der Code bereits gefunden wurde
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found before login click => success`);
      return foundCode;
    }

    // Schritt 2: Klick auf den Login-Button
    const loginButtonSelector = "#accept";
    logger.debug(`[${uniqueSessionId}] Waiting for login button`);
    await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
    logger.debug(`[${uniqueSessionId}] Clicking login button`);
    await page.click(loginButtonSelector, { delay: 100 });

    // Warten, damit der Klick verarbeitet wird, und direkt prüfen:
    await setTimeoutPromise(1000);

    // Falls ein 418-Status empfangen wurde, abbrechen
    if (bannedStatus) {
      logger.warn(`[${uniqueSessionId}] Aborting further actions due to 418 status`);
      return "ACCOUNT_BANNED";
    }

    // Direkt nach Login: Code prüfen
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found immediately after login click => success`);
      return foundCode;
    }

    let currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] URL after login click: ${currentUrl}`);

    // Falls Consent benötigt wird (z.B. URL enthält "consent")
    if (currentUrl.includes("consent") && !foundCode && !bannedStatus) {
      logger.info(`[${uniqueSessionId}] Consent page detected. Processing allow step.`);
      try {
        logger.debug(`[${uniqueSessionId}] Waiting for allow button on consent page`);
        await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });
        logger.debug(`[${uniqueSessionId}] Clicking allow button on consent page`);
        await page.click(loginButtonSelector, { delay: 100 });
        // Warten auf Navigation
        await page.waitForNavigation({ timeout: 30000 });
      } catch (allowErr) {
        logger.warn(`[${uniqueSessionId}] Error during consent allow step: ${allowErr.message}`);
      }
    }

    // Letzte Prüfung, ob der Code nun vorhanden ist
    await setTimeoutPromise(1000);
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found after consent allow => success`);
      return foundCode;
    }

    // Letzter Regex-Check im finalen URL
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
    // Entferne den Response-Listener korrekt mit "page.off"
    page.off('response', responseListener);
  }
}

module.exports = { performLogin };
