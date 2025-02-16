// utils/helpers.js
const setTimeoutPromise = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  setTimeoutPromise
}
