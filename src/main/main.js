const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execSync } = require("child_process");

let mainWindow;

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function getMeetingsPath() {
  return path.join(app.getPath("userData"), "meetings.json");
}

function getLeadsPath() {
  return path.join(app.getPath("userData"), "leads.json");
}

function getLeadSearchesPath() {
  return path.join(app.getPath("userData"), "lead_searches.json");
}

function getPythonExecutable() {
  const appPath = app.getAppPath();
  const localVenvPython = process.platform === "win32"
    ? path.join(appPath, ".venv", "Scripts", "python.exe")
    : path.join(appPath, ".venv", "bin", "python");

  // 1. Try bundled venv (dev mode)
  if (fs.existsSync(localVenvPython)) {
    return localVenvPython;
  }

  // 2. Try to find python on PATH
  if (process.platform === "win32") {
    try {
      const result = execSync("where python 2>nul", {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000
      });
      const first = result.trim().split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) return first;
    } catch {}
  } else {
    try {
      const result = execSync("which python3 2>/dev/null || which python 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000
      });
      const first = result.trim().split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) return first;
    } catch {}
  }

  // 3. Try common Windows install locations
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Python313\\python.exe",
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python313", "python.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fallback - will likely fail but gives a clear error
  return process.platform === "win32" ? "python" : "python3";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function slugify(value) {
  return String(value || "meeting")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "meeting";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function configureMediaCapture() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = new Set(["media", "display-capture"]);
    const isAppWindow = mainWindow && webContents.id === mainWindow.webContents.id;
    callback(Boolean(isAppWindow && allowedPermissions.has(permission)));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 }
      });

      callback({
        video: sources[0],
        audio: process.platform === "win32" ? "loopback" : undefined
      });
    } catch (error) {
      console.error("Unable to configure system audio capture.", error);
      callback({});
    }
  });
}

app.whenReady().then(async () => {
  configureMediaCapture();
  createWindow();
  // Ensure Python and pip dependencies are available (especially on Mac)
  try {
    await ensurePythonAndDeps();
  } catch (err) {
    console.error("[Python setup]", err.message);
  }
});

// ===================================================================
// First-Launch Python & Pip Dependency Setup
// ===================================================================

const PYTHON_MAC_INSTALLER_URL = "https://www.python.org/ftp/python/3.13.3/python-3.13.3-macos11.pkg";
const REQUIRED_PIP_PACKAGES = ["faster-whisper==1.2.1", "groq"];

