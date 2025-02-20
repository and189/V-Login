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
        logger.debug(`Evaluating anti-detection script: ${script}`);
        await page.evaluate(script);
        logger.debug("Script evaluation completed");
    }
    logger.debug("Anti-detection measures applied successfully");
}

module.exports = { bypassPuppeteerDetection };
