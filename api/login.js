const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry');
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { getNextProxy } = require('../utils/proxyPool');

// Configurable value - Default: 1 concurrent login
// Log process.env.MAX_CONCURRENT_LOGINS before parsing
logger.info(`process.env.MAX_CONCURRENT_LOGINS: ${process.env.MAX_CONCURRENT_LOGINS}`);
const maxConcurrentLogins = +process.env.MAX_CONCURRENT_LOGINS || 1;
logger.info(`MAX_CONCURRENT_LOGINS is set to: ${maxConcurrentLogins}`);
let concurrentLogins = 0;

router.post('/', async (req, res) => {
  logger.info(`Current maxConcurrentLogins (from var): ${maxConcurrentLogins}`); // Log value here
  logger.info(`process.env.MAX_CONCURRENT_LOGINS (in handler): ${process.env.MAX_CONCURRENT_LOGINS}`); // Log value here
  if (concurrentLogins >= maxConcurrentLogins) {
    logger.warn('Another login request is already in progress, rejecting new request.');
    return res.status(503).json({
      status: AuthResponseStatus.ERROR,
      description: "Server is busy, only a limited number of login requests are allowed at a time."
    });
  }

  concurrentLogins++;
  const startTime = Date.now();
  const requestId = uuidv4();
  let proxy;

  logger.info(`Received login request - Request ID: ${requestId}`);

  try {
    const { url, username, password } = req.body;
    res.on('finish', () => {
      const dragoName = req.headers['user-agent'] || 'unknown';
      logger.info(`Request processed in ${(Date.now() - startTime) / 1000}s for ${username || 'unknown'} Proxy: ${proxy || 'none'} HTTP Status: ${res.statusCode}. Request by ${dragoName}`);
    });

    const required = ["url", "username", "password"];
    if (!required.every(key => req.body[key])) {
      logger.error(`[Request ID: ${requestId}] Missing required parameters`);
      return res.status(400).json({
        status: AuthResponseStatus.ERROR,
        description: "Missing required parameters"
      });
    }

    try {
      proxy = await getNextProxy();
      logger.info(`[Request ID: ${requestId}] Using proxy: ${proxy}`);
    } catch (error) {
      logger.error(`[Request ID: ${requestId}] No available proxy!`);
      return res.status(503).json({
        status: AuthResponseStatus.ERROR,
        description: "No proxy available at the moment."
      });
    }

    logger.info(`[Request ID: ${requestId}] Starting first login attempt...`);
    const loginPromise = loginWithRetry(url, username, password, proxy);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out after 60 seconds')), 60000)
    );

    let loginResult;
    try {
      loginResult = await Promise.race([loginPromise, timeoutPromise]);
    } catch (error) {
      logger.error(`[Request ID: ${requestId}] Request timed out: ${error.message}`);
      return res.status(500).json({
        status: AuthResponseStatus.ERROR,
        description: "Request timed out"
      });
    }

    const { result, attempts } = loginResult;

    if (result.token) {
      logger.info(`[Request ID: ${requestId}] SUCCESS => 200, login_code: ${result.token}`);
      return res.status(200).json({
        status: AuthResponseStatus.SUCCESS,
        login_code: result.token,
        usedProxy: result.usedProxy || null
      });
    }

    // Differentiate here based on the specific error type:
    if (result.error) {
      let statusCode = 500; // Default status code
      switch (result.error) {
        case "IP_BLOCKED":
          logger.warn(`[Request ID: ${requestId}] IP_BLOCKED detected`);
          statusCode = 403;
          break;
        case "ACCOUNT_BANNED":
        case "IMPERVA_BLOCKED":
          logger.warn(`[Request ID: ${requestId}] Account banned or Imperva blocked detected`);
          statusCode = 418;
          break;
        case "INVALID_CREDENTIALS":
        case "LOGIN_FAILED":
        case "ACCOUNT_DISABLED":
          logger.warn(`[Request ID: ${requestId}] Login failed due to invalid credentials`);
          statusCode = attempts > 1 ? 503 : 400;
          break;
        case "NAVIGATION_TIMEOUT":
          logger.warn(`[Request ID: ${requestId}] Navigation timeout during login process`);
          statusCode = 504;
          break;
        default:
          logger.error(`[Request ID: ${requestId}] Unhandled error: ${result.error}`);
          break;
      }
      return res.status(statusCode).json({
        status: AuthResponseStatus.ERROR,
        description: result.description || "Internal server error"
      });
    }

    // Fallback: If neither token nor specific error has been returned
    logger.error(`[Request ID: ${requestId}] No token found unexpectedly`);
    return res.status(500).json({
      status: AuthResponseStatus.ERROR,
      description: "No token found unexpectedly"
    });
  } catch (error) {
    logger.error(`[Request ID: ${requestId}] API error: ${JSON.stringify(error)}`);
    return res.status(500).json({
      status: AuthResponseStatus.ERROR,
      description: "Internal server error"
    });
  } finally {
    concurrentLogins--;
  }
});

module.exports = router;
