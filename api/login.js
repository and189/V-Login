// api/login.js
const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry'); // Neues Modul, das IP-Ban-Handling integriert
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { URLSearchParams } = require('url');
const { getNextProxy } = require('../utils/proxyPool');  // Proxy aus dem Pool

let isProcessing = false;

router.post('/', async (req, res) => {
  const startTime = Date.now();
  const requestId = uuidv4();
  logger.info(`Received login request - Request ID: ${requestId}`);

  if (isProcessing) {
    logger.warn(`[Request ID: ${requestId}] Request rejected - Server is currently processing another request.`);
    return res.status(429).json({
      status: AuthResponseStatus.ERROR,
      description: "Server is busy. Please try again later."
    });
  }

  isProcessing = true;
  logger.debug(`[Request ID: ${requestId}] Set isProcessing = true`);

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

    // 1. Hole den nächsten Proxy aus dem Pool
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

    // 2. (Optional) Wenn du zusätzlich noch Konfigurationsparameter als Query-String anhängen möchtest,
    //    könntest du hier z. B. auch platform- und kernel-Informationen in einem config-Objekt verpacken.
    const config = {
      proxy,             // Proxy aus dem Pool
      platform: 'mac',   // Beispiel: "windows", "mac", "linux"
      kernel: 'chromium' // Beispiel: "chromium"
    };
    const query = new URLSearchParams({ config: JSON.stringify(config) });
    // Falls du den WS-Endpoint zusätzlich mit Query-Parametern versehen möchtest, kannst du das auch tun:
    // (Hinweis: loginWithRetry/launchAndConnectToBrowser baut intern den WS-Endpoint; dieser Schritt ist optional)
    logger.info(`[Request ID: ${requestId}] Config: ${JSON.stringify(config)}`);

    // 3. Starte den Login-Versuch über den IP-Ban-Handling-Workflow
    logger.info(`[Request ID: ${requestId}] Starting first login attempt...`);
    const result = await loginWithRetry(url, username, password, proxy);

    logger.info(`[Request ID: ${requestId}] Request processed in ${(Date.now() - startTime) / 1000}s`);

    // Fehlerbehandlung
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

    // Erfolg
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
    isProcessing = false;
    logger.debug(`[Request ID: ${requestId}] Set isProcessing = false`);
  }
});

module.exports = router;
