// api/login.js
const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry'); // New module with integrated IP-ban handling
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { URLSearchParams } = require('url');
const { getNextProxy } = require('../utils/proxyPool');  // Proxy from pool

router.post('/', async (req, res) => {
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

    // 1. Get the next proxy from the pool
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

    // 2. (Optional) Attach configuration parameters as a query string.
    // You could, for example, pack platform and kernel information into a config object.
    const config = {
      proxy,             // Proxy from the pool
      platform: 'mac',   // Example: "windows", "mac", "linux"
      kernel: 'chromium' // Example: "chromium"
    };
    const query = new URLSearchParams({ config: JSON.stringify(config) });
    // (Optional) You can append this query string to the WS endpoint if needed.
    logger.info(`[Request ID: ${requestId}] Config: ${JSON.stringify(config)}`);

    // 3. Start the login attempt using the IP-ban handling workflow
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
  }
});

module.exports = router;
