// core/login_handler.js
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

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
 * @returns {Promise<string|false>} - Possible returns:
 *    - ory-code (string) on success
 *    - "ACCOUNT_BANNED" if 418 or final page indicates ban
 *    - "IP_BLOCKED" if 403 or Incapsula triggers
 *    - "INVALID_CREDENTIALS", "ACCOUNT_DISABLED", etc. if final page has known error strings
 *    - false if unknown error
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null;        // If we find an "ory_ac_..." code in any response URL
  let bannedStatus = false;    // Set to true if any response returns 418
  let impervaBlocked = false;  // Set to true if any response returns 403 or "Incapsula"

  const oryRegex = /ory_ac_[^&#]+/i;

  /**
   * Response listener to set flags based on HTTP status code or "Incapsula" text
   * Also extracts ory-code if found in the response URL
   */
  async function responseListener(response) {
    try {
      const status = response.status();

      // 418 => "ACCOUNT_BANNED"
      if (status === 418) {
        bannedStatus = true;
        logger.warn(`[${uniqueSessionId}] Response status 418 => account banned`);
      }

      // 403 => Possibly Imperva or IP block
      if (status === 403) {
        impervaBlocked = true;
        logger.warn(`[${uniqueSessionId}] Response status 403 => possible Captcha Imperva/IP block`);
      }

      // Optionally read response text to detect "Incapsula"
      try {
        const body = await response.text();
        if (body.includes("Incapsula") || body.includes("Request unsuccessful. Incapsula")) {
          impervaBlocked = true;
          logger.warn(`[${uniqueSessionId}] Incapsula text found => IP block/Imperva detection`);
        }
      } catch (readErr) {
        logger.warn(`[${uniqueSessionId}] Could not read response text: ${readErr.message}`);
      }

      // If no code found yet, try extracting from the response URL
      if (!foundCode) {
        const match = oryRegex.exec(response.url());
        if (match) {
          foundCode = match[0];
          logger.info(`[${uniqueSessionId}] Found ory-code => ${foundCode}`);
        }
      }
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Error in responseListener: ${err.message}`);
    }
  }

  // Attach the response listener
  page.on('response', responseListener);

  // Set a global timeout (90 seconds)
  let timeoutHandle;
  const globalTimeout = 90000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Global login timeout reached'));
    }, globalTimeout);
  });

  // The main login flow
  const loginProcess = (async () => {
    logger.debug(`[${uniqueSessionId}] Waiting for username field`);
    await page.waitForSelector('input#email', { timeout: 10000 });
    await page.focus('input#email');
    await page.keyboard.type(username);

    logger.debug(`[${uniqueSessionId}] Waiting for password field`);
    await page.waitForSelector('input#password', { timeout: 10000 });
    await page.focus('input#password');
    await page.keyboard.type(password);

    logger.debug(`[${uniqueSessionId}] Waiting 1 second after credentials`);
    await setTimeoutPromise(1000);

    // If we already have an ory-code before clicking (rare, but let's check)
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] ory-code found before login click => success`);
    } else {
      // Click the login button
      const loginButtonSelector = '#accept';
      logger.debug(`[${uniqueSessionId}] Waiting for login button`);
      await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
      logger.debug(`[${uniqueSessionId}] Clicking login button`);
      await page.click(loginButtonSelector, { delay: 100 });

      // Wait a bit after clicking
      await setTimeoutPromise(1000);

      logger.info(`[${uniqueSessionId}] URL after login click: ${page.url()}`);

      // If there's a consent page, handle it
      if (page.url().includes("consent")) {
        logger.info(`[${uniqueSessionId}] Consent page detected`);
        try {
          await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });
          logger.debug(`[${uniqueSessionId}] Clicking allow on consent page`);
          await page.click(loginButtonSelector, { delay: 100 });
          await page.waitForNavigation({ timeout: 30000 });
        } catch (err) {
          logger.warn(`[${uniqueSessionId}] Consent allow step error: ${err.message}`);
        }
      }

      // Another brief wait
      await setTimeoutPromise(1000);
    }

    // Now we do our final checks all together, so we don't abort early.

    // If an ory-code was found by any response
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] ory-code found => ${foundCode}`);
    }

    // Log the final URL
    const finalUrl = page.url();
    logger.info(`[${uniqueSessionId}] Final URL: ${finalUrl}`);

    // If we still haven't found a code, try the final URL
    if (!foundCode) {
      const finalMatch = oryRegex.exec(finalUrl);
      if (finalMatch) {
        foundCode = finalMatch[0];
        logger.info(`[${uniqueSessionId}] Found ory-code in final URL => ${foundCode}`);
      }
    }

    // If we STILL don't have a code, let's do the final page content check
    let finalPageContent = "";
    if (!foundCode) {
      logger.warn(`[${uniqueSessionId}] No code found => checking page content`);
      try {
        finalPageContent = await page.content();
      } catch (readErr) {
        logger.warn(`[${uniqueSessionId}] Could not read final page content: ${readErr.message}`);
      }
    }

    // *** NOW decide what to return, in order of priority ***

    // 1) IP_BLOCKED?
    if (impervaBlocked) {
      logger.warn(`[${uniqueSessionId}] IP block / Imperva detected => "IP_BLOCKED"`);
      return "IP_BLOCKED";
    }

    // 2) BANNED?
    // either from 418 or if final page content indicates ban
    if (bannedStatus) {
      logger.warn(`[${uniqueSessionId}] 418 => "ACCOUNT_BANNED"`);
      return "ACCOUNT_BANNED";
    }
    if (finalPageContent.includes("We are unable to log you in to this account. Please contact Customer Service")) {
      logger.error(`[${uniqueSessionId}] Final page indicates banned => "ACCOUNT_BANNED"`);
      return "ACCOUNT_BANNED";
    }

    // 3) INVALID_CREDENTIALS or ACCOUNT_DISABLED?
    if (finalPageContent.includes("Your username or password is incorrect.")) {
      logger.warn(`[${uniqueSessionId}] Final page => "INVALID_CREDENTIALS"`);
      return "INVALID_CREDENTIALS";
    }
    if (finalPageContent.includes("your account has been disabled for")) {
      logger.error(`[${uniqueSessionId}] Final page => "ACCOUNT_DISABLED"`);
      return "ACCOUNT_DISABLED";
    }

    // 4) Incapsula in final page? (Just in case)
    if (finalPageContent.includes("Incapsula") || finalPageContent.includes("Request unsuccessful. Incapsula")) {
      logger.warn(`[${uniqueSessionId}] Final page => Incapsula => "IP_BLOCKED"`);
      return "IP_BLOCKED";
    }

    // 5) If foundCode is set, return it
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Returning code => ${foundCode}`);
      return foundCode;
    }

    // 6) If none of the above matched, return false
    logger.warn(`[${uniqueSessionId}] No recognized error or code => login failed (false)`);
    return false;
  })();

  // Wrap with the global timeout
  try {
    const result = await Promise.race([loginProcess, timeoutPromise]);
    clearTimeout(timeoutHandle);
    return result;
  } catch (error) {
    logger.error(`[${uniqueSessionId}] Global login error: ${error.message}`);
    return false;
  } finally {
    // Detach the listener to avoid memory leaks
    page.off('response', responseListener);
  }
}

module.exports = { performLogin };
