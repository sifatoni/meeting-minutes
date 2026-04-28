/**
 * Browser launch configuration and page-level stealth setup.
 * The stealth plugin is already applied on the puppeteer instance exported by
 * puppeteerSetup.js — this module only provides the *options* and helper setup.
 *
 * Production-grade: rotating UAs, randomised viewports, full header suite,
 * WebGL/plugin spoofing, and Google consent handling.
 */

// ─── User-Agent Pool ──────────────────────────────────────────────────────────
// Mix of Chrome/Edge/Firefox on Windows/Mac/Linux — updated to 2024-era strings.

const USER_AGENTS = [
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  // Edge Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.80",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.2365.92",
  // Chrome Mac
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Safari Mac
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  // Firefox Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  // Chrome Linux
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
];

// ─── Viewport Pool ────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
  { width: 1680, height: 1050 }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomUA() { return pick(USER_AGENTS); }
function getRandomViewport() { return pick(VIEWPORTS); }

// ─── Browser Launch Config ────────────────────────────────────────────────────

/**
 * Returns the puppeteer.launch() options object.
 * @param {object} opts
 * @param {boolean} [opts.headless=true]  — "new" for true headless, false for visible
 * @param {string}  [opts.proxy]          — e.g. "http://IP:PORT"
 * @param {boolean} [opts.debug=false]    — adds slowMo for debugging
 */
function getBrowserConfig(opts = {}) {
  const vp = getRandomViewport();
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-notifications",
    "--disable-popup-blocking",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    `--window-size=${vp.width},${vp.height}`,
    "--lang=en-US,en"
  ];

  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy}`);
  }

  return {
    headless: opts.debug ? false : (opts.headless !== undefined ? opts.headless : "new"),
    slowMo: opts.debug ? 50 : 0,
    args,
    defaultViewport: vp,
    ignoreHTTPSErrors: true
  };
}

// ─── Page-Level Stealth Setup ─────────────────────────────────────────────────

/**
 * Apply stealth overrides and headers on a page object.
 * Call once after browser.newPage().
 */
async function setupPage(page, userAgent) {
  const ua = userAgent || getRandomUA();
  const vp = getRandomViewport();

  await page.setViewport(vp);
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1"
  });

  // Belt-and-suspenders on top of the stealth plugin
  await page.evaluateOnNewDocument(() => {
    // Ensure webdriver flag is gone
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // Chrome runtime object (some detection scripts check this)
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
    }

    // Spoof consistent language list
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

    // Spoof plugin count (real browsers have plugins)
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const arr = [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
          { name: "Native Client", filename: "internal-nacl-plugin" }
        ];
        arr.item = (i) => arr[i] || null;
        arr.namedItem = (n) => arr.find(p => p.name === n) || null;
        arr.refresh = () => {};
        return arr;
      }
    });

    // Spoof hardware concurrency (avoid fingerprinting outliers)
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });

    // Override permissions so notifications check looks normal
    const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (origQuery) {
      window.navigator.permissions.query = (params) =>
        params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }

    // Spoof WebGL vendor/renderer to look like a real GPU
    const getParameterProto = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return "Intel Inc.";              // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
      return getParameterProto.call(this, param);
    };
  });
}

// ─── Google Consent Handler ───────────────────────────────────────────────────

/**
 * Click through any Google consent / cookie wall that may appear.
 * Returns true if a button was clicked.
 */
async function handleGoogleConsent(page) {
  const candidates = [
    "#L2AGLb",
    'button[aria-label*="Accept all"]',
    'button[aria-label*="Accept"]',
    "#acceptButton",
    "form[action*='consent'] button",
    ".QS5gu.sy4vM",
    'button[jsname="higCR"]',
    'button[jsname="b3VHJd"]'
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await new Promise(r => setTimeout(r, 1500));
        return true;
      }
    } catch (_) {}
  }
  return false;
}

module.exports = {
  USER_AGENTS,
  VIEWPORTS,
  getRandomUA,
  getRandomViewport,
  getBrowserConfig,
  setupPage,
  handleGoogleConsent
};
