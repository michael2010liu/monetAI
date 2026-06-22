// Glance — main process
// Creates a small always-on-top widget, registers a global hotkey,
// captures the screen on demand, and talks to the Claude API.

require("dotenv").config();
const {
  app,
  BrowserWindow,
  globalShortcut,
  desktopCapturer,
  screen,
  ipcMain,
  nativeImage,
} = require("electron");
const path = require("path");
const { execFile } = require("child_process");

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.GLANCE_MODEL || "claude-sonnet-4-6";
const HOTKEY = process.env.GLANCE_HOTKEY || "CommandOrControl+Shift+Space";
const MAX_IMG_WIDTH = 1568; // sweet spot for Claude vision: detail vs tokens

let win = null;

// ---------- window ----------

function createWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 560,
    height: 128, // brand strip + input bar; renderer asks to grow when chatting
    x: screenW - 580,
    y: 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the widget above fullscreen apps where the OS allows it
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The magic trick: exclude this window from screen capture,
  // so the screenshot Claude sees never contains the widget itself.
  win.setContentProtection(true);

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Let the renderer know when the widget is hidden/shown, so it can
  // clear stale chat history after a long hide.
  win.on("hide", () => win.webContents.send("widget-hidden"));
  win.on("show", () => win.webContents.send("widget-shown"));

  // Push the last-known track to the renderer once it's loaded, so it
  // doesn't have to wait up to 5s for the next poll tick.
  win.webContents.on("did-finish-load", () => {
    if (lastNowPlaying) win.webContents.send("nowplaying", lastNowPlaying);
  });
}

function toggleWidget() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.webContents.send("focus-input");
  }
}

// ---------- screen capture ----------

async function captureScreen() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;

  // macOS quirk: the very first capture after launch often comes back
  // blank while the capture pipeline warms up. Retry a couple of times
  // before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: width * scale, height: height * scale },
    });

    const source =
      sources.find((s) => s.display_id === String(primary.id)) || sources[0];

    if (source) {
      let img = source.thumbnail;
      const size = img.getSize();
      if (!img.isEmpty() && size.width > 0 && size.height > 0) {
        if (size.width > MAX_IMG_WIDTH) {
          img = img.resize({ width: MAX_IMG_WIDTH });
        }
        // JPEG keeps payloads small; 80 quality is plenty for text legibility
        return img.toJPEG(80).toString("base64");
      }
    }

    // blank capture — give the pipeline a moment and try again
    await new Promise((r) => setTimeout(r, 350));
  }

  throw new Error(
    "Screen capture kept coming back empty. Check Screen Recording permission, then fully restart the app."
  );
}

// ---------- now playing (macOS) ----------
// AppleScript that asks Spotify first, then Apple Music, for the current
// track and play state. Returns "source|state|track|artist" or empty.
// Runs locally, no API keys — but macOS will ask once for Automation perm.
const NOW_PLAYING_SCRIPT = `
tell application "System Events"
  set hasSpotify to (exists (processes where name is "Spotify"))
  set hasMusic to (exists (processes where name is "Music"))
end tell
if hasSpotify then
  try
    tell application "Spotify"
      set s to player state as string
      if s is "playing" or s is "paused" then
        return "spotify|" & s & "|" & (name of current track) & "|" & (artist of current track)
      end if
    end tell
  end try
end if
if hasMusic then
  try
    tell application "Music"
      set s to player state as string
      if s is "playing" or s is "paused" then
        return "music|" & s & "|" & (name of current track) & "|" & (artist of current track)
      end if
    end tell
  end try
end if
return ""
`;

let lastNowPlaying = null;

function getNowPlaying() {
  return new Promise((resolve) => {
    const child = execFile("osascript", ["-"], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = (stdout || "").trim();
      if (!line) return resolve(null);
      const [source, state, track, artist] = line.split("|");
      if (!track) return resolve(null);
      resolve({ source, state, track, artist: artist || "" });
    });
    child.stdin.end(NOW_PLAYING_SCRIPT);
  });
}

