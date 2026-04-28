/**
 * CAPTCHA detection, page-state checks, and human-in-the-loop solving.
 *
 * Extracted from googleSearchScraper.js so it can be tested and swapped
 * independently without touching scraper logic.
 */

const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage } = require("./utils/stealthConfig");
const { sleep } = require("./utils/delay");

const CAPTCHA_TIMEOUT = 120_000; // 2 minutes max wait for human solve

// ─── Page-State Checks ────────────────────────────────────────────────────────

/**
 * Returns true if the current page is a CAPTCHA or rate-limit wall.
 */
async function isBlocked(page) {
  try {
    const title = await page.title();
    if (title.includes("Sorry") || title.includes("unusual traffic")) return true;

    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("unusual traffic")   ||
        text.includes("captcha")           ||
        text.includes("verify you are human") ||
        text.includes("i'm not a robot")   ||
        text.includes("detected unusual")  ||
        !!document.querySelector("#captcha")                       ||
        !!document.querySelector('form[action*="sorry"]')          ||
        !!document.querySelector('iframe[src*="recaptcha"]')       ||
        !!document.querySelector(".g-recaptcha")
      );
    });
  } catch (_) {
    return false;
  }
}

/**
 * Returns true if Google returned a genuine "no results" page.
 */
async function hasNoResults(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return (
        /did not match any documents|no results found/i.test(text) ||
        (
          !!document.querySelector("#topstuff:not(:empty)") &&
          !document.querySelector("div.g, .tF2Cxc")
        )
      );
    });
  } catch (_) {
    return false;
  }
}

// ─── Human-in-the-Loop Solver ─────────────────────────────────────────────────

/**
 * Opens a VISIBLE browser window so the user can manually solve the CAPTCHA.
 *
 * Flow:
 *   1. Launch headful browser (stealth still applied)
 *   2. Navigate to the blocked URL
 *   3. Wait up to CAPTCHA_TIMEOUT for the CAPTCHA to be cleared
 *   4. Extract cookies and return them for session transfer into headless session
 *
 * @param {string}   url        — URL that triggered the CAPTCHA
 * @param {Function} onProgress — Progress logger callback
 * @param {Function} onCaptcha  — IPC callback to notify renderer (leads:captcha)
 * @param {number}   leadsCount — Current lead count for logging context
 * @returns {{ cookies: object[] } | null}
 */
async function solveWithHuman(url, onProgress, onCaptcha, leadsCount) {
  let captchaBrowser;

  try {
    onProgress({
      step: "log",
      message: "[CAPTCHA] Opening visible browser for manual solve...",
      count: leadsCount
    });
    onCaptcha({
      type: "captcha",
      message: "Manual verification required — solve the CAPTCHA in the browser window that just opened"
    });

    // Headful browser — user must be able to see and interact
    captchaBrowser = await puppeteer.launch(getBrowserConfig({ headless: false, debug: true }));
    const captchaPage = await captchaBrowser.newPage();
    await setupPage(captchaPage);
    await captchaPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await captchaPage.bringToFront();

    onProgress({
      step: "log",
      message: "[CAPTCHA] Waiting for user to solve (max 2 minutes)...",
      count: leadsCount
    });

    // Poll until CAPTCHA clears (user solved it)
    try {
      await captchaPage.waitForFunction(() => {
        const text = (document.body?.innerText || "").toLowerCase();
        return (
          !text.includes("unusual traffic")      &&
          !text.includes("captcha")              &&
          !text.includes("verify you are human") &&
          !text.includes("i'm not a robot")      &&
          !document.querySelector("#captcha")    &&
          !document.querySelector('form[action*="sorry"]') &&
          !document.querySelector('iframe[src*="recaptcha"]') &&
          !document.querySelector(".g-recaptcha")
        );
      }, { timeout: CAPTCHA_TIMEOUT });
    } catch (_) {
      onProgress({
        step: "log",
        message: "[CAPTCHA] Timeout — user did not solve within 2 minutes. Skipping page.",
        count: leadsCount
      });
      onCaptcha({ type: "timeout", message: "CAPTCHA timeout — skipping this page" });
      return null;
    }

    onProgress({ step: "log", message: "[CAPTCHA] Solved! Transferring session...", count: leadsCount });
    onCaptcha({ type: "solved", message: "CAPTCHA solved — resuming scraping..." });

    const cookies = await captchaPage.cookies();
    await sleep(2000); // brief pause so Google fully registers the solve
    return { cookies };

  } catch (err) {
    onProgress({
      step: "log",
      message: `[CAPTCHA] Error during manual solve: ${err.message}`,
      count: leadsCount
    });
    return null;
  } finally {
    if (captchaBrowser) await captchaBrowser.close().catch(() => {});
  }
}

module.exports = { isBlocked, hasNoResults, solveWithHuman, CAPTCHA_TIMEOUT };
