const logger = require('./logger');

// Using native fetch to get the public IP
async function getCurrentIp() {
  logger.debug("getCurrentIp: Attempting to retrieve current IP using fetch...");
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    logger.debug(`getCurrentIp: Response received with status: ${response.status}`);
    if (!response.ok) {
      const msg = `HTTP error! Status: ${response.status}`;
      logger.error(`getCurrentIp: ${msg}`);
      throw new Error(msg);
    }
    const data = await response.json();
    logger.debug(`getCurrentIp: Successfully retrieved IP: ${data.ip}`);
    return data.ip;
  } catch (error) {
    logger.error(`getCurrentIp: Unable to retrieve current IP: ${error.message}`);
    throw new Error(`Unable to retrieve current IP: ${error.message}`);
  }
}

// Dummy implementation for isIpBanned – adjust as needed
async function isIpBanned(ip) {
  logger.debug(`isIpBanned: Checking if IP ${ip} is banned...`);
  // Example: always return false
  logger.debug(`isIpBanned: IP ${ip} is not banned (dummy implementation)`);
  return false;
}

module.exports = { getCurrentIp, isIpBanned };
