const https = require("https");
const { extractEmails, extractPhones } = require("./emailExtractor");
const { sleep, randInt } = require("./utils/delay");

async function scrapeYellowPages(input, onProgress, signal, onData) {
  const emitData = typeof onData === "function" ? onData : () => {};
  
  onProgress({
    step: "log",
    message: `[SCRAPER] [Yellow Pages] Starting search...`,
    count: 0
  });

  const leads = [];
  const industry = encodeURIComponent(input.industry || "");
  const location = encodeURIComponent(input.area || input.location || "");

  for (let page = 1; page <= 10; page++) {
    if (signal.cancelled) break;
    
    const url = `https://www.yellowpages.com.bd/search?keyword=${industry}&location=${location}&page=${page}`;
    
    onProgress({
       step: "log",
       message: `[SCRAPER] [Yellow Pages] Fetching page ${page}...`,
       count: leads.length
    });

    try {
      const html = await new Promise((resolve, reject) => {
        https.get(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html"
          }
        }, (res) => {
          if (res.statusCode !== 200) {
            resolve("");
            return;
          }
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });

      if (!html) break;

      const itemRegex = /<div[^>]*class="[^"]*(?:col-sm-8|details)[^"]*"[^>]*>([\s\S]*?)<\/div/gi;
      let match;
      const blocks = [];
      while ((match = itemRegex.exec(html)) !== null) {
          blocks.push(match[1]);
      }
      
      const chunks = blocks.length > 0 ? blocks : html.split(/<hr[^>]*>/i);
      
      const pageLeads = [];
      for (const chunk of chunks) {
         const text = chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
         if (!text) continue;
         
         const emails = extractEmails(text);
         const phones = extractPhones(text);
         
         const nameMatch = chunk.match(/<h[2-4][^>]*>(?:<a[^>]*>)?(.*?)(?:<\/a>)?<\/h[2-4]>/i) || 
                           chunk.match(/class="[^"]*title[^"]*"[^>]*>(?:<a[^>]*>)?(.*?)(?:<\/a>)?</i);
         let orgName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, "").trim() : "Unknown Business";
         
         if (emails.length > 0 || phones.length > 0) {
             const lead = {
                id: `yp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: "",
                designation: "",
                organization: orgName,
                industry: input.industry,
                location: input.location,
                area: input.area,
                email: emails[0] || "",
                phone: phones[0] || "",
                profileUrl: "",
                linkedinUrl: "",
                source: "Yellow Pages BD",
                createdAt: new Date().toISOString()
             };
             leads.push(lead);
             pageLeads.push(lead);
         }
      }
      
      if (pageLeads.length > 0) {
         emitData(pageLeads, { source: "yellowpages", page });
      }

      await sleep(randInt(1000, 2000));
      
      if (chunks.length < 2 && page > 1) break;

    } catch (err) {
       onProgress({ step: "log", message: `[SCRAPER] [Yellow Pages] Error: ${err.message}`, count: leads.length });
       break;
    }
  }

  return leads;
}

module.exports = { scrapeYellowPages };
