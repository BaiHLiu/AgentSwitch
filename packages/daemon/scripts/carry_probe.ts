/** How a message reaches an agent already at work in a terminal without being typed into it, and how a note reaches it
 *  at its next step (docs/talk-v0.md §10). Real agents, a real model turn each — a probe, not a test.
 *
 *    node --import tsx scripts/carry_probe.ts claude <out dir>
 *    node --import tsx scripts/carry_probe.ts codex <out dir>
 *
 *  claude: a terminal started as the service starts one (`agentLauncher`, its hooks pointed at this script's own
 *    stand-in for the service), with `--messaging-socket-path`. Once its input is on screen and empty, a frame is sent
 *    to that socket — Claude Code's own cross-session inbox — and the PostToolUse hook answers with a note
 *    (`additionalContext`). Then the same frame to a terminal in bypass mode, where an outside message waits for the
 *    person: nothing there is approved, it is ended.
 *  codex: a terminal as the service starts one, on its private app-server; a second client starts a turn on the
 *    TUI's thread (`turn/start`). Where the user's Codex already trusts the installed app's hooks (read with `hooks/list`,
 *    never written), they are on too and PostToolUse answers with the note.
 *
 *  attest: Claude Code's permission-mode parity. A message in its own envelope (`<cross-session-message from=…
 *    from-name=… from-mode=…>`) with the sender's mode, to a terminal in bypass mode (from `bypass`: delivered? from
 *    `prompting`: held?) and to one in manual mode (from `bypass`: held?). One real turn at most.
 *  steer: Send To's two ways into a Codex terminal at work — `turn/steer` into the turn it is doing, and
 *    `turn/interrupt` and then `turn/start`.
 *
 *  Typed into a terminal: nothing. Answered for anyone: nothing (the one command it lets run is `pwd`, by a flag of
 *  this run). It stops at anything on a screen it does not expect, prints the screen, and ends what it started. What it
 *  saw goes to <out dir>: screens, the frames it got back, the hooks' events, the record as the simple view reads it,
 *  and the paths of the sessions it made. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { connect, createServer as netServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import headless from "@xterm/headless";
import * as pty from "node-pty";
import { agentLauncher } from "../src/terminals/launch.js";
import { inputEmpty, screenRows } from "../src/terminals/host.js";
import { codexHookArgs } from "../src/terminals/codexHooks.js";
import { readRecord } from "../src/sessions/record.js";
import { AppServerClient } from "../src/harness/appserver.js";
import { connectWsLines } from "../src/harness/wsLines.js";

const which = process.argv[2];
const out = resolve(process.argv[3] ?? "carry-probe");
if (!["claude", "codex", "attest", "steer"].includes(which ?? "")) { console.error("claude|codex|attest|steer <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const REPO = resolve(import.meta.dirname, "..", "..", "..");
// Sockets want a short path (104 bytes on macOS).
const SOCKS = `/tmp/as-carry-${process.pid}`;
mkdirSync(SOCKS, { recursive: true, mode: 0o700 });
const STATE = join(out, "state");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => { console.log(line); log.push(line); };
const log: string[] = [];
const NOTE = "AgentSwitch：05 · Codex 留了一条知会（不用回复它）：登录接口新加的字段定名为 refreshToken。";
const MARK = "〔搬话 · 探针〕";

// What the service's own variables would carry in from this terminal (it runs inside AgentSwitch) stays out.
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(AGENTSWITCH_|SECRET_GATE_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/.test(k))) as Record<string, string>;

// ---- a stand-in for the service: the hooks report here, and PostToolUse answers once with the note
const events: { at: number; event: string; tool?: string; session?: string }[] = [];
let session: { id?: string; transcript?: string } = {};
let noted = false;
const hooks = httpServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    let output: unknown = undefined;
    if (req.url === "/terminals/hook") {
      const { event, payload } = JSON.parse(body || "{}") as { event: string; payload: Record<string, unknown> };
      const p = payload ?? {};
      events.push({ at: Date.now(), event, ...(typeof p.tool_name === "string" ? { tool: p.tool_name } : {}), ...(typeof p.session_id === "string" ? { session: p.session_id } : {}) });
      if (typeof p.session_id === "string") session.id = p.session_id;
      if (typeof p.transcript_path === "string") session.transcript = p.transcript_path;
      if (event === "PostToolUse" && !noted) { noted = true; output = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NOTE } }; }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(output ? { output } : {}));
  });
});
await new Promise<void>((ok) => hooks.listen(0, "127.0.0.1", () => ok()));
const hookUrl = `http://127.0.0.1:${(hooks.address() as { port: number }).port}`;

// ---- a terminal: the program in a pty, its screen kept by a headless terminal as the service keeps it
type Term = { pty: pty.IPty; term: headless.Terminal; lines: () => string[]; ready: () => boolean };
const started: pty.IPty[] = [];
function open(file: string, args: readonly string[], tenv: Record<string, string>): Term {
  const cols = 120, rows = 40;
  const term = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  const p = pty.spawn(file, [...args], { name: "xterm-256color", cols, rows, cwd: REPO, env: tenv });
  started.push(p);
  p.onData((d) => term.write(d));
  term.onData((d) => p.write(d));   // the terminal's own answers to the program's questions (cursor place, colours)
  const lines = () => { const b = term.buffer.active, o: string[] = []; for (let y = b.baseY; y < b.baseY + rows; y++) o.push(b.getLine(y)?.translateToString(true) ?? ""); return o; };
  // Its input on screen and empty, and no list of choices anywhere (a question, a folder's trust): the service's test.
  const ready = () => inputEmpty(screenRows(term, 12)) && !lines().some((l) => /^\s*(?:[›❯>]\s*)?\d+\.\s+\S/.test(l) || /trust this folder|Do you trust|need(?:s)? review/i.test(l));
  return { pty: p, term, lines, ready };
}
const shot = (t: Term, name: string) => writeFileSync(join(out, `${name}.txt`), t.lines().join("\n").replace(/\s+$/gm, "") + "\n");
async function until(what: string, test: () => boolean, ms: number, step = 250): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) { if (test()) return true; await sleep(step); }
  say(`  (no ${what} within ${ms / 1000} s)`);
  return false;
}

// ---- a listener for what comes back to the address a frame names as its sender
const frames: { at: number; frame: unknown }[] = [];
function listen(path: string): Server {
  rmSync(path, { force: true });
  const s = netServer((c: Socket) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let frame: unknown; try { frame = JSON.parse(line); } catch { frame = { unparsed: line.slice(0, 200) }; }
        // An auth line names a token: never kept.
        if (frame && typeof frame === "object" && (frame as { type?: unknown }).type === "auth") frame = { type: "auth", token: "(not kept)" };
        frames.push({ at: Date.now(), frame });
      }
    });
  });
  s.listen(path);
  return s;
}
function send(path: string, lines: readonly unknown[]): Promise<void> {
  return new Promise((ok, fail) => {
    const c = connect({ path }, () => { c.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); });
    c.on("close", () => ok());
    c.on("error", fail);
  });
}

/** The record as the simple view reads it, the probe's turn: each item's kind and the start of its text. */
function record(harness: "claude-code" | "codex", path: string | undefined): void {
  if (!path || !existsSync(path)) { say(`  record: none found (${path ?? "no path"})`); return; }
  const r = readRecord(harness, path, { cwd: REPO });
  const items = (r?.items ?? []).map((i) => ({ kind: i.type, text: ("text" in i ? i.text : "").replace(/\s+/g, " ").slice(0, 160), steps: "steps" in i ? i.steps.length : 0 }));
  writeFileSync(join(out, `${which}-record-items.json`), JSON.stringify(items, null, 1));
  say(`  record (simple view): ${items.map((i) => i.kind).join(", ") || "nothing"}`);
  for (const i of items) say(`    ${i.kind}${i.steps ? ` (${i.steps} steps)` : ""}: ${i.text}`);
}

