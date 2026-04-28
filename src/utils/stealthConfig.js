const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const getBrowser = async (proxy = null) => {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  const browser = await puppeteer.launch({
    headless: false,
    args
  });

  return browser;
};

module.exports = {
  getBrowser
};
