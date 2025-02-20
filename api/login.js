// api/login.js
const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry');
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { URLSearchParams } = require('url');
const { getNextProxy } = require('../utils/proxyPool');

let isBusy = false;

router.post('/', async (req, res) => {
  if (isBusy) {
    logger.warn('Another login request is already in progress, rejecting new request.');
    return res.status(503).json({
      status: AuthResponseStatus.ERROR,
      description: "Server is busy, only one login request at a time."
    });
  }

  isBusy = true;
  const startTime = Date.now();
  const requestId = uuidv4();
  let proxy;

  logger.info(`Received login request - Request ID: ${requestId}`);

  try {
    const { url, username, password } = req.body;
    res.on('finish', () => {
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

    const config = {
      proxy,
      platform: 'mac',
      kernel: 'chromium'
    };
    const query = new URLSearchParams({ config: JSON.stringify(config) });
    logger.info(`[Request ID: ${requestId}] Config: ${JSON.stringify(config)}`);

    logger.info(`[Request ID: ${requestId}] Starting first login attempt...`);
    const result = await loginWithRetry(url, username, password, proxy);

    if (result.error) {
      if (result.error === "IP_BLOCKED") {
        logger.warn(`[Request ID: ${requestId}] IP_BLOCKED detected`);
        return res.status(403).json({
          status: AuthResponseStatus.ERROR,
          description: "IP is blocked."
        });
      }
      if (["ACCOUNT_BANNED", "IMPERVA_BLOCKED"].includes(result.error)) {
        logger.warn(`[Request ID: ${requestId}] BANNED => 418`);
        return res.status(418).json({
          status: AuthResponseStatus.BANNED,
          description: "Account is banned or Imperva blocked"
        });
      }
      if (["LOGIN_FAILED", "INVALID_CREDENTIALS", "ACCOUNT_DISABLED"].includes(result.error)) {
        logger.warn(`[Request ID: ${requestId}] Login failed => 400`);
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

    if (result.token) {
      logger.info(`[Request ID: ${requestId}] SUCCESS => 200, login_code: ${result.token}`);
      return res.status(200).json({
        status: AuthResponseStatus.SUCCESS,
        login_code: result.token,
        usedProxy: result.usedProxy || null
      });
    }

    logger.error(`[Request ID: ${requestId}] No token found unexpectedly => 500`);
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
    isBusy = false;
  }
});

module.exports = router;