const ended: string[] = [];
async function end(): Promise<void> {
  for (const p of started) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } try { p.kill(); } catch { /* gone */ } }
  await sleep(1500);
  for (const p of started) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } }
  hooks.close();
}

try {
  if (which === "claude") await claude(); else if (which === "attest") await attest(); else await codex(which === "steer");
} catch (err) {
  say(`failed: ${(err as Error).stack ?? err}`);
} finally {
  await end();
  // Anything still running that names this run's folders.
  try { execSync(`pkill -9 -f ${JSON.stringify(STATE)} || true; pkill -9 -f ${JSON.stringify(SOCKS)} || true`); } catch { /* none */ }
  await sleep(500);
  const left = execSync(`ps -axo pid,command | grep -F -e ${JSON.stringify(STATE)} -e ${JSON.stringify(SOCKS)} | grep -v grep || true`).toString().trim();
  say(`left running: ${left || "nothing"}`);
  rmSync(SOCKS, { recursive: true, force: true });
  writeFileSync(join(out, `${which}-hooks.json`), JSON.stringify(events, null, 1));
  writeFileSync(join(out, `${which}-frames.json`), JSON.stringify(frames, null, 1));
  writeFileSync(join(out, `${which}-sessions.txt`), ended.join("\n") + "\n");
  writeFileSync(join(out, `${which}.log`), log.join("\n") + "\n");
  process.exit(0);
}

