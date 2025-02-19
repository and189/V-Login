const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { setTimeoutPromise } = require('../utils/helpers');

/**
 * performLogin:
 * - Searches the URL for an "ory_ac_..." code.
 * - Checks after the login click if a 418 (Account banned) response is received.
 * - As soon as either the code is found or a 418-status is detected, the flow is aborted.
 * - If no code is found, checks the final page text for known error messages (e.g., invalid credentials).
 *
 * @param {Object} page - Puppeteer Page instance
 * @param {string} username - Login username
 * @param {string} password - Login password
 * @param {string} [uniqueSessionId] - Optional unique session ID (auto-generated if not provided)
 * @returns {Promise<string|false>} - Returns the code (string), "ACCOUNT_BANNED", "INVALID_CREDENTIALS", "ACCOUNT_DISABLED", etc., or false if unknown errors
 */
async function performLogin(page, username, password, uniqueSessionId = uuidv4()) {
  let foundCode = null;      // Stores the ory-code once found
  let bannedStatus = false;  // Set to true if a 418 response is detected

  // Regex to extract the "ory_ac_..." code
  const oryRegex = /ory_ac_[^&#]+/i;

  // Response listener to detect the ory-code or 418 (banned) status
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

  // Attach the response listener
  page.on('response', responseListener);

  // Global timeout (90 seconds)
  let timeoutHandle;
  const globalTimeout = 90000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Global login timeout reached'));
    }, globalTimeout);
  });

  // Main login process
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

    // If the code was already found before the click
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found before login click => success`);
      return foundCode;
    }

    const loginButtonSelector = '#accept';
    logger.debug(`[${uniqueSessionId}] Waiting for login button`);
    await page.waitForSelector(loginButtonSelector, { timeout: 6000, visible: true });
    logger.debug(`[${uniqueSessionId}] Clicking login button`);
    await page.click(loginButtonSelector, { delay: 100 });

    // Small wait so that the click is processed
    await setTimeoutPromise(1000);

    // Check if a 418 response was received
    if (bannedStatus) {
      logger.warn(`[${uniqueSessionId}] Aborting further actions due to 418 status`);
      return "ACCOUNT_BANNED";
    }

    // Check if the ory-code became available right after the click
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found immediately after login click => success`);
      return foundCode;
    }

    let currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] URL after login click: ${currentUrl}`);

    // If a consent page is detected, attempt the Allow flow
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

    // After potential consent flow
    await setTimeoutPromise(1000);
    if (foundCode) {
      logger.info(`[${uniqueSessionId}] Code found after consent allow => success`);
      return foundCode;
    }

    currentUrl = page.url();
    logger.info(`[${uniqueSessionId}] Final URL: ${currentUrl}`);

    // Check the final URL for the ory-code
    const finalMatch = oryRegex.exec(currentUrl);
    if (finalMatch) {
      logger.info(`[${uniqueSessionId}] Found ory-code in final URL => ${finalMatch[0]}`);
      return finalMatch[0];
    }

    logger.warn(`[${uniqueSessionId}] No code found => login failed`);

    // --- ADDITIONAL ERROR MESSAGE CHECKS ---
    // We read the page's HTML content to see if known error messages are displayed.
    try {
      const finalPageContent = await page.content();

      // Example known error messages:
      if (finalPageContent.includes("Your username or password is incorrect.")) {
        logger.warn(`[${uniqueSessionId}] Incorrect credentials => 400`);
        return "INVALID_CREDENTIALS";
      }
      if (finalPageContent.includes("your account has been disabled for")) {
        logger.error(`[${uniqueSessionId}] Account is temporarily disabled => 400`);
        return "ACCOUNT_DISABLED";
      }
      if (finalPageContent.includes("We are unable to log you in to this account. Please contact Customer Service")) {
        logger.error(`[${uniqueSessionId}] Possibly banned or locked => "ACCOUNT_BANNED"`);
        return "ACCOUNT_BANNED";
      }
      // You can add additional checks for other specific error messages if needed.
    } catch (contentErr) {
      logger.warn(`[${uniqueSessionId}] Error reading final page content: ${contentErr.message}`);
    }

    // If no known error text was found, return false
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
    // Remove the listener to avoid memory leaks
    page.off('response', responseListener);
  }
}

module.exports = { performLogin };
