// Filename: puppeteerHandler.js

const launchOptions = {
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox'
  ],
  headless: false,
  defaultViewport: { width: 1280, height: 800 },
  // Further Puppeteer launch options possible here
};

module.exports = {
  launchOptions
};
