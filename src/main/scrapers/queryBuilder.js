/**
 * Diversified LinkedIn query builder.
 *
 * Generates 5–8 structurally unique queries per search to avoid pattern
 * fingerprinting. Each query varies in keyword order, designation wording,
 * location placement, and optional email domain filter.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const EMAIL_DOMAINS = [
  "@gmail.com", "@yahoo.com", "@outlook.com",
  "@hotmail.com", "@icloud.com", "@aol.com"
];

// Maps canonical designation names → real-world synonym variants
const DESIGNATION_MAP = {
  ceo:              ["CEO", "Chief Executive Officer", "Managing Director", "MD"],
  cto:              ["CTO", "Chief Technology Officer", "VP Engineering", "Head of Technology"],
  cfo:              ["CFO", "Chief Financial Officer", "Finance Director", "Head of Finance"],
  cmo:              ["CMO", "Chief Marketing Officer", "Marketing Director", "Head of Marketing"],
  director:         ["Director", "Head", "VP", "Vice President"],
  manager:          ["Manager", "Lead", "Senior Manager", "Head"],
  founder:          ["Founder", "Co-Founder", "Owner", "Proprietor"],
  "marketing head": ["Marketing Head", "Head of Marketing", "Marketing Director", "CMO"],
  president:        ["President", "Managing Director", "CEO", "Executive Director"],
  coo:              ["COO", "Chief Operating Officer", "Operations Director", "Head of Operations"],
  "hr head":        ["HR Head", "Head of HR", "HR Director", "Chief People Officer"],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns all known synonym variants for a designation.
 * Falls back to the raw designation if unknown.
 */
function getVariants(designation) {
  if (!designation) return ["CEO"];
  const synonyms = DESIGNATION_MAP[designation.toLowerCase().trim()];
  return synonyms || [designation];
}

/**
 * Returns a random email domain as a quoted token, e.g. "@gmail.com"
 * or "" if randomness says to skip (unless `always` is true).
 */
function maybeEmail(always = false) {
  if (!always && Math.random() > 0.55) return "";
  return `"${pick(EMAIL_DOMAINS)}"`;
}

// ─── Main Builder ─────────────────────────────────────────────────────────────

/**
 * Build 5–8 diversified LinkedIn search queries for one designation.
 *
 * Templates deliberately vary:
 *   - Keyword ORDER  (designation-first vs industry-first vs location-first)
 *   - QUOTING style  (quoted vs bare)
 *   - LOCATION depth (area / country / both)
 *   - EMAIL filter   (none / gmail / yahoo / outlook / hotmail / aol)
 *   - SITE position  (front vs end of query)
 *   - SYNONYM        (CEO / Managing Director / Chief Executive Officer / MD)
 *
 * @param {string} designation — e.g. "CEO"
 * @param {string} area        — City/district, e.g. "Dhaka"
 * @param {string} industry    — e.g. "FMCG"
 * @param {string} country     — e.g. "Bangladesh"
 * @returns {string[]}         — 5–8 unique query strings
 */
function buildLinkedInQueries(designation, area, industry, country) {
  const variants = getVariants(designation);
  const v0 = variants[0];
  const v1 = variants[1] || variants[0];
  const v2 = variants[2] || variants[0];
  const v3 = variants[3] || variants[0];

  const seen = new Set();
  const candidates = [];

  function add(q) {
    const norm = q.trim().toLowerCase();
    if (!seen.has(norm) && q.trim()) {
      seen.add(norm);
      candidates.push(q.trim());
    }
  }

  // ── Template 1: Standard — designation → industry → area ─────────────────
  // Example: site:linkedin.com/in "CEO" "FMCG" "Dhaka"
  if (area) {
    add(`site:linkedin.com/in "${v0}" "${industry}" "${area}"`);
  }

  // ── Template 2: Industry first → country → synonym ───────────────────────
  // Example: site:linkedin.com/in "FMCG" "Bangladesh" "Managing Director"
  add(`site:linkedin.com/in "${industry}" "${country}" "${v1}"`);

  // ── Template 3: Standard + gmail filter ──────────────────────────────────
  // Example: site:linkedin.com/in "CEO" "FMCG" "Dhaka" "@gmail.com"
  if (area) {
    add(`site:linkedin.com/in "${v0}" "${industry}" "${area}" "@gmail.com"`);
  } else {
    add(`site:linkedin.com/in "${v0}" "${industry}" "${country}" "@gmail.com"`);
  }

  // ── Template 4: Bare terms (no quotes), yahoo filter ─────────────────────
  // Example: site:linkedin.com/in FMCG Bangladesh "MD" "@yahoo.com"
  add(`site:linkedin.com/in ${industry} ${country} "${v2}" "@yahoo.com"`);

  // ── Template 5: OR-grouped synonyms (query rotation) ─────────────────────
  // Example: site:linkedin.com/in ("CEO" OR "MD" OR "Managing Director") "FMCG" "Dhaka"
  if (variants.length > 1) {
    const orGroup = variants.slice(0, Math.min(3, variants.length))
      .map(v => `"${v}"`).join(" OR ");
    const loc = area ? `"${area}"` : `"${country}"`;
    add(`site:linkedin.com/in (${orGroup}) "${industry}" ${loc}`);
  }

  // ── Template 6: Area + country both, alternate variant + random email ─────
  // Example: site:linkedin.com/in "Chief Executive Officer" "Dhaka" "Bangladesh" "@outlook.com"
  if (area) {
    const email = maybeEmail(true);
    add(`site:linkedin.com/in "${v1}" "${area}" "${country}"${email ? " " + email : ""}`);
  }

  // ── Template 7: SITE FILTER AT END (structural variety) ──────────────────
  // Example: "CEO" "FMCG" "Dhaka" site:linkedin.com/in "@hotmail.com"
  {
    const email = maybeEmail();
    const loc = area ? `"${area}"` : `"${country}"`;
    add(`"${v0}" "${industry}" ${loc} site:linkedin.com/in${email ? " " + email : ""}`);
  }

  // ── Template 8: Rare email (outlook/hotmail/icloud/aol), country-wide ─────
  // Example: site:linkedin.com/in "Founder" "FMCG" "Bangladesh" "@icloud.com"
  {
    const rareEmail = `"${pick(EMAIL_DOMAINS.slice(2))}"`;
    add(`site:linkedin.com/in "${v3}" "${industry}" "${country}" ${rareEmail}`);
  }

  // ── Template 9: Location before industry ─────────────────────────────────
  // Example: site:linkedin.com/in "CEO" "Dhaka" "FMCG"
  if (area) {
    add(`site:linkedin.com/in "${v0}" "${area}" "${industry}"`);
  } else {
    add(`site:linkedin.com/in "${v1}" "${country}" "${industry}"`);
  }

  // ── Shuffle (keep Template 1 first as it's most reliable) ────────────────
  const [first, ...rest] = candidates;
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const ordered = first ? [first, ...rest] : rest;

  // Return 5–8 queries
  const targetCount = Math.floor(Math.random() * 4) + 5; // 5, 6, 7, or 8
  return ordered.slice(0, targetCount);
}

module.exports = { buildLinkedInQueries, getVariants, EMAIL_DOMAINS };
