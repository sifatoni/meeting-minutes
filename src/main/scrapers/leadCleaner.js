/**
 * Lead cleaning and scoring pipeline.
 * Uses the professional scoring engine for consistent 0–100 scoring.
 *
 * STRICT RULE: Leads without email OR phone are removed.
 */

const { scoreLead, deduplicateLeads } = require("./scoringEngine");

/**
 * Score, filter, deduplicate, and sort leads.
 * @param {Array} leads - Raw leads from scrapers
 * @param {string[]} inputKeywords - Search keywords for context
 * @returns {Array} Cleaned, scored, deduplicated leads sorted by score
 */
function scoreAndClean(leads, inputKeywords = []) {
  // Extract designation keywords from input for scoring
  const designationKeywords = inputKeywords.filter(kw =>
    kw && kw.length > 1 && !/^\d+$/.test(kw)
  );

  // Score all leads
  const scored = leads.map(lead => scoreLead(lead, designationKeywords));

  // Keep leads that have at least ONE contact channel (email, phone, OR LinkedIn URL)
  const withContact = scored.filter(l => l.email || l.phone || (l.linkedinUrl && l.linkedinUrl.includes("linkedin.com")));

  // Deduplicate by email / phone / LinkedIn
  const deduped = deduplicateLeads(withContact);

  // Sort by score descending (highest value leads first)
  return deduped.sort((a, b) => b.contactScore - a.contactScore);
}

module.exports = { scoreAndClean, scoreLead };
