/**
 * Data-extraction helpers: query building, DOM scraping, title parsing, lead construction.
 */

const { extractEmails, extractPhones } = require("../emailExtractor");

// ─── Query Mode Constants ─────────────────────────────────────────────────────

const QUERY_MODE = { SAFE: "safe", AGGRESSIVE: "aggressive" };

const EMAIL_DOMAINS = [
  "@gmail.com", "@yahoo.com", "@hotmail.com",
  "@outlook.com", "@icloud.com", "@protonmail.com"
];

// Common synonyms for query rotation (reduces fingerprinting)
const DESIGNATION_SYNONYMS = {
  "ceo": ["CEO", "Chief Executive Officer", "Managing Director"],
  "cto": ["CTO", "Chief Technology Officer", "VP Engineering"],
  "cfo": ["CFO", "Chief Financial Officer", "Finance Director"],
  "cmo": ["CMO", "Chief Marketing Officer", "Marketing Director"],
  "director": ["Director", "Head", "VP"],
  "manager": ["Manager", "Lead", "Senior Manager"],
  "founder": ["Founder", "Co-Founder", "Owner"],
  "marketing head": ["Marketing Head", "Head of Marketing", "Marketing Director"]
};

// ─── Dual-Mode Query Builder ──────────────────────────────────────────────────

/**
 * Build search queries in SAFE or AGGRESSIVE mode.
 *
 * SAFE (default):
 *   - site:linkedin.com/in only
 *   - No email domain operators
 *   - Generates 4–6 query variations
 *
 * AGGRESSIVE:
 *   - Adds "@gmail.com" OR "@yahoo.com" etc. for direct email harvesting
 *   - Higher yield but triggers CAPTCHA faster
 *   - Generates 6–10 query variations
 *
 * @param {string} designation  — Target role (e.g. "CEO")
 * @param {string} area         — City/region (e.g. "Dhaka")
 * @param {string} industry     — Industry (e.g. "FMCG")
 * @param {string} country      — Country (e.g. "Bangladesh")
 * @param {string} mode         — "safe" or "aggressive"
 * @returns {string[]} Array of search query strings
 */
function buildQueries(designation, area, industry, country, mode = QUERY_MODE.SAFE) {
  const queries = [];
  const isAggressive = mode === QUERY_MODE.AGGRESSIVE;

  // Get synonym variations for designation rotation
  const designationVariants = getDesignationVariants(designation);

  // ── SAFE QUERIES (always generated) ─────────────────────────────────────

  // Variation 1: Full LinkedIn site-search with area
  if (area) {
    const p = ["site:linkedin.com/in"];
    if (designation) p.push(`"${designation}"`);
    if (industry) p.push(`"${industry}"`);
    p.push(`"${area}"`);
    if (country) p.push(`"${country}"`);
    queries.push(p.join(" "));
  }

  // Variation 2: LinkedIn site-search country-wide
  {
    const p = ["site:linkedin.com/in"];
    if (designation) p.push(`"${designation}"`);
    if (industry) p.push(`"${industry}"`);
    if (country) p.push(`"${country}"`);
    queries.push(p.join(" "));
  }

  // Variation 3: Natural language with "linkedin" keyword
  {
    const p = [];
    if (designation) p.push(`"${designation}"`);
    if (industry) p.push(`"${industry}"`);
    if (area) p.push(`"${area}"`);
    else if (country) p.push(`"${country}"`);
    p.push("linkedin");
    queries.push(p.join(" "));
  }

  // Variation 4: Contact-oriented search
  {
    const p = [];
    if (designation) p.push(`"${designation}"`);
    if (industry) p.push(`"${industry}"`);
    if (country) p.push(`"${country}"`);
    p.push("email contact");
    queries.push(p.join(" "));
  }

  // Variation 5: OR-grouped designation synonyms (query rotation)
  if (designationVariants.length > 1) {
    const orGroup = designationVariants.map(d => `"${d}"`).join(" OR ");
    const p = [`site:linkedin.com/in (${orGroup})`];
    if (industry) p.push(`"${industry}"`);
    if (country) p.push(`"${country}"`);
    queries.push(p.join(" "));
  }

  // ── AGGRESSIVE QUERIES (only in aggressive mode) ────────────────────────

  if (isAggressive) {
    const emailOr = EMAIL_DOMAINS.slice(0, 3).map(d => `"${d}"`).join(" OR ");

    // Variation A1: LinkedIn + email domains
    {
      const p = ["site:linkedin.com/in"];
      if (designation) p.push(`"${designation}"`);
      if (industry) p.push(`"${industry}"`);
      if (country) p.push(`"${country}"`);
      p.push(emailOr);
      queries.push(p.join(" "));
    }

    // Variation A2: Open web email harvest (no site: restriction)
    {
      const p = [];
      if (designation) p.push(`"${designation}"`);
      if (industry) p.push(`"${industry}"`);
      if (country) p.push(`"${country}"`);
      p.push(emailOr);
      p.push("contact");
      queries.push(p.join(" "));
    }

    // Variation A3: With area + email domains
    if (area) {
      const p = [];
      if (designation) p.push(`"${designation}"`);
      if (industry) p.push(`"${industry}"`);
      p.push(`"${area}"`);
      p.push(emailOr);
      queries.push(p.join(" "));
    }

    // Variation A4: OR-grouped designations + email domains
    if (designationVariants.length > 1) {
      const orGroup = designationVariants.map(d => `"${d}"`).join(" OR ");
      const p = [`(${orGroup})`];
      if (industry) p.push(`"${industry}"`);
      if (country) p.push(`"${country}"`);
      p.push(emailOr);
      queries.push(p.join(" "));
    }
  }

  // Deduplicate
  const seen = new Set();
  return queries.filter(q => {
    const norm = q.toLowerCase().trim();
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
}

/**
 * Get synonym variants for a designation to enable query rotation.
 */
function getDesignationVariants(designation) {
  if (!designation) return [];
  const key = designation.toLowerCase().trim();
  const synonyms = DESIGNATION_SYNONYMS[key];
  if (synonyms) return synonyms;
  return [designation]; // No synonyms found, return as-is
}

/**
 * Returns mode-specific scraping configuration.
 * SAFE:       up to 15 pages/query, 2–5s delay
 * AGGRESSIVE: up to 4 pages/query, 5–10s delay (higher CAPTCHA risk)
 */
function getQueryConfig(mode = QUERY_MODE.SAFE) {
  if (mode === QUERY_MODE.AGGRESSIVE) {
    return {
      maxPagesPerQuery: 4,
      minDelay: 5000,
      maxDelay: 10000,
      mode: QUERY_MODE.AGGRESSIVE
    };
  }
  return {
    maxPagesPerQuery: 15,
    minDelay: 2000,
    maxDelay: 5000,
    mode: QUERY_MODE.SAFE
  };
}

function parseLinkedInTitle(title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();

  const mA = clean.match(
    /^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})\s*[-–|]\s*([^|<>@\n\r]{2,60}?)\s*[-–|]\s*([^|<>@\n\r]{2,60}?)\s*\|?\s*LinkedIn/i
  );
  if (mA) return { name: mA[1].trim(), designation: mA[2].trim(), organization: mA[3].trim() };

  const mB = clean.match(
    /^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})\s*[-–|]\s*([^|<>@\n\r]{2,60}?)\s*\|?\s*LinkedIn/i
  );
  if (mB) return { name: mB[1].trim(), designation: mB[2].trim(), organization: "" };

  const mC2 = clean.match(
    /^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})\s*[-–|]\s*(.+?)\s+at\s+(.+?)(?:\s*[-–|]\s*LinkedIn)?$/i
  );
  if (mC2) return { name: mC2[1].trim(), designation: mC2[2].trim(), organization: mC2[3].trim() };

  const mC = clean.match(/^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})\s*[-–]/i);
  if (mC) return { name: mC[1].trim(), designation: "", organization: "" };

  const mE = clean.match(/^([A-Z][a-z'.]+(?:\s+[A-Z][a-z'.]+){1,3})/);
  if (mE && clean.toLowerCase().includes("linkedin")) {
    return { name: mE[1].trim(), designation: "", organization: "" };
  }

  return null;
}

