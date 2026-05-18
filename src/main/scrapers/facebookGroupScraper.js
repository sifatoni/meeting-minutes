const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage } = require("./utils/stealthConfig");
const { sleep, randInt } = require("./utils/delay");
const { extractEmails, extractPhones } = require("./emailExtractor");

const MAX_SCROLLS = 3;

async function scrapeFacebookGroups(input, onProgress, signal, onData) {
  const emitData = typeof onData === "function" ? onData : () => {};
  
  onProgress({
    step: "log",
    message: `[SCRAPER] [Facebook Groups] Starting search...`,
    count: 0
  });

  const designations = input.designations?.length ? input.designations.slice(0, 2) : ["CEO"];
  let browser;

  try {
    browser = await puppeteer.launch(getBrowserConfig({ debug: false }));
  } catch (err) {
    throw new Error(`[Method 5] Failed to launch browser: ${err.message}`);
  }

  signal.onCancel = () => browser.close().catch(() => {});
  const leads = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    await setupPage(page);

    for (const designation of designations) {
      if (signal.cancelled) break;

      const query = `${input.industry || ""} ${input.area || ""} ${designation} phone OR contact`.trim();
      const url = `https://m.facebook.com/search/posts/?q=${encodeURIComponent(query)}`;

      onProgress({
         step: "log",
         message: `[SCRAPER] [Facebook Groups] Fetching posts for: ${query}`,
         count: leads.length
      });

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(randInt(2000, 3000));

        const isBlocked = await page.evaluate(() => {
           const text = document.body.innerText.toLowerCase();
           return !!document.querySelector('form[action*="login"]') || text.includes("log in to") || text.includes("sign up");
        });

        if (isBlocked) {
           onProgress({ step: "log", message: `[FB] Login wall detected — skipping`, count: leads.length });
           break; 
        }

        for (let i = 0; i < MAX_SCROLLS; i++) {
          if (signal.cancelled) break;

          const results = await page.evaluate(() => {
             const items = [];
             document.querySelectorAll('div[data-ft], article, div[role="article"]').forEach(el => {
                const text = el.innerText;
                if (text && text.length > 20) items.push(text);
             });
             return items;
          });

          const pageLeads = [];
          for (const text of results) {
            const emails = extractEmails(text);
            const phones = extractPhones(text);

            if (emails.length > 0 || phones.length > 0) {
               const lead = {
                  id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: "",
                  designation: designation,
                  organization: "",
                  industry: input.industry,
                  location: input.location,
                  area: input.area,
                  email: emails[0] || "",
                  phone: phones[0] || "",
                  profileUrl: "",
                  linkedinUrl: "",
                  source: "Facebook Groups",
                  createdAt: new Date().toISOString()
               };
               leads.push(lead);
               pageLeads.push(lead);
            }
          }

          if (pageLeads.length > 0) {
             emitData(pageLeads, { source: "facebook_groups", page: i+1 });
          }

          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(randInt(4000, 7000));
        }

      } catch (err) {
         onProgress({ step: "log", message: `[SCRAPER] [Facebook Groups] Error: ${err.message}`, count: leads.length });
      }
    }
  } finally {
    await browser.close().catch(() => {});
    signal.onCancel = null;
  }

  return leads;
}

module.exports = { scrapeFacebookGroups };
