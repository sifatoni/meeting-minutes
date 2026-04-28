/**
 * Method 2 — Google Maps → website email/phone scraper (Production-grade).
 *
 * Features: stealth config, fallback pages (/contact, /about, /contact-us),
 * proper delays, try/catch per business, structured logging.
 */

const puppeteer = require("./puppeteerSetup");
const { getBrowserConfig, setupPage } = require("./utils/stealthConfig");
const { sleep, randInt, randomScroll, simulateMouseMovement } = require("./utils/delay");
const { extractEmails, extractPhones } = require("./emailExtractor");

const DEBUG = false;

async function scrapeGoogleMaps(input, onProgress, signal, onData) {
  const emitData = typeof onData === "function" ? onData : () => {};
  const query = [input.industry, input.area || "", input.location || ""].filter(Boolean).join(" ");

  let browser;
  try {
    browser = await puppeteer.launch(getBrowserConfig({ debug: DEBUG }));
  } catch (err) {
    throw new Error(`[Method 2] Failed to launch browser: ${err.message}`);
  }

  signal.onCancel = () => browser.close().catch(() => {});
  const leads = [];

  try {
    const page = await browser.newPage();
    await setupPage(page);

    onProgress({ step: "maps-nav", message: `[SCRAPER] Searching Google Maps for "${query}"…`, count: 0 });

    try {
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      try {
        await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      } catch (err) {
        onProgress({ step: "log", message: `[RETRY] Maps navigation failed: ${err.message}`, count: 0 });
      }
    }

    await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});

    // Scroll feed to load more results
    for (let i = 0; i < 10; i++) {
      if (signal.cancelled) break;
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollBy(0, 600);
      });
      await sleep(randInt(1200, 2000));
    }

    const businessLinks = await page.evaluate(() => {
      const seen = new Set();
      const items = [];
      document.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        const nameEl = a.querySelector('[class*="qBF1Pd"], [class*="NrDZNb"], h3');
        const name = (nameEl?.textContent || a.getAttribute("aria-label") || a.textContent || "").trim().split("\n")[0].trim();
        if (name && name.length > 1) {
          seen.add(href);
          items.push({ mapsUrl: href, name });
        }
      });
      return items.slice(0, 25);
    });

    onProgress({ step: "maps-found", message: `[SUCCESS] Found ${businessLinks.length} businesses`, count: 0 });

    for (let i = 0; i < businessLinks.length; i++) {
      if (signal.cancelled) break;
      const biz = businessLinks[i];

      onProgress({ step: "maps-detail", message: `[SCRAPER] Checking ${biz.name} (${i + 1}/${businessLinks.length})`, count: leads.length });

      try {
        await page.goto(biz.mapsUrl, { waitUntil: "networkidle2", timeout: 20000 });
        await sleep(randInt(1500, 3000));
        await simulateMouseMovement(page);

        const details = await page.evaluate(() => {
          const phoneLink = document.querySelector('a[href^="tel:"]');
          const phone = phoneLink ? phoneLink.href.replace("tel:", "").trim() : (document.querySelector('[data-item-id^="phone:"]')?.textContent || "").trim();
          const websiteLink = document.querySelector('a[data-item-id="authority"]') || document.querySelector('a[aria-label*="website" i]');
          return { phone, website: websiteLink?.href || "" };
        });

        let emails = [];
        const phones = details.phone ? [details.phone] : [];

        // Visit website + fallback pages for email extraction
        if (details.website && !details.website.includes("google.com")) {
          let sitePage;
          try {
            sitePage = await browser.newPage();
            await setupPage(sitePage);

            // Homepage
            await sitePage.goto(details.website, { waitUntil: "domcontentloaded", timeout: 15000 });
            emails.push(...extractEmails(await sitePage.content()));
            await sleep(randInt(800, 1500));

            const base = new URL(details.website).origin;
            const fallbackPaths = ["/contact", "/contact-us", "/about", "/about-us"];

            for (const p of fallbackPaths) {
              try {
                await sitePage.goto(base + p, { waitUntil: "domcontentloaded", timeout: 8000 });
                emails.push(...extractEmails(await sitePage.content()));
                await sleep(randInt(500, 1000));
              } catch (_) {}
            }
          } catch (err) {
            onProgress({ step: "log", message: `[SKIPPED] Broken URL: ${details.website} — ${err.message}`, count: leads.length });
          } finally {
            await sitePage?.close().catch(() => {});
          }
        }

        emails = [...new Set(emails)].filter(e =>
          !e.includes("example") && !e.includes("sentry") && !e.includes("noreply") && !e.includes("wixpress")
        );

        if (emails.length || phones.length) {
          const designations = input.designations?.length ? input.designations : ["CEO"];
          leads.push({
            id: `maps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: "",
            designation: designations[0] || "CEO",
            organization: biz.name,
            industry: input.industry || "",
            location: input.location || "",
            area: input.area || "",
            email: emails[0] || "",
            phone: phones[0] || "",
            linkedinUrl: "",
            source: "Google Maps",
            createdAt: new Date().toISOString()
          });
          onProgress({ step: "log", message: `[SUCCESS] ${biz.name} → email:${emails.length > 0 ? "✓" : "✗"} phone:${phones.length > 0 ? "✓" : "✗"}`, count: leads.length });

          // Stream lead out immediately
          emitData([leads[leads.length - 1]], { source: "Google Maps", business: biz.name });
        }
      } catch (err) {
        onProgress({ step: "log", message: `[SKIPPED] Error checking ${biz.name}: ${err.message}`, count: leads.length });
      }

      // Rate limiting between businesses
      await sleep(randInt(2000, 4000));
    }
  } finally {
    await browser.close().catch(() => {});
    signal.onCancel = null;
  }

  onProgress({ step: "log", message: `[SCRAPER] Method 2 complete — ${leads.length} business leads`, count: leads.length });
  return leads;
}

module.exports = { scrapeGoogleMaps };
