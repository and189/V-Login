// utils/logger.js
const winston = require('winston');

// Standardmäßig "info" – in der Entwicklung kann man z.B. "debug" setzen.
const logLevel = process.env.LOG_LEVEL || 'info';

// Custom Format: Zeitstempel, Log-Level und Message; zusätzliche Metadaten werden schön formatiert angezeigt.
const customFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
  return `${timestamp} [${level}] ${message}${metaString ? ' ' + metaString : ''}`;
});

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    customFormat
  ),
  transports: [
    // Dateiausgabe – hier werden alle Logs persistiert
    new winston.transports.File({
      filename: '/tmp/app.log',
      level: logLevel,
    }).on('error', error => {
      console.error('Fehler beim Schreiben in app.log:', error);
    }),
    // Konsolenausgabe mit Farbe
    new winston.transports.Console({
      level: logLevel,
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        customFormat
      )
    })
  ],
});

module.exports = logger;

