// utils/ipUtils.js
const axios = require('axios');

async function getCurrentIp() {
  try {
    const response = await axios.get('https://api.ipify.org?format=json');
    return response.data.ip;
  } catch (error) {
    throw new Error(`Unable to retrieve current IP: ${error.message}`);
  }
}

// Dummy-Implementierung für isIpBanned – passt das bei dir an
async function isIpBanned(ip) {
  // Beispiel: immer false zurückgeben
  return false;
}

module.exports = { getCurrentIp, isIpBanned };

