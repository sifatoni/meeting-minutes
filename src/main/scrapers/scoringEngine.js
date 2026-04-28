/**
 * Professional Lead Scoring Engine (0–100)
 *
 * Scoring breakdown:
 *   +40 → email exists
 *   +30 → phone exists
 *   +15 → LinkedIn URL exists
 *   +10 → designation matches target keywords
 *   +5  → company name present
 *
 * Score labels:
 *   80–100 → HIGH
 *   50–79  → MEDIUM
 *   0–49   → LOW
 */

const PERSONAL_EMAIL_RE = /gmail\.com|yahoo\.com|outlook\.com|hotmail\.com|live\.com|protonmail\.com|ymail\.com|icloud\.com/i;

const DESIGNATION_KEYWORDS = [
  "ceo", "cto", "cfo", "coo", "cmo", "founder", "co-founder",
  "director", "head", "vp", "vice president", "president",
  "manager", "lead", "chief", "partner", "owner", "md",
  "managing director", "general manager", "marketing head"
];

/**
 * Score a single lead.
 * @param {object} lead - The lead object
 * @param {string[]} targetDesignations - User-specified target designations
 * @returns {object} Lead with contactScore, valueBand, emailType, scoreBreakdown
 */
function scoreLead(lead, targetDesignations = []) {
  const email = (lead.email || "").toLowerCase().trim();
  const phone = (lead.phone || "").trim();
  const linkedin = (lead.linkedinUrl || "").trim();
  const designation = (lead.designation || "").toLowerCase().trim();
  const organization = (lead.organization || "").trim();

  const breakdown = { email: 0, phone: 0, linkedin: 0, designation: 0, company: 0 };

  // Email: +40
  if (email) breakdown.email = 40;

  // Phone: +30
  if (phone) breakdown.phone = 30;

  // LinkedIn: +15
  if (linkedin && linkedin.includes("linkedin.com")) breakdown.linkedin = 15;

  // Designation match: +10
  if (designation) {
    const matchesTarget = targetDesignations.some(d =>
      designation.includes(d.toLowerCase()) || d.toLowerCase().includes(designation)
    );
    const matchesKnown = DESIGNATION_KEYWORDS.some(kw => designation.includes(kw));
    if (matchesTarget || matchesKnown) breakdown.designation = 10;
  }

  // Company name: +5
  if (organization && organization.length > 1) breakdown.company = 5;

  const total = breakdown.email + breakdown.phone + breakdown.linkedin + breakdown.designation + breakdown.company;
  const valueBand = total >= 80 ? "High" : total >= 50 ? "Medium" : "Low";
  const emailType = email ? (PERSONAL_EMAIL_RE.test(email) ? "Personal" : "Business") : "";

  return {
    ...lead,
    email,
    phone,
    contactScore: total,
    valueBand,
    emailType,
    scoreBreakdown: breakdown
  };
}

/**
 * Deduplicate leads by email (primary), phone, and LinkedIn URL.
 * Keeps the higher-scored version when duplicates are found.
 */
function deduplicateLeads(leads) {
  const seen = new Set();
  const deduped = [];

  for (const lead of leads) {
    const keys = [
      lead.email ? `email:${lead.email}` : null,
      lead.phone ? `phone:${lead.phone}` : null,
      lead.linkedinUrl ? `li:${lead.linkedinUrl.toLowerCase().split("?")[0]}` : null
    ].filter(Boolean);

    const isDup = keys.some(k => seen.has(k));
    if (!isDup) {
      keys.forEach(k => seen.add(k));
      deduped.push(lead);
    }
  }

  return deduped;
}

module.exports = { scoreLead, deduplicateLeads, DESIGNATION_KEYWORDS };
