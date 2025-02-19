// utils/proxyCheck.js
const axios = require('axios');

/**
 * Checks if the given proxy is working by sending a GET request to a known endpoint.
 * @param {string} proxyUrl - The proxy URL (e.g. "http://user:pass@host:port")
 * @param {number} [timeout=5000] - Timeout in ms.
 * @returns {Promise<boolean>} - true if working, false otherwise.
 */
async function isProxyWorking(proxyUrl, timeout = 5000) {
  try {
    // Use a simple GET to a known endpoint (e.g., ipify)
    const response = await axios.get('https://api.ipify.org?format=json', {
      proxy: new URL(proxyUrl),
      timeout,
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

module.exports = { isProxyWorking };
