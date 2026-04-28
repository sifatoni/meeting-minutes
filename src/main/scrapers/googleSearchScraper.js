/**
 * Method 1 — Multi-platform Google lead scraper.
 *
 * Architecture:
 *   queryBuilder.js   → diversified LinkedIn query generation (5–8/search)
 *   captchaHandler.js → CAPTCHA detection + human-in-the-loop solving
 *   extractors.js     → DOM scraping + lead construction (all platforms)
 *
 * Platform execution order: LinkedIn → Instagram → Facebook (strict)
 * Session: persistent Chrome profile (userDataDir) for cookie / history reuse
 * Delays: 4–8s standard, 10–15s occasional — human pacing
 * Pages: max 7, random early-stop at 4–7 per query
 */

const path     = require("path");
const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage, handleGoogleConsent } = require("./utils/stealthConfig");
const { sleep, randInt, randomScroll, simulateMouseMovement, readingPause } = require("./utils/delay");
const { QUERY_MODE, buildQueries, extractResultsFromPage, buildLeadFromResult } = require("./utils/extractors");
const { buildLinkedInQueries }           = require("./queryBuilder");
const { isBlocked, hasNoResults, solveWithHuman } = require("./captchaHandler");

// ─── Config ───────────────────────────────────────────────────────────────────

const DEBUG           = false;
const MAX_TOTAL_LEADS = 300;
const MAX_PAGES       = 7;

// Persistent Chrome profile — reuses cookies/history across runs
const CHROME_PROFILE_DIR = path.resolve(__dirname, "../../../chrome-profile");

// Map common country names → ISO 3166-1 alpha-2 codes for Google geo-targeting
const COUNTRY_CODES = {
  bangladesh: "bd", india: "in",  pakistan: "pk", "sri lanka": "lk",
  nepal:      "np", usa:   "us",  uk:        "gb", australia:   "au",
  canada:     "ca", china: "cn",  singapore: "sg", malaysia:    "my",
  indonesia:  "id", nigeria: "ng", kenya:     "ke", ghana:       "gh",
};

function getCountryCode(location = "", area = "") {
  const text = `${location} ${area}`.toLowerCase();
  for (const [name, code] of Object.entries(COUNTRY_CODES)) {
    if (text.includes(name)) return code;
  }
  return "bd"; // default: Bangladesh (primary use-case)
}

// Strict platform execution order (LinkedIn highest value → fallbacks)
const PLATFORMS = ["linkedin", "instagram", "facebook"];

// ─── Pagination Resolver ──────────────────────────────────────────────────────

const MAX_RANGE = 10; // hard cap: no query fetches more than 10 pages at once

/**
 * Resolve the page range for a query run.
 *
 * Priority:
 *   1. input.startPage / input.endPage provided  → use custom range
 *   2. Neither provided                          → random 4–MAX_PAGES (smart mode)
 *
 * Validation rules (applied before returning):
 *   - startPage ≥ 1
 *   - if endPage < startPage → swap them
 *   - if only startPage given → endPage = startPage + MAX_RANGE - 1
 *   - range clamped to MAX_RANGE pages
 *
 * @returns {{ startPg: number, endPg: number, mode: "custom"|"auto" }}
 */
function resolvePagination(input) {
  const rawStart = input.startPage != null ? parseInt(input.startPage, 10) : NaN;
  const rawEnd   = input.endPage   != null ? parseInt(input.endPage,   10) : NaN;

  const hasStart = !isNaN(rawStart) && rawStart >= 1;
  const hasEnd   = !isNaN(rawEnd)   && rawEnd   >= 1;

  if (!hasStart && !hasEnd) {
    // Smart mode: random stop between 4 and MAX_PAGES
    const end = randInt(4, MAX_PAGES);
    return { startPg: 1, endPg: end, mode: "auto" };
  }

  let start = hasStart ? Math.max(1, rawStart) : 1;
  let end   = hasEnd   ? Math.max(1, rawEnd)   : start + MAX_RANGE - 1;

  // Swap if inverted
  if (end < start) [start, end] = [end, start];

  // Clamp range
  if (end - start + 1 > MAX_RANGE) end = start + MAX_RANGE - 1;

  return { startPg: start, endPg: end, mode: "custom" };
}

