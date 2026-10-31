/** What the simple view could show while an answer is being written (docs/simple-view-v0.md §5.14): real agents, a
 *  real model turn each — a probe, not a test.
 *
 *    node --import tsx scripts/stream_probe.ts claude <out dir>
 *    node --import tsx scripts/stream_probe.ts codex <out dir>
 *
 *  claude: a terminal as the service starts one; a long answer asked for through its own inbox (nothing typed). Every
 *    250 ms: how much of the answer is on its screen, and how much is in its record — whether the screen has it as it
 *    is written while the record has it only at the end.
 *  codex: a terminal on its private app-server; a second client follows the TUI's thread (`thread/resume`), asks for
 *    a long answer (`turn/start`), and counts the pieces of it it is sent (`item/agentMessage/delta`) against what the
 *    record and the TUI's screen have meanwhile; and asks for its background terminals (`thread/backgroundTerminals/list`).
 *
 *  Typed into a terminal: nothing. Answered for anyone: nothing. It ends everything it started and lists the sessions
 *  it made. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import * as pty from "node-pty";
import { agentLauncher } from "../src/terminals/launch.js";
import { inputEmpty, screenRows } from "../src/terminals/host.js";
import { AppServerClient } from "../src/harness/appserver.js";
import { connectWsLines } from "../src/harness/wsLines.js";

const which = process.argv[2];
const out = resolve(process.argv[3] ?? "stream-probe");
if (which !== "claude" && which !== "codex") { console.error("claude|codex <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const SOCKS = `/tmp/as-stream-${process.pid}`;
mkdirSync(SOCKS, { recursive: true, mode: 0o700 });
const STATE = join(out, "state");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const say = (line: string) => { console.log(line); log.push(line); };
const ASK = "〔探针〕请用中文写一段大约 600 字的说明：一个终端程序怎样把屏幕上的字画出来（不要用任何工具，不要分点，直接写成几段话）。";
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(AGENTSWITCH_|SECRET_GATE_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/.test(k))) as Record<string, string>;

const events: { at: number; event: string }[] = [];
let transcript: string | undefined;
const hooks = httpServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (req.url === "/terminals/hook") {
      const { event, payload } = JSON.parse(body || "{}") as { event: string; payload: Record<string, unknown> };
      events.push({ at: Date.now(), event });
      if (typeof payload?.transcript_path === "string") transcript = payload.transcript_path;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise<void>((ok) => hooks.listen(0, "127.0.0.1", () => ok()));
const hookUrl = `http://127.0.0.1:${(hooks.address() as { port: number }).port}`;

const started: pty.IPty[] = [];
function open(file: string, args: readonly string[], tenv: Record<string, string>) {
  const cols = 120, rows = 40;
  const term = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  const p = pty.spawn(file, [...args], { name: "xterm-256color", cols, rows, cwd: REPO, env: tenv });
  started.push(p);
  p.onData((d) => term.write(d));
  term.onData((d) => p.write(d));
  const lines = () => { const b = term.buffer.active, o: string[] = []; for (let y = 0; y < b.length; y++) o.push(b.getLine(y)?.translateToString(true) ?? ""); return o; };
  const ready = () => inputEmpty(screenRows(term, 12)) && !lines().slice(-40).some((l) => /^\s*(?:[›❯>]\s*)?\d+\.\s+\S/.test(l) || /trust this folder|Do you trust|need(?:s)? review/i.test(l));
  return { pty: p, lines, ready };
}
async function until(test: () => boolean, ms: number, step = 250): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) { if (test()) return true; await sleep(step); }
  return false;
}
/** Chinese characters in some text: how much of the answer there is (the screen's own words are English). */
const han = (s: string) => (s.match(/[一-鿿]/g) ?? []).length;
const ended: string[] = [];

try {
  if (which === "claude") await claude(); else await codex();
} catch (err) {
  say(`failed: ${(err as Error).stack ?? err}`);
} finally {
  for (const p of started) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
  await sleep(1500);
  for (const p of started) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
  hooks.close();
  try { execSync(`pkill -9 -f ${JSON.stringify(STATE)} || true; pkill -9 -f ${JSON.stringify(SOCKS)} || true`); } catch { /* none */ }
  await sleep(500);
  const left = execSync(`ps -axo pid,command | grep -F -e ${JSON.stringify(STATE)} -e ${JSON.stringify(SOCKS)} | grep -v grep || true`).toString().trim();
  say(`left running: ${left || "nothing"}`);
  rmSync(SOCKS, { recursive: true, force: true });
  writeFileSync(join(out, `${which}-sessions.txt`), ended.join("\n") + "\n");
  writeFileSync(join(out, `${which}.log`), log.join("\n") + "\n");
  process.exit(0);
}

