const axios = require('axios');
const logger = require('./logger');

/**
 * Checks if the given proxy is working by sending a GET request to a known endpoint.
 * @param {string} proxyUrl - The proxy URL (e.g. "http://user:pass@host:port")
 * @param {number} [timeout=5000] - Timeout in ms.
 * @returns {Promise<boolean>} - true if working, false otherwise.
 */
async function isProxyWorking(proxyUrl, timeout = 5000) {
  logger.debug(`isProxyWorking: Checking proxy ${proxyUrl} with timeout ${timeout}ms`);
  try {
    // Use a simple GET to a known endpoint (e.g., ipify) with HTTP protocol
    const response = await axios.get('http://api.ipify.org?format=json', {
      proxy: new URL(proxyUrl),
      timeout,
    });
    logger.debug(`isProxyWorking: Received response with status ${response.status} for proxy ${proxyUrl}`);
    return response.status === 200;
  } catch (error) {
    logger.warn(`isProxyWorking: Proxy check failed for ${proxyUrl}. Error: ${error.message}`);
    return false;
  }
}

module.exports = { isProxyWorking };
