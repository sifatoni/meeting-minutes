/**
 * Method 1 — Google → LinkedIn lead scraper (Production-grade).
 *
 * Features: stealth config, human-in-the-loop CAPTCHA solving,
 * warm-up session, human-like behavior, streaming, proper logging.
 */

const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage, handleGoogleConsent } = require("./utils/stealthConfig");
const { sleep, randInt, randomScroll, simulateMouseMovement, readingPause } = require("./utils/delay");
const { QUERY_MODE, buildQueries, getQueryConfig, extractResultsFromPage, buildLeadFromResult } = require("./utils/extractors");

const DEBUG = false;
const MAX_PAGES_PER_QUERY = 15;
const MAX_TOTAL_LEADS = 300;
const CAPTCHA_TIMEOUT = 120000; // 2 minutes max wait for manual solve

// ─── CAPTCHA / Block Detection ────────────────────────────────────────────────

async function isBlocked(page) {
  try {
    const title = await page.title();
    if (title.includes("Sorry") || title.includes("unusual traffic")) return true;

    return await page.evaluate(() => {
      const text = document.body?.innerText?.toLowerCase() || "";
      const hasBlockText = (
        text.includes("unusual traffic") ||
        text.includes("captcha") ||
        text.includes("verify you are human") ||
        text.includes("i'm not a robot") ||
        text.includes("detected unusual")
      );

      const hasCaptchaSelectors = (
        !!document.querySelector("#captcha") ||
        !!document.querySelector('form[action*="sorry"]') ||
        !!document.querySelector('iframe[src*="recaptcha"]') ||
        !!document.querySelector(".g-recaptcha")
      );

      return hasBlockText || hasCaptchaSelectors;
    });
  } catch (_) { return false; }
}

async function hasNoResults(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return (
        /did not match any documents|no results found/i.test(text) ||
        (!!document.querySelector("#topstuff:not(:empty)") && !document.querySelector("div.g, .tF2Cxc"))
      );
    });
  } catch (_) { return false; }
}

// ─── Human-in-the-Loop CAPTCHA Solver ─────────────────────────────────────────

/**
 * Opens a VISIBLE browser window so the user can manually solve the CAPTCHA.
 * After solving, extracts cookies and returns them for session transfer.
 *
 * @param {string}   url         — The URL that triggered the CAPTCHA
 * @param {Function} onProgress  — Progress logger
 * @param {Function} onCaptcha   — IPC callback to notify renderer
 * @param {number}   leadsCount  — Current lead count for logging
 * @returns {object|null}        — { cookies } on success, null on timeout/failure
 */
async function solveWithHuman(url, onProgress, onCaptcha, leadsCount) {
  let captchaBrowser;

  try {
    onProgress({ step: "log", message: "[CAPTCHA] Opening visible browser for manual solve...", count: leadsCount });
    onCaptcha({ type: "captcha", message: "Manual verification required — solve CAPTCHA in the browser window" });

    // Launch a VISIBLE browser with stealth still applied
    captchaBrowser = await puppeteer.launch(getBrowserConfig({
      headless: false,
      debug: true  // slowMo: 50 for user comfort
    }));

    const captchaPage = await captchaBrowser.newPage();
    await setupPage(captchaPage);

    // Navigate to the blocked URL
    await captchaPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await captchaPage.bringToFront();

    onProgress({ step: "log", message: "[CAPTCHA] Waiting for user to solve (max 2 minutes)...", count: leadsCount });

    // Wait for CAPTCHA to be cleared by the user
    try {
      await captchaPage.waitForFunction(() => {
        const text = document.body?.innerText?.toLowerCase() || "";
        return !text.includes("unusual traffic") &&
               !text.includes("captcha") &&
               !text.includes("verify you are human") &&
               !text.includes("i'm not a robot") &&
               !document.querySelector("#captcha") &&
               !document.querySelector('form[action*="sorry"]') &&
               !document.querySelector('iframe[src*="recaptcha"]') &&
               !document.querySelector(".g-recaptcha");
      }, { timeout: CAPTCHA_TIMEOUT });
    } catch (_) {
      onProgress({ step: "log", message: "[CAPTCHA] Timeout — user did not solve within 2 minutes. Skipping page.", count: leadsCount });
      onCaptcha({ type: "timeout", message: "CAPTCHA timeout — skipping this page" });
      return null;
    }

    // CAPTCHA solved! Extract cookies for session transfer
    onProgress({ step: "log", message: "[CAPTCHA] Solved! Transferring session...", count: leadsCount });
    onCaptcha({ type: "solved", message: "CAPTCHA solved — resuming scraping..." });

    const cookies = await captchaPage.cookies();

    // Small delay to let Google fully process the solve
    await sleep(2000);

    return { cookies };
  } catch (err) {
    onProgress({ step: "log", message: `[CAPTCHA] Error during manual solve: ${err.message}`, count: leadsCount });
    return null;
  } finally {
    if (captchaBrowser) {
      await captchaBrowser.close().catch(() => {});
    }
  }
}