/** The answer's characters in a Claude Code record: its assistant text so far. */
function recordHan(path: string | undefined): number {
  if (!path || !existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const d = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; text?: string }[] } };
      if (d.type === "assistant") for (const p of d.message?.content ?? []) if (p.type === "text") n += han(p.text ?? "");
    } catch { /* a line being written */ }
  }
  return n;
}

async function claude(): Promise<void> {
  const launch = agentLauncher({ binaries: { "claude-code": join(homedir(), ".local/bin/claude") }, hookUrl: () => hookUrl, stateDir: STATE, env });
  const inbox = join(SOCKS, "inbox.sock");
  const plan = launch({ id: "stream-claude", harness: "claude-code", cwd: REPO, mode: "manual", model: "sonnet", hookToken: "probe" });
  const t = open(plan.file, [...plan.args, "--messaging-socket-path", inbox], plan.env);
  if (!await until(t.ready, 45_000)) { writeFileSync(join(out, "claude-stuck.txt"), t.lines().join("\n")); say("stopped: its input is not on screen"); return; }
  const dir = join(homedir(), ".claude", "sessions");
  const key = readdirSync(dir).find((f) => f.startsWith(`${t.pty.pid}.`) && f.endsWith(".key"));
  const token = key ? (JSON.parse(readFileSync(join(dir, key), "utf8")) as { peerToken?: string }).peerToken : undefined;
  if (!token) { say("stopped: no peer key"); return; }
  const body = `<cross-session-message from="uds:${join(SOCKS, "from.sock")}" from-name="probe">\n${ASK}\n</cross-session-message>`;
  await new Promise<void>((ok, fail) => { const c = connect({ path: inbox }, () => c.end([{ type: "auth", token }, { type: "user", message: { role: "user", content: body }, msg_id: randomUUID(), priority: "next" }].map((l) => JSON.stringify(l)).join("\n") + "\n")); c.on("close", () => ok()); c.on("error", fail); });
  const sentAt = Date.now();
  const samples: string[] = [];
  let lastScreen = -1, lastRecord = -1;
  const askHan = han(ASK);
  while (Date.now() - sentAt < 180_000) {
    const screen = Math.max(0, han(t.lines().join("\n")) - askHan - 40);   // its own echo of what was asked, and a little slack
    const rec = recordHan(transcript);
    if (screen !== lastScreen || rec !== lastRecord) samples.push(`${((Date.now() - sentAt) / 1000).toFixed(2)}s screen ${screen} record ${rec}`);
    lastScreen = screen; lastRecord = rec;
    if (events.some((e) => e.event === "Stop" && e.at > sentAt)) break;
    await sleep(250);
  }
  writeFileSync(join(out, "claude-samples.txt"), samples.join("\n") + "\n");
  writeFileSync(join(out, "claude-end.txt"), t.lines().join("\n"));
  const growing = samples.filter((s) => / screen [1-9]\d* record 0$/.test(s)).length;
  say(`claude: ${samples.length} changes; while the record had none of the answer, the screen had more of it ${growing} times`);
  for (const s of samples.slice(0, 6).concat(samples.slice(-4))) say(`  ${s}`);
  if (transcript) ended.push(transcript);
}

