const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * Hilfsfunktion: Listet alle vorhandenen input-Felder mit relevanten Infos.
 */
async function debugAvailableInputs(page, uniqueSessionId) {
  try {
    const allInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(input => ({
        name: input.getAttribute('name'),
        id: input.id,
        type: input.type,
        outerHTML: input.outerHTML
      }));
    });
    logger.warn(`[${uniqueSessionId}] Currently present input fields: ${JSON.stringify(allInputs, null, 2)}`);
  } catch (err) {
    logger.warn(`[${uniqueSessionId}] Could not list input fields: ${err.message}`);
  }
}

/**
 * Hilfsfunktion: Listet alle button-ähnlichen Elemente (button, input[type="button"], input[type="submit"]).
 */
async function debugAvailableButtons(page, uniqueSessionId) {
  try {
    const allButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]')).map(el => el.outerHTML)
    );
    logger.warn(`[${uniqueSessionId}] Currently present button-like elements: ${JSON.stringify(allButtons, null, 2)}`);
  } catch (err) {
    logger.warn(`[${uniqueSessionId}] Could not list button elements: ${err.message}`);
  }
}

/**
 * Helper-Funktion: Sucht den Login-Button im aktuellen Frame und in allen iFrames
 * und loggt den outerHTML, wenn er gefunden wird.
 */
async function logLoginButton(page, uniqueSessionId) {
  const loginButtonSelector = '#accept';
  let buttonFound = false;

  // Zuerst im Hauptframe suchen
  try {
    const mainButton = await page.$(loginButtonSelector);
    if (mainButton) {
      const buttonHTML = await page.evaluate(el => el.outerHTML, mainButton);
      logger.debug(`[${uniqueSessionId}] Login button found in main frame: ${buttonHTML}`);
      buttonFound = true;
    }
  } catch (err) {
    logger.warn(`[${uniqueSessionId}] Error searching login button in main frame: ${err.message}`);
  }

  // In iFrames suchen, falls im Hauptframe nichts gefunden wurde
  if (!buttonFound) {
    const frames = page.frames();
    logger.debug(`[${uniqueSessionId}] Searching for login button in ${frames.length} frames...`);
    for (const frame of frames) {
      // Überspringe den Hauptframe
      if (frame !== page.mainFrame()) {
        try {
          const button = await frame.$(loginButtonSelector);
          if (button) {
            const buttonHTML = await frame.evaluate(el => el.outerHTML, button);
            logger.debug(`[${uniqueSessionId}] Login button found in frame (${frame.url()}): ${buttonHTML}`);
            buttonFound = true;
          }
        } catch (err) {
          logger.warn(`[${uniqueSessionId}] Error searching login button in frame ${frame.url()}: ${err.message}`);
        }
      }
    }
  }

  if (!buttonFound) {
    logger.warn(`[${uniqueSessionId}] Login button with selector "${loginButtonSelector}" not found in main frame or any iFrame.`);
  }
}

