const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execSync } = require("child_process");
const dns = require("dns").promises;

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

  // Fallback — will likely fail but gives a clear error
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
const REQUIRED_PIP_PACKAGES = ["faster-whisper==1.2.1", "openrouter", "groq"];

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
    sendSetup("python", "Python not found. Downloading Python installer…", 0);
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
              sendSetup("python", `Downloading Python… ${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`, pct);
            }
          });
          res.pipe(ws);
          ws.on("finish", () => { ws.close(); resolve(); });
          ws.on("error", (err) => { fs.unlink(installerPath, () => {}); reject(err); });
        }).on("error", reject);
      };
      follow(PYTHON_MAC_INSTALLER_URL, 0);
    });

    sendSetup("python", "Installing Python 3.13…", -1);
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
    sendSetup("python", "Installing Python dependencies…", -1);
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

ipcMain.handle("meeting:process", async (_event, meetingId) => {
  const meetings = readJson(getMeetingsPath(), []);
  const meeting = meetings.find((item) => item.id === meetingId);
  if (!meeting) throw new Error("Meeting not found.");

  const meetingDataDir = path.join(app.getPath("userData"), "meetings", meeting.id);
  ensureDir(meetingDataDir);

  meeting.status = "Processing";
  writeJson(getMeetingsPath(), meetings);

  const config = readJson(getConfigPath(), {});
  const scriptPath = path.join(app.getAppPath(), "scripts", "process_meeting.py");
  const input = JSON.stringify({
    meeting,
    outputDir: meetingDataDir,
    config
  });

  const result = await runPython(scriptPath, input);
  const output = JSON.parse(result);

  meeting.status = "Minutes Ready";
  meeting.files.transcript = output.transcriptPath;
  meeting.files.minutes = output.minutesPath;
  meeting.files.docx = output.docxPath;
  writeJson(getMeetingsPath(), meetings);

  return {
    meeting,
    transcript: fs.readFileSync(output.transcriptPath, "utf8"),
    minutes: readJson(output.minutesPath, {})
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
// Lead Intelligence (Local Contact-First Engine)
// ===================================================================

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeCsv(value) {
  const str = String(value == null ? "" : value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

function domainFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeDesignation(value) {
  const raw = normalizeWhitespace(value).toLowerCase();
  const mappings = [
    ["ceo", "CEO"],
    ["chief executive officer", "CEO"],
    ["founder", "Founder"],
    ["co-founder", "Founder"],
    ["cmo", "Marketing Head"],
    ["chief marketing officer", "Marketing Head"],
    ["head of marketing", "Marketing Head"],
    ["vp marketing", "Marketing Head"],
    ["marketing director", "Marketing Head"],
    ["director of marketing", "Marketing Head"],
    ["managing director", "Managing Director"],
    ["country manager", "Country Manager"]
  ];
  for (const [key, label] of mappings) {
    if (raw.includes(key)) return label;
  }
  return value || "Decision Maker";
}

function normalizePhone(rawPhone) {
  const raw = String(rawPhone || "").trim();
  if (!raw) return { value: "", isValid: false };

  const cleaned = raw.replace(/[^\d+]/g, "");
  const hasPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");
  const validLength = digits.length >= 8 && digits.length <= 15;
  if (!validLength) return { value: "", isValid: false };

  return { value: hasPlus ? `+${digits}` : digits, isValid: true };
}

function isLikelyPersonalName(value) {
  if (!value) return false;
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (words.some((w) => w.length < 2 || w.length > 20)) return false;
  return words.every((w) => /^[A-Z][a-z'.-]+$/.test(w));
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractEmails(text) {
  const source = String(text || "");
  const standardMatches = source.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const normalizedText = source
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
  const obfuscatedMatches = normalizedText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return unique([...standardMatches, ...obfuscatedMatches].map((v) => v.toLowerCase()));
}

function extractPhones(text) {
  const matches = String(text || "").match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  const normalized = [];
  for (const m of matches) {
    const normalizedPhone = normalizePhone(m);
    if (normalizedPhone.isValid) normalized.push(normalizedPhone.value);
  }
  return unique(normalized);
}

function inferOrganizationFromDomain(domain) {
  if (!domain) return "";
  const core = domain.split(".")[0] || "";
  return core
    .split(/[-_]/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function generateEmailGuess(name, domain) {
  if (!name || !domain) return null;
  const parts = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return null;

  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first}.${last}@${domain}`;
}

async function verifyEmailMx(email) {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex + 1);
  if (!domain || !domain.includes(".")) return false;

  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

function buildLeadSearchQueries(input) {
  const industry = normalizeWhitespace(input.industry);
  const location = normalizeWhitespace(input.location);
  const organization = normalizeWhitespace(input.organization || "");
  const roles = Array.isArray(input.designations) && input.designations.length
    ? input.designations.map((d) => normalizeWhitespace(d)).filter(Boolean)
    : ["CEO", "Marketing Head"];

  const roleQuery = roles.join(" OR ");
  const base = organization
    ? `${organization} ${location} ${roleQuery} email phone`
    : `${industry} companies ${location} ${roleQuery} email phone`;

  return unique([
    `${base} contact`,
    `${base} leadership team`,
    `${base} about us`,
    `${base} linkedin`
  ]);
}

function parseSearchResultLinks(html) {
  const links = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(match[1]);
    if (!rawHref) continue;

    let href = rawHref;
    // DuckDuckGo redirects: //duckduckgo.com/l/?uddg=ENCODED_URL
    if (href.includes("duckduckgo.com/l/?") || href.startsWith("/l/?")) {
      try {
        const fullHref = href.startsWith("//") ? `https:${href}` :
          href.startsWith("/") ? `https://duckduckgo.com${href}` : href;
        const u = new URL(fullHref);
        const uddg = u.searchParams.get("uddg");
        if (uddg) href = decodeURIComponent(uddg);
      } catch {}
    }

    // Google redirects: /url?q=ENCODED_URL
    if (href.startsWith("/url?") || (href.includes("google.com/url") && href.includes("?q="))) {
      try {
        const fullHref = href.startsWith("/url?") ? `https://www.google.com${href}` : href;
        const u = new URL(fullHref);
        const target = u.searchParams.get("q") || u.searchParams.get("url");
        if (target) href = decodeURIComponent(target);
      } catch {}
    }

    if (!/^https?:\/\//i.test(href)) continue;
    if (href.includes("duckduckgo.com")) continue;
    if (href.includes("bing.com")) continue;
    if (href.includes("google.com")) continue;
    if (href.includes("/ck/a?")) continue; // Skip Bing click-tracking redirects
    if (/\.(jpg|jpeg|png|gif|pdf|svg|webp|ico)(\?|$)/i.test(href)) continue;
    links.push(href);
  }
  return unique(links).slice(0, 30);
}

function extractRoleNamePairs(text, designations) {
  const roles = (designations && designations.length ? designations : ["CEO", "Marketing Head"])
    .map((r) => normalizeWhitespace(r))
    .filter(Boolean);

  const snippets = String(text || "").split(/[.!?\n\r]/).map((s) => s.trim()).filter(Boolean);
  const pairs = [];
  for (const line of snippets) {
    for (const role of roles) {
      const rolePattern = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m1 = line.match(new RegExp(`([A-Z][a-z'.-]+(?:\\s+[A-Z][a-z'.-]+){1,3})\\s*[,|-]\\s*${rolePattern}`, "i"));
      const m2 = line.match(new RegExp(`${rolePattern}\\s*[:|-]\\s*([A-Z][a-z'.-]+(?:\\s+[A-Z][a-z'.-]+){1,3})`, "i"));
      if (m1 && isLikelyPersonalName(m1[1])) pairs.push({ name: m1[1], designation: role });
      if (m2 && isLikelyPersonalName(m2[1])) pairs.push({ name: m2[1], designation: role });
    }
  }
  return pairs.slice(0, 20);
}

async function fetchText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        fetchText(nextUrl, timeoutMs).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
        if (data.length > 600000) {
          req.destroy(new Error("Response too large"));
        }
      });
      res.on("end", () => resolve(data));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
  });
}

async function postJson(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...extraHeaders
      }
    };
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        postJson(next, body, extraHeaders).then(resolve).catch(reject);
        return;
      }
      let raw = "";
      res.on("data", (chunk) => { raw += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error("Invalid JSON response from API")); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const LEAD_TITLE_EXPANSIONS = {
  "ceo": ["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Managing Director", "MD", "President", "Owner"],
  "marketing head": ["CMO", "Chief Marketing Officer", "Head of Marketing", "VP Marketing", "VP of Marketing", "Marketing Director", "Director of Marketing", "Marketing Manager"],
  "managing director": ["Managing Director", "MD", "General Manager", "GM"],
  "country manager": ["Country Manager", "Country Head", "Regional Manager", "Regional Director", "Territory Manager"],
  "cto": ["CTO", "Chief Technology Officer", "VP Engineering", "Head of Technology"],
  "cfo": ["CFO", "Chief Financial Officer", "VP Finance", "Finance Director"],
  "sales head": ["VP Sales", "Sales Director", "Head of Sales", "Chief Sales Officer", "Sales Manager"]
};

function expandLeadTitles(designations) {
  const out = [];
  for (const d of designations) {
    const mapped = LEAD_TITLE_EXPANSIONS[d.toLowerCase()];
    if (mapped) out.push(...mapped);
    else out.push(d);
  }
  return unique(out);
}

// Apollo.io People Search — primary lead source (paginated, up to 3 pages = 300 leads)
// Free tier: 50 email credits/month. Paid plans unlock full email + phone.
// Sign up at: https://app.apollo.io/#/settings/integrations/api
async function searchApolloIo(apiKey, input) {
  const designations = (input.designations && input.designations.length)
    ? input.designations : ["CEO", "Marketing Head"];

  const basePayload = {
    per_page: 100,
    person_titles: expandLeadTitles(designations),
    // NOTE: q_organization_keyword_tags is intentionally omitted — Apollo's internal
    // tag taxonomy rarely matches free-text industry names and silently returns 0.
    // Location + title filters are strong enough; industry is post-filtered by scoring.
    person_locations: [normalizeWhitespace(input.location)].filter(Boolean),
    reveal_personal_emails: true,
    reveal_phone_number: true
  };
  if (input.organization) basePayload.q_organization_name = normalizeWhitespace(input.organization);

  const allPeople = [];
  let apolloError = null;
  const apolloHeaders = { "X-Api-Key": apiKey };

  for (let page = 1; page <= 3; page++) {
    try {
      const res = await postJson("https://api.apollo.io/api/v1/mixed_people/search", { ...basePayload, page }, apolloHeaders);
      const people = Array.isArray(res.people) ? res.people : [];
      if (res.error) { apolloError = res.error; break; }
      allPeople.push(...people);
      const pag = res.pagination || {};
      if (people.length < 100 || page >= (pag.total_pages || 1)) break;
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      // Try legacy URL on first page failure
      if (page === 1) {
        try {
          const res2 = await postJson("https://api.apollo.io/v1/mixed_people/search", { ...basePayload, page }, apolloHeaders);
          const people2 = Array.isArray(res2.people) ? res2.people : [];
          allPeople.push(...people2);
          if (people2.length > 0) continue;
        } catch {}
      }
      apolloError = e.message;
      break;
    }
  }

  if (apolloError) throw new Error(apolloError);

  return allPeople.map((person) => {
    const org = person.organization || {};
    const phoneEntry = (person.phone_numbers || []).find((p) => p.sanitized_number || p.raw_number);
    const rawPhone = phoneEntry ? (phoneEntry.sanitized_number || phoneEntry.raw_number || "") : "";
    const emailRaw = normalizeWhitespace(person.email || "");
    const emailMasked = emailRaw.includes("*");
    return {
      id: `apollo-${person.id || Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: normalizeWhitespace(person.name || `${person.first_name || ""} ${person.last_name || ""}`.trim()),
      designation: normalizeDesignation(normalizeWhitespace(person.title || designations[0])),
      organization: normalizeWhitespace(org.name || input.organization || "Unknown Organization"),
      industry: normalizeWhitespace(input.industry),
      location: normalizeWhitespace([person.city, person.country || input.location].filter(Boolean).join(", ")),
      countryCode: normalizeWhitespace(input.countryCode || ""),
      email: emailMasked ? "" : emailRaw,
      phone: normalizePhone(rawPhone).value || "",
      linkedinUrl: normalizeWhitespace(person.linkedin_url || person.linkedin || ""),
      source: "Apollo.io",
      createdAt: nowIso()
    };
  });
}

// People Data Labs — second major database (different sources from Apollo)
// Free sandbox: 100 API credits/month
// Sign up at: https://dashboard.peopledatalabs.com/api-key
async function searchPdl(apiKey, input) {
  const designations = (input.designations && input.designations.length)
    ? input.designations : ["CEO", "Marketing Head"];

  const expandedTitles = expandLeadTitles(designations);
  const country = normalizeWhitespace(input.location).toLowerCase().replace(/'/g, "''");

  // PDL SQL is LIKE-based, case-insensitive, and more reliable than Elasticsearch DSL
  const titleClauses = expandedTitles
    .slice(0, 10)
    .map((t) => `job_title LIKE '%${t.toLowerCase().replace(/'/g, "''")}%'`)
    .join(" OR ");

  let sql = `SELECT * FROM person WHERE (${titleClauses}) AND location_country = '${country}'`;
  if (input.organization) {
    const org = normalizeWhitespace(input.organization).toLowerCase().replace(/'/g, "''");
    sql += ` AND job_company_name LIKE '%${org}%'`;
  }

  const res = await postJson(
    "https://api.peopledatalabs.com/v5/person/search",
    { sql, size: 100 },
    { "X-Api-Key": apiKey }
  );

  return (Array.isArray(res.data) ? res.data : []).map((p) => {
    const emails = Array.isArray(p.emails) ? p.emails : [];
    const phones = Array.isArray(p.phone_numbers) ? p.phone_numbers : [];
    const primaryEmail = (emails.find((e) => e && e.type === "professional") || emails[0] || {});
    const emailCandidates = unique([
      normalizeWhitespace(typeof p.work_email === "string" ? p.work_email : ""),
      normalizeWhitespace(typeof p.recommended_personal_email === "string" ? p.recommended_personal_email : ""),
      normalizeWhitespace(primaryEmail && typeof primaryEmail === "object" ? (primaryEmail.address || primaryEmail.email || "") : ""),
      normalizeWhitespace(typeof primaryEmail === "string" ? primaryEmail : "")
    ]);
    const rawPhonePrimary = phones[0] || "";
    const rawPhone = typeof rawPhonePrimary === "object"
      ? (rawPhonePrimary.sanitized_number || rawPhonePrimary.international_number || rawPhonePrimary.number || rawPhonePrimary.raw_number || "")
      : rawPhonePrimary;
    const phoneCandidates = unique([
      normalizeWhitespace(typeof p.mobile_phone === "string" ? p.mobile_phone : ""),
      normalizeWhitespace(rawPhone)
    ]);
    const pdlMaskedContact = ["emails", "phone_numbers", "work_email", "mobile_phone", "personal_emails", "recommended_personal_emails"]
      .some((field) => typeof p[field] === "boolean");

    return {
      id: `pdl-${p.id || Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: normalizeWhitespace(p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim()),
      designation: normalizeDesignation(normalizeWhitespace(p.job_title || designations[0])),
      organization: normalizeWhitespace(p.job_company_name || "Unknown Organization"),
      industry: normalizeWhitespace(input.industry),
      location: normalizeWhitespace(p.location_name || input.location),
      countryCode: normalizeWhitespace(input.countryCode || ""),
      email: emailCandidates[0] || "",
      phone: normalizePhone(phoneCandidates[0] || "").value || "",
      linkedinUrl: normalizeWhitespace(p.linkedin_url || p.linkedin || ""),
      pdlMaskedContact,
      source: "People Data Labs",
      createdAt: nowIso()
    };
  });
}

// Extract decision-maker names+titles from LinkedIn search result snippets.
// No API key needed — search engines index LinkedIn profiles and show
// "Name - Title - Company | LinkedIn" in their result titles/snippets.
async function searchLinkedInSnippets(input, designations) {
  const leads = [];
  // Use 2-3 role terms, not all expanded titles (too many queries)
  const primaryTitles = designations.length ? designations.slice(0, 3) : ["CEO", "Marketing Head"];
  const location = normalizeWhitespace(input.location);
  const industry = normalizeWhitespace(input.industry || "");

  for (const title of primaryTitles) {
    // Query 1: LinkedIn-focused (works best on Bing)
    const liQuery = `"${title}" ${industry} ${location} site:linkedin.com`;
    // Query 2: General web — catches business directories, news, company pages
    const genQuery = `"${title}" ${industry} ${location} contact email`;
    const engines = [
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(liQuery)}`,
      `https://www.bing.com/search?q=${encodeURIComponent(liQuery)}`,
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(genQuery)}`
    ];
    for (const url of engines) {
      try {
        const html = await fetchText(url, 12000);
        const parsedLeads = parseNameTitlePairsFromSearchHtml(html, designations);
        const profileUrls = extractLinkedInProfileUrlsFromSearchHtml(html);
        for (let i = 0; i < parsedLeads.length; i++) {
          parsedLeads[i].linkedinUrl = profileUrls[i] || "";
        }
        leads.push(...parsedLeads);
        if (leads.length >= 80) break;
      } catch {}
    }
    if (leads.length >= 80) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const seen = new Set();
  return leads.filter((l) => {
    const key = `${l.name.toLowerCase()}|${(l.linkedinUrl || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
}

function extractLinkedInProfileUrlsFromSearchHtml(html) {
  const text = decodeHtmlEntities(String(html || ""));
  const urls = [];
  const regex = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-z0-9-_%]+\/?/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    urls.push(m[0].split("?")[0]);
  }
  return unique(urls);
}

function parseNameTitlePairsFromSearchHtml(html, designations) {
  const leads = [];
  const text = decodeHtmlEntities(String(html || ""));
  const roleAliases = expandLeadTitles(designations || ["CEO", "Marketing Head"]);
  const roleRegex = new RegExp(
    roleAliases.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "i"
  );

  const patterns = [
    // "John Doe - CEO - Company | LinkedIn"
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3})\s*-\s*([^-|<>@\n]{3,55}?)\s*-\s*([^|<>@\n]{3,55}?)\s*\|\s*LinkedIn/g,
    // "John Doe | CEO | Company"
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3})\s*\|\s*([^|<>@\n]{3,55}?)\s*\|\s*([^|<>@\n]{3,55}?)\s*\|\s*LinkedIn/g,
    // "John Doe, CEO at Company" or "John Doe, CEO of Company"
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3}),\s*([^,<>@\n]{3,55}?)\s+(?:at|of)\s+([^,.<>@\n]{3,55})/g,
    // "John Doe - CEO at Company"
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3})\s*[-–]\s*([^-–<>@\n]{3,55}?)\s+(?:at|@)\s+([^,.<>@\n]{3,55})/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = normalizeWhitespace(match[1]);
      const designation = normalizeWhitespace(match[2]).replace(/\s+(at|of|@)\s+.*/i, "").trim();
      const organization = normalizeWhitespace(match[3] || "");
      if (!isLikelyPersonalName(name)) continue;
      if (!roleRegex.test(designation)) continue;
      leads.push({ name, designation, organization });
    }
  }

  return leads;
}