async function codex(): Promise<void> {
  const bin = join(homedir(), ".local/share/agentswitch/cli/codex/beta/0.163.0-alpha.5/bin/codex");
  const daemons = () => execSync("ps -axo command | grep -e '--managed-daemon' | grep -v grep || true").toString().trim();
  const before = daemons();
  const launch = agentLauncher({ binaries: { codex: bin }, hookUrl: () => hookUrl, stateDir: STATE, env, codexHooks: () => false, codexServer: true });
  const plan = launch({ id: "stream-codex", harness: "codex", cwd: REPO, mode: "manual", hookToken: "probe" });
  const companion = plan.companion as unknown as { start(): Promise<{ args: string[]; env: Record<string, string> } | null>; stop(): void; server?: { url: string; token: string } | null };
  const tui = await companion.start();
  if (!tui || !companion.server) { say("stopped: its app-server did not start"); return; }
  try {
    const t = open(plan.file, tui.args, tui.env);
    if (!await until(t.ready, 45_000)) { writeFileSync(join(out, "codex-stuck.txt"), t.lines().join("\n")); say("stopped: its input is not on screen"); return; }
    const ws = await connectWsLines(companion.server.url, { token: companion.server.token, timeoutMs: 10_000 });
    const notes: { at: number; method: string; delta?: string }[] = [];
    const rpc = new AppServerClient(ws.input, ws.output, async () => ({ decision: "decline" }), (method, params) => {
      const delta = (params as { delta?: unknown } | undefined)?.delta;
      notes.push({ at: Date.now(), method, ...(typeof delta === "string" ? { delta } : {}) });
    });
    await rpc.request("initialize", { clientInfo: { name: "agentswitch-probe", version: "1" }, capabilities: { experimentalApi: true } }, 10_000);
    rpc.notify("initialized");
    let thread: string | undefined;
    for (const stop = Date.now() + 20_000; !thread && Date.now() < stop; await sleep(500)) {
      for (const id of ((await rpc.request("thread/loaded/list", {}, 10_000)).data as string[] | undefined) ?? []) {
        const read = ((await rpc.request("thread/read", { threadId: id, includeTurns: false }, 10_000)).thread ?? {}) as { ephemeral?: boolean; path?: string };
        if (read.ephemeral) continue;
        thread = id; transcript = read.path; break;
      }
    }
    if (!thread) { say("stopped: the TUI's thread did not appear"); return; }
    let terminals: unknown;
    try { terminals = await rpc.request("thread/backgroundTerminals/list", { threadId: thread }, 10_000); } catch (err) { terminals = { error: String(err) }; }
    say(`codex: thread/backgroundTerminals/list: ${JSON.stringify(terminals).slice(0, 200)}`);
    const sentAt = Date.now();
    await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: ASK }] }, 20_000);
    // A thread has no record before its first turn, and `thread/resume` wants one: followed once the turn has begun.
    let resumed: unknown = null;
    for (const stop = Date.now() + 8_000; Date.now() < stop; await sleep(250)) {
      try { resumed = await rpc.request("thread/resume", { threadId: thread }, 20_000); break; } catch (err) { resumed = { error: String(err) }; }
    }
    say(`codex: thread/resume from the second client, ${((Date.now() - sentAt) / 1000).toFixed(1)} s after turn/start: ${JSON.stringify(resumed).slice(0, 200)}`);
    const askHan = han(ASK);
    const samples: string[] = [];
    let last = "";
    while (Date.now() - sentAt < 180_000) {
      const deltas = notes.filter((n) => n.method === "item/agentMessage/delta");
      const got = han(deltas.map((n) => n.delta ?? "").join(""));
      const screen = Math.max(0, han(t.lines().join("\n")) - askHan - 40);
      const rec = transcript && existsSync(transcript) ? statSync(transcript).size : 0;
      const now = `deltas ${deltas.length} (${got} chars) screen ${screen} record ${rec} bytes`;
      if (now !== last) samples.push(`${((Date.now() - sentAt) / 1000).toFixed(2)}s ${now}`);
      last = now;
      if (notes.some((n) => n.method === "turn/completed" && n.at > sentAt)) break;
      await sleep(250);
    }
    writeFileSync(join(out, "codex-samples.txt"), samples.join("\n") + "\n");
    writeFileSync(join(out, "codex-end.txt"), t.lines().join("\n"));
    const kinds = [...new Set(notes.filter((n) => n.at > sentAt).map((n) => n.method))];
    say(`codex: ${samples.length} changes; told after turn/start: ${kinds.slice(0, 18).join(" ")}`);
    for (const s of samples.slice(0, 6).concat(samples.slice(-3))) say(`  ${s}`);
    try { ws.input.end(); } catch { /* gone */ }
    if (transcript) ended.push(transcript);
  } finally {
    companion.stop();
    await sleep(1000);
    say(`codex's managed daemon: before ${before ? "running" : "not running"}, after ${daemons() ? "running" : "not running"}`);
  }
}