function isPythonAvailable() {
  try {
    const cmd = process.platform === "win32" ? "python --version" : "python3 --version";
    execSync(cmd, { windowsHide: true, encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function arePipDepsInstalled() {
  const pythonExe = getPythonExecutable();
  try {
    const result = execSync(`"${pythonExe}" -c "import faster_whisper; print('ok')"`, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000
    });
    return result.trim() === "ok";
  } catch {
    return false;
  }
}

async function ensurePythonAndDeps() {
  // On Mac, install Python if missing
  if (process.platform === "darwin" && !isPythonAvailable()) {
    sendSetup("python", "Python not found. Downloading Python installer...", 0);
    const tmpDir = path.join(app.getPath("temp"), "python-setup");
    ensureDir(tmpDir);
    const installerPath = path.join(tmpDir, "python-3.13.3.pkg");

    await new Promise((resolve, reject) => {
      const follow = (currentUrl, depth) => {
        if (depth > 10) { reject(new Error("Too many redirects.")); return; }
        const mod = currentUrl.startsWith("https") ? https : http;
        mod.get(currentUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            let next = res.headers.location;
            if (next.startsWith("/")) {
              const u = new URL(currentUrl);
              next = `${u.protocol}//${u.host}${next}`;
            }
            follow(next, depth + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          const total = parseInt(res.headers["content-length"] || "0", 10);
          let received = 0;
          const ws = fs.createWriteStream(installerPath);
          res.on("data", (chunk) => {
            received += chunk.length;
            if (total > 0) {
              const pct = Math.round((received / total) * 100);
              sendSetup("python", `Downloading Python... ${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`, pct);
            }
          });
          res.pipe(ws);
          ws.on("finish", () => { ws.close(); resolve(); });
          ws.on("error", (err) => { fs.unlink(installerPath, () => {}); reject(err); });
        }).on("error", reject);
      };
      follow(PYTHON_MAC_INSTALLER_URL, 0);
    });

    sendSetup("python", "Installing Python 3.13...", -1);
    await new Promise((resolve, reject) => {
      const child = spawn("sudo", ["installer", "-pkg", installerPath, "-target", "/"], {
        stdio: "ignore"
      });
      child.on("error", reject);
      child.on("close", (code) => {
        code === 0 ? resolve() : reject(new Error(`Python installer exited with code ${code}`));
      });
    });

    try { fs.unlinkSync(installerPath); } catch {}
    sendSetup("python", "Python installed.", 100);
  }

  // Install pip dependencies if missing
  if (!arePipDepsInstalled()) {
    sendSetup("python", "Installing Python dependencies...", -1);
    const pythonExe = getPythonExecutable();
    await new Promise((resolve, reject) => {
      const args = ["-m", "pip", "install", ...REQUIRED_PIP_PACKAGES];
      const child = spawn(pythonExe, args, { windowsHide: true, stdio: "pipe" });
      child.on("error", (err) => {
        console.error("[pip install error]", err.message);
        resolve(); // Don't block app launch
      });
      child.on("close", (code) => {
        if (code === 0) {
          sendSetup("python", "Dependencies installed.", 100);
        } else {
          console.error(`[pip install] exited with code ${code}`);
        }
        resolve(); // Don't block app launch
      });
    });
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("app:getState", async () => {
  return {
    config: readJson(getConfigPath(), {}),
    meetings: readJson(getMeetingsPath(), [])
  };
});

ipcMain.handle("app:chooseAudioFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Audio Save Folder",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const config = readJson(getConfigPath(), {});
  config.audioDirectory = result.filePaths[0];
  writeJson(getConfigPath(), config);
  return config;
});

ipcMain.handle("app:saveConfig", async (_event, patch) => {
  const config = readJson(getConfigPath(), {});
  Object.assign(config, patch);
  writeJson(getConfigPath(), config);
  return config;
});

ipcMain.handle("app:uploadExistingAudio", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Upload Existing Recording",
    filters: [
      { name: "Audio Files", extensions: ["mp3", "wav", "webm", "ogg", "m4a", "mp4", "mkv", "mov", "avi", "dat"] }
    ],
    properties: ["openFile", "multiSelections"]
  });

  if (result.canceled || !result.filePaths.length) return null;

  return result.filePaths;
});

ipcMain.handle("meeting:importAudio", async (_event, payload) => {
  const config = readJson(getConfigPath(), {});
  if (!config.audioDirectory) {
    throw new Error("Audio save folder is required before importing audio.");
  }

  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${slugify(payload.title || "imported")}`;
  const meetingAudioDir = path.join(config.audioDirectory, id);
  ensureDir(meetingAudioDir);

  const sourcePath = payload.filePath;
  const ext = path.extname(sourcePath).toLowerCase().slice(1);
  const destPath = path.join(meetingAudioDir, `uploaded.${ext}`);
  fs.copyFileSync(sourcePath, destPath);

  const meeting = {
    id,
    title: payload.title || "Imported Meeting",
    client: payload.client || "",
    participants: payload.participants || "",
    type: payload.type || "Imported Audio",
    createdAt: now.toISOString(),
    status: "Recorded",
    audioDir: meetingAudioDir,
    files: { uploaded: destPath }
  };

  const meetings = readJson(getMeetingsPath(), []);
  meetings.unshift(meeting);
  writeJson(getMeetingsPath(), meetings);
  return meeting;
});

ipcMain.handle("meeting:create", async (_event, payload) => {
  const config = readJson(getConfigPath(), {});
  if (!config.audioDirectory) {
    throw new Error("Audio save folder is required before creating a meeting.");
  }

  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${slugify(payload.title)}`;
  const meetingAudioDir = path.join(config.audioDirectory, id);
  ensureDir(meetingAudioDir);

  const meeting = {
    id,
    title: payload.title || "Untitled Meeting",
    client: payload.client || "",
    participants: payload.participants || "",
    type: payload.type || "Google Meet",
    createdAt: now.toISOString(),
    status: "Draft",
    audioDir: meetingAudioDir,
    files: {}
  };

  const meetings = readJson(getMeetingsPath(), []);
  meetings.unshift(meeting);
  writeJson(getMeetingsPath(), meetings);
  return meeting;
});

ipcMain.handle("meeting:saveRecording", async (_event, payload) => {
  const meetings = readJson(getMeetingsPath(), []);
  const meeting = meetings.find((item) => item.id === payload.meetingId);
  if (!meeting) throw new Error("Meeting not found.");

  const allowedAudioKinds = new Set(["mic", "system", "meeting_audio"]);
  const audioKind = allowedAudioKinds.has(payload.kind) ? payload.kind : "mic";
  const extension = payload.mimeType && payload.mimeType.includes("webm") ? "webm" : "dat";
  const filePath = path.join(meeting.audioDir, `${audioKind}.${extension}`);
  const buffer = Buffer.from(payload.base64Data, "base64");
  fs.writeFileSync(filePath, buffer);

  meeting.files[audioKind] = filePath;
  meeting.status = "Recorded";
  writeJson(getMeetingsPath(), meetings);
  return meeting;
});

ipcMain.handle("meeting:deleteSourceRecordings", async (_event, meetingId) => {
  const meetings = readJson(getMeetingsPath(), []);
  const meeting = meetings.find((item) => item.id === meetingId);
  if (!meeting) throw new Error("Meeting not found.");

  for (const audioKind of ["mic", "system"]) {
    const filePath = meeting.files[audioKind];
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    delete meeting.files[audioKind];
  }

  writeJson(getMeetingsPath(), meetings);
  return meeting;
});

ipcMain.handle("meeting:updateMinutes", async (_event, payload) => {
  const meetings = readJson(getMeetingsPath(), []);
  const meeting = meetings.find((item) => item.id === payload.meetingId);
  if (!meeting) throw new Error("Meeting not found.");

  const meetingDataDir = path.join(app.getPath("userData"), "meetings", meeting.id);
  ensureDir(meetingDataDir);
  const minutesPath = path.join(meetingDataDir, "minutes.json");
  writeJson(minutesPath, payload.minutes);

  meeting.files.minutes = minutesPath;
  meeting.status = "Minutes Ready";
  writeJson(getMeetingsPath(), meetings);
  return meeting;
});

ipcMain.handle("meeting:process", async (_event, meetingId, options = {}) => {
  const meetings = readJson(getMeetingsPath(), []);
  const meeting = meetings.find((item) => item.id === meetingId);
  if (!meeting) throw new Error("Meeting not found.");

  const meetingDataDir = path.join(app.getPath("userData"), "meetings", meeting.id);
  ensureDir(meetingDataDir);

  meeting.status = "Processing";
  writeJson(getMeetingsPath(), meetings);

  // Merge per-request options (e.g. summaryMode) over the persisted config
  const config = { ...readJson(getConfigPath(), {}), ...options };
  const scriptPath = path.join(app.getAppPath(), "scripts", "process_meeting.py");
  const input = JSON.stringify({
    meeting,
    outputDir: meetingDataDir,
    config
  });

  const result = await runPython(scriptPath, input);
  console.log("[DEBUG] Python raw output:", result.slice(0, 500));
  let output;
  try {
    output = JSON.parse(result);
  } catch (e) {
    throw new Error("Invalid response from processing engine - Python may have crashed.");
  }
  if (!output || output.status === "error") {
    throw new Error(output?.message || "Processing failed");
  }
  const minutes = readJson(output.minutesPath, {});

  meeting.status = minutes._transcriptionError ? "Transcription Failed" : "Minutes Ready";
  meeting.files.transcript = output.transcriptPath;
  meeting.files.minutes = output.minutesPath;
  meeting.files.docx = output.docxPath;
  writeJson(getMeetingsPath(), meetings);

  return {
    meeting,
    transcript: fs.readFileSync(output.transcriptPath, "utf8"),
    minutes
  };
});

ipcMain.handle("meeting:exportDocx", async (_event, payload) => {
  const meetings = readJson(getMeetingsPath(), []);
  const meeting = meetings.find((item) => item.id === payload.meetingId);
  if (!meeting) throw new Error("Meeting not found.");

  const meetingDataDir = path.join(app.getPath("userData"), "meetings", meeting.id);
  ensureDir(meetingDataDir);
  const minutesPath = path.join(meetingDataDir, "minutes.json");
  writeJson(minutesPath, payload.minutes);

  const scriptPath = path.join(app.getAppPath(), "scripts", "process_meeting.py");
  const config = readJson(getConfigPath(), {});
  const result = await runPython(scriptPath, JSON.stringify({
    meeting,
    outputDir: meetingDataDir,
    exportOnly: true,
    config
  }));
  const output = JSON.parse(result);

  meeting.files.minutes = minutesPath;
  meeting.files.docx = output.docxPath;
  meeting.status = "Exported";
  writeJson(getMeetingsPath(), meetings);
  return meeting;
});

ipcMain.handle("meeting:clearHistory", async () => {
  writeJson(getMeetingsPath(), []);
  return [];
});

// ===================================================================
// Lead Intelligence (Puppeteer Scraping Engine)
// ===================================================================

function nowIso() { return new Date().toISOString(); }
function normalizeWhitespace(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function escapeCsv(value) {
  const str = String(value == null ? "" : value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, "\"\"")}"`;
  return str;
}

let scrapeGoogleSearch, scrapeGoogleMaps, scoreAndClean, scoreLead;
try {
  ({ scrapeGoogleSearch } = require("./scrapers/googleSearchScraper"));
  ({ scrapeGoogleMaps } = require("./scrapers/mapsScraper"));
  ({ scoreAndClean, scoreLead } = require("./scrapers/leadCleaner"));
} catch (err) {
  console.error("[Lead Intelligence] Scraper modules failed to load:", err.message);
}

let activeSearchSignal = null;

function dedupeLeads(leads) {
  const seen = new Map();
  for (const lead of leads) {
    const key = (lead.email || lead.phone || `${lead.name}|${lead.organization}`).toLowerCase();
    const existing = seen.get(key);
    if (!existing || (lead.contactScore || 0) > (existing.contactScore || 0)) {
      seen.set(key, lead);
    }
  }
  return [...seen.values()];
}

ipcMain.handle("leads:getState", async () => {
  return {
    leads: readJson(getLeadsPath(), []),
    searches: readJson(getLeadSearchesPath(), [])
  };
});

ipcMain.handle("leads:search", async (event, payload) => {
  if (!scrapeGoogleSearch || !scrapeGoogleMaps) {
    mainWindow.webContents.send("leads:error", { message: "Scraper modules not loaded. Run: npm install" });
    return { ok: false };
  }

  const input = {
    industry: normalizeWhitespace(payload?.industry),
    location: normalizeWhitespace(payload?.location),
    area: normalizeWhitespace(payload?.area || ""),
    organization: normalizeWhitespace(payload?.organization || ""),
    designations: Array.isArray(payload?.designations)
      ? payload.designations.map(v => normalizeWhitespace(v)).filter(Boolean)
      : ["CEO"],
    queryMode: payload?.queryMode || "aggressive"
  };

  if (!input.industry || !input.location) {
    mainWindow.webContents.send("leads:error", { message: "Industry and country are required." });
    return { ok: false };
  }

  if (activeSearchSignal) activeSearchSignal.cancelled = true;
  const signal = { cancelled: false, onCancel: null };
  activeSearchSignal = signal;

  const sendProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("leads:progress", data);
    }
  };

  // ── Multi-key lead accumulator ────────────────────────────────────────────
  // leadMap:  primaryKey → scored lead
  // keyIndex: anyContactKey → primaryKey   (prevents false-splits when the
  //           same person arrives from two sources with different contact info)
  const leadMap = new Map();
  const keyIndex = new Map();
  const keywords = [input.industry, input.location, input.area, ...(input.designations || [])].filter(Boolean);

  function getLeadKeys(lead) {
    const keys = [];
    const email = (lead.email || "").toLowerCase().trim();
    const digits = (lead.phone || "").replace(/\D/g, "");
    const li = (lead.linkedinUrl || "").toLowerCase().split("?")[0].split("#")[0];
    if (email) keys.push(`e:${email}`);
    if (digits.length >= 7) keys.push(`p:${digits.slice(-9)}`); // last 9 digits = country-prefix-agnostic
    if (li.includes("linkedin.com/in/")) keys.push(`li:${li}`);
    return keys;
  }

  function applyFallbackScore(lead) {
    // scoreLead never filters — safe to use as "never-drop" path
    if (typeof scoreLead === "function") return scoreLead(lead, keywords);
    return { ...lead, contactScore: 0, valueBand: "Low", emailType: "", scoreBreakdown: {} };
  }

  function mergeLead(lead) {
    // ── Score (never drop) ──────────────────────────────────────────────────
    let scored = scoreAndClean([lead], keywords)[0];
    if (!scored) {
      scored = applyFallbackScore(lead);
      console.warn(`[IPC] FALLBACK score: "${lead.name || "unknown"}" — score=${scored.contactScore} (no contact info)`);
    }

    const newKeys = getLeadKeys(scored);

    // ── Find matching existing entry by any contact key ─────────────────────
    let primaryKey = null;
    for (const k of newKeys) {
      if (keyIndex.has(k)) { primaryKey = keyIndex.get(k); break; }
    }

    if (primaryKey && leadMap.has(primaryKey)) {
      // ── Merge into existing, fill any missing fields, re-score ─────────────
      const existing = leadMap.get(primaryKey);
      const merged = {
        ...existing,
        email:       existing.email       || scored.email,
        phone:       existing.phone       || scored.phone,
        organization: existing.organization || scored.organization,
        linkedinUrl: existing.linkedinUrl || scored.linkedinUrl,
        designation: existing.designation || scored.designation,
      };
      const reScored = scoreAndClean([merged], keywords)[0] || applyFallbackScore(merged);
      leadMap.set(primaryKey, reScored);
      for (const k of newKeys) if (!keyIndex.has(k)) keyIndex.set(k, primaryKey);
      return reScored;
    }

    // ── New lead ────────────────────────────────────────────────────────────
    const pk = newKeys[0] || `id:${scored.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`;
    leadMap.set(pk, scored);
    for (const k of newKeys) keyIndex.set(k, pk);
    return scored;
  }

  function sendChunk(rawLeads, meta) {
    const src = meta?.source || "unknown";

    // ── Log 1: raw ──────────────────────────────────────────────────────────
    console.log(`\n[IPC] ── sendChunk ────────────────────────────────────────`);
    console.log(`[IPC] Source: ${src}  |  Raw received: ${rawLeads.length}`);
    if (rawLeads.length > 0) {
      const sample = rawLeads.slice(0, 2).map(l => ({
        name: l.name, email: l.email || "—", phone: l.phone || "—",
        li: (l.linkedinUrl || "").slice(-35)
      }));
      console.log(`[IPC] Raw sample: ${JSON.stringify(sample)}`);
    }

    const mapBefore = leadMap.size;
    const processed = [];
    for (const lead of rawLeads) {
      const result = mergeLead(lead);
      if (result) processed.push(result);
    }

    // ── Log 2: after merge ──────────────────────────────────────────────────
    const added = leadMap.size - mapBefore;
    console.log(`[IPC] After merge: ${processed.length} processed | +${added} new | map total: ${leadMap.size}`);

    // ── Log 3: after scoring ────────────────────────────────────────────────
    const hi  = processed.filter(l => l.contactScore >= 80).length;
    const med = processed.filter(l => l.contactScore >= 50 && l.contactScore < 80).length;
    const lo  = processed.filter(l => l.contactScore < 50).length;
    const withEmail = processed.filter(l => l.email).length;
    const withPhone = processed.filter(l => l.phone).length;
    const liOnly    = processed.filter(l => !l.email && !l.phone && l.linkedinUrl).length;
    console.log(`[IPC] Scores → HIGH:${hi} MED:${med} LOW:${lo}`);
    console.log(`[IPC] Contact → email:${withEmail} phone:${withPhone} linkedin-only:${liOnly}`);

    if (processed.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const allLeads = [...leadMap.values()].sort((a, b) => (b.contactScore || 0) - (a.contactScore || 0));
      writeJson(getLeadsPath(), allLeads);

      // ── Log 4: sent to UI ─────────────────────────────────────────────────
      console.log(`[IPC] → leads:chunk  ${processed.length} leads → UI  (${leadMap.size} total in map)`);
      mainWindow.webContents.send("leads:chunk", { leads: processed, total: leadMap.size, meta });
    }
  }

  (async () => {
    try {
      sendProgress({ step: "start", message: "Starting lead search - this may take 3-5 minutes...", count: 0 });

      // ── CAPTCHA notification callback ──
      const sendCaptcha = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("leads:captcha", data);
        }
      };

      // ── Method 1: Google → LinkedIn ──
      sendProgress({ step: "method1-start", message: "[Method 1] Google → LinkedIn search starting...", count: 0 });
      try {
        await scrapeGoogleSearch(input, sendProgress, signal, sendChunk, sendCaptcha);
        sendProgress({ step: "method1-done", message: `[Method 1] Done — ${leadMap.size} profiles found`, count: leadMap.size });
      } catch (err) {
        sendProgress({ step: "method1-error", message: `[Method 1] Error: ${err.message}`, count: leadMap.size });
      }

      if (signal.cancelled) {
        sendProgress({ step: "cancelled", message: "Search cancelled.", count: leadMap.size });
        return;
      }

      // ── Method 2: Google Maps → Website ──
      sendProgress({ step: "method2-start", message: "[Method 2] Google Maps → website email search starting...", count: leadMap.size });
      try {
        await scrapeGoogleMaps(input, sendProgress, signal, sendChunk);
        sendProgress({ step: "method2-done", message: `[Method 2] Done — ${leadMap.size} total contacts`, count: leadMap.size });
      } catch (err) {
        sendProgress({ step: "method2-error", message: `[Method 2] Error: ${err.message}`, count: leadMap.size });
      }

      if (signal.cancelled) {
        sendProgress({ step: "cancelled", message: "Search cancelled.", count: leadMap.size });
        return;
      }

      // ── Final persist + summary ──
      const finalLeads = [...leadMap.values()].sort((a, b) => (b.contactScore || 0) - (a.contactScore || 0));
      writeJson(getLeadsPath(), finalLeads);

      const searches = readJson(getLeadSearchesPath(), []);
      searches.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: nowIso(),
        query: input,
        leadCount: finalLeads.length
      });
      writeJson(getLeadSearchesPath(), searches.slice(0, 100));

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("leads:complete", {
          leads: finalLeads,
          total: finalLeads.length,
          highValue: finalLeads.filter(l => l.contactScore >= 80).length,
          mediumValue: finalLeads.filter(l => l.contactScore >= 50 && l.contactScore < 80).length,
          lowValue: finalLeads.filter(l => l.contactScore < 50).length
        });
      }
    } catch (err) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("leads:error", { message: err.message });
      }
    } finally {
      activeSearchSignal = null;
    }
  })();

  return { ok: true };
});

