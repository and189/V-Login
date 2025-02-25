// app.js
const express = require('express');
const bodyParser = require('body-parser');
const loginRoute = require('./api/login');
const logger = require('./utils/logger');
const { DEFAULT_TIMEOUT } = require("./config/constants");
require('dotenv').config(); // Füge dies hinzu, wenn du .env-Dateien verwendest

const app = express();
const port = 5090;

app.use(bodyParser.json());

// Mount the login route
app.use('/api/v1/login-code', loginRoute);

// Allgemeiner Fehlerhandler
app.use((err, req, res, next) => {
  logger.error(`Global error handler: ${err.stack}`);
  res.status(500).json({
      status: "ERROR",
      description: "Internal Server Error"
  });
});

if (module === require.main) {
    logger.info(`Starting server on port ${port}`);
    app.listen(port, '0.0.0.0', () => {
        logger.info(`Server listening on port ${port}`);
        const fs = require('fs');
        const sourceFile = 'proxy_data/proxyStats.json';
        const destFile = 'proxy_data/proxyStats.json';
        try {
          fs.mkdirSync('proxy_data', { recursive: true });
          if (fs.existsSync(sourceFile)) {
            logger.info(`${sourceFile} exists, attempting to copy`);
            fs.copyFileSync(sourceFile, destFile);
            logger.info(`Successfully copied ${sourceFile} to ${destFile}`);
          } else {
            logger.error(`${sourceFile} does not exist`);
          }
        } catch (err) {
          logger.error(`Error copying ${sourceFile} to ${destFile}: ${err.message}`);
        }
    });
}

module.exports = app;
