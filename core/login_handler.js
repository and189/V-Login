// core/login_handler.js
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * Login-Ablauf:
 * - Wir suchen nach "ory_ac_..."-Code via Regex (aus dem URL-String).
 * - Sobald der Code gefunden ist, brechen wir den Flow ab (erfolgreich).
 * - Falls wir noch keinen Code haben, machen wir ggf. waitForNavigation usw.
 * - So wird der Code nicht mehr „überschrieben“ oder verloren,
 *   auch wenn später ein Timeout auftritt.
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null;           // Speichert den ory-Code, sobald gefunden
  let loginAttemptStarted = false; // Ob wir bereits den Login-Button geklickt haben

  // Regex zum Extrahieren des "ory_ac_..." aus beliebiger Stelle der URL,
  // bis zum nächsten & oder # oder ? (je nach Format).
  const oryRegex = /ory_ac_[^&#]+/i;

  // Response-Listener:
  // Sobald wir einen Response sehen, prüfen wir auf „ory_ac_“ im URL
  page.on('response', async (response) => {
    try {
      // Falls wir schon einen Code haben, brauchen wir nichts weiter zu tun.
      if (foundCode) return;

      const url = response.url();
      // Mit Regex suchen
      const match = oryRegex.exec(url);
      if (match) {
        // Code gefunden!
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
    // Schritt 1: Username/Passwort eingeben
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

    // Check, ob Code schon gefunden
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found even before login click => success`);
      return foundCode;
    }

    // Schritt 2: Login-Klick
    const loginButtonSelector = "#accept";
    logger.debug(`[${uniqueSessionId}] Waiting for login button`);
    await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
    logger.debug(`[${uniqueSessionId}] Clicking login button`);
    loginAttemptStarted = true;
    await page.click(loginButtonSelector, { delay: 100 });

    // Nur warten auf Navigation, wenn wir **noch keinen** Code haben
    if (!foundCode) {
      try {
        logger.debug(`[${uniqueSessionId}] Waiting for navigation (10s) after login click`);
        await page.waitForNavigation({ timeout: 10000 });
      } catch (navErr) {
        logger.warn(`[${uniqueSessionId}] Navigation after login click timed out: ${navErr.message}`);
      }
    }

    // Falls Code mittlerweile da
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found => success after login click`);
      return foundCode;
    }

    let currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] URL after login click: ${currentUrl}`);

    // Check Consent => "Allow"
    if (currentUrl.includes("consent") && !foundCode) {
      logger.info(`[${uniqueSessionId}] Consent page detected. Allow step required.`);
      try {
        logger.debug(`[${uniqueSessionId}] Waiting for allow button on consent page`);
        await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });

        logger.debug(`[${uniqueSessionId}] Using MouseEvent inside evaluate to click the allow button`);
        await page.evaluate(() => {
          const button = document.querySelector('#accept');
          if (button) {
            const event = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            button.dispatchEvent(event);
          }
        });

        // Nur wenn noch kein Code da
        if (!foundCode) {
          try {
            logger.debug(`[${uniqueSessionId}] Waiting for navigation (30s) after allow click`);
            await page.waitForNavigation({ timeout: 30000 });
          } catch (allowNavErr) {
            logger.warn(`[${uniqueSessionId}] Navigation after allow click timed out: ${allowNavErr.message}`);
            // 20s Fallback-Polling
            const maxPoll = 20000, pollInt = 1000;
            for (let elapsed = 0; elapsed < maxPoll && !foundCode; elapsed += pollInt) {
              currentUrl = page.url();
              logger.debug(`[${uniqueSessionId}] Polling URL after allow (elapsed ${elapsed}ms): ${currentUrl}`);
              if (!currentUrl.includes("consent")) break;
              await setTimeoutPromise(pollInt);
            }
          }
        }

        currentUrl = page.url();
        logger.info(`[${uniqueSessionId}] URL after allow step: ${currentUrl}`);

        // Noch 10s final, wenn immer noch kein Code
        if (!foundCode) {
          logger.debug(`[${uniqueSessionId}] Additional 10s wait for final screen after allow`);
          await setTimeoutPromise(10000);
        }

        // Code jetzt da?
        if (foundCode) {
          logger.info(`[${uniqueSessionId}] Code found => success after allow`);
          return foundCode;
        }

      } catch (e) {
        logger.error(`[${uniqueSessionId}] Error during allow flow: ${e.message}`);
        throw e;
      }
    }

    // Finale URL
    currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] Final URL: ${currentUrl}`);

    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found => success at final step`);
      return foundCode;
    }

    // Letzter Regex-Check:
    // Möglicherweise taucht "ory_ac_" erst jetzt in der finalen URL auf:
    const finalMatch = oryRegex.exec(currentUrl);
    if (finalMatch) {
      logger.info(`[${uniqueSessionId}] Found ory-code in final URL => ${finalMatch[0]}`);
      return finalMatch[0];
    }

    logger.warn(`[${uniqueSessionId}] No code => fail => false`);
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