// ─── Human-Like Delay ─────────────────────────────────────────────────────────

/**
 * Paced delay between page loads.
 * Standard:   4–8s (most page-to-page transitions)
 * Occasional: 10–15s (15% chance — simulates reading, distraction, bathroom break)
 */
async function humanPageDelay() {
  if (Math.random() < 0.15) {
    await sleep(randInt(10_000, 15_000));
  } else {
    await sleep(randInt(4_000, 8_000));
  }
}

// ─── Safe Navigation ──────────────────────────────────────────────────────────

/**
 * Navigate to a URL with CAPTCHA detection and retry logic.
 *
 * Attempt 1: Load page. If blocked → quick backoff (5–8s) and retry.
 * Attempt 2: Still blocked → open headful browser for human solve, transfer cookies.
 * Attempt 3: Final attempt. Fail gracefully → return false (skip page).
 */
async function safeGoto(page, url, onProgress, onCaptcha, leadsCount) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      onProgress({
        step: "log",
        message: `[SCRAPER] Navigating (attempt ${attempt + 1}/3)...`,
        count: leadsCount
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(randInt(1000, 2000)); // settle time before checking state

      if (await isBlocked(page)) {
        onProgress({
          step: "log",
          message: `[BLOCKED] CAPTCHA/rate-limit on attempt ${attempt + 1}`,
          count: leadsCount
        });

        if (attempt === 0) {
          // Transient block → short backoff
          await sleep(randInt(5000, 8000));
          continue;
        }

        if (attempt === 1) {
          // Persistent block → open visible browser for manual solve
          const result = await solveWithHuman(url, onProgress, onCaptcha, leadsCount);

          if (result?.cookies?.length) {
            await page.setCookie(...result.cookies);
            onProgress({ step: "log", message: "[SCRAPER] Session transferred. Retrying...", count: leadsCount });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await sleep(randInt(1500, 2500));
            if (await isBlocked(page)) {
              await sleep(20000);
              continue;
            }
          } else {
            // Solve failed or timed out
            await sleep(20000);
            continue;
          }
        }

        if (attempt === 2) {
          onProgress({ step: "log", message: "[SKIPPED] Still blocked — skipping page.", count: leadsCount });
          return false;
        }
      }

      // Wait for Google to render any results — use a function check so a single
      // missed class name can't cause the whole page to be skipped.
      try {
        await page.waitForFunction(() =>
          document.querySelector("#search")  !== null ||
          document.querySelector("#rso")     !== null ||
          document.querySelectorAll("a h3").length > 0,
        { timeout: 12000 });
      } catch (_) {
        // Timeout ≠ no results. Proceed anyway — the extractor has its own
        // fallback strategies and will return whatever it can find.
        if (await hasNoResults(page)) {
          onProgress({ step: "log", message: "[WAIT] Genuine no-results page detected.", count: leadsCount });
        } else {
          onProgress({ step: "log", message: "[WAIT] Result container not detected via waitForFunction — extracting anyway.", count: leadsCount });
        }
      }

      await sleep(randInt(800, 1500));
      await handleGoogleConsent(page);
      return true;

    } catch (err) {
      onProgress({
        step: "log",
        message: `[RETRY] Navigation error (attempt ${attempt + 1}/3): ${err.message}`,
        count: leadsCount
      });
      await sleep(5000);
    }
  }

  onProgress({ step: "log", message: "[SKIPPED] Failed after all retries.", count: leadsCount });
  return false;
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