// ---- Claude Code
async function claude(): Promise<void> {
  const launch = agentLauncher({ binaries: { "claude-code": join(homedir(), ".local/bin/claude") }, hookUrl: () => hookUrl, stateDir: STATE, env });
  for (const mode of ["manual", "bypass"] as const) {
    say(`== Claude Code, ${mode}`);
    session = {}; noted = false;
    const inbox = join(SOCKS, `${mode}.sock`), back = join(SOCKS, `${mode}-from.sock`);
    const plan = launch({ id: `carry-${mode}`, harness: "claude-code", cwd: REPO, mode, model: "sonnet", hookToken: "probe" });
    const t = open(plan.file, [...plan.args, "--messaging-socket-path", inbox, "--allowedTools", "Bash(pwd)"], plan.env);
    if (!await until("input box", t.ready, 45_000)) { shot(t, `claude-${mode}-stuck`); say("  stopped: its input is not on screen (see the screen)"); return; }
    shot(t, `claude-${mode}-0-ready`);
    // Its peer key, as any peer of it reads it: next to its other session files, by its pid.
    const dir = join(homedir(), ".claude", "sessions");
    const key = readdirSync(dir).find((f) => f.startsWith(`${t.pty.pid}.`) && f.endsWith(".key"));
    if (!key || !existsSync(inbox)) { say(`  stopped: no inbox (${existsSync(inbox) ? "socket there" : "no socket"}, ${key ? "key there" : "no key"})`); return; }
    const token = (JSON.parse(readFileSync(join(dir, key), "utf8")) as { peerToken?: string }).peerToken;
    say(`  inbox at its socket; its key file names a peer token: ${token ? "yes" : "no"}`);
    const replies = listen(back);
    const text = `${MARK}07 · Codex（管 packages/daemon）对你说：\n我把 /api/login 的返回加了 refreshToken 字段，你那边的登录页按它改。\n\n` +
      "（这是一次试验：请运行一次 `pwd`，然后用两句话回答：1. 这句话是谁、经什么到你这里的（你看得出来的话）；2. 运行 pwd 之后你有没有收到别的附加说明，有的话原样写出来。不要改任何文件。）";
    const sentAt = Date.now();
    await send(inbox, [{ type: "auth", token }, { type: "user", message: { role: "user", content: text }, from: `uds:${back}`, msg_id: randomUUID(), priority: "next" }]);
    say("  frame sent");
    await sleep(3000);
    shot(t, `claude-${mode}-1-after-3s`);
    const stopped = () => events.some((e) => e.event === "Stop" && e.at > sentAt);
    const waited = await until("end of a turn", stopped, mode === "bypass" ? 20_000 : 150_000, 500);
    await sleep(2500);
    shot(t, `claude-${mode}-2-end`);
    say(`  a turn ran and ended: ${waited ? "yes" : "no"}; hooks after the frame: ${events.filter((e) => e.at > sentAt).map((e) => e.event + (e.tool ? `(${e.tool})` : "")).join(" ") || "none"}`);
    say(`  the note given at PostToolUse: ${noted ? "yes" : "no"}`);
    say(`  frames back to its sender: ${frames.length ? frames.map((f) => JSON.stringify(f.frame).slice(0, 200)).join(" | ") : "none"}`);
    if (session.transcript) { ended.push(session.transcript); record("claude-code", session.transcript); }
    replies.close();
    try { process.kill(-t.pty.pid, "SIGTERM"); } catch { t.pty.kill(); }
    await sleep(1500);
    say(`  its key file after it ended: ${existsSync(join(dir, key)) ? "still there" : "gone"}`);
  }
}

