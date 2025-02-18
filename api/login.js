// api/login.js
const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry');
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { URLSearchParams } = require('url');
const { getNextProxy } = require('../utils/proxyPool');

// --- NEW: Global variable to track if a request is already in progress
let isBusy = false;

router.post('/', async (req, res) => {
  // 1. Check if a request is already in progress
  if (isBusy) {
    // Reject the request (e.g., 503 - Service Unavailable)
    logger.warn('Another login request is already in progress, rejecting new request.');
    return res.status(503).json({
      status: AuthResponseStatus.ERROR,
      description: "Server is busy, only one login request at a time."
    });
  }

  // 2. Mark that a request is now being processed
  isBusy = true;

  const startTime = Date.now();
  const requestId = uuidv4();
  let proxy; // declared here so it is accessible in the finish listener

  logger.info(`Received login request - Request ID: ${requestId}`);

  try {
    const { url, username, password } = req.body;

    // Attach a finish event listener to log final details (including actual HTTP status code)
    res.on('finish', () => {
      // Extract dragoName from the User-Agent header (e.g., "Dragonite/1.13.3-testing (Level) Git/04e1203)")
      const dragoName = req.headers['user-agent'] || 'unknown';
      logger.info(`Request processed in ${(Date.now() - startTime) / 1000}s for ${username || 'unknown'} using ${proxy || 'none'} result ${res.statusCode}. Request by ${dragoName}`);
    });

    const required = ["url", "username", "password"];
    if (!required.every(key => req.body[key])) {
      logger.error(`[Request ID: ${requestId}] Missing required parameters`);
      return res.status(400).json({
        status: AuthResponseStatus.ERROR,
        description: "Missing required parameters"
      });
    }

    // 1. Retrieve a proxy from the pool
    try {
      proxy = getNextProxy();
      logger.info(`[Request ID: ${requestId}] Using proxy: ${proxy}`);
    } catch (error) {
      logger.error(`[Request ID: ${requestId}] No available proxy!`);
      return res.status(503).json({
        status: AuthResponseStatus.ERROR,
        description: "No proxy available at the moment."
      });
    }

    // 2. (Optional) Configuration parameters as query string
    const config = {
      proxy,
      platform: 'mac',
      kernel: 'chromium'
    };
    const query = new URLSearchParams({ config: JSON.stringify(config) });
    logger.info(`[Request ID: ${requestId}] Config: ${JSON.stringify(config)}`);

    // 3. Start login attempt
    logger.info(`[Request ID: ${requestId}] Starting first login attempt...`);
    const result = await loginWithRetry(url, username, password, proxy);

    // Error handling
    if (result.error) {
      if (result.error === "IP_BLOCKED") {
        logger.warn(`[Request ID: ${requestId}] IP blocked => waiting 60s => no response`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        logger.warn(`[Request ID: ${requestId}] 60s over => returning silently`);
        return;
      }
      if (["ACCOUNT_BANNED", "IMPERVA_BLOCKED"].includes(result.error)) {
        logger.warn(`[Request ID: ${requestId}] BANNED => 418`);
        return res.status(418).json({
          status: AuthResponseStatus.BANNED,
          description: "Account is banned or Imperva blocked"
        });
      }
      if (result.error === "LOGIN_FAILED") {
        logger.warn(`[Request ID: ${requestId}] Invalid credentials => 400`);
        return res.status(400).json({
          status: AuthResponseStatus.INVALID,
          description: "Invalid credentials or login error"
        });
      }
      logger.error(`[Request ID: ${requestId}] Unhandled error => 500 => ${result.error}`);
      return res.status(500).json({
        status: AuthResponseStatus.ERROR,
        description: result.description || "Internal server error"
      });
    }

    // Success
    if (result.token) {
      logger.info(`[Request ID: ${requestId}] SUCCESS => 200, login_code: ${result.token}`);
      return res.status(200).json({
        status: AuthResponseStatus.SUCCESS,
        login_code: result.token,
        usedProxy: result.usedProxy || null
      });
    }

    logger.error(`[Request ID: ${requestId}] No error, no token => unexpected => 500`);
    return res.status(500).json({
      status: AuthResponseStatus.ERROR,
      description: "No token found unexpectedly"
    });

  } catch (error) {
    logger.error(`[Request ID: ${requestId}] API error: ${error}`);
    return res.status(500).json({
      status: AuthResponseStatus.ERROR,
      description: "Internal server error"
    });
  } finally {
    // 3. Release the busy flag so the next request can be processed
    isBusy = false;
  }
});

module.exports = router;