// Send a transport command (playpause / next track / previous track) to
// whichever app the chip is currently reflecting.
function controlMedia(source, command) {
  const allowed = { playpause: 1, "next track": 1, "previous track": 1 };
  if (!allowed[command]) return Promise.resolve();
  const appName = source === "music" ? "Music" : "Spotify";
  const script = `tell application "${appName}" to ${command}`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 2000 }, () => resolve());
  });
}

function pushNowPlaying(np) {
  lastNowPlaying = np;
  if (win && !win.isDestroyed()) win.webContents.send("nowplaying", np);
}

function startNowPlayingPoll() {
  if (process.platform !== "darwin") return; // AppleScript is macOS-only
  const tick = async () => {
    const np = await getNowPlaying();
    // Only push when something changed, to keep the renderer quiet.
    const changed =
      (np && (!lastNowPlaying ||
        np.track !== lastNowPlaying.track ||
        np.artist !== lastNowPlaying.artist ||
        np.state !== lastNowPlaying.state)) ||
      (!np && lastNowPlaying);
    if (changed) pushNowPlaying(np);
  };
  tick();
  setInterval(tick, 5000);
}

// ---------- Claude API ----------

const SYSTEM_PROMPT = `You are Monet, a tiny on-screen assistant. The user sends you a screenshot of their screen plus a question.

Match your depth to the task:
- Quick questions about what's on screen ("what does this error mean", "summarize this"): answer in a few sentences.
- Problems that need solving (math, physics, code debugging): actually solve them. Work step by step, show the key reasoning, and state the final answer clearly. Double-check arithmetic before answering.

Refer to what's visible directly ("the integral in problem 3"). If part of the problem is cut off or too small to read reliably, say exactly what you can't see rather than guessing.

Formatting:
- No markdown headers or bullet styling.
- For ANY math, physics, or chemistry expression — variables, equations, integrals, fractions, Greek letters, vectors, units — wrap it in LaTeX. Use $...$ for inline math (e.g., "the velocity $v_0$") and $$...$$ on its own line for displayed equations (e.g., "$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$"). This applies even to simple things like $x^2$, $\\pi$, or $9.8\\,\\text{m/s}^2$.
- If you literally need a dollar sign in prose (currency), escape it as \\$.`;

async function askClaude(question, screenshotB64, history) {
  if (!API_KEY) {
    throw new Error(
      "Missing API key. Create a .env file with ANTHROPIC_API_KEY=sk-ant-..."
    );
  }

  // Previous turns go in as text only (keeps token usage sane);
  // only the current turn carries the fresh screenshot.
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.text })),
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: screenshotB64,
          },
        },
        { type: "text", text: question },
      ],
    },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ---------- IPC ----------

ipcMain.handle("ask", async (_evt, { question, history }) => {
  const shot = await captureScreen();
  const answer = await askClaude(question, shot, history);
  return answer;
});

ipcMain.on("resize", (_evt, height) => {
  if (!win) return;
  const [w] = win.getSize();
  win.setSize(w, Math.min(Math.max(height, 128), 760));
});

ipcMain.on("hide", () => win && win.hide());

ipcMain.handle("media-control", async (_evt, command) => {
  if (!lastNowPlaying) return;
  await controlMedia(lastNowPlaying.source, command);
  // Re-poll immediately so the chip updates within ~200ms rather than
  // waiting up to 5s for the next scheduled tick.
  setTimeout(async () => {
    const np = await getNowPlaying();
    pushNowPlaying(np);
  }, 200);
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  createWindow();
  captureScreen().catch(() => {}); // warm up capture; ignore result
  startNowPlayingPoll();
  const ok = globalShortcut.register(HOTKEY, toggleWidget);
  if (!ok) console.warn(`Could not register hotkey ${HOTKEY}`);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
