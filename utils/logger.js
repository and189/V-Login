// utils/logger.js
const winston = require('winston');
const chalkLib = require('chalk');
const chalk = chalkLib.default || chalkLib;

// Default log level – in development you can set this to "debug".
const logLevel = process.env.LOG_LEVEL || 'info';

// Custom format for file output (without colors)
const fileFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
  return `${timestamp} [${level}] ${message}${metaString ? ' ' + metaString : ''}`;
});

// Custom format for console output using chalk for conditional coloring
const consoleFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  let coloredMessage = message;

  // If the message contains "SUCCESS", "ory-code" or "ory token", color it green.
  if (message.includes('SUCCESS') || message.includes('ory-code') || message.includes('ory token')) {
    coloredMessage = chalk.green(message);
  } 
  // If the message contains "INVALID" or "418", color it red.
  else if (message.includes('INVALID') || message.includes('418')) {
    coloredMessage = chalk.red(message);
  } 
  // Otherwise, color normal text black.
  else {
    coloredMessage = chalk.black(message);
  }

  const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
  return `${timestamp} [${level}] ${coloredMessage}${metaString ? ' ' + metaString : ''}`;
});

const logger = winston.createLogger({
  level: logLevel,
  // For file transport, we use a non-colored format.
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    fileFormat
  ),
  transports: [
    // File output – all logs are persisted here.
    new winston.transports.File({
      filename: '/tmp/app.log',
      level: logLevel,
    }).on('error', error => {
      console.error('Error writing to app.log:', error);
    }),
    // Console output – using our custom chalk-based format.
    new winston.transports.Console({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        consoleFormat
      )
    })
  ],
});

module.exports = logger;
