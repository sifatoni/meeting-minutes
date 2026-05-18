const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage } = require("./utils/stealthConfig");
const { sleep, randInt } = require("./utils/delay");
const { extractEmails, extractPhones } = require("./emailExtractor");

const MAX_PROFILES = 50;

async function enrichLinkedInProfiles(urls, onProgress, signal) {
  if (!urls || !urls.length) return [];
  
  onProgress({
    step: "log",
    message: `[SCRAPER] [LinkedIn Profile] Starting enrichment for ${Math.min(urls.length, MAX_PROFILES)} profiles...`,
    count: 0
  });

  const profilesToScrape = urls.slice(0, MAX_PROFILES);
  const enrichedData = [];
  let browser;

  try {
    browser = await puppeteer.launch(getBrowserConfig({ debug: false }));
  } catch (err) {
    throw new Error(`[Method 6] Failed to launch browser: ${err.message}`);
  }

  signal.onCancel = () => browser.close().catch(() => {});

  try {
    const page = await browser.newPage();
    await setupPage(page);

    for (let i = 0; i < profilesToScrape.length; i++) {
      if (signal.cancelled) break;
      const url = profilesToScrape[i];

      onProgress({
         step: "log",
         message: `[SCRAPER] [LinkedIn Profile] (${i+1}/${profilesToScrape.length}) Visiting: ${url}`,
         count: enrichedData.length
      });

      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (response && response.status() === 429) {
           onProgress({ step: "log", message: `[SCRAPER] [LinkedIn Profile] Rate limited (429). Stopping.`, count: enrichedData.length });
           break;
        }

        await sleep(randInt(2000, 3000));

        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
        const pageUrl = page.url();

        if (pageUrl.includes("authwall") || pageText.includes("join to see") || pageText.includes("unusual activity")) {
           onProgress({ step: "log", message: `[SCRAPER] [LinkedIn Profile] Authwall or login required. Skipping.`, count: enrichedData.length });
           await sleep(randInt(5000, 8000));
           continue;
        }

        try {
           const contactBtn = await page.$('a[href$="/overlay/contact-info/"], button:has-text("Contact info")');
           if (contactBtn) {
              await contactBtn.click();
              await sleep(randInt(1500, 2500));
           }
        } catch(e) {}

        const profile = await page.evaluate(() => {
           const name = document.querySelector('h1.text-heading-xlarge, h1[class*="heading"]')?.textContent?.trim() || "";
           const designation = document.querySelector('div.text-body-medium, [class*="headline"]')?.textContent?.trim() || "";
           const location = document.querySelector('span[class*="location"]')?.textContent?.trim() || "";
           const about = document.querySelector('div[class*="summary"], section[data-section="summary"]')?.textContent?.trim() || "";
           const bodyText = document.body.innerText || "";
           return { name, designation, location, about, bodyText };
        });

        const emails = extractEmails(profile.bodyText);
        const phones = extractPhones(profile.bodyText);

        enrichedData.push({
           url: url,
           name: profile.name,
           designation: profile.designation,
           location: profile.location,
           about: profile.about,
           email: emails[0] || "",
           phone: phones[0] || ""
        });

        await sleep(randInt(5000, 8000));

      } catch (err) {
         onProgress({ step: "log", message: `[SCRAPER] [LinkedIn Profile] Error on ${url}: ${err.message}`, count: enrichedData.length });
      }
    }
  } finally {
    await browser.close().catch(() => {});
    signal.onCancel = null;
  }

  return enrichedData;
}

module.exports = { enrichLinkedInProfiles };
