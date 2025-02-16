// core/detection.js
const logger = require('../utils/logger'); // Relative Pfade

async function bypassPuppeteerDetection(page) {
    logger.debug("Applying anti-detection measures");
    const scripts = [
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})",
        "window.navigator.chrome = { runtime: {}, app: { isInstalled: false } };",
        "Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3]})",
        "Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']})"
    ];
    for (const script of scripts) {
        await page.evaluate(script);
    }
}

module.exports = { bypassPuppeteerDetection };