// ---- Codex
async function codex(steer = false): Promise<void> {
  const bin = join(homedir(), ".local/share/agentswitch/cli/codex/beta/0.163.0-alpha.5/bin/codex");
  // The installed app's hook command is the text the user's Codex trusts (docs/terminal-v0.md §3).
  const app = join(REPO, "packages/mac-app/build/AgentSwitch.app/Contents/Resources/runtime");
  const node = join(app, "node/bin/node"), hookScript = join(app, "daemon/dist/terminals/hookClient.js");
  const daemons = () => execSync("ps -axo command | grep -e '--managed-daemon' | grep -v grep || true").toString().trim();
  const before = daemons();
  let trusted = false;
  if (existsSync(node) && existsSync(hookScript)) {
    const shq = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
    const args = codexHookArgs(`${shq(node)} ${shq(hookScript)}`, 10, 30 * 60);
    const child = spawn(bin, [...args, "app-server"], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SOCKS });
    const c = new AppServerClient(child.stdin!, child.stdout!, async () => ({ decision: "decline" }), () => undefined);
    try {
      await c.request("initialize", { clientInfo: { name: "agentswitch-probe", version: "1" } }, 20_000);
      c.notify("initialized");
      const listed = await c.request("hooks/list", { cwds: [SOCKS] }, 20_000);
      const mine = ((listed.data as { hooks?: { source?: string; trustStatus?: string }[] }[] | undefined)?.[0]?.hooks ?? []).filter((h) => h.source === "sessionFlags");
      trusted = mine.length > 0 && mine.every((h) => h.trustStatus === "trusted");
      say(`== Codex hooks of the installed app: ${mine.length} listed, ${trusted ? "all trusted" : "not all trusted — run without them"}`);
    } finally { child.kill("SIGKILL"); }
  }
  const launch = agentLauncher({ binaries: { codex: bin }, hookUrl: () => hookUrl, stateDir: STATE, env, node, hookScript, codexHooks: () => trusted, codexServer: true });
  const plan = launch({ id: "carry-codex", harness: "codex", cwd: REPO, mode: "manual", hookToken: "probe" });
  const companion = plan.companion as unknown as { start(): Promise<{ args: string[]; env: Record<string, string> } | null>; stop(): void; server?: { url: string; token: string } | null };
  const tui = await companion.start();
  if (!tui || !companion.server) { say("stopped: its app-server did not start"); return; }
  try {
    const t = open(plan.file, tui.args, tui.env);
    if (!await until("composer", t.ready, 45_000)) { shot(t, "codex-stuck"); say("  stopped: its input is not on screen (see the screen)"); return; }
    shot(t, "codex-0-ready");
    const ws = await connectWsLines(companion.server.url, { token: companion.server.token, timeoutMs: 10_000 });
    const notes: string[] = [];
    const rpc = new AppServerClient(ws.input, ws.output, async () => ({ decision: "decline" }), (method: string) => { notes.push(method); });
    await rpc.request("initialize", { clientInfo: { name: "agentswitch-probe", version: "1" }, capabilities: { experimentalApi: true } }, 10_000);
    rpc.notify("initialized");
    let thread: string | undefined;
    for (const stop = Date.now() + 20_000; !thread && Date.now() < stop; await sleep(500)) {
      const loaded = ((await rpc.request("thread/loaded/list", {}, 10_000)).data as string[] | undefined) ?? [];
      for (const id of loaded) {
        const read = ((await rpc.request("thread/read", { threadId: id, includeTurns: false }, 10_000)).thread ?? {}) as { ephemeral?: boolean; path?: string };
        if (read.ephemeral) continue;
        thread = id;
        if (typeof read.path === "string") session.transcript = read.path;
        break;
      }
    }
    if (!thread) { say("  stopped: the TUI's thread did not appear"); return; }
    say(`  the TUI's thread: found; its record: ${session.transcript ? "named" : "not named yet"}`);
    if (steer) { await steering(t, rpc, thread); return; }
    const text = `${MARK}07 · Claude Code（管 packages/mac-app）对你说：\n我这边按 /api/login 的新返回改完了登录页。\n\n` +
      "（这是一次试验：请运行一次 `pwd`，然后用两句话回答：1. 这句话是谁、经什么到你这里的（你看得出来的话）；2. 运行 pwd 之后你有没有收到别的附加说明，有的话原样写出来。不要改任何文件。）";
    const sentAt = Date.now();
    const turn = await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text }] }, 20_000);
    say(`  turn/start answered: ${JSON.stringify(turn).slice(0, 160)}`);
    await sleep(3000);
    shot(t, "codex-1-after-3s");
    const done = () => notes.includes("turn/completed") || events.some((e) => e.event === "Stop" && e.at > sentAt);
    const waited = await until("end of the turn", done, 180_000, 500);
    await sleep(2500);
    shot(t, "codex-2-end");
    say(`  the turn ended: ${waited ? "yes" : "no"}; hooks after it: ${events.filter((e) => e.at > sentAt).map((e) => e.event + (e.tool ? `(${e.tool})` : "")).join(" ") || "none"}`);
    say(`  the note given at PostToolUse: ${noted ? "yes" : "no"}; the server told the second client: ${[...new Set(notes)].slice(0, 14).join(" ")}`);
    if (!session.transcript) {
      const read = ((await rpc.request("thread/read", { threadId: thread, includeTurns: false }, 10_000)).thread ?? {}) as { path?: string };
      if (typeof read.path === "string") session.transcript = read.path;
    }
    try { ws.input.end(); } catch { /* gone */ }
    if (session.transcript) { ended.push(session.transcript); record("codex", session.transcript); }
  } finally {
    companion.stop();
    await sleep(1000);
    const after = daemons();
    say(`  Codex's managed daemon: before ${before ? "running" : "not running"}, after ${after ? "running" : "not running"}`);
  }
}

