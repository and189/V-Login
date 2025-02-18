// core/login_handler.js
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * performLogin:
 * - Searches the URL for an "ory_ac_..." code.
 * - After clicking the login button, checks if a response with status 418 (Account banned) is received.
 * - As soon as either the code is found or a 418 status is detected, the flow is aborted.
 *
 * @param {Object} page - Puppeteer Page instance.
 * @param {string} username - Username.
 * @param {string} password - Password.
 * @param {string} [uniqueSessionId] - Optional: Unique session ID (automatically generated if not provided).
 * @returns {Promise<string|false>} - Returns the found code, "ACCOUNT_BANNED", or false on errors.
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null;    // Stores the ory-code once it is found.
  let bannedStatus = false; // Set to true if a response with status 418 is received.

  // Regular expression to extract the "ory_ac_..." code from a URL.
  const oryRegex = /ory_ac_[^&#]+/i;

  // Response listener: Checks if the response contains the code or if a response with status 418 is returned.
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
          // Hier wird nur der String (erstes Element) gespeichert.
          foundCode = match[0];
          logger.info(`[${uniqueSessionId}] Found ory-code => ${foundCode}`);
        }
      }
    } catch (err) {
      logger.warn(`[${uniqueSessionId}] Error in response listener: ${err.message}`);
    }
  }
  // Attach the response listener to the page.
  page.on('response', responseListener);

  // Global timeout setup (90 seconds).
  let timeoutHandle;
  const globalTimeout = 90000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Global login timeout reached'));
    }, globalTimeout);
  });

  // Main login process.
  const loginProcess = (async () => {
    logger.debug(`[${uniqueSessionId}] Waiting for username field`);
    // Wait for the username input field to appear.
    await page.waitForSelector('input#email', { timeout: 10000 });
    await page.focus('input#email');
    // Type in the username.
    await page.keyboard.type(username);

    logger.debug(`[${uniqueSessionId}] Waiting for password field`);
    // Wait for the password input field to appear.
    await page.waitForSelector('input#password', { timeout: 10000 });
    await page.focus('input#password');
    // Type in the password.
    await page.keyboard.type(password);

    logger.debug(`[${uniqueSessionId}] Waiting 1 second after entering credentials`);
    // Wait briefly to ensure that the credentials are fully entered.
    await setTimeoutPromise(1000);

    // If the code was found before clicking the login button, return it immediately.
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found before login click => success`);
      return foundCode;
    }

    const loginButtonSelector = "#accept";
    logger.debug(`[${uniqueSessionId}] Waiting for login button`);
    // Wait for the login button to be visible.
    await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
    logger.debug(`[${uniqueSessionId}] Clicking login button`);
    // Click the login button with a slight delay.
    await page.click(loginButtonSelector, { delay: 100 });

    // Short wait to allow the click action to be processed.
    await setTimeoutPromise(1000);

    // If a response with status 418 was received, abort further actions.
    if (bannedStatus) {
      logger.warn(`[${uniqueSessionId}] Aborting further actions due to 418 status`);
      return "ACCOUNT_BANNED";
    }

    // If the code was found immediately after clicking the login button, return it.
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found immediately after login click => success`);
      return foundCode;
    }

    let currentUrl = page.url(); // This line is crucial!

    logger.info(`[${uniqueSessionId}] Navigated to the login page`);

    // If a consent page is detected and no code or banned status is set, attempt the allow flow.
    if (currentUrl.includes("consent") && !foundCode && !bannedStatus) {
      logger.info(`[${uniqueSessionId}] Consent page detected. Processing allow step.`);
      try {
        logger.debug(`[${uniqueSessionId}] Waiting for allow button on consent page`);
        // Wait for the allow button to appear.
        await page.waitForSelector(loginButtonSelector, { timeout: 10000, visible: true });
        logger.debug(`[${uniqueSessionId}] Clicking allow button on consent page`);
        // Click the allow button.
        await page.click(loginButtonSelector, { delay: 100 });
        // Wait for navigation to complete.
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
    logger.info(`[${uniqueSessionId}] Navigation after login completed`);

    // Attempt to extract the ory-code from the final URL.
    const finalMatch = oryRegex.exec(currentUrl);
    if (finalMatch) {
      logger.info(`[${uniqueSessionId}] Found ory-code in final URL => ${finalMatch[0]}`);
      return finalMatch[0];
    }

    logger.warn(`[${uniqueSessionId}] No code found => login failed`);
    return false;
  })();

  try {
    // Execute the login process with a race against the global timeout.
    const result = await Promise.race([loginProcess, timeoutPromise]);
    clearTimeout(timeoutHandle);
    return result;
  } catch (error) {
    logger.error(`[${uniqueSessionId}] Global login error: ${error.message}`);
    return false;
  } finally {
    // Remove the response listener to prevent memory leaks.
    page.off('response', responseListener);
  }
}

module.exports = { performLogin };
