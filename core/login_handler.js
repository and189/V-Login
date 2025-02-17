// core/login_handler.js
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * Login-Ablauf:
 * - Wir suchen nach "ory_ac_..."-Code via Regex (aus dem URL-String).
 * - Sobald der Code gefunden ist, brechen wir den Flow ab (erfolgreich).
 * - Falls wir noch keinen Code haben, warten wir ggf. auf Navigation oder Consent-Schritte.
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null; // Speichert den ory-Code, sobald gefunden
  let loginAttemptStarted = false; // Ob wir bereits den Login-Button geklickt haben

  // Regex zum Extrahieren des "ory_ac_..." aus beliebiger Stelle der URL
  const oryRegex = /ory_ac_[^&#]+/i;

  // Response-Listener: Bei jeder Response prüfen wir, ob in der URL der ory-Code auftaucht
  page.on('response', async (response) => {
    try {
      if (foundCode) return;
      const url = response.url();
      const match = oryRegex.exec(url);
      if (match) {
        foundCode = match[0];
        logger.info(`[${uniqueSessionId}] Found ory-code => ${foundCode}`);
      }
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Error in response listener: ${err.message}`);
    }
  });

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
    loginAttemptStarted = true;
    await page.click(loginButtonSelector, { delay: 100 });

    // Warten, damit der Klick verarbeitet wird, und direkt prüfen:
    await setTimeoutPromise(1000);
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found immediately after login click => success`);
      return foundCode;
    }

    let currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] URL after login click: ${currentUrl}`);

    // Falls Consent benötigt wird (z.B. URL enthält "consent")
    if (currentUrl.includes("consent") && !foundCode) {
      logger.info(`[${uniqueSessionId}] Consent page detected. Processing allow step.`);
      try {
        logger.debug(`[${uniqueSessionId}] Waiting for allow button on consent page`);
        await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });
        // Nur ein einmaliger Klick auf "Allow"
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
    page.removeAllListeners('response');
  }
}

module.exports = { performLogin };
