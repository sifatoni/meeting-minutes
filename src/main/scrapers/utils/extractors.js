/**
 * Data-extraction helpers: query building, DOM scraping, title parsing, lead construction.
 * Supports multi-platform: LinkedIn → Instagram → Facebook with aggressive email targeting.
 */

const { extractEmails, extractPhones } = require("../emailExtractor");

// ─── Constants ────────────────────────────────────────────────────────────────

const QUERY_MODE = { SAFE: "safe", AGGRESSIVE: "aggressive" };

const EMAIL_DOMAINS = [
  "@gmail.com", "@yahoo.com", "@hotmail.com",
  "@outlook.com", "@icloud.com"
];

// Mandatory email OR clause for aggressive targeting
const EMAIL_OR_CLAUSE = `(${EMAIL_DOMAINS.map(d => `"${d}"`).join(" OR ")})`;

const PLATFORM_FILTERS = {
  linkedin:  "linkedin.com/in",
  instagram: "instagram.com",
  facebook:  "facebook.com"
};

const DESIGNATION_SYNONYMS = {
  "ceo":            ["CEO", "Chief Executive Officer", "Managing Director"],
  "cto":            ["CTO", "Chief Technology Officer", "VP Engineering"],
  "cfo":            ["CFO", "Chief Financial Officer", "Finance Director"],
  "cmo":            ["CMO", "Chief Marketing Officer", "Marketing Director"],
  "director":       ["Director", "Head", "VP"],
  "manager":        ["Manager", "Lead", "Senior Manager"],
  "founder":        ["Founder", "Co-Founder", "Owner"],
  "marketing head": ["Marketing Head", "Head of Marketing", "Marketing Director"]
};

// ─── Platform Query Builder ───────────────────────────────────────────────────

/**
 * Build queries for a single platform (site filter).
 * SAFE:       site filter + keywords, no email operators
 * AGGRESSIVE: + mandatory email OR clause for direct email harvesting
 */