// Generate common email address patterns for a given full name + domain.
function generateEmailPatterns(name, domain) {
  if (!name || !domain) return [];
  const parts = name.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  const fi = first[0];
  return unique([
    `${first}.${last}@${domain}`,
    `${fi}.${last}@${domain}`,
    `${first}${last}@${domain}`,
    `${fi}${last}@${domain}`,
    `${first}@${domain}`,
    `${last}.${first}@${domain}`,
    `${first}_${last}@${domain}`
  ]);
}

// Look up a company's web domain via Clearbit's free autocomplete (no API key needed).
async function lookupCompanyDomain(orgName) {
  if (!orgName || orgName === "Unknown Organization") return "";
  const q = orgName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  if (!q) return "";
  try {
    const raw = await fetchText(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`,
      8000
    );
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data[0] && data[0].domain) {
      return data[0].domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    }
  } catch {}
  return "";
}

// Hunter.io Domain Email Search — secondary source
// Free tier: 25 domain searches/month. Good for finding emails after domain is known.
// Sign up at: https://hunter.io/api-keys
async function searchHunterDomain(apiKey, domain, designations) {
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(apiKey)}&type=personal&limit=10`;
  let body;
  try {
    const raw = await fetchText(url, 12000);
    body = JSON.parse(raw);
  } catch {
    return [];
  }

  const data = body.data || {};
  const emails = Array.isArray(data.emails) ? data.emails : [];
  const orgName = normalizeWhitespace(data.organization || inferOrganizationFromDomain(domain));
  const targetRoles = (designations && designations.length ? designations : ["CEO", "Marketing Head"])
    .map((d) => d.toLowerCase());
  const executiveSeniorities = new Set(["executive", "c-suite"]);

  return emails
    .filter((e) => {
      if (!e.value) return false;
      const pos = (e.position || "").toLowerCase();
      const seniority = (e.seniority || "").toLowerCase();
      return targetRoles.some((r) => pos.includes(r)) || executiveSeniorities.has(seniority);
    })
    .map((e) => ({
      id: `hunter-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: normalizeWhitespace(`${e.first_name || ""} ${e.last_name || ""}`.trim()),
      designation: normalizeDesignation(normalizeWhitespace(e.position || (designations[0] || "Decision Maker"))),
      organization: orgName,
      industry: "",
      location: "",
      countryCode: "",
      email: normalizeWhitespace(e.value || ""),
      phone: "",
      linkedinUrl: "",
      source: "Hunter.io",
      createdAt: nowIso()
    }));
}

async function searchWebLinks(query) {
  const engines = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    `https://www.google.com/search?num=20&q=${encodeURIComponent(query)}`
  ];

  const all = [];
  for (const searchUrl of engines) {
    try {
      const html = await fetchText(searchUrl, 12000);
      all.push(...parseSearchResultLinks(html));
      if (all.length >= 20) break;
    } catch {}
  }
  return unique(all).slice(0, 30);
}

async function fetchCompanyDomainFallback(input) {
  const suggestions = [];
  const querySet = unique([
    `${input.industry} ${input.location}`,
    `${input.industry} companies ${input.location}`,
    `${input.organization || ""}`.trim()
  ]).filter(Boolean);

  for (const query of querySet.slice(0, 3)) {
    const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`;
    try {
      const body = await fetchText(url, 10000);
      const data = JSON.parse(body);
      if (Array.isArray(data)) {
        for (const item of data.slice(0, 20)) {
          const domain = normalizeWhitespace(item.domain || "");
          const name = normalizeWhitespace(item.name || "");
          if (!domain) continue;
          suggestions.push({
            domain: domain.replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
            name
          });
        }
      }
    } catch {}
  }

  return unique(
    suggestions
      .map((s) => `https://${s.domain}`)
      .filter(Boolean)
  ).slice(0, 30);
}

function extractInternalCandidateLinks(baseUrl, html) {
  const hrefMatches = String(html || "").match(/href=["']([^"']+)["']/gi) || [];
  const candidates = [];
  const keywords = ["contact", "about", "team", "leadership", "management", "marketing", "board"];
  for (const raw of hrefMatches) {
    const href = raw.replace(/^href=["']|["']$/gi, "").trim();
    if (!href) continue;
    let absolute;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const path = absolute.toLowerCase();
    if (!keywords.some((k) => path.includes(k))) continue;
    if (!/^https?:\/\//.test(absolute)) continue;
    candidates.push(absolute);
  }
  return unique(candidates).slice(0, 10);
}

function extractJsonLdContacts(html) {
  const leads = [];
  const scripts = String(html || "").match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const block of scripts) {
    const jsonText = block
      .replace(/^[\s\S]*?>/, "")
      .replace(/<\/script>$/i, "")
      .trim();
    if (!jsonText) continue;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }

    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const nodeType = String(node["@type"] || "").toLowerCase();
      const contacts = []
        .concat(node.contactPoint || [])
        .concat(node.employee || [])
        .concat(node.member || []);

      if (nodeType.includes("person")) {
        leads.push({
          name: normalizeWhitespace(node.name || ""),
          designation: normalizeWhitespace(node.jobTitle || "Decision Maker"),
          email: normalizeWhitespace(node.email || ""),
          phone: normalizeWhitespace(node.telephone || ""),
          organization: normalizeWhitespace(node.worksFor?.name || "")
        });
      }

      for (const contact of contacts) {
        if (!contact || typeof contact !== "object") continue;
        leads.push({
          name: normalizeWhitespace(contact.name || ""),
          designation: normalizeWhitespace(contact.jobTitle || contact.contactType || "Decision Maker"),
          email: normalizeWhitespace(contact.email || ""),
          phone: normalizeWhitespace(contact.telephone || ""),
          organization: normalizeWhitespace(node.name || "")
        });
      }
    }
  }
  return leads;
}

function extractMailtoAndTel(html) {
  const text = String(html || "");
  const emails = [];
  const phones = [];

  const mailtoMatches = text.match(/mailto:([^"'?#\s>]+)/gi) || [];
  for (const m of mailtoMatches) {
    const email = m.replace(/^mailto:/i, "").trim();
    if (email) emails.push(email);
  }

  const telMatches = text.match(/tel:([^"'?#\s>]+)/gi) || [];
  for (const m of telMatches) {
    const phone = m.replace(/^tel:/i, "").trim();
    if (phone) phones.push(phone);
  }

  return { emails: unique(emails), phones: unique(phones) };
}

function inferNameFromEmail(email) {
  const local = String(email || "").split("@")[0] || "";
  const clean = local.replace(/[._-]+/g, " ").replace(/\d+/g, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2) return "";
  const pretty = words
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return isLikelyPersonalName(pretty) ? pretty : "";
}

function buildStandardSitePaths(url) {
  try {
    const origin = new URL(url).origin;
    return [
      `${origin}/contact`,
      `${origin}/contact-us`,
      `${origin}/about`,
      `${origin}/about-us`,
      `${origin}/team`,
      `${origin}/leadership`,
      `${origin}/management`,
      `${origin}/company`,
      `${origin}/our-team`
    ];
  } catch {
    return [];
  }
}

function scoreLead(lead, requestedDesignations, input) {
  let score = 0;
  if (lead.email && lead.emailVerified) score += 40;
  else if (lead.email) score += 20;

  if (lead.phone && lead.phoneVerified) score += 40;
  else if (lead.phone) score += 20;

  const targetRoles = (requestedDesignations || []).map((d) => String(d).toLowerCase());
  const designation = String(lead.designation || "").toLowerCase();
  if (targetRoles.some((role) => designation.includes(role.toLowerCase()))) {
    score += 15;
  }

  const industry = String(input.industry || "").toLowerCase();
  const location = String(input.location || "").toLowerCase();
  const text = `${lead.organization} ${lead.location} ${lead.source}`.toLowerCase();
  if ((industry && text.includes(industry)) || (location && text.includes(location))) {
    score += 5;
  }

  let band = "Low";
  if (score >= 80) band = "High";
  else if (score >= 50) band = "Medium";

  return { score, band };
}

function dedupeLeads(leads) {
  const seen = new Map();
  for (const lead of leads) {
    const key = lead.email || lead.phone || `${lead.name}|${lead.organization}`.toLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, lead);
      continue;
    }
    if ((lead.contactScore || 0) > (existing.contactScore || 0)) {
      seen.set(key, lead);
    }
  }
  return [...seen.values()];
}

async function discoverLeadsLocal(input) {
  const config = readJson(getConfigPath(), {});
  const apolloApiKey = normalizeWhitespace(config.apolloApiKey || "");
  const hunterApiKey = normalizeWhitespace(config.hunterApiKey || "");
  const pdlApiKey = normalizeWhitespace(config.pdlApiKey || "");

  const designations = Array.isArray(input.designations) && input.designations.length
    ? input.designations
    : ["CEO", "Marketing Head"];

  const stats = {
    queryCount: 0,
    linksFound: 0,
    pagesFetched: 0,
    contactSignalsFound: 0,
    fallbackLinksFound: 0,
    roleMatchedLeads: 0,
    contactOnlyLeads: 0,
    apolloLeads: 0,
    pdlLeads: 0,
    hunterLeads: 0,
    linkedInLeads: 0,
    emailsGuessed: 0,
    apiProvider: "Web Scraping",
    apiErrors: [],
    apiWarnings: []
  };

  const activeSources = [];
  const allDiscovered = [];

  // ── SOURCE 1: Apollo.io (paginated, up to 300 leads) ───────────────
  if (apolloApiKey) {
    activeSources.push("Apollo.io");
    try {
      const results = await searchApolloIo(apolloApiKey, input);
      allDiscovered.push(...results);
      stats.apolloLeads = results.length;
    } catch (e) {
      const msg = e.message || "Unknown error";
      console.error("[Apollo.io]", msg);
      if (/API_INACCESSIBLE|free plan|not accessible with this api_key/i.test(msg)) {
        stats.apiWarnings.push("Apollo.io free plan cannot access people search; continuing with other sources.");
      } else {
        stats.apiErrors.push(`Apollo.io: ${msg.slice(0, 120)}`);
      }
    }
  }

  // ── SOURCE 2: People Data Labs (different DB from Apollo) ──────────
  if (pdlApiKey) {
    activeSources.push("PDL");
    try {
      const results = await searchPdl(pdlApiKey, input);
      const contactable = results.filter((r) => r.email || r.phone);
      const maskedCount = results.filter((r) => r.pdlMaskedContact).length;
      allDiscovered.push(...contactable);
      stats.pdlLeads = contactable.length;
      if (results.length > 0 && contactable.length === 0 && maskedCount > 0) {
        stats.apiWarnings.push("PDL free plan returned records with masked contact fields. Upgrade PDL Search plan to unlock email/phone values.");
      }
    } catch (e) {
      const msg = e.message || "Unknown error";
      console.error("[PDL]", msg);
      stats.apiErrors.push(`PDL: ${msg.slice(0, 120)}`);
    }
  }

  // ── DOMAIN DISCOVERY via web search (feeds Hunter + scraping) ──────
  const queries = buildLeadSearchQueries(input);
  stats.queryCount = queries.length;

  const allLinks = [];
  for (const query of queries.slice(0, 4)) {
    const found = await searchWebLinks(query);
    allLinks.push(...found.slice(0, 8));
  }
  if (input.organization) {
    for (const q of [`${input.organization} official website`, `${input.organization} contact`]) {
      const found = await searchWebLinks(q);
      allLinks.push(...found.slice(0, 4));
    }
  }
  const links = unique(allLinks);

  if (!links.length) {
    const fallback = await fetchCompanyDomainFallback(input);
    links.push(...fallback);
    stats.fallbackLinksFound = fallback.length;
  }
  if (!links.length && input.organization) {
    const slug = input.organization.toLowerCase().replace(/[^a-z0-9]+/g, "");
    links.push(`https://${slug}.com`, `https://${slug}.net`, `https://${slug}.com.bd`);
    stats.fallbackLinksFound += 3;
  }
  stats.linksFound = links.length;

  // ── SOURCE 3: Hunter.io per discovered domain ──────────────────────
  if (hunterApiKey && links.length) {
    activeSources.push("Hunter.io");
    const domains = unique(links.map((l) => domainFromUrl(l)).filter(Boolean)).slice(0, 10);
    for (const domain of domains) {
      try {
        const results = await searchHunterDomain(hunterApiKey, domain, designations);
        allDiscovered.push(...results);
        stats.hunterLeads += results.length;
      } catch {}
    }
  }

  // ── SOURCE 4: LinkedIn profile snippets (free, no API key needed) ──
  // Extracts "Name - Title - Company | LinkedIn" from search engine result pages.
  {
    activeSources.push("LinkedIn/Search");
    try {
      const snippetLeads = await searchLinkedInSnippets(input, designations);
      for (const sl of snippetLeads) {
        allDiscovered.push({
          id: `li-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: sl.name,
          designation: normalizeDesignation(sl.designation),
          organization: sl.organization || "Unknown Organization",
          industry: normalizeWhitespace(input.industry),
          location: normalizeWhitespace(input.location),
          countryCode: normalizeWhitespace(input.countryCode || ""),
          email: "",
          phone: "",
          linkedinUrl: normalizeWhitespace(sl.linkedinUrl || ""),
          source: "LinkedIn (search snippet)",
          createdAt: nowIso()
        });
        stats.linkedInLeads += 1;
      }
    } catch (e) {
      console.error("[LinkedIn snippets]", e.message);
    }
  }

  // ── SOURCE 5: Web page scraping fallback/supplement ─────────────────
  // Always run fallback when Apollo is missing OR Apollo yielded no leads.
  if (!apolloApiKey || stats.apolloLeads === 0) {
    activeSources.push("Web Scraping");
    const crawlQueue = [...links.slice(0, 30)];
    for (const link of links.slice(0, 15)) {
      crawlQueue.push(...buildStandardSitePaths(link));
    }
    const visited = new Set();
    let crawlBudget = 35;

    while (crawlQueue.length && crawlBudget > 0) {
      const link = crawlQueue.shift();
      if (!link || visited.has(link)) continue;
      visited.add(link);
      crawlBudget -= 1;

      let html;
      try { html = await fetchText(link, 10000); } catch { continue; }
      stats.pagesFetched += 1;

      const text = stripHtml(html);
      const emails = extractEmails(`${html}\n${text}`);
      const phones = extractPhones(`${html}\n${text}`);
      const directContacts = extractMailtoAndTel(html);
      const mergedEmails = unique([...emails, ...directContacts.emails]);
      const mergedPhones = unique([...phones, ...directContacts.phones]);
      const rolePairs = extractRoleNamePairs(text, designations);
      const jsonLdLeads = extractJsonLdContacts(html);
      const domain = domainFromUrl(link);
      const organization = normalizeWhitespace(input.organization) || inferOrganizationFromDomain(domain);

      if (mergedEmails.length || mergedPhones.length || jsonLdLeads.length) {
        stats.contactSignalsFound += mergedEmails.length + mergedPhones.length + jsonLdLeads.length;
      }

      const internalLinks = extractInternalCandidateLinks(link, html);
      for (const il of internalLinks) {
        if (!visited.has(il) && crawlQueue.length < 60) crawlQueue.push(il);
      }

      if (!rolePairs.length && !jsonLdLeads.length && !(mergedEmails.length || mergedPhones.length)) continue;

      for (const pair of rolePairs.slice(0, 4)) {
        allDiscovered.push({
          id: `scrape-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: pair.name,
          designation: normalizeDesignation(pair.designation),
          organization: organization || "Unknown Organization",
          industry: normalizeWhitespace(input.industry),
          location: normalizeWhitespace(input.location),
          countryCode: normalizeWhitespace(input.countryCode || ""),
          email: mergedEmails[0] || generateEmailGuess(pair.name, domain) || "",
          phone: mergedPhones[0] || "",
          linkedinUrl: /linkedin\.com\/in\//i.test(link) ? link : "",
          source: link,
          createdAt: nowIso()
        });
        stats.roleMatchedLeads += 1;
      }

      for (const jl of jsonLdLeads.slice(0, 6)) {
        const guessedEmail = jl.email || (jl.name ? generateEmailGuess(jl.name, domain) : "");
        allDiscovered.push({
          id: `scrape-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: jl.name || inferNameFromEmail(guessedEmail) || "",
          designation: normalizeDesignation(jl.designation || (designations[0] || "Decision Maker")),
          organization: jl.organization || organization || "Unknown Organization",
          industry: normalizeWhitespace(input.industry),
          location: normalizeWhitespace(input.location),
          countryCode: normalizeWhitespace(input.countryCode || ""),
          email: guessedEmail || mergedEmails[0] || "",
          phone: jl.phone || mergedPhones[0] || "",
          linkedinUrl: /linkedin\.com\/in\//i.test(link) ? link : "",
          source: link,
          createdAt: nowIso()
        });
        stats.roleMatchedLeads += 1;
      }

      if (!rolePairs.length && !jsonLdLeads.length && (mergedEmails.length || mergedPhones.length)) {
        allDiscovered.push({
          id: `scrape-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: inferNameFromEmail(mergedEmails[0] || ""),
          designation: normalizeDesignation(designations[0] || "Decision Maker"),
          organization: organization || "Unknown Organization",
          industry: normalizeWhitespace(input.industry),
          location: normalizeWhitespace(input.location),
          countryCode: normalizeWhitespace(input.countryCode || ""),
          email: mergedEmails[0] || "",
          phone: mergedPhones[0] || "",
          linkedinUrl: /linkedin\.com\/in\//i.test(link) ? link : "",
          source: link,
          createdAt: nowIso()
        });
        stats.contactOnlyLeads += 1;
      }
    }
  }

  // ── ENRICH: MX-verify emails, normalize phones, score ─────────────
  const enriched = [];
  for (const lead of allDiscovered) {
    const normalizedPhone = normalizePhone(lead.phone || "");
    const emailLower = String(lead.email || "").toLowerCase();
    const emailSyntaxOk = !!emailLower && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}$/i.test(emailLower);
    const emailVerified = emailSyntaxOk ? await verifyEmailMx(emailLower) : false;

    const scored = scoreLead(
      { ...lead, email: emailLower, phone: normalizedPhone.value, emailVerified, phoneVerified: normalizedPhone.isValid },
      designations, input
    );
    enriched.push({
      ...lead,
      email: emailLower,
      phone: normalizedPhone.value,
      emailVerified,
      phoneVerified: normalizedPhone.isValid,
      contactScore: scored.score,
      valueBand: scored.band
    });
  }

  // ── POST-ENRICH: guess emails for named leads that still have none ─
  // For any lead (especially from LinkedIn snippets) that has a real name
  // but no email: look up the company domain via Clearbit, then try the 7
  // most common corporate email patterns and keep the first MX-verified one.
  const needsEmail = enriched.filter((l) => !l.email && isLikelyPersonalName(l.name));
  for (const lead of needsEmail.slice(0, 20)) {
    const domain = await lookupCompanyDomain(lead.organization);
    if (!domain) continue;
    const patterns = generateEmailPatterns(lead.name, domain);
    for (const pattern of patterns) {
      if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}$/i.test(pattern)) continue;
      if (await verifyEmailMx(pattern)) {
        lead.email = pattern;
        lead.emailGuessed = true;
        lead.emailVerified = false;
        lead.contactScore = (lead.contactScore || 0) + 15;
        lead.valueBand = lead.contactScore >= 80 ? "High" : lead.contactScore >= 50 ? "Medium" : "Low";
        stats.emailsGuessed += 1;
        break;
      }
    }
  }

  stats.apiProvider = activeSources.join(" + ") || "Web Scraping";
  const leads = dedupeLeads(enriched).sort((a, b) => (b.contactScore || 0) - (a.contactScore || 0));
  return { leads, stats };
}

ipcMain.handle("leads:getState", async () => {
  return {
    leads: readJson(getLeadsPath(), []),
    searches: readJson(getLeadSearchesPath(), [])
  };
});

ipcMain.handle("leads:searchLocal", async (_event, payload) => {
  const input = {
    industry: normalizeWhitespace(payload?.industry),
    location: normalizeWhitespace(payload?.location),
    countryCode: normalizeWhitespace(payload?.countryCode || ""),
    organization: normalizeWhitespace(payload?.organization || ""),
    designations: Array.isArray(payload?.designations) ? payload.designations.map((v) => normalizeWhitespace(v)).filter(Boolean) : []
  };

  if (!input.industry || !input.location) {
    throw new Error("Industry and location are required.");
  }

  const discovery = await discoverLeadsLocal(input);
  const leads = discovery.leads;
  const existing = readJson(getLeadsPath(), []);
  const merged = dedupeLeads([...leads, ...existing]).sort((a, b) => (b.contactScore || 0) - (a.contactScore || 0));
  writeJson(getLeadsPath(), merged);

  const searches = readJson(getLeadSearchesPath(), []);
  searches.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowIso(),
    query: input,
    leadCount: leads.length
  });
  writeJson(getLeadSearchesPath(), searches.slice(0, 100));

  return {
    leads,
    total: leads.length,
    highValue: leads.filter((l) => l.valueBand === "High").length,
    mediumValue: leads.filter((l) => l.valueBand === "Medium").length,
    lowValue: leads.filter((l) => l.valueBand === "Low").length,
    debug: discovery.stats
  };
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

  const header = [
    "Name", "Email", "LinkedIn URL", "Email Verified", "Phone", "Phone Verified",
    "Organization", "Designation", "Industry", "Location",
    "Score", "Value Band", "Source", "Created At"
  ];
  const lines = [header.join(",")];
  for (const lead of leads) {
    lines.push([
      escapeCsv(lead.name || ""),
      escapeCsv(lead.email || ""),
      escapeCsv(lead.linkedinUrl || ""),
      escapeCsv(lead.emailVerified ? "Yes" : "No"),
      escapeCsv(lead.phone || ""),
      escapeCsv(lead.phoneVerified ? "Yes" : "No"),
      escapeCsv(lead.organization || ""),
      escapeCsv(lead.designation || ""),
      escapeCsv(lead.industry || ""),
      escapeCsv(lead.location || ""),
      escapeCsv(lead.contactScore || 0),
      escapeCsv(lead.valueBand || "Low"),
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
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
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
      if (code !== 0) {
        reject(new Error(stderr || `Python worker exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
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

// All local models that the program supports — all must be available
const REQUIRED_OLLAMA_MODELS = ["qwen2.5:3b", "gemini-3-flash-preview"];

function getOllamaModel() {
  const config = readJson(getConfigPath(), {});
  if (config.model && config.model !== "online") {
    return config.model;
  }
  return process.env.MEETING_OLLAMA_MODEL || "gemini-3-flash-preview";
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

ipcMain.handle("ollama:check", () => ollamaStatus());

ipcMain.handle("ollama:setup", async () => {
  let st = await ollamaStatus();

  // Step 1 — Install Ollama if not found
  if (!st.installed) {
    sendSetup("install", "Downloading Ollama installer…", 0);
    const tmpDir = path.join(app.getPath("temp"), "ollama-setup");
    ensureDir(tmpDir);
    const installerPath = path.join(tmpDir, "OllamaSetup.exe");

    await downloadInstaller(installerPath, (recv, total) => {
      const pct = Math.round((recv / total) * 100);
      const mb = (recv / 1048576).toFixed(0);
      const totalMb = (total / 1048576).toFixed(0);
      sendSetup("install", `Downloading Ollama… ${mb} / ${totalMb} MB`, pct);
    });

    sendSetup("install", "Running Ollama installer…", -1);
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

    sendSetup("install", "Waiting for Ollama to start…", -1);
    await new Promise((r) => setTimeout(r, 5000));
    st = await ollamaStatus();
  }

  // Step 2 — Start the Ollama service if installed but not running
  if (st.installed && !st.running) {
    sendSetup("service", "Starting Ollama service…", -1);
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

  // Step 3 — Pull all missing models
  if (st.running && !st.modelReady) {
    const modelsToPull = st.missingModels.length > 0 ? st.missingModels : [...REQUIRED_OLLAMA_MODELS];
    const totalModels = modelsToPull.length;

    for (let i = 0; i < totalModels; i++) {
      const modelToPull = modelsToPull[i];
      const modelLabel = `(${i + 1}/${totalModels}) ${modelToPull}`;
      sendSetup("model", `Pulling model ${modelLabel}…`, 0);

      await new Promise((resolve, reject) => {
        const exe = st.ollamaPath || "ollama";
        const child = spawn(exe, ["pull", modelToPull], { windowsHide: true });

        const onData = (chunk) => {
          let text = chunk.toString().replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
          text = text.replace(/▕.*?▏/g, '').replace(/\s+/g, ' ').trim();
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
