const { getBrowser } = require('../utils/stealthConfig');
const { randomDelay } = require('../utils/delay');
const { extractGoogleResults, parseData } = require('../utils/extractors');

const scrapeGoogle = async (query, maxPages = 30, proxy = null) => {
  console.log(`[Scraper] Starting scraper for query: "${query}"`);
  
  const browser = await getBrowser(proxy);
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'accept-language': 'en-US,en;q=0.9'
  });

  const allLeads = [];
  
  for (let i = 0; i < maxPages; i++) {
    const start = i * 10;
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${start}`;
    
    let blocked = true;
    let retries = 0;

    while (blocked && retries < 3) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const pageContent = await page.content();
        if (pageContent.includes("unusual traffic") || pageContent.includes("recaptcha") || pageContent.includes('id="captcha"')) {
          console.log(`[Scraper] Block detected on page ${i + 1}. Waiting 10 seconds...`);
          await new Promise(res => setTimeout(res, 10000));
          retries++;
          continue; 
        }

        blocked = false; 
      } catch (err) {
        console.error(`[Scraper] Error navigating to page ${i + 1}: ${err.message}`);
        retries++;
        await new Promise(res => setTimeout(res, 5000));
      }
    }

    if (blocked) {
      console.log(`[Scraper] Failed to bypass block after retries on page ${i + 1}. Stopping scraper.`);
      break; 
    }

    try {
      await page.waitForSelector('div.g', { timeout: 10000 });
    } catch (err) {
      console.log(`[Scraper] No search results found on page ${i + 1} or timeout.`);
      break; 
    }

    // Human-like behavior
    await randomDelay(2000, 5000);
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(Math.random() * 500));
    });
    
    await randomDelay(1000, 3000);

    const rawData = await extractGoogleResults(page);
    const parsedData = parseData(rawData);
    
    // Filter out completely empty leads
    const validLeads = parsedData.filter(lead => lead.name || lead.email || lead.phone);
    
    allLeads.push(...validLeads);
    
    console.log(`[Scraper] Page ${i + 1} -> ${validLeads.length} results`);
    
    await randomDelay(3000, 6000);
  }

  console.log(`[Scraper] Total leads: ${allLeads.length}`);

  await browser.close();
  return allLeads;
};

module.exports = { scrapeGoogle };

// Self-test execution block
if (require.main === module) {
  const query = process.argv[2] || 'site:linkedin.com/in "software engineer" "gmail.com"';
  scrapeGoogle(query, 3).then(leads => {
    console.log(JSON.stringify(leads, null, 2));
  }).catch(err => {
    console.error('[Scraper] Critical error:', err);
  });
}
