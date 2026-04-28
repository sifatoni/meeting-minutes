const extractGoogleResults = async (page) => {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.g')).map(el => {
      const title = el.querySelector('h3')?.innerText || '';
      const link = el.querySelector('a')?.href || '';
      const snippet = el.querySelector('.VwiC3b')?.innerText || '';
      return { title, link, snippet };
    });
  });
};

const parseData = (data) => {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/;
  const phoneRegex = /(\+880|01)[0-9]{9}/;

  return data.map(item => {
    // Basic heuristics to split name and company from title
    let name = item.title;
    let company = '';
    
    if (item.title.includes('-')) {
        const parts = item.title.split('-');
        name = parts[0].trim();
        company = parts.slice(1).join('-').trim();
    } else if (item.title.includes('|')) {
        const parts = item.title.split('|');
        name = parts[0].trim();
        company = parts.slice(1).join('|').trim();
    }

    const emailMatch = item.snippet.match(emailRegex);
    const phoneMatch = item.snippet.match(phoneRegex) || item.title.match(phoneRegex);

    return {
      name: name || '',
      linkedin_url: item.link.includes('linkedin.com') ? item.link : '',
      company: company || '',
      email: emailMatch ? emailMatch[0] : '',
      phone: phoneMatch ? phoneMatch[0] : '',
      source: "google_scraper"
    };
  });
};

module.exports = {
  extractGoogleResults,
  parseData
};
