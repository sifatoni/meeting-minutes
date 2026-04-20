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

function getPythonExecutable() {
  const appPath = app.getAppPath();
  const localVenvPython = process.platform === "win32"
    ? path.join(appPath, ".venv", "Scripts", "python.exe")
    : path.join(appPath, ".venv", "bin", "python");

  if (fs.existsSync(localVenvPython)) {
    return localVenvPython;
  }

  return "python";
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

app.whenReady().then(() => {
  configureMediaCapture();
  createWindow();
});

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

  const scriptPath = path.join(app.getAppPath(), "scripts", "process_meeting.py");
  const input = JSON.stringify({
    meeting,
    outputDir: meetingDataDir
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
  const result = await runPython(scriptPath, JSON.stringify({
    meeting,
    outputDir: meetingDataDir,
    exportOnly: true
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

function runPython(scriptPath, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(getPythonExecutable(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
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
const OLLAMA_MODEL = process.env.MEETING_OLLAMA_MODEL || "qwen2.5:3b";
const OLLAMA_INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

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
  const out = { installed: false, running: false, modelReady: false, ollamaPath: null };

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
        out.modelReady = r.data.models.some((m) =>
          m.name === OLLAMA_MODEL || m.name === `${OLLAMA_MODEL}:latest`
        );
      }
    } catch {
      out.modelReady = false;
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

  // Step 3 — Pull the model if not present
  if (st.running && !st.modelReady) {
    sendSetup("model", `Pulling model ${OLLAMA_MODEL}…`, 0);

    await new Promise((resolve, reject) => {
      const exe = st.ollamaPath || "ollama";
      const child = spawn(exe, ["pull", OLLAMA_MODEL], { windowsHide: true });

      const onData = (chunk) => {
        const text = chunk.toString().trim();
        if (!text) return;
        const match = text.match(/(\d+)%/);
        sendSetup("model", text, match ? parseInt(match[1], 10) : -1);
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("close", (code) => {
        code === 0 ? resolve() : reject(new Error(`Model pull failed (code ${code}).`));
      });
    });

    sendSetup("model", "Model ready.", 100);
  }

  return ollamaStatus();
});