/**
 * Multi-platform Google → Lead scraper with streaming, cancellation,
 * session reuse, and human-like pacing.
 *
 * Execution order per designation:
 *   1. LinkedIn  (5–8 diversified queries, primary platform)
 *   2. Instagram (2–3 queries, secondary)
 *   3. Facebook  (2–3 queries, fallback)
 *
 * Fallback rule: if LinkedIn returns 0 results for 2 consecutive pages
 *   → abort remaining LinkedIn queries, move straight to Instagram.
 *
 * @param {object}   input       — { designations, area, industry, location, queryMode }
 * @param {Function} onProgress  — IPC logger  → leads:progress
 * @param {object}   signal      — { cancelled: bool, onCancel: fn }
 * @param {Function} onData      — Streaming callback called after EACH page
 * @param {Function} onCaptcha   — IPC callback → leads:captcha
 */
async function scrapeGoogleSearch(input, onProgress, signal, onData, onCaptcha) {
  const emitData    = typeof onData    === "function" ? onData    : () => {};
  const emitCaptcha = typeof onCaptcha === "function" ? onCaptcha : () => {};

  const designations = input.designations?.length
    ? input.designations.slice(0, 3)
    : ["CEO", "Marketing Head"];

  const currentMode = input.queryMode || QUERY_MODE.AGGRESSIVE;
  let captchaCount  = 0;

  onProgress({
    step: "log",
    message: `[SCRAPER] Mode: ${currentMode.toUpperCase()} | Platforms: ${PLATFORMS.join(" → ")} | Max ${MAX_PAGES} pages | Session: persistent`,
    count: 0
  });

  const startTime = Date.now();
  let browser;

  try {
    browser = await puppeteer.launch({
      ...getBrowserConfig({ debug: DEBUG }),
      userDataDir: CHROME_PROFILE_DIR  // reuse cookies + session history
    });
  } catch (err) {
    throw new Error(`[Method 1] Failed to launch browser: ${err.message}`);
  }

  signal.onCancel = () => browser.close().catch(() => {});
  const leads = [];

  try {
    const page = await browser.newPage();
    await setupPage(page);

    // ── Warm-up: seed cookies by visiting Google homepage ──────────────────
    onProgress({ step: "google-search", message: "[SCRAPER] Initialising browser session…", count: 0 });
    try {
      await page.goto("https://www.google.com", { waitUntil: "domcontentloaded", timeout: 25000 });
      await handleGoogleConsent(page);
      await simulateMouseMovement(page);
      await randomScroll(page, "light");
      await sleep(randInt(1500, 2500));
    } catch (_) {}

    // ── Per-designation loop ───────────────────────────────────────────────
    for (const designation of designations) {
      if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS) break;

      // LinkedIn: diversified queryBuilder (5–8 unique queries)
      // Instagram/Facebook: platform-site-filter queries from extractors
      const { instagram, facebook } = buildQueries(
        designation, input.area, input.industry, input.location, currentMode
      );
      const platformQueries = {
        linkedin:  buildLinkedInQueries(designation, input.area, input.industry, input.location),
        instagram,
        facebook
      };

      onProgress({
        step: "google-search",
        message: `[SCRAPER] "${designation}" — LI:${platformQueries.linkedin.length} IG:${platformQueries.instagram.length} FB:${platformQueries.facebook.length} queries`,
        count: leads.length
      });

      // ── Strict platform order ────────────────────────────────────────────
      for (const platform of PLATFORMS) {
        if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS) break;

        const queries = platformQueries[platform] || [];
        if (queries.length === 0) continue;

        console.log("PLATFORM:", platform.toUpperCase());
        onProgress({
          step: "log",
          message: `[SCRAPER] ── [${platform.toUpperCase()}] starting (${queries.length} queries) ──`,
          count: leads.length
        });

        let platformAbort = false; // LinkedIn fallback flag

        for (const query of queries) {
          if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS || platformAbort) break;

          console.log("QUERY:", query);

          // Resolve pagination: custom range from input or random smart-mode
          const { startPg, endPg, mode: pgMode } = resolvePagination(input);
          let consecutiveEmpty = 0;

          if (pgMode === "custom") {
            onProgress({
              step: "log",
              message: `[SCRAPER] [${platform.toUpperCase()}] Custom range: pages ${startPg}–${endPg} (${endPg - startPg + 1} pages)`,
              count: leads.length
            });
          }

          for (let pageNum = startPg; pageNum <= endPg; pageNum++) {
            if (signal.cancelled || leads.length >= MAX_TOTAL_LEADS) break;

            const start  = (pageNum - 1) * 10;
            const glCode = getCountryCode(input.location, input.area);
            const url    = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${start}&num=10&hl=en&gl=${glCode}&pws=0`;

            onProgress({
              step: "log",
              message: `[SCRAPER] [${platform.toUpperCase()}] Page ${pageNum}/${endPg} — fetching... (start=${start})`,
              count: leads.length
            });

            const success = await safeGoto(page, url, onProgress, emitCaptcha, leads.length);

            if (!success) {
              captchaCount++;
              // Too many CAPTCHAs even in aggressive mode → treat as transient, continue
              if (captchaCount >= 3) {
                onProgress({
                  step: "log",
                  message: `[CAPTCHA] ${captchaCount} total blocks — continuing with caution`,
                  count: leads.length
                });
              }
              continue;
            }

            if (await hasNoResults(page)) {
              onProgress({
                step: "log",
                message: `[SKIPPED] No results on Page ${pageNum}`,
                count: leads.length
              });
              consecutiveEmpty++;
              // LinkedIn fallback: 2+ consecutive empty pages → move to Instagram
              if (platform === "linkedin" && consecutiveEmpty >= 2) {
                onProgress({
                  step: "log",
                  message: "[FALLBACK] LinkedIn empty for 2 pages — moving to next platform",
                  count: leads.length
                });
                platformAbort = true;
              }
              break;
            }

            // ── Human behaviour before reading results ──────────────────────
            await simulateMouseMovement(page);
            await randomScroll(page, "normal");
            await readingPause(page);

            const results = await extractResultsFromPage(page);
            console.log("RESULT COUNT:", results.length);

            if (results.length === 0) {
              consecutiveEmpty++;
              if (consecutiveEmpty >= 2) {
                onProgress({
                  step: "log",
                  message: "[SKIPPED] 2 consecutive empty pages — next query",
                  count: leads.length
                });
                if (platform === "linkedin") platformAbort = true;
                break;
              }
            } else {
              consecutiveEmpty = 0;
            }

            // ── Build leads + stream immediately ───────────────────────────
            const pageLeads = [];
            for (const result of results) {
              const lead = buildLeadFromResult(result, input, designation);
              if (lead) {
                leads.push(lead);
                pageLeads.push(lead);
              }
            }

            console.log("LEADS BUILT:", pageLeads.length);

            // Stream leads to renderer RIGHT NOW — don't wait for full scrape
            if (pageLeads.length > 0) {
              emitData(pageLeads, { source: platform, page: pageNum });
            }

            onProgress({
              step: "log",
              message: `[SCRAPER] [${platform.toUpperCase()}] Page ${pageNum}: ${pageLeads.length} leads (Total: ${leads.length})`,
              count: leads.length
            });

            // ── Human-like inter-page delay ────────────────────────────────
            await humanPageDelay();
          }

          // Pause between queries (not between pages)
          if (!signal.cancelled && !platformAbort) {
            await sleep(randInt(2000, 4000));
          }
        }
      }
    }

  } finally {
    await browser.close().catch(() => {});
    signal.onCancel = null;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  onProgress({
    step: "log",
    message: `[SCRAPER] Complete — ${leads.length} leads in ${elapsed}s`,
    count: leads.length
  });

  return leads;
}

module.exports = { scrapeGoogleSearch };
