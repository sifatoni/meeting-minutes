const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage } = require("./utils/stealthConfig");
const { sleep, randInt } = require("./utils/delay");
const { QUERY_MODE, buildQueries, buildLeadFromResult } = require("./utils/extractors");
const { buildLinkedInQueries } = require("./queryBuilder");

const MAX_PAGES = 5;

async function scrapeBing(input, onProgress, signal, onData) {
  const emitData = typeof onData === "function" ? onData : () => {};
  
  const designations = input.designations?.length ? input.designations.slice(0, 3) : ["CEO"];
  const currentMode = input.queryMode || QUERY_MODE.AGGRESSIVE;
  
  onProgress({
    step: "log",
    message: `[SCRAPER] [Bing] Starting fallback search...`,
    count: 0
  });

  let browser;
  try {
    browser = await puppeteer.launch(getBrowserConfig({ debug: false }));
  } catch (err) {
    throw new Error(`[Method 3] Failed to launch browser: ${err.message}`);
  }

  signal.onCancel = () => browser.close().catch(() => {});
  const leads = [];

  try {
    const page = await browser.newPage();
    await setupPage(page);

    for (const designation of designations) {
      if (signal.cancelled) break;

      const { instagram, facebook } = buildQueries(
        designation, input.area, input.industry, input.location, currentMode
      );
      const queries = [
        ...buildLinkedInQueries(designation, input.area, input.industry, input.location),
        ...instagram,
        ...facebook
      ];

      for (const query of queries) {
        if (signal.cancelled) break;

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
          if (signal.cancelled) break;

          const start = (pageNum - 1) * 10 + 1; // Bing pagination starts at 1, 11, 21
          const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${start}&count=10`;

          try {
             onProgress({
              step: "log",
              message: `[SCRAPER] [Bing] Fetching Page ${pageNum}...`,
              count: leads.length
            });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await sleep(randInt(1000, 2000));
            
            const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
            if (pageText.includes("captcha") || pageText.includes("verify") || pageText.includes("robot") || pageText.includes("unusual activity")) {
              onProgress({ step: "log", message: `[SCRAPER] [Bing] CAPTCHA detected. Waiting to retry...`, count: leads.length });
              await sleep(randInt(8000, 12000));
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
              await sleep(randInt(1500, 2500));
              const pageText2 = await page.evaluate(() => document.body.innerText.toLowerCase());
              if (pageText2.includes("captcha") || pageText2.includes("verify") || pageText2.includes("robot") || pageText2.includes("unusual activity")) {
                 onProgress({ step: "log", message: `[SCRAPER] [Bing] CAPTCHA still present. Skipping query.`, count: leads.length });
                 break;
              }
            }

            const results = await page.evaluate(() => {
               const items = [];
               document.querySelectorAll(".b_algo").forEach(el => {
                 const a = el.querySelector("h2 a");
                 if (!a || !a.href) return;
                 const snippet = el.querySelector(".b_caption p")?.textContent || "";
                 items.push({ title: a.textContent, link: a.href, snippet });
               });
               return items;
            });

            if (results.length === 0) {
              onProgress({ step: "log", message: `[SCRAPER] [Bing] No results on page ${pageNum}.`, count: leads.length });
              break;
            }

            const pageLeads = [];
            for (const res of results) {
              const lead = buildLeadFromResult(res, input, designation);
              if (lead) {
                lead.source = "Bing Search";
                leads.push(lead);
                pageLeads.push(lead);
              }
            }

            if (pageLeads.length > 0) {
              emitData(pageLeads, { source: "bing", page: pageNum });
            }

            await sleep(randInt(3000, 5000));

          } catch (err) {
             onProgress({ step: "log", message: `[SCRAPER] [Bing] Error: ${err.message}`, count: leads.length });
             break;
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    signal.onCancel = null;
  }
  return leads;
}

module.exports = { scrapeBing };