// ─── Safe Navigation with Human-in-the-Loop CAPTCHA ───────────────────────────

/**
 * Navigate to a URL with CAPTCHA detection. If blocked:
 * 1. First attempt:  wait 5s and retry (might be transient)
 * 2. Second attempt: open visible browser for human solve, transfer cookies
 * 3. Third attempt:  final backoff, then skip
 */
async function safeGoto(page, url, onProgress, onCaptcha, leadsCount) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      onProgress({ step: "log", message: `[SCRAPER] Loading page (attempt ${attempt + 1}/3)...`, count: leadsCount });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1000);

      if (await isBlocked(page)) {
        onProgress({ step: "log", message: `[BLOCKED] CAPTCHA detected on attempt ${attempt + 1}`, count: leadsCount });

        if (attempt === 0) {
          // First block: quick backoff — might be transient
          onProgress({ step: "log", message: "[RETRY] Quick backoff (5s)...", count: leadsCount });
          await sleep(5000);
          continue;
        }

        if (attempt === 1) {
          // Second block: human-in-the-loop
          const result = await solveWithHuman(url, onProgress, onCaptcha, leadsCount);

          if (result && result.cookies) {
            // Transfer cookies to current headless session
            await page.setCookie(...result.cookies);
            onProgress({ step: "log", message: "[SCRAPER] Session transferred. Retrying page...", count: leadsCount });

            // Retry the same URL with fresh cookies
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await sleep(1500);

            if (await isBlocked(page)) {
              onProgress({ step: "log", message: "[BLOCKED] Still blocked after CAPTCHA solve. Final backoff (20s)...", count: leadsCount });
              await sleep(20000);
              continue;
            }
          } else {
            // Human solve failed/timed out
            onProgress({ step: "log", message: "[RETRY] Human solve unavailable. Final backoff (20s)...", count: leadsCount });
            await sleep(20000);
            continue;
          }
        }

        if (attempt === 2) {
          onProgress({ step: "log", message: "[SKIPPED] Blocked after all attempts — skipping page.", count: leadsCount });
          return false;
        }
      }

      // Wait for search results to appear
      try {
        await page.waitForSelector("div.g, .tF2Cxc, #search", { timeout: 10000 });
      } catch (_) {
        if (!(await hasNoResults(page))) {
          onProgress({ step: "log", message: "[RETRY] Page looks empty. Retrying...", count: leadsCount });
          await sleep(5000);
          continue;
        }
      }

      await sleep(randInt(800, 1500));
      await handleGoogleConsent(page);

      return true;
    } catch (err) {
      onProgress({ step: "log", message: `[RETRY] Navigation error (attempt ${attempt + 1}/3): ${err.message}`, count: leadsCount });
      await sleep(5000);
    }
  }

  onProgress({ step: "log", message: "[SKIPPED] Failed to fetch page after all retries.", count: leadsCount });
  return false;
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

/**
 * @param {object}   input      — Search parameters (includes input.queryMode: "safe"|"aggressive")
 * @param {Function} onProgress — Progress/log callback → IPC leads:progress
 * @param {object}   signal     — Cancellation signal { cancelled, onCancel }
 * @param {Function} onData     — Streaming callback for real-time lead chunks
 * @param {Function} onCaptcha  — CAPTCHA event callback → IPC leads:captcha
 */