/** Send To's two ways into a Codex turn that is going on (docs/talk-v0.md §10.2): into it (`turn/steer`), or after
 *  stopping it (`turn/interrupt`, then `turn/start`). */
async function steering(t: Term, rpc: AppServerClient, thread: string): Promise<void> {
  const stops = () => events.filter((e) => e.event === "Stop").length;
  const turnId = (r: unknown) => ((r as { turn?: { id?: string } }).turn?.id);
  // 1. Into the turn it is doing.
  let before = stops();
  const first = await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: `${MARK}请运行 \`sleep 12 && echo first-done\`，然后用一句话说你做完了。不要改任何文件。` }] }, 20_000);
  const id1 = turnId(first);
  await until("the command running", () => t.lines().some((l) => /sleep 12/.test(l)), 30_000);
  await sleep(1500);
  shot(t, "steer-1-running");
  let steered: unknown;
  try { steered = await rpc.request("turn/steer", { threadId: thread, expectedTurnId: id1, input: [{ type: "text", text: `${MARK}（追加，来自 07 · Claude Code）回答的最后加上 STEER-OK 这几个字母。` }] }, 20_000); }
  catch (err) { steered = { error: String(err) }; }
  say(`  turn/steer while it ran: ${JSON.stringify(steered).slice(0, 200)}`);
  await until("end of the first turn", () => stops() > before, 120_000, 500);
  await sleep(2000);
  shot(t, "steer-2-end");
  const last = t.lines();
  // The steered words have STEER-OK in them too: the answer is a line that has it and not them.
  say(`  the answer has STEER-OK: ${last.some((l) => /STEER-OK/.test(l) && !/追加/.test(l)) ? "yes" : "no"}; the steered words on its screen: ${last.some((l) => /追加，来自 07/.test(l)) ? "yes" : "no"}`);
  // 2. Stopped, then a new one.
  before = stops();
  const second = await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: `${MARK}请运行 \`sleep 40 && echo second-done\`，然后说你做完了。不要改任何文件。` }] }, 20_000);
  const id2 = turnId(second);
  await until("the second command running", () => t.lines().some((l) => /sleep 40/.test(l)), 30_000);
  await sleep(1500);
  let stopped: unknown;
  try { stopped = await rpc.request("turn/interrupt", { threadId: thread, turnId: id2 }, 20_000); }
  catch (err) { stopped = { error: String(err) }; }
  say(`  turn/interrupt: ${JSON.stringify(stopped).slice(0, 200)}`);
  await sleep(2500);
  shot(t, "steer-3-interrupted");
  const after = await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: `${MARK}（打断之后，来自 07 · Claude Code）只回答 INTERRUPT-OK。` }] }, 20_000);
  say(`  turn/start after it: ${JSON.stringify(after).slice(0, 120)}`);
  await until("end of the turn after the interrupt", () => stops() > before, 120_000, 500);
  await sleep(2000);
  shot(t, "steer-4-end");
  const screen = t.lines().join("\n");
  say(`  after the interrupt: the answer INTERRUPT-OK on its screen: ${/INTERRUPT-OK\s*$|• INTERRUPT-OK/m.test(screen) ? "yes" : "no"}; its command's output (\`└ second-done\`, only if it was not stopped): ${/└ second-done/.test(screen) ? "yes" : "no"}`);
  if (!session.transcript) {
    const read = ((await rpc.request("thread/read", { threadId: thread, includeTurns: false }, 10_000)).thread ?? {}) as { path?: string };
    if (typeof read.path === "string") session.transcript = read.path;
  }
  if (session.transcript) { ended.push(session.transcript); record("codex", session.transcript); }
}