ipcMain.handle("leads:cancel", async () => {
  if (activeSearchSignal) {
    activeSearchSignal.cancelled = true;
    if (typeof activeSearchSignal.onCancel === "function") {
      await activeSearchSignal.onCancel().catch(() => {});
    }
    activeSearchSignal = null;
  }
  return { ok: true };
});

ipcMain.handle("leads:exportCsv", async (_event, payload) => {
  const leads = Array.isArray(payload?.leads) ? payload.leads : readJson(getLeadsPath(), []);
  if (!leads.length) throw new Error("No leads available to export.");

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Leads CSV",
    defaultPath: `lead_export_${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }]
  });
  if (result.canceled || !result.filePath) return null;

  const header = ["Name", "Email", "Phone", "Organization", "Designation", "Industry", "Location", "Area", "LinkedIn URL", "Score", "Source", "Created At"];
  const lines = [header.join(",")];
  for (const lead of leads) {
    lines.push([
      escapeCsv(lead.name || ""),
      escapeCsv(lead.email || ""),
      escapeCsv(lead.phone || ""),
      escapeCsv(lead.organization || ""),
      escapeCsv(lead.designation || ""),
      escapeCsv(lead.industry || ""),
      escapeCsv(lead.location || ""),
      escapeCsv(lead.area || ""),
      escapeCsv(lead.linkedinUrl || ""),
      escapeCsv(lead.contactScore || 0),
      escapeCsv(lead.source || ""),
      escapeCsv(lead.createdAt || "")
    ].join(","));
  }

  fs.writeFileSync(result.filePath, lines.join("\n"), "utf8");
  return { filePath: result.filePath, count: leads.length };
});

ipcMain.handle("leads:clear", async () => {
  writeJson(getLeadsPath(), []);
  writeJson(getLeadSearchesPath(), []);
  return { ok: true };
});

function runPython(scriptPath, input) {
  return new Promise((resolve, reject) => {
    const pythonExe = getPythonExecutable();
    let child;
    try {
      child = spawn(pythonExe, [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (err) {
      reject(new Error(
        `Could not start Python. Please install Python 3.10+ from https://www.python.org/downloads/ and ensure it is added to your system PATH.\n\nDetails: ${err.message}`
      ));
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(
          `Python was not found on this computer. Please install Python 3.10+ from https://www.python.org/downloads/ and make sure to check "Add Python to PATH" during installation.\n\nSearched for: ${pythonExe}`
        ));
      } else {
        reject(new Error(
          `Failed to run Python: ${err.message}\n\nSearched for: ${pythonExe}`
        ));
      }
    });

    child.on("close", (code) => {
      if (stderr) {
        console.log("[Python stderr]", stderr);
      }
      const out = stdout.trim();
      if (!out) {
        reject(new Error(stderr || `Python returned empty response (exit code ${code})`));
        return;
      }
      resolve(out);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// ===================================================================
// Ollama Auto-Setup
// ===================================================================

const OLLAMA_API = "http://127.0.0.1:11434";
const OLLAMA_INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

// All local models that the program supports " all must be available
const REQUIRED_OLLAMA_MODELS = ["qwen2.5:3b"];

function getOllamaModel() {
  const config = readJson(getConfigPath(), {});
  if (config.model && config.model !== "online") {
    return config.model;
  }
  return process.env.MEETING_OLLAMA_MODEL || "qwen2.5:3b";
}

function findOllamaPath() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
    path.join(localAppData, "Ollama", "ollama.exe"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const result = execSync("where ollama 2>nul", {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000
    });
    const first = result.trim().split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}

  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(body) });
        } catch {
          resolve({ ok: res.statusCode === 200, data: body });
        }
      });
    }).on("error", () => resolve({ ok: false, data: null }));
  });
}

