/** Probe (2026-10-09, OpenCode 2.0.25): how does the TUI take a model when it starts? 2.0.25 dropped `-m` from the
 *  main command (`Unrecognized flag: -m in command opencode`; `run` and `mini` keep it), so a terminal can no longer
 *  name its model on the command line. This starts the real TUI the way a terminal does — a private `serve --stdio`,
 *  the TUI attached with `--server` — in a throw-away environment (its own XDG directories, a made-up provider that
 *  points nowhere), and prints what the server and the screen say. Nothing is typed and no model is called.
 *  The last two go through the terminals' own launcher (`agentLauncher`, its companion): what a terminal started on a
 *  model, and one gone on with on another model, look like.
 *    npx tsx scripts/opencode_model_probe.ts [case …]
 *    cases: none config variant agent session project content resume launcher launcher-resume
 *
 *  Seen on 2.0.25: `model` in the configuration is what the TUI opens on, `provider/model#variant` with its level; the
 *  folder's own `opencode.json` is above the OPENCODE_CONFIG file and below OPENCODE_CONFIG_CONTENT; `--session` with
 *  an id nobody has makes no session until the first message; a session gone on with keeps its own model, and follows
 *  `POST /api/session/:id/model` ("Switched model to …"). */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import headless from "@xterm/headless";
import pty from "node-pty";
import { basicAuth, startStdioServe, stopStdioServe } from "../src/harness/opencodeStdio.js";
import { agentLauncher } from "../src/terminals/launch.js";

const binary = process.env.OPENCODE_BIN ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 9_000);
type Json = Record<string, unknown>;

const provider = {
  demo: {
    npm: "@ai-sdk/openai-compatible", name: "Demo", options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "none" },
    models: {
      alpha: { name: "Alpha", reasoning: true, tool_call: true, limit: { context: 200000, output: 8000 }, variants: { low: {}, high: {} } },
      beta: { name: "Beta", reasoning: true, tool_call: true, limit: { context: 200000, output: 8000 }, variants: { low: {}, high: {} } },
    },
  },
};