/** Claude Code's parity between the sender's permission mode and its own (docs/talk-v0.md §10.5). */
async function attest(): Promise<void> {
  const launch = agentLauncher({ binaries: { "claude-code": join(homedir(), ".local/bin/claude") }, hookUrl: () => hookUrl, stateDir: STATE, env });
  // Its own envelope, as it writes one (from, from-name, from-mode in this order; the body between two line breaks).
  const envelope = (from: string, mode: "bypass" | "prompting" | null, body: string) =>
    `<cross-session-message from="uds:${from}" from-name="05 · Codex"${mode ? ` from-mode="${mode}"` : ""}>\n${body}\n</cross-session-message>`;
  const body = "07，我是 05 · Codex（管 packages/daemon）：登录接口新加的字段定名为 refreshToken。\n\n（这是一次试验：请只用一句话回答：你看到的发信人叫什么。不要运行命令，不要改任何文件。）";
  // `PROBE_ACCEPT=1`: the terminal's own settings say `crossSessionInbound: "accept"` and nothing says the sender's
  // mode (user, 2026-10-16: 声明权限方式先别管了，默认先做全bypass权限吧) — a bypass terminal, from an agent that
  // asks: delivered?
  const accept = process.env.PROBE_ACCEPT === "1";
  const cases: { mode: "manual" | "bypass"; from: ("bypass" | "prompting" | null)[] }[] = accept ? [{ mode: "bypass", from: [null] }]
    : [{ mode: "bypass", from: ["bypass", "prompting"] }, { mode: "manual", from: ["bypass"] }];
  for (const c of cases) {
    say(`== Claude Code, ${c.mode}`);
    const inbox = join(SOCKS, `${c.mode}.sock`), back = join(SOCKS, `${c.mode}-from.sock`);
    const plan = launch({ id: `attest-${c.mode}`, harness: "claude-code", cwd: REPO, mode: c.mode, model: "sonnet", hookToken: "probe" });
    if (accept) {
      const file = plan.args[plan.args.indexOf("--settings") + 1]!;
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), crossSessionInbound: "accept" }, null, 2), { mode: 0o600 });
    }
    const t = open(plan.file, [...plan.args, "--messaging-socket-path", inbox], plan.env);
    if (!await until("input box", t.ready, 45_000)) { shot(t, `attest-${c.mode}-stuck`); say("  stopped: its input is not on screen (see the screen)"); return; }
    const dir = join(homedir(), ".claude", "sessions");
    const key = readdirSync(dir).find((f) => f.startsWith(`${t.pty.pid}.`) && f.endsWith(".key"));
    const token = key ? (JSON.parse(readFileSync(join(dir, key), "utf8")) as { peerToken?: string }).peerToken : undefined;
    if (!token) { say("  stopped: no peer key"); return; }
    const replies = listen(back);
    for (const from of c.from) {
      const sentAt = Date.now(), seen = frames.length;
      await send(inbox, [{ type: "auth", token }, { type: "user", message: { role: "user", content: envelope(back, from, body) }, from: `uds:${back}`, msg_id: randomUUID(), priority: "next" }]);
      const ran = await until("end of a turn", () => events.some((e) => e.event === "Stop" && e.at > sentAt), 60_000, 500);
      await sleep(2000);
      shot(t, `attest-${c.mode}-from-${from ?? "none"}`);
      const got = frames.slice(seen).map((f) => f.frame as { action?: string; status?: string; cause?: string; reason?: string });
      say(`  from ${from ?? "an agent that says nothing of its mode"}: a turn ran: ${ran ? "yes" : "no"}; receipts: ${got.map((g) => `${g.status ?? g.action}${g.cause ? ` (${g.cause})` : ""}`).join(", ") || "none"}`);
      const held = t.lines().join("\n");
      if (/Held message from another session/.test(held)) {
        say(`  its own box: ${(held.match(/The sending session[^\n]*|The sender[^\n]*/) ?? [""])[0].trim()}`);
        break;   // the box stays until someone answers it: nobody does, the terminal is ended
      }
    }
    if (session.transcript) { ended.push(session.transcript); record("claude-code", session.transcript); }
    session = {};
    replies.close();
    try { process.kill(-t.pty.pid, "SIGTERM"); } catch { t.pty.kill(); }
    await sleep(1500);
  }
}
