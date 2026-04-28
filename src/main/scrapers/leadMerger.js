const { normalizePhone } = require("./emailExtractor");

function mergeLeads(method1Leads, method2Leads) {
  const all = [...method1Leads, ...method2Leads];

  // Maps: canonical key → index into result array
  const byEmail = new Map();
  const byPhone = new Map();
  const byLinkedin = new Map();
  const result = [];

  for (const lead of all) {
    const email = (lead.email || "").toLowerCase().trim();
    const phone = normalizePhone(lead.phone || "") || (lead.phone || "").trim();
    const linkedin = (lead.linkedinUrl || "").toLowerCase().split("?")[0];

    // Priority: email match > phone match > LinkedIn match
    let existingIdx = -1;
    if (email && byEmail.has(email)) existingIdx = byEmail.get(email);
    else if (phone && byPhone.has(phone)) existingIdx = byPhone.get(phone);
    else if (linkedin && byLinkedin.has(linkedin)) existingIdx = byLinkedin.get(linkedin);

    if (existingIdx !== -1) {
      const existing = result[existingIdx];
      const existingScore = existing.contactScore || 0;
      const newScore = lead.contactScore || 0;

      // Keep the higher-scored version; fill any missing fields from the other
      const winner = newScore >= existingScore ? lead : existing;
      const loser = winner === lead ? existing : lead;

      result[existingIdx] = {
        ...winner,
        email: winner.email || loser.email,
        phone: winner.phone || loser.phone,
        organization: winner.organization || loser.organization,
        linkedinUrl: winner.linkedinUrl || loser.linkedinUrl,
        designation: winner.designation || loser.designation
      };

      // Re-register all keys so they point to the merged entry
      const me = (result[existingIdx].email || "").toLowerCase().trim();
      const mp = normalizePhone(result[existingIdx].phone || "") || (result[existingIdx].phone || "").trim();
      const ml = (result[existingIdx].linkedinUrl || "").toLowerCase().split("?")[0];

      if (me) byEmail.set(me, existingIdx);
      if (mp) byPhone.set(mp, existingIdx);
      if (ml) byLinkedin.set(ml, existingIdx);
    } else {
      const idx = result.length;
      result.push(lead);
      if (email) byEmail.set(email, idx);
      if (phone) byPhone.set(phone, idx);
      if (linkedin) byLinkedin.set(linkedin, idx);
    }
  }

  return result;
}

module.exports = { mergeLeads };
