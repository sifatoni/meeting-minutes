const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SECRET_KEY = "SokrioMeetings@2024$LicenseKey#Bangladesh";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const EPOCH = new Date("2024-01-01T00:00:00.000Z");
const PLAN_NAMES = ["7-Day", "1-Month", "3-Month", "6-Month", "1-Year"];

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const result = [];
  for (const char of str) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 character: " + char);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(result);
}

function getLicensePath() {
  return path.join(app.getPath("userData"), "license.json");
}

function validateLicense(key) {
  try {
    const stripped = String(key || "").replace(/-/g, "").toUpperCase().trim();
    if (stripped.length !== 16) {
      return { valid: false, expiresAt: null, daysLeft: 0, planName: "", error: "Invalid license key" };
    }

    const bytes = base32Decode(stripped);
    if (bytes.length !== 10) {
      return { valid: false, expiresAt: null, daysLeft: 0, planName: "", error: "Invalid license key" };
    }

    const durationIndex = bytes[0];
    const expiryDays = (bytes[1] << 8) | bytes[2];
    const payloadBytes = bytes.slice(0, 7);
    const checksumBytes = bytes.slice(7, 10);

    const hmac = crypto.createHmac("sha256", SECRET_KEY);
    hmac.update(payloadBytes);
    const digest = hmac.digest();

    if (
      digest[0] !== checksumBytes[0] ||
      digest[1] !== checksumBytes[1] ||
      digest[2] !== checksumBytes[2]
    ) {
      return { valid: false, expiresAt: null, daysLeft: 0, planName: "", error: "Invalid license key" };
    }

    const expiresAt = new Date(EPOCH.getTime() + expiryDays * 86400000);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysLeft = Math.floor((expiresAt.getTime() - today.getTime()) / 86400000);

    const planName = PLAN_NAMES[durationIndex] || "Unknown";

    if (daysLeft < -3) {
      return { valid: false, expiresAt, daysLeft, planName, error: "License expired" };
    }

    return { valid: true, expiresAt, daysLeft, planName, error: null };
  } catch {
    return { valid: false, expiresAt: null, daysLeft: 0, planName: "", error: "Invalid license key" };
  }
}

function saveLicense(key) {
  const licensePath = getLicensePath();
  fs.mkdirSync(path.dirname(licensePath), { recursive: true });
  fs.writeFileSync(licensePath, JSON.stringify({ key }, null, 2), "utf8");
}

function loadLicense() {
  try {
    const data = JSON.parse(fs.readFileSync(getLicensePath(), "utf8"));
    return data.key || null;
  } catch {
    return null;
  }
}

function isLicenseActive() {
  const key = loadLicense();
  if (!key) return false;
  return validateLicense(key).valid;
}

function getLicenseInfo() {
  const key = loadLicense();
  if (!key) return null;
  return validateLicense(key);
}

module.exports = { validateLicense, saveLicense, loadLicense, isLicenseActive, getLicenseInfo };