async function ollamaStatus() {
  const out = {
    installed: false,
    running: false,
    modelReady: false,
    ollamaPath: null,
    installedModels: [],
    missingModels: []
  };

  out.ollamaPath = findOllamaPath();
  out.installed = !!out.ollamaPath;

  try {
    const r = await httpGet(OLLAMA_API);
    out.running = r.ok;
  } catch {
    out.running = false;
  }

  if (out.running) {
    try {
      const r = await httpGet(`${OLLAMA_API}/api/tags`);
      if (r.ok && r.data && Array.isArray(r.data.models)) {
        const availableNames = r.data.models.map((m) => m.name);
        out.installedModels = availableNames;

        for (const requiredModel of REQUIRED_OLLAMA_MODELS) {
          const found = availableNames.some((name) =>
            name === requiredModel || name === `${requiredModel}:latest`
          );
          if (!found) {
            out.missingModels.push(requiredModel);
          }
        }

        out.modelReady = out.missingModels.length === 0;
      }
    } catch {
      out.modelReady = false;
      out.missingModels = [...REQUIRED_OLLAMA_MODELS];
    }
  }

  return out;
}

function downloadInstaller(destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, depth) => {
      if (depth > 10) {
        reject(new Error("Too many redirects."));
        return;
      }

      const mod = currentUrl.startsWith("https") ? https : http;
      mod.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next = res.headers.location;
          if (next.startsWith("/")) {
            const u = new URL(currentUrl);
            next = `${u.protocol}//${u.host}${next}`;
          }
          follow(next, depth + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        const ws = fs.createWriteStream(destPath);

        res.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(received, total);
        });

        res.pipe(ws);
        ws.on("finish", () => { ws.close(); resolve(); });
        ws.on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
      }).on("error", reject);
    };

    follow(OLLAMA_INSTALLER_URL, 0);
  });
}

