if (global.logger) {
  module.exports = global.logger;
  return;
}

const winston = require('winston');
 
// Default log level is "info" - can be set to "debug" for development, for example.
const logLevel = process.env.LOG_LEVEL || 'info';

// Custom Format: Request-ID, Timestamp, Log-Level and Message
const customFormat = winston.format.printf(({ timestamp, level, message, requestId, ...meta }) => {
  // If requestId exists, prepend it to the message
  const prefix = requestId ? `[${requestId}] ` : ''; 
  const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
  return `${timestamp} [${level}] ${prefix}${message} ${metaString}`;
});

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    customFormat // Using the new format here
  ),
  transports: [
    // File output - all logs are persisted here
    new winston.transports.File({
      filename: '/tmp/app.log',
      level: logLevel,
    }).on('error', error => {
      console.error('Error writing to app.log:', error);
    }),
    // Console output with color
    new winston.transports.Console({
      level: logLevel,
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        customFormat // And here as well
      )
    })
  ],
});

// Helper function to set the Request-ID in the log context
logger.setRequestId = (requestId) => {
  logger.defaultMeta = { requestId }; 
};

// Zusätzlicher Debug-Log beim Initialisieren des Loggers
logger.debug(`Logger initialized with log level: ${logLevel}`);

global.logger = logger;
 
module.exports = logger;
