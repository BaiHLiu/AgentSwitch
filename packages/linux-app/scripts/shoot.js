// Pictures of the service's terminal page in states driven by a script, off screen (how the page is checked without
// anyone's desktop; docs/linux-app-v0.md). Run with the system's Electron:
//   electron scripts/shoot.js <steps.json> <out dir>
// steps.json: { "base": "http://127.0.0.1:4711", "home": "~/.agentswitch", "page": "/ui/terminal.html", "width": 1400,
//   "height": 860, "scheme": "dark" | "light", "steps": [{ "name": "one", "js": "…", "wait": 800 }] } — each step's
// JavaScript runs in the page, then after `wait` ms the page is pictured as <out>/<name>.png; what the JavaScript returns
// is written to <out>/<name>.json.
import { app, BrowserWindow, nativeTheme } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consoleLink, readToken } from "../lib/service.js";

const [stepsFile, out] = process.argv.slice(-2);
const plan = JSON.parse(readFileSync(stepsFile, "utf8"));
// Off screen (its pictures are made on demand: a hidden window stops drawing once nothing on it moves).
app.disableHardwareAcceleration();
const home = plan.home.replace(/^~/, process.env.HOME);
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  nativeTheme.themeSource = plan.scheme ?? "dark";
  mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: plan.width ?? 1400, height: plan.height ?? 860, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.webContents.setFrameRate(30);
  const log = [];
  win.webContents.on("console-message", (e) => log.push(`[${e.level}] ${e.message} (${e.sourceId?.split("/").pop()}:${e.lineNumber})`));
  win.webContents.on("render-process-gone", (_e, d) => log.push(`renderer gone: ${d.reason}`));
  const flush = () => writeFileSync(join(out, "console.txt"), log.join("\n"));
  const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no answer in ${ms} ms`); })]);
  try {
    const link = await consoleLink({ base: plan.base, token: readToken(home), next: plan.page ?? "/ui/terminal.html" });
    await win.loadURL(link);
    await sleep(plan.settle ?? 2500);
    for (const step of plan.steps) {
      let said = null;
      try { said = step.js ? await within(win.webContents.executeJavaScript(step.js), 10_000, step.name) : null; } catch (err) { said = { error: String(err?.message ?? err) }; }
      if (step.reload) { win.webContents.reload(); await new Promise((r) => win.webContents.once("did-finish-load", r)); }
      await sleep(step.wait ?? 800);
      flush();
      win.webContents.invalidate();
      await sleep(150);
      writeFileSync(join(out, `${step.name}.png`), (await within(win.webContents.capturePage(), 10_000, `${step.name} picture`)).toPNG());
      writeFileSync(join(out, `${step.name}.json`), JSON.stringify(said, null, 2) ?? "null");
    }
  } catch (err) {
    writeFileSync(join(out, "error.txt"), String(err?.stack ?? err));
  }
  flush();
  app.quit();
});
