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
    });
}

module.exports = app; // Exportiere die App für Tests