async function extractResultsFromPage(page) {
  return page.evaluate(() => {
    const items = [];
    const seen = new Set();

    function getSnippet(container) {
      // Extensive list of selectors for Google snippets across various layouts
      const sels = [
        ".VwiC3b", ".lEBKkf", ".IsZvec", ".yXK7lf", ".s3v9rd", 
        "[data-sncf='1']", ".r025kc", ".hgKElc", ".MU70pf", ".Uo8X3b"
      ];
      for (const s of sels) {
        const el = container.querySelector(s);
        if (el && el.textContent.trim().length > 10) return el.textContent;
      }
      // Fallback: look for any div/span that has a decent amount of text
      const fallback = Array.from(container.querySelectorAll('div, span'))
        .find(el => el.textContent.trim().length > 30);
      return fallback ? fallback.textContent : (container.textContent || "").slice(0, 600);
    }

    // High priority: Specific LinkedIn result structures
    const containers = document.querySelectorAll('div.g, .tF2Cxc, .MjjYGa, .sr__card');
    
    containers.forEach(container => {
      const link = container.querySelector('a[href*="linkedin.com/in/"]');
      if (!link) return;

      const href = (link.href || "").split("?")[0].split("#")[0];
      if (seen.has(href)) return;

      const h3 = container.querySelector("h3");
      if (!h3) return;

      seen.add(href);
      items.push({ 
        title: h3.textContent || "", 
        url: href, 
        snippet: getSnippet(container) 
      });
    });

    // Fallback: any link to linkedin.com/in/ that wasn't caught by containers
    if (items.length < 5) {
      document.querySelectorAll('a[href*="linkedin.com/in/"]').forEach(link => {
        const href = (link.href || "").split("?")[0].split("#")[0];
        if (seen.has(href)) return;

        const h3 = link.querySelector("h3") || link.parentElement?.querySelector("h3") || link.closest('div')?.querySelector('h3');
        if (!h3) return;

        const container = link.closest('div.g') || link.parentElement?.parentElement?.parentElement;
        
        seen.add(href);
        items.push({ 
          title: h3.textContent || "", 
          url: href, 
          snippet: container ? getSnippet(container) : "" 
        });
      });
    }

    return items;
  });
}

function buildLeadFromResult(result, input, fallbackDesignation) {
  const parsed = parseLinkedInTitle(result.title);
  if (!parsed) return null;

  const text = `${result.snippet} ${result.title}`;
  const emails = extractEmails(text);
  const phones = extractPhones(text);

  return {
    id: `gs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: parsed.name,
    designation: parsed.designation || fallbackDesignation || "",
    organization: parsed.organization || "",
    industry: input.industry || "",
    location: input.location || "",
    area: input.area || "",
    email: emails[0] || "",
    phone: phones[0] || "",
    linkedinUrl: result.url,
    source: "Google/LinkedIn",
    createdAt: new Date().toISOString()
  };
}

module.exports = { QUERY_MODE, buildQueries, getQueryConfig, getDesignationVariants, parseLinkedInTitle, extractResultsFromPage, buildLeadFromResult };