type Case = {
  readonly config: Json;
  readonly args?: (session: string) => string[];
  readonly after?: "setModel";
  /** The folder's own `opencode.json`, which names another model. */
  readonly project?: Json;
  /** The same config as OPENCODE_CONFIG_CONTENT instead of the OPENCODE_CONFIG file. */
  readonly inline?: boolean;
  /** A session made on the server before the TUI starts, on another model: the TUI resumes it. */
  readonly made?: Json;
};
const CASES: Record<string, Case> = {
  none: { config: {} },
  config: { config: { model: "demo/beta" } },
  variant: { config: { model: "demo/beta#high" } },
  agent: { config: { model: "demo/beta", agent: { build: { model: "demo/beta", variant: "high" } } } },
  session: { config: {}, args: (id) => ["--session", id], after: "setModel" },
  project: { config: { model: "demo/beta#high" }, project: { model: "demo/alpha" } },
  content: { config: { model: "demo/beta#high" }, project: { model: "demo/alpha" }, inline: true },
  resume: { config: { model: "demo/beta#high" }, made: { providerID: "demo", id: "alpha", variant: "low" }, after: "setModel" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function one(name: string, c: Case): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ocmodel-")));
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd, { recursive: true });
  const xdg = Object.fromEntries(["DATA", "CONFIG", "CACHE", "STATE"].map((k) => [`XDG_${k}_HOME`, join(scratch, k.toLowerCase())]));
  const config = join(scratch, "opencode.json");
  writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json", provider, ...(c.inline ? {} : c.config) }, null, 2));
  if (c.project) writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...c.project }, null, 2));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", LANG: "en_US.UTF-8",
    ...xdg, OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...(c.inline ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(c.config) } : {}),
  };
  console.log(`\n=== ${name}: ${c.inline ? "OPENCODE_CONFIG_CONTENT" : "OPENCODE_CONFIG"} ${JSON.stringify(c.config)}${c.project ? `, the folder's own ${JSON.stringify(c.project)}` : ""}`);
  const server = await startStdioServe({ binary, cwd, env, port: 0 });
  const call = async (method: string, path: string, body?: Json): Promise<{ status: number; json: Json | null }> => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { authorization: basicAuth(server.password), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000) });
    const text = await res.text();
    let json: Json | null = null;
    try { json = JSON.parse(text) as Json; } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const loc = `directory=${encodeURIComponent(cwd)}`;
  try {
    const models = (await call("GET", `/api/model?${loc}`)).json?.data;
    console.log(`models: ${(Array.isArray(models) ? models as Json[] : []).map((m) => `${String(m.providerID)}/${String(m.id)}[${(Array.isArray(m.variants) ? m.variants as Json[] : []).map((v) => String(v.id)).join(",")}]`).join(" ") || "(none)"}`);
    let session = `ses_${Date.now().toString(16)}probe${Math.random().toString(36).slice(2, 10)}`;
    if (c.made) {
      const made = await call("POST", "/api/session", { title: "probe", model: c.made, location: { directory: cwd } });
      const id = (made.json?.data as Json | undefined)?.id;
      console.log(`a session made first: ${made.status} ${typeof id === "string" ? id : JSON.stringify(made.json).slice(0, 300)} model=${JSON.stringify((made.json?.data as Json | undefined)?.model ?? null)}`);
      if (typeof id === "string") session = id;
    }
    const args = ["--server", server.url, ...(c.args?.(session) ?? (c.made ? ["--session", session] : []))];
    console.log(`tui: opencode ${args.map((a) => (a === server.url ? "<url>" : a)).join(" ")}`);
    const term = new headless.Terminal({ cols: 120, rows: 36, allowProposedApi: true });
    const child = pty.spawn(binary, args, { name: "xterm-256color", cols: 120, rows: 36, cwd, env: { ...env, OPENCODE_PASSWORD: server.password } });
    let exited: number | null = null;
    child.onData((d) => term.write(d));
    child.onExit((e) => { exited = e.exitCode; });
    await sleep(WAIT_MS);
    const listed = (await call("GET", `/api/session?${loc}`)).json?.data;
    const sessions = (Array.isArray(listed) ? listed as Json[] : []);
    console.log(`sessions on the server after ${WAIT_MS} ms: ${sessions.length}${sessions.map((s) => ` ${String(s.id)} model=${JSON.stringify(s.model ?? null)}`).join("")}`);
    if (c.after === "setModel") {
      const set = await call("POST", `/api/session/${encodeURIComponent(session)}/model?${loc}`, { model: { providerID: "demo", id: "beta", variant: "high" } });
      console.log(`POST /api/session/<id>/model → ${set.status} ${JSON.stringify(set.json).slice(0, 200)}`);
      await sleep(2_500);
      const now = (await call("GET", `/api/session/${encodeURIComponent(session)}?${loc}`));
      console.log(`session now: ${now.status} model=${JSON.stringify((now.json?.data as Json | undefined)?.model ?? null)}`);
    }
    await new Promise<void>((r) => term.write("", r));
    const rows: string[] = [];
    for (let y = 0; y < term.rows; y++) rows.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
    const shown = () => { for (const row of rows) if (row.trim() && !/[█▀▄]{3}/.test(row.replace(/[┃╹]/g, "").slice(0, 60).trim().slice(0, 3))) console.log(`  | ${row.trimEnd()}`); };
    console.log(exited === null ? "screen:" : `tui exited with ${exited}; screen:`);
    shown();
    if (exited === null) child.kill();
  } finally {
    await stopStdioServe(server.child);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Through the launcher: a terminal on `demo/beta` at `high`, new or going on with a session that was on another. */
async function launched(name: string, resume: boolean): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ocmodel-")));
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "demo/alpha" }, null, 2));
  const xdg = Object.fromEntries(["DATA", "CONFIG", "CACHE", "STATE"].map((k) => [`XDG_${k}_HOME`, join(scratch, k.toLowerCase())]));
  const config = join(scratch, "opencode.json");
  writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json", provider }, null, 2));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", LANG: "en_US.UTF-8", ...xdg, OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: "1" };
  console.log(`\n=== ${name}: the launcher, model demo/beta, effort high${resume ? ", going on with a session that was on demo/alpha at low" : ""}; the folder's own config names demo/alpha`);
  let session: string | undefined;
  try {
    if (resume) {
      const first = await startStdioServe({ binary, cwd, env, port: 0 });
      const res = await fetch(`${first.url}/api/session`, { method: "POST", headers: { authorization: basicAuth(first.password), "content-type": "application/json" }, body: JSON.stringify({ title: "probe", model: { providerID: "demo", id: "alpha", variant: "low" }, location: { directory: cwd } }) });
      session = String(((await res.json()) as { data?: Json }).data?.id ?? "");
      await stopStdioServe(first.child);
      console.log(`a session made first: ${res.status} ${session}`);
    }
    const launch = agentLauncher({ binaries: { opencode: binary }, hookUrl: () => "http://127.0.0.1:9", stateDir: join(scratch, "state-dir"), env, opencodeServer: true });
    const plan = launch({ id: "probe", harness: "opencode", cwd, mode: "manual", hookToken: "tok", model: "demo/beta", effort: "high", ...(session ? { resume: session } : {}) });
    const started = await plan.companion!.start();
    const args = started?.args ?? plan.args, runEnv = started?.env ?? plan.env;
    console.log(`tui: opencode ${args.map((a) => (/^https?:/.test(a) ? "<url>" : a)).join(" ")}    OPENCODE_CONFIG_CONTENT=${runEnv.OPENCODE_CONFIG_CONTENT ?? "(none)"}`);
    const term = new headless.Terminal({ cols: 120, rows: 36, allowProposedApi: true });
    const child = pty.spawn(binary, [...args], { name: "xterm-256color", cols: 120, rows: 36, cwd, env: runEnv });
    let exited: number | null = null;
    child.onData((d) => term.write(d));
    child.onExit((e) => { exited = e.exitCode; });
    const statuses: string[] = [];
    plan.companion!.attach({ status: (st) => { if (statuses.at(-1) !== st) statuses.push(st); }, ask: async () => null });
    await sleep(WAIT_MS + 3_000);
    await new Promise<void>((r) => term.write("", r));
    console.log(`${exited === null ? "" : `tui exited with ${exited}; `}statuses: ${statuses.join(" → ") || "(none)"}; screen:`);
    for (let y = 0; y < term.rows; y++) {
      const row = term.buffer.active.getLine(y)?.translateToString(true) ?? "";
      if (row.trim() && !/[█▀▄]{3}/.test(row.replace(/[┃╹]/g, "").trim().slice(0, 3))) console.log(`  | ${row.trimEnd()}`);
    }
    if (exited === null) child.kill();
    plan.companion!.stop();
    await sleep(1_500);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const want = process.argv.slice(2);
for (const [name, c] of Object.entries(CASES)) if (!want.length || want.includes(name)) await one(name, c);
if (!want.length || want.includes("launcher")) await launched("launcher", false);
if (!want.length || want.includes("launcher-resume")) await launched("launcher-resume", true);
process.exit(0);
