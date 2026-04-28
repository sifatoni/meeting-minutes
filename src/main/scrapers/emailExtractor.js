const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.(?!png|jpg|jpeg|gif|webp|svg|ico)[a-zA-Z]{2,}/g;
const PHONE_BD_RE = /(?:\+880|880|01)[0-9]{9}/g;

function extractEmails(text) {
  const matches = String(text || "").match(EMAIL_RE) || [];
  return [...new Set(matches.map(e => e.toLowerCase()))].filter(e => {
    const domain = e.split("@")[1] || "";
    return domain.includes(".") && !domain.includes("example") && !domain.includes("domain.com");
  });
}

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("880") && digits.length === 13) return "+" + digits;
  if (digits.startsWith("01") && digits.length === 11) return "+880" + digits.slice(1);
  if (digits.length >= 10 && digits.length <= 15) return "+" + digits;
  return "";
}

function extractPhones(text) {
  const matches = String(text || "").match(PHONE_BD_RE) || [];
  return [...new Set(matches.map(normalizePhone))].filter(Boolean);
}

module.exports = { extractEmails, extractPhones, normalizePhone, EMAIL_RE, PHONE_BD_RE };
