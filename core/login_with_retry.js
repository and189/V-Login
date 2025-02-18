// core/login_with_retry.js

const { getCurrentIp } = require('../utils/ipUtils');
const { setTimeoutPromise } = require('../utils/helpers');
const logger = require('../utils/logger');
const { launchAndConnectToBrowser } = require('./puppeteer');
const { getNextProxy } = require('../utils/proxyPool');

/**
 * Wartet darauf, dass sich die öffentliche IP vom previousIp ändert.
 * @param {string} previousIp - Die aktuell gesperrte (lokale) IP.
 * @param {number} checkIntervalMs - Wie oft (in ms) die IP geprüft wird (Standard: 60000 ms).
 * @returns {Promise<string>} - Die neue IP, sobald sie sich ändert.
 */
async function waitForNewIp(previousIp, checkIntervalMs = 60000) {
  let currentIp = previousIp;
  logger.info(`Lokale IP gesperrt. Warte auf neue IP (aktuelle IP: ${previousIp})...`);
  
  // Polling Loop: Überprüfen, ob sich die IP geändert hat.
  while (currentIp === previousIp) {
    await setTimeoutPromise(checkIntervalMs);
    try {
      currentIp = await getCurrentIp();
      logger.info(`Aktuelle IP erneut abgefragt: ${currentIp}`);
    } catch (error) {
      logger.warn(`Fehler beim Abfragen der aktuellen IP: ${error.message}`);
    }
  }

  logger.info(`Neue IP erkannt: ${currentIp}`);
  return currentIp;
}

/**
 * Versucht, sich einzuloggen. Wenn ein "IP_BLOCKED"-Fehler erkannt wird:
 *  - Ohne Proxy (lokale IP) -> warte auf IP-Wechsel und versuche erneut.
 *  - Mit Proxy -> sofortigen Wechsel auf einen anderen Proxy (falls vorhanden).
 *
 * @param {string} url - Die Login-URL.
 * @param {string} username - Der Benutzername.
 * @param {string} password - Das Passwort.
 * @param {string} [proxy] - (Optional) Wenn gesetzt, wird dieser Proxy verwendet.
 * @returns {Promise<Object>} - Das Ergebnis des Login-Prozesses.
 */
async function loginWithRetry(url, username, password, proxy) {
  logger.info("Starte ersten Login-Versuch ...");
  let result = await launchAndConnectToBrowser(url, username, password, proxy);

  // Prüfen, ob eine IP-Sperre aufgetreten ist
  if (result.error === "IP_BLOCKED") {
    // Fall A: Lokale IP ist gesperrt (kein Proxy angegeben oder leer)
    if (!proxy || !proxy.trim()) {
      logger.warn("Lokale IP wurde gesperrt. Warte, bis sich die IP ändert ...");
      try {
        const previousIp = await getCurrentIp();
        // Auf IP-Wechsel warten
        await waitForNewIp(previousIp);
        
        // Erneuter Login-Versuch (weiterhin ohne Proxy)
        logger.info("Versuche erneut, nachdem sich die lokale IP geändert hat ...");
        result = await launchAndConnectToBrowser(url, username, password);
      } catch (error) {
        logger.error(`Fehler während des IP-Wechsels: ${error.message}`);
      }

    // Fall B: Proxy ist gesperrt -> direkt auf den nächsten Proxy wechseln
    } else {
      logger.warn(`Proxy gesperrt: ${proxy}. Versuche, anderen Proxy aus dem Pool zu holen ...`);
      const newProxy = getNextProxy();
      
      if (!newProxy) {
        logger.error("Kein weiterer Proxy im Pool verfügbar. Breche ab.");
        return result; // oder ggf. throw new Error(...) oder ein anderes Handling
      }

      logger.info(`Neuer Proxy gewählt: ${newProxy}. Starte neuen Login-Versuch ...`);
      result = await launchAndConnectToBrowser(url, username, password, newProxy);
    }
  } else {
    logger.debug("Kein IP_BLOCKED-Fehler oder es wurde kein Proxy-Fehler erkannt. Kein Wechsel nötig.");
  }

  return result;
}

module.exports = { loginWithRetry };
