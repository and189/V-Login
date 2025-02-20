// routes/login.js

const express = require('express');
const router = express.Router();
const { loginWithRetry } = require('../core/login_with_retry');
const { AuthResponseStatus } = require('../core/auth_response');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { URLSearchParams } = require('url');
const { getNextProxy } = require('../utils/proxyPool');

router.post('/', async (req, res) => {
  const startTime = Date.now();
  const requestId = uuidv4();
  let proxy;

  logger.info(`Received login request - Request ID: ${requestId}`);

  // Wenn die Response fertig ist, loggen wir die Dauer, den Status und den User-Agent
  res.on('finish', () => {
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(3);
    const dragoName = req.headers['user-agent'] || 'unknown';
    logger.info(
      `Request processed in ${durationSec}s for ${req.body.username || 'unknown'} using ${proxy || 'none'} ` +
      `result ${res.statusCode}. Request by ${dragoName}`
    );
  });

  try {
    // Validierung der Input-Parameter
    const { url, username, password } = req.body;
    const required = ["url", "username", "password"];
    if (!required.every(key => req.body[key])) {
      logger.error(`[Request ID: ${requestId}] Missing required parameters`);
      return res.status(400).json({
        status: AuthResponseStatus.ERROR,
        description: "Missing required parameters"
      });
    }

    // Nächsten Proxy aus dem Pool holen
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

    // Beispiel: Hier könnte man dem Browserless-Config-Objekt Proxy-Daten mitgeben
    const config = {
      proxy,
      platform: 'mac',
      kernel: 'chromium'
    };
    const query = new URLSearchParams({ config: JSON.stringify(config) });
    logger.info(`[Request ID: ${requestId}] Config: ${JSON.stringify(config)}`);

    logger.info(`[Request ID: ${requestId}] Starting first login attempt...`);
    // -> loginWithRetry: dein Core-Login, das am Ende { error: "..."} oder { token: "..."} zurückgibt
    const result = await loginWithRetry(url, username, password, proxy);

    // 1) Wenn wir einen Fehler haben:
    if (result.error) {
      if (result.error === "IP_BLOCKED") {
        logger.warn(`[Request ID: ${requestId}] IP_BLOCKED detected => 403`);
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
      // Ansonsten unbekannter Fehler => 500
      logger.error(`[Request ID: ${requestId}] Unhandled error => 500 => ${result.error}`);
      return res.status(500).json({
        status: AuthResponseStatus.ERROR,
        description: result.description || "Internal server error"
      });
    }

    // 2) Kein "error", also haben wir entweder ein token ODER ...
    if (result.token) {
      // -> **NEUE ABFRAGE**: Falls "token" in Wahrheit "IP_BLOCKED" oder andere Fehlerstrings enthält:
      if (result.token === "IP_BLOCKED") {
        logger.warn(`[Request ID: ${requestId}] IP_BLOCKED detected (token) => 403`);
        return res.status(403).json({
          status: AuthResponseStatus.ERROR,
          description: "IP is blocked."
        });
      }
      if (["ACCOUNT_BANNED", "IMPERVA_BLOCKED"].includes(result.token)) {
        logger.warn(`[Request ID: ${requestId}] BANNED => 418 (token)`);
        return res.status(418).json({
          status: AuthResponseStatus.BANNED,
          description: "Account is banned or Imperva blocked"
        });
      }
      if (["LOGIN_FAILED", "INVALID_CREDENTIALS", "ACCOUNT_DISABLED"].includes(result.token)) {
        logger.warn(`[Request ID: ${requestId}] Login failed => 400 (token)`);
        return res.status(400).json({
          status: AuthResponseStatus.INVALID,
          description: "Invalid credentials or login error"
        });
      }

      // => Ansonsten ist es wirklich ein Erfolgs-Token
      logger.info(`[Request ID: ${requestId}] SUCCESS => 200, login_code: ${result.token}`);
      return res.status(200).json({
        status: AuthResponseStatus.SUCCESS,
        login_code: result.token,
        usedProxy: result.usedProxy || null
      });
    }

    // 3) Weder error noch token => unexpected
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
  }
});

module.exports = router;