function buildPlatformQueries(siteFilter, designation, area, industry, country, mode) {
  const queries = [];
  const isAggressive = mode === QUERY_MODE.AGGRESSIVE;
  const variants = getDesignationVariants(designation);

  // Query 1: clean — no email filter. Runs first so we always get baseline results.
  if (area) {
    const p = [`site:${siteFilter}`];
    if (designation) p.push(`"${designation}"`);
    if (industry)    p.push(`"${industry}"`);
    p.push(`"${area}"`);
    if (country)     p.push(`"${country}"`);
    queries.push(p.join(" "));
  }

  // Query 2: clean — country-wide, no email filter.
  {
    const p = [`site:${siteFilter}`];
    if (designation) p.push(`"${designation}"`);
    if (industry)    p.push(`"${industry}"`);
    if (country)     p.push(`"${country}"`);
    queries.push(p.join(" "));
  }

  // Query 3: OR-grouped synonyms + email filter only in aggressive mode.
  // Placed last so clean queries always execute first.
  if (variants.length > 1) {
    const orGroup = variants.map(d => `"${d}"`).join(" OR ");
    const p = [`site:${siteFilter} (${orGroup})`];
    if (industry) p.push(`"${industry}"`);
    if (country)  p.push(`"${country}"`);
    if (isAggressive) p.push(EMAIL_OR_CLAUSE);
    queries.push(p.join(" "));
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
 * Build grouped queries for all platforms.
 *
 * @returns {{ linkedin: string[], instagram: string[], facebook: string[] }}
 */
function buildQueries(designation, area, industry, country, mode = QUERY_MODE.SAFE) {
  const grouped = {};
  for (const [platform, siteFilter] of Object.entries(PLATFORM_FILTERS)) {
    grouped[platform] = buildPlatformQueries(siteFilter, designation, area, industry, country, mode);
  }
  return grouped;
}

/**
 * Get synonym variants for a designation to enable query rotation.
 */
function getDesignationVariants(designation) {
  if (!designation) return [];
  const key = designation.toLowerCase().trim();
  return DESIGNATION_SYNONYMS[key] || [designation];
}

/**
 * Returns mode-specific scraping configuration.
 * SAFE:       up to 15 pages/query, 2–5s delay
 * AGGRESSIVE: up to 4 pages/query, 5–10s delay
 */
function getQueryConfig(mode = QUERY_MODE.SAFE) {
  if (mode === QUERY_MODE.AGGRESSIVE) {
    return { maxPagesPerQuery: 4,  minDelay: 5000,  maxDelay: 10000, mode: QUERY_MODE.AGGRESSIVE };
  }
  return   { maxPagesPerQuery: 15, minDelay: 2000,  maxDelay: 5000,  mode: QUERY_MODE.SAFE };
}

// ─── DOM Extraction ───────────────────────────────────────────────────────────

/**
 * Extract { title, link, snippet } from any Google SERP page.
 *
 * Three-strategy approach so a Google layout change can never produce 0 results:
 *
 *   S1. h3 inside anchor — layout-agnostic. Google ALWAYS renders result titles
 *       as <h3> elements inside a clickable <a>. Works across every known layout.
 *
 *   S2. Classic div.g / .tF2Cxc containers — keeps working if S1 misses any.
 *
 *   S3. Platform-URL link scan — last resort. Scans every <a href> on the page
 *       and keeps only links matching linkedin/instagram/facebook. Guarantees
 *       we never return 0 results from a page that has target-platform links.
 *
 * Debug metrics are returned to Node.js and logged via console.log (not inside
 * page.evaluate, so they appear in the Electron/Node terminal).
 */
async function extractResultsFromPage(page) {
  const { items, debug } = await page.evaluate(() => {
    const items = [];
    const seen  = new Set();

    // ── Debug counters (returned to Node.js, not logged here) ────────────
    const htmlLength = document.documentElement.innerHTML.length;
    const linksFound = document.querySelectorAll("a[href]").length;

    // ── Snippet extraction ─────────────────────────────────────────────────
    function getSnippet(el) {
      if (!el) return "";
      const SNIPPET_SELS = [
        ".VwiC3b", ".lEBKkf", ".IsZvec", ".yXK7lf", ".s3v9rd",
        "[data-sncf]", ".r025kc", ".hgKElc", ".MU70pf", ".Uo8X3b",
        ".ITZIwc", ".x54gtf", ".st"
      ];
      for (const s of SNIPPET_SELS) {
        const node = el.querySelector(s);
        if (node && node.textContent.trim().length > 20) return node.textContent.trim();
      }
      // Generic: deepest single-line-ish text block
      const candidates = Array.from(el.querySelectorAll("div, span"))
        .filter(n => n.children.length < 4 && n.textContent.trim().length > 40)
        .sort((a, b) => b.textContent.length - a.textContent.length);
      return candidates[0]
        ? candidates[0].textContent.trim().slice(0, 400)
        : (el.textContent || "").slice(0, 300).trim();
    }

    function addItem(rawHref, titleText, container) {
      const href = (rawHref || "").split("?")[0].split("#")[0];
      if (!href.startsWith("http") || seen.has(href)) return;
      // Skip Google-internal navigation links
      if (href.includes("google.com/search") ||
          href.includes("accounts.google.com") ||
          href.includes("google.com/intl")) return;
      seen.add(href);
      items.push({ title: (titleText || "").trim(), link: href, snippet: getSnippet(container) });
    }

    // ── Strategy 1: <a> → <h3> — primary, layout-agnostic ────────────────
    document.querySelectorAll("h3").forEach(h3 => {
      const anchor = h3.closest("a");
      if (!anchor || !anchor.href) return;
      const container =
        h3.closest("div.g, .tF2Cxc, .MjjYGa, [data-sokoban-container], [jscontroller]") ||
        anchor.closest("div.g, [jscontroller]") ||
        anchor.parentElement?.parentElement?.parentElement;
      addItem(anchor.href, h3.textContent, container);
    });

    // ── Strategy 2: classic div.g / .tF2Cxc containers ───────────────────
    document.querySelectorAll("div.g, .tF2Cxc, .MjjYGa").forEach(container => {
      const anchor = container.querySelector('a[href^="http"]');
      if (!anchor) return;
      const h3 = container.querySelector("h3");
      if (!h3) return;
      addItem(anchor.href, h3.textContent, container);
    });

    // ── Strategy 3: platform-URL fallback scan ────────────────────────────
    // Only runs if S1+S2 found fewer than 3 results.
    if (items.length < 3) {
      const TARGETS = ["linkedin.com/in/", "instagram.com/", "facebook.com/"];
      document.querySelectorAll("a[href]").forEach(anchor => {
        const href = anchor.href || "";
        if (!TARGETS.some(t => href.includes(t))) return;
        const h3 = anchor.querySelector("h3") ||
                   anchor.closest("[jscontroller]")?.querySelector("h3") ||
                   anchor.parentElement?.querySelector("h3");
        const title     = h3?.textContent || anchor.textContent || href;
        const container = anchor.closest("div.g, [jscontroller]") ||
                          anchor.parentElement?.parentElement;
        addItem(href, title, container);
      });
    }

    return { items, debug: { htmlLength, linksFound, resultsParsed: items.length } };
  });

  // Surface extraction diagnostics to Node.js terminal
  console.log("HTML LENGTH:", debug.htmlLength);
  console.log("LINKS FOUND:", debug.linksFound);
  console.log("RESULTS PARSED:", debug.resultsParsed);

  return items;
}

// ─── Title Parsers ────────────────────────────────────────────────────────────

/**
 * Parse a LinkedIn-style title: "Name - Designation - Company | LinkedIn"
 */
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

  const mC = clean.match(
    /^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})\s*[-–|]\s*(.+?)\s+at\s+(.+?)(?:\s*[-–|]\s*LinkedIn)?$/i
  );
  if (mC) return { name: mC[1].trim(), designation: mC[2].trim(), organization: mC[3].trim() };

  const mD = clean.match(/^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})\s*[-–]/i);
  if (mD) return { name: mD[1].trim(), designation: "", organization: "" };

  const mE = clean.match(/^([A-Z][a-z'.]+(?:\s+[A-Z][a-z'.]+){1,3})/);
  if (mE && clean.toLowerCase().includes("linkedin")) {
    return { name: mE[1].trim(), designation: "", organization: "" };
  }

  return null;
}