/**
 * performLogin:
 * - Searches the URL for an "ory_ac_..." code in responses.
 * - Tracks if any response had 418 => bannedStatus = true
 * - Tracks if any response had 403 or "Incapsula" text => impervaBlocked = true
 * - After the login click (and potential consent flow), checks the final page text for known errors.
 * - Only at the end do we decide which error code or success value to return.
 *
 * @param {Object} page - Puppeteer Page instance
 * @param {string} username - Login username
 * @param {string} password - Login password
 * @param {string} [uniqueSessionId] - Optional unique session ID (auto-generated if not provided)
 * @returns {Promise<Object>} - Rückgabeobjekt: { token: <ory-code> } bei Erfolg oder { error: <Fehlercode> }
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  logger.debug(`[${uniqueSessionId}] Starting performLogin with username: ${username}`);
  let foundCode = null;        // Falls ein "ory_ac_..." Code in einer Response gefunden wird
  let bannedStatus = false;    // Wird true, wenn eine Response mit 418 zurückkommt
  let impervaBlocked = false;  // Wird true, wenn eine Response mit 403 oder "Incapsula" Text zurückkommt
  const oryRegex = /ory_ac_[^&#]+/i;

  /**
   * Response listener: Setzt Flags basierend auf HTTP-Status oder Textinhalt und extrahiert ggf. den ory-code.
   */
  async function responseListener(response) {
    try {
      const status = response.status();
      logger.debug(`[${uniqueSessionId}] Response received: ${response.url()} with status ${status}`);
      
      if (status === 418) {
        bannedStatus = true;
        logger.warn(`[${uniqueSessionId}] Response status 418 detected => account banned`);
      }
      if (status === 403) {
        impervaBlocked = true;
        logger.warn(`[${uniqueSessionId}] Response status 403 detected => possible IP block/Imperva`);
      }

      try {
        const body = await response.text();
        logger.debug(`[${uniqueSessionId}] Response text length: ${body.length}`);
        if (body.includes("Incapsula") || body.includes("Request unsuccessful. Incapsula")) {
          impervaBlocked = true;
          logger.warn(`[${uniqueSessionId}] "Incapsula" text found in response => IP block/Imperva detection`);
        }
      } catch (readErr) {
        logger.warn(`[${uniqueSessionId}] Could not read response text: ${readErr.message}`);
      }

      if (!foundCode) {
        const match = oryRegex.exec(response.url());
        if (match) {
          foundCode = match[0];
          logger.info(`[${uniqueSessionId}] Found ory-code in response URL: ${foundCode}`);
        }
      }
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Error in responseListener: ${err.message}`);
    }
  }

  // Response-Listener anhängen
  logger.debug(`[${uniqueSessionId}] Attaching response listener for login process`);
  page.on('response', responseListener);

  // Globalen Timeout setzen (59 Sekunden)
  let timeoutHandle;
  const globalTimeout = 59000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Global login timeout reached'));
    }, globalTimeout);
  });
  logger.debug(`[${uniqueSessionId}] Global timeout set to ${globalTimeout}ms`);

  // Haupt-Login-Prozess
  const loginProcess = (async () => {
    // Zuerst: Login-Button suchen und HTML-Inhalt loggen
    await logLoginButton(page, uniqueSessionId);

    // Warten auf das Username-Feld
    logger.debug(`[${uniqueSessionId}] Waiting for username input field ('input#email')`);
    const usernameFieldStartTime = Date.now();
    try {
      await page.waitForSelector('input#email', { timeout: 10000 });
      const usernameFieldEndTime = Date.now();
      logger.debug(`[${uniqueSessionId}] Username field found in ${usernameFieldEndTime - usernameFieldStartTime}ms. Focusing and typing username...`);
      await page.focus('input#email');
      await page.keyboard.type(username);
      logger.debug(`[${uniqueSessionId}] Username typed successfully`);
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Could not find 'input#email': ${err.message}`);
      await debugAvailableInputs(page, uniqueSessionId);
      throw err;
    }

    // Warten auf das Passwort-Feld
    logger.debug(`[${uniqueSessionId}] Waiting for password input field ('input#password')`);
    try {
      await page.waitForSelector('input#password', { timeout: 10000 });
      logger.debug(`[${uniqueSessionId}] Password field found. Focusing and typing password...`);
      await page.focus('input#password');
      await page.keyboard.type(password);
      logger.debug(`[${uniqueSessionId}] Password typed successfully`);
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Could not find 'input#password': ${err.message}`);
      await debugAvailableInputs(page, uniqueSessionId);
      throw err;
    }

    // Kurze Wartezeit nach Eingabe der Daten
    logger.debug(`[${uniqueSessionId}] Waiting 1 second after entering credentials`);
    await setTimeoutPromise(1000);

    if (foundCode) {
      logger.info(`[${uniqueSessionId}] ory-code already found before login click: ${foundCode}`);
    } else {
      // Login-Button anklicken
      const loginButtonSelector = '#accept';
      logger.debug(`[${uniqueSessionId}] Waiting for login button (${loginButtonSelector}) to be visible`);
      try {
        await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
        logger.debug(`[${uniqueSessionId}] Login button visible. Clicking login button with a short delay...`);
        await page.click(loginButtonSelector, { delay: 100 });
      } catch (err) {
        logger.warn(`[${uniqueSessionId}] Could not find login button '${loginButtonSelector}': ${err.message}`);
        await debugAvailableButtons(page, uniqueSessionId);
        throw err;
      }

      // Wartezeit nach Klick
      logger.debug(`[${uniqueSessionId}] Waiting 1 second after login button click`);
      await setTimeoutPromise(1000);
      logger.info(`[${uniqueSessionId}] URL after login click: ${page.url()}`);

      // Falls eine Consent-Seite erkannt wird, diese behandeln
      if (page.url().includes("consent")) {
        logger.info(`[${uniqueSessionId}] Consent page detected. Initiating consent flow...`);
        try {
          await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });
          logger.debug(`[${uniqueSessionId}] Consent allow button visible. Clicking to accept consent...`);
          await page.click(loginButtonSelector, { delay: 100 });
          logger.debug(`[${uniqueSessionId}] Waiting for navigation after consent click (timeout 30000ms)...`);
          await page.waitForNavigation({ timeout: 30000 });
          logger.info(`[${uniqueSessionId}] Navigation completed after consent acceptance. Current URL: ${page.url()}`);
        } catch (err) {
          logger.warn(`[${uniqueSessionId}] Error during consent flow: ${err.message}`);
        }
      }

      // Weitere kurze Wartezeit vor den finalen Prüfungen
      logger.debug(`[${uniqueSessionId}] Waiting 1 additional second before finalizing login process`);
      await setTimeoutPromise(1000);
    }

    // Finaler Check nach Klick/Consent-Flow
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] ory-code found during login process: ${foundCode}`);
    } else {
      logger.debug(`[${uniqueSessionId}] No ory-code found from responses so far. Checking final URL for code...`);
    }

    const finalUrl = page.url();
    logger.info(`[${uniqueSessionId}] Final URL after login process: ${finalUrl}`);

    if (!foundCode) {
      const finalMatch = oryRegex.exec(finalUrl);
      if (finalMatch) {
        foundCode = finalMatch[0];
        logger.info(`[${uniqueSessionId}] Found ory-code in final URL: ${foundCode}`);
      }
    }

    let finalPageContent = "";
    if (!foundCode) {
      logger.warn(`[${uniqueSessionId}] No ory-code found => checking final page content for error indicators`);
      try {
        finalPageContent = await page.content();
        logger.debug(`[${uniqueSessionId}] Final page content length: ${finalPageContent.length}`);
      } catch (readErr) {
        logger.warn(`[${uniqueSessionId}] Could not read final page content: ${readErr.message}`);
      }
    }

    // Entscheidung basierend auf den ermittelten Informationen
    if (impervaBlocked) {
      logger.warn(`[${uniqueSessionId}] Imperva/IP block detected during login => returning "IP_BLOCKED"`);
      return { error: "IP_BLOCKED" };
    }
    if (bannedStatus) {
      logger.warn(`[${uniqueSessionId}] Banned status detected (HTTP 418) => returning "ACCOUNT_BANNED"`);
      return { error: "ACCOUNT_BANNED" };
    }
    if (finalPageContent.includes("We are unable to log you in to this account. Please contact Customer Service")) {
      logger.error(`[${uniqueSessionId}] Final page indicates account ban => returning "ACCOUNT_BANNED"`);
      return { error: "ACCOUNT_BANNED" };
    }
    if (finalPageContent.includes("Your username or password is incorrect.")) {
      logger.warn(`[${uniqueSessionId}] Final page indicates invalid credentials => returning "INVALID_CREDENTIALS"`);
      return { error: "INVALID_CREDENTIALS" };
    }
    if (finalPageContent.includes("your account has been disabled for")) {
      logger.error(`[${uniqueSessionId}] Final page indicates account disabled => returning "ACCOUNT_DISABLED"`);
      return { error: "ACCOUNT_DISABLED" };
    }
    if (finalPageContent.includes("Incapsula") || finalPageContent.includes("Request unsuccessful. Incapsula")) {
      logger.warn(`[${uniqueSessionId}] Final page indicates Incapsula protection => returning "IP_BLOCKED"`);
      return { error: "IP_BLOCKED" };
    }
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Login successful. Returning ory-code: ${foundCode}`);
      return { token: foundCode };
    }
    logger.warn(`[${uniqueSessionId}] No recognized error or code found => login failed (returning "LOGIN_FAILED")`);
    return { error: "LOGIN_FAILED" };
  })();

  try {
    const result = await Promise.race([loginProcess, timeoutPromise]);
    clearTimeout(timeoutHandle);
    logger.debug(`[${uniqueSessionId}] Login process completed with result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    logger.error(`[${uniqueSessionId}] Global login error: ${error.message}`);
    return { error: "LOGIN_FAILED" };
  } finally {
    logger.debug(`[${uniqueSessionId}] Detaching response listener from page`);
    page.off('response', responseListener);
  }
}

module.exports = { performLogin };
