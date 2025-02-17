// utils/ipUtils.js

// Using native fetch to get the public IP
async function getCurrentIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const data = await response.json();
    return data.ip;
  } catch (error) {
    throw new Error(`Unable to retrieve current IP: ${error.message}`);
  }
}

// Dummy implementation for isIpBanned – adjust as needed
async function isIpBanned(ip) {
  // Example: always return false
  return false;
}

module.exports = { getCurrentIp, isIpBanned };