async function scrapeGoogleSearch(input, onProgress, signal, onData, onCaptcha) {
  const emitData = typeof onData === "function" ? onData : () => {};
  const emitCaptcha = typeof onCaptcha === "function" ? onCaptcha : () => {};
  const designations = (input.designations && input.designations.length)
    ? input.designations.slice(0, 3)
    : ["CEO", "Marketing Head"];

  // ── Dual-mode: get config for requested mode ──
  let currentMode = input.queryMode || QUERY_MODE.SAFE;
  let config = getQueryConfig(currentMode);
  let captchaCount = 0;

  onProgress({ step: "log", message: `[SCRAPER] Mode: ${currentMode.toUpperCase()} (max ${config.maxPagesPerQuery} pages/query, ${config.minDelay/1000}–${config.maxDelay/1000}s delay)`, count: 0 });

  const startTime = Date.now();
  let browser;

  try {
    browser = await puppeteer.launch(getBrowserConfig({ debug: DEBUG }));
  } catch (err) {
    throw new Error(`[Method 1] Failed to launch browser: ${err.message}`);
  }

  signal.onCancel = () => browser.close().catch(() => {});
  const leads = [];

  try {
    const page = await browser.newPage();
    await setupPage(page);

    // ── Warm-up: visit Google homepage to seed cookies ──
    onProgress({ step: "google-search", message: "[SCRAPER] Initialising browser session…", count: 0 });
    try {
      await page.goto("https://www.google.com", { waitUntil: "domcontentloaded", timeout: 25000 });
      await handleGoogleConsent(page);
      await simulateMouseMovement(page);
      await randomScroll(page, "light");
      await sleep(randInt(1500, 2500));
    } catch (_) {}

    // ── Per-designation loop ──
    for (const designation of designations) {
      if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS) break;

      const queries = buildQueries(designation, input.area, input.industry, input.location, currentMode);
      onProgress({ step: "google-search", message: `[SCRAPER] "${designation}" — ${queries.length} queries (${currentMode} mode)`, count: leads.length });

      for (const query of queries) {
        if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS) break;

        let consecutiveEmpty = 0;

        for (let pageNum = 0; pageNum < config.maxPagesPerQuery; pageNum++) {
          if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS) break;

          const start = pageNum * 10;
          const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${start}&num=10&hl=en&gl=us`;

          onProgress({ step: "log", message: `[SCRAPER] Page ${pageNum + 1} — fetching...`, count: leads.length });

          const success = await safeGoto(page, url, onProgress, emitCaptcha, leads.length);

          if (!success) {
            captchaCount++;

            // ── FALLBACK: If aggressive mode hits CAPTCHA, switch to safe ──
            if (currentMode === QUERY_MODE.AGGRESSIVE && captchaCount >= 2) {
              currentMode = QUERY_MODE.SAFE;
              config = getQueryConfig(currentMode);
              onProgress({ step: "log", message: "[FALLBACK] Aggressive mode triggered too many CAPTCHAs — switching to SAFE mode", count: leads.length });
            }
            continue;
          }

          if (await hasNoResults(page)) {
            onProgress({ step: "log", message: `[SKIPPED] No results on Page ${pageNum + 1} — moving to next query`, count: leads.length });
            break;
          }

          // Human behavior
          await simulateMouseMovement(page);
          await randomScroll(page, "normal");
          await readingPause(page);

          const results = await extractResultsFromPage(page);

          if (results.length === 0) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 2) {
              onProgress({ step: "log", message: "[SKIPPED] 2 consecutive empty pages — next query", count: leads.length });
              break;
            }
          } else {
            consecutiveEmpty = 0;
          }

          const pageLeads = [];
          for (const result of results) {
            const lead = buildLeadFromResult(result, input, designation);
            if (lead) { leads.push(lead); pageLeads.push(lead); }
          }

          // Stream leads out immediately after each page
          if (pageLeads.length > 0) {
            emitData(pageLeads, { source: "Google/LinkedIn", page: pageNum + 1 });
          }

          onProgress({ step: "log", message: `[SCRAPER] Extracted ${pageLeads.length} leads (Total: ${leads.length})`, count: leads.length });

          // Mode-aware rate limiting
          await sleep(randInt(config.minDelay, config.maxDelay));
        }

        // Pause between queries
        if (!signal.cancelled) await sleep(randInt(1500, 3000));
      }
    }
  } finally {
    await browser.close().catch(() => {});
    signal.onCancel = null;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  onProgress({ step: "log", message: `[SCRAPER] Method 1 complete — ${leads.length} leads in ${elapsed}s (final mode: ${currentMode})`, count: leads.length });

  return leads;
}

module.exports = { scrapeGoogleSearch };

