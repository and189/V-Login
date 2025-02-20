// utils/helpers.js
const logger = require('./logger');

const setTimeoutPromise = (ms) => {
  logger.debug(`setTimeoutPromise: Waiting for ${ms}ms`);
  return new Promise(resolve => setTimeout(() => {
    logger.debug(`setTimeoutPromise: Resolved after ${ms}ms`);
    resolve();
  }, ms));
};

module.exports = {
  setTimeoutPromise
};
