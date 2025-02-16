// core/login_with_retry.js

const { getCurrentIp } = require('../utils/ipUtils');
const { setTimeoutPromise } = require('../utils/helpers');
const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');

/**
 * Wartet darauf, dass sich die öffentliche IP von previousIp ändert.
 *
 * @param {string} previousIp - Die aktuell gesperrte IP.
 * @param {number} checkIntervalMs - Wie oft (in ms) wird die IP überprüft (Standard: 60000 ms).
 * @returns {Promise<string>} - Gibt die neue IP zurück, sobald sich diese ändert.
 */
async function waitForNewIp(previousIp, checkIntervalMs = 60000) {
  let currentIp = previousIp;
  logger.info(`Local IP banned. Waiting for a new IP (current IP: ${previousIp})...`);
  
  // Polling-Schleife: Prüfe alle checkIntervalMs, ob sich die IP geändert hat.
  while (currentIp === previousIp) {
    await setTimeoutPromise(checkIntervalMs);
    try {
      currentIp = await getCurrentIp();
      logger.info(`Checked current IP: ${currentIp}`);
    } catch (error) {
      logger.warn(`Error retrieving IP: ${error.message}`);
    }
  }
  logger.info(`New IP detected: ${currentIp}`);
  return currentIp;
}

/**
 * Führt einen Login-Versuch durch. Falls ein lokaler IP-Ban festgestellt wird (error "IP_BLOCKED")
 * und kein Proxy verwendet wird, wird gewartet, bis sich die öffentliche IP ändert, und danach
 * ein erneuter Login-Versuch gestartet.
 *
 * @param {string} url - Die Authentifizierungs-URL.
 * @param {string} username - Der Benutzername.
 * @param {string} password - Das Passwort.
 * @param {string} [proxy] - (Optional) Falls gesetzt, wird der IP-Waiting-Mechanismus übersprungen.
 * @returns {Promise<Object>} - Das Ergebnis des Login-Prozesses.
 */
async function loginWithRetry(url, username, password, proxy) {
  // Erster Login-Versuch
  logger.info("Starting first login attempt...");
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // Falls kein Proxy genutzt wird und ein IP-Ban (local oder Imperva) erkannt wurde:
  if (result.error === "IP_BLOCKED" && (!proxy || proxy.trim() === "")) {
    try {
      logger.warn("Detected IP_BLOCKED error. Initiating wait for new IP...");
      const previousIp = await getCurrentIp();
      logger.info(`Current IP before waiting: ${previousIp}`);
      // Warte darauf, dass sich die IP ändert.
      await waitForNewIp(previousIp);
      
      // Nach Erhalt einer neuen IP wird ein erneuter Login-Versuch gestartet.
      logger.info("Retrying login after IP change...");
      result = await launchAndConnectToBrowser(url, username, password, proxy);
    } catch (error) {
      logger.error(`Error during IP wait and retry: ${error.message}`);
    }
  } else {
    logger.debug("No IP_BLOCKED error detected or proxy in use. Not retrying based on IP.");
  }

  return result;
}

module.exports = { loginWithRetry };
