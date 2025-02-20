// core/auth_response.js
const logger = require('../utils/logger');

const AuthResponseStatus = {
    SUCCESS: "SUCCESS",
    INVALID: "INVALID",
    BANNED: "BANNED",
    ERROR: "ERROR"
};

logger.debug(`auth_response module loaded with statuses: ${JSON.stringify(AuthResponseStatus)}`);

module.exports = { AuthResponseStatus };
