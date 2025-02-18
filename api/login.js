// api/login.js
const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry');
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { URLSearchParams } = require('url');
const { getNextProxy } = require('../utils/proxyPool');

// --- NEW: Global variable to track the number of active requests
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 5;

router.post('/', async (req, res) => {
  // 1. Check if the maximum number of concurrent requests has been reached.
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    logger.warn('Maximum concurrent login requests reached, rejecting new request.');
    return res.status(503).json({
      status: AuthResponseStatus.ERROR,
      description: "Server is busy, maximum concurrent login requests reached."
    });
  }

  // 2. Increase the active requests counter
  activeRequests++;

  const startTime = Date.now();
  const requestId = uuidv4();
  logger.info(`Received login request - Request ID: ${requestId}`);

  try {
    const { url, username, password } = req.body;
    const required = ["url", "username", "password"];
    if (!required.every(key => req.body[key])) {
      logger.error(`[Request ID: ${requestId}] Missing required parameters`);
      return res.status(400).json({
        status: AuthResponseStatus.ERROR,
        description: "Missing required parameters"
      });
    }

    // 3. Retrieve a proxy from the pool
    let proxy;
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

    // 4. (Optional) Set configuration parameters as a query string
    const config = {
      proxy,
      platform: 'mac',
      kernel: 'chromium'
    };
    const query = new URLSearchParams({ config: JSON.stringify(config) });
    logger.info(`[Request ID: ${requestId}] Config: ${JSON.stringify(config)}`);

    // 5. Start the login attempt
    logger.info(`[Request ID: ${requestId}] Starting first login attempt...`);
    const result = await loginWithRetry(url, username, password, proxy);

    logger.info(`[Request ID: ${requestId}] Request processed in ${(Date.now() - startTime) / 1000}s`);

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

    // Success handling
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
    // 6. Decrease the activ