function sendSetup(phase, detail, pct) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ollama:progress", { phase, detail, pct });
  }
}

async function waitForApi(seconds) {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await httpGet(OLLAMA_API);
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

ipcMain.handle("ollama:check", () =>
  Promise.race([
    ollamaStatus(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
  ]).catch(() => ({
    installed: false, running: false, modelReady: false,
    ollamaPath: null, installedModels: [], missingModels: []
  }))
);

ipcMain.handle("ollama:setup", async () => {
  let st = await ollamaStatus();

  // Step 1 " Install Ollama if not found
  if (!st.installed) {
    sendSetup("install", "Downloading Ollama installer...", 0);
    const tmpDir = path.join(app.getPath("temp"), "ollama-setup");
    ensureDir(tmpDir);
    const installerPath = path.join(tmpDir, "OllamaSetup.exe");

    await downloadInstaller(installerPath, (recv, total) => {
      const pct = Math.round((recv / total) * 100);
      const mb = (recv / 1048576).toFixed(0);
      const totalMb = (total / 1048576).toFixed(0);
      sendSetup("install", `Downloading Ollama... ${mb} / ${totalMb} MB`, pct);
    });

    sendSetup("install", "Running Ollama installer...", -1);
    await new Promise((resolve, reject) => {
      const child = spawn(installerPath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], {
        windowsHide: true
      });
      child.on("error", reject);
      child.on("close", (code) => {
        code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}.`));
      });
    });

    try { fs.unlinkSync(installerPath); } catch {}

    sendSetup("install", "Waiting for Ollama to start...", -1);
    await new Promise((r) => setTimeout(r, 5000));
    st = await ollamaStatus();
  }

  // Step 2 " Start the Ollama service if installed but not running
  if (st.installed && !st.running) {
    sendSetup("service", "Starting Ollama service...", -1);
    if (st.ollamaPath) {
      try {
        const child = spawn(st.ollamaPath, ["serve"], {
          windowsHide: true,
          detached: true,
          stdio: "ignore"
        });
        child.unref();
      } catch {}
    }

    const ok = await waitForApi(30);
    if (!ok) throw new Error("Ollama service did not start. Please start Ollama manually.");
    st = await ollamaStatus();
  }

  // Step 3 " Pull all missing models
  if (st.running && !st.modelReady) {
    const modelsToPull = st.missingModels.length > 0 ? st.missingModels : [...REQUIRED_OLLAMA_MODELS];
    const totalModels = modelsToPull.length;

    for (let i = 0; i < totalModels; i++) {
      const modelToPull = modelsToPull[i];
      const modelLabel = `(${i + 1}/${totalModels}) ${modelToPull}`;
      sendSetup("model", `Pulling model ${modelLabel}...`, 0);

      await new Promise((resolve, reject) => {
        const exe = st.ollamaPath || "ollama";
        const child = spawn(exe, ["pull", modelToPull], { windowsHide: true });

        const onData = (chunk) => {
          let text = chunk.toString("utf8").replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
          text = text.replace(/[...]/g, '').replace(/\s+/g, ' ').trim();
          if (!text) return;
          const match = text.match(/(\d+)%/);
          sendSetup("model", `${modelLabel}: ${text}`, match ? parseInt(match[1], 10) : -1);
        };

        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", reject);
        child.on("close", (code) => {
          code === 0 ? resolve() : reject(new Error(`Model pull failed for ${modelToPull} (code ${code}).`));
        });
      });

      sendSetup("model", `Model ${modelLabel} ready.`, 100);
    }

    sendSetup("model", `All ${totalModels} models ready.`, 100);
  }

  return ollamaStatus();
});