/**
 * Generic title parser for Instagram / Facebook / other results.
 * Attempts to extract a name from the beginning of the title string.
 */
function parseGenericTitle(title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  if (!clean) return { name: "Unknown", designation: "", organization: "" };

  // Capitalized name at start
  const mName = clean.match(/^([A-Z][a-z'.‑\-]+(?:\s+[A-Z][a-z'.‑\-]+){1,3})/);
  if (mName) {
    const rest = clean.slice(mName[1].length).replace(/^[\s\-–|]+/, "");
    const parts = rest.split(/[-–|]/);
    return {
      name:         mName[1].trim(),
      designation:  (parts[0] || "").trim(),
      organization: (parts[1] || "").trim()
    };
  }

  // Fallback: first segment before separator
  const parts = clean.split(/[-–|]/);
  return {
    name:         (parts[0] || clean).slice(0, 60).trim() || "Unknown",
    designation:  (parts[1] || "").trim(),
    organization: (parts[2] || "").trim()
  };
}

// ─── Platform Detection ───────────────────────────────────────────────────────

function detectPlatform(url) {
  if (!url) return "web";
  if (url.includes("linkedin.com"))  return "linkedin";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com"))  return "facebook";
  return "web";
}

// ─── Lead Builder ─────────────────────────────────────────────────────────────

/**
 * Build a lead object from a search result.
 * NEVER returns null — always returns a partial lead with whatever data is available.
 */
function buildLeadFromResult(result, input, fallbackDesignation) {
  const url      = result.link || result.url || "";
  const platform = detectPlatform(url);

  let parsed;
  if (platform === "linkedin") {
    parsed = parseLinkedInTitle(result.title) || parseGenericTitle(result.title);
  } else {
    parsed = parseGenericTitle(result.title);
  }

  const text   = `${result.snippet || ""} ${result.title || ""}`;
  const emails = extractEmails(text);
  const phones = extractPhones(text);

  const lead = {
    id:           `gs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name:         parsed.name         || "Unknown",
    designation:  parsed.designation  || fallbackDesignation || "",
    organization: parsed.organization || "",
    industry:     input.industry      || "",
    location:     input.location      || "",
    area:         input.area          || "",
    email:        emails[0]           || "",
    phone:        phones[0]           || "",
    profileUrl:   url,
    linkedinUrl:  platform === "linkedin" ? url : "",
    source:       platform,
    createdAt:    new Date().toISOString()
  };

  return lead;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  QUERY_MODE,
  PLATFORM_FILTERS,
  buildQueries,
  buildPlatformQueries,
  getQueryConfig,
  getDesignationVariants,
  parseLinkedInTitle,
  parseGenericTitle,
  detectPlatform,
  extractResultsFromPage,
  buildLeadFromResult
};
