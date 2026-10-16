/** What Dispatch's Codex and OpenCode runs could show while an answer is written (docs/simple-view-v0.md §5.14), each
 *  as its executor runs it — a real model turn each, a probe, not a test.
 *
 *    node --import tsx scripts/partial_probe.ts codex
 *    node --import tsx scripts/partial_probe.ts opencode
 *    node --import tsx scripts/partial_probe.ts pi
 *
 *  codex: `codex app-server` over stdio as the executor starts it (src/executors/codex.ts: thread/start, ephemeral,
 *    then turn/start): how many `item/agentMessage/delta` its own client is sent before `item/completed`, and when.
 *  opencode: `opencode serve` as the executor's server (src/executors/opencodeServer.ts), a session of its own, the
 *    session's messages asked for every 250 ms as the executor asks (src/executors/opencodeServeRun.ts): how often the
 *    unfinished text part is longer than the last time. Of OpenCode's session only lengths and times are read (none of
 *    its words are printed), and the session is deleted at the end.
 *
 *  pi: no Dispatch runs, but its terminals load AgentSwitch's extension: `pi -p` with an extension of this probe's that
 *    counts `message_update` events (`text_delta`), on a throw-away agent folder (`PI_CODING_AGENT_DIR`, no sign-in of
 *    yours) and a model of the LM Studio running on this Mac (nothing leaves it, nothing is paid); `--no-session`.
 *
 *  Nothing is typed into anything; no tool is let run. Everything started is ended. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppServerClient } from "../src/harness/appserver.js";
import { OpenCodeExecServer } from "../src/executors/opencodeServer.js";

const which = process.argv[2];
if (which !== "codex" && which !== "opencode" && which !== "pi") { console.error("codex|opencode|pi"); process.exit(2); }
const ASK = "用中文写一段大约 300 字的说明：终端怎样把字画到屏幕上。不要用任何工具，直接写。";
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(AGENTSWITCH_|SECRET_GATE_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/.test(k))) as Record<string, string>;
const cwd = mkdtempSync(join(tmpdir(), "as-partial-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Json = Record<string, unknown>;

try {
  if (which === "codex") await codex(); else if (which === "pi") await pi(); else await opencode();
} catch (err) {
  console.log(`failed: ${(err as Error).stack ?? err}`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
  process.exit(0);
}

async function codex(): Promise<void> {
  const bin = join(homedir(), ".local/share/agentswitch/cli/codex/beta/0.163.0-alpha.5/bin/codex");
  const child = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"], cwd });
  const t0 = Date.now();
  let pieces = 0, chars = 0, first = 0, last = 0, whole = 0, wholeChars = 0, done = false;
  const c = new AppServerClient(child.stdin!, child.stdout!, async () => ({ decision: "decline" }), (method, params) => {
    const p = (params ?? {}) as Json;
    if (method === "item/agentMessage/delta" && typeof p.delta === "string") { pieces += 1; chars += p.delta.length; last = Date.now() - t0; first ||= last; }
    if (method === "item/completed" && ((p.item as Json | undefined)?.type === "agentMessage")) { whole = Date.now() - t0; wholeChars = String((p.item as Json).text ?? "").length; }
    if (method === "turn/completed") done = true;
  });
  try {
    await c.request("initialize", { clientInfo: { name: "agentswitch-probe", version: "1" }, capabilities: { experimentalApi: true } }, 20_000);
    c.notify("initialized");
    // As the executor opens a run's thread, kept nowhere.
    const started = await c.request("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true }, 20_000);
    const threadId = String(((started.thread ?? {}) as Json).id ?? "");
    await c.request("turn/start", { threadId, input: [{ type: "text", text: ASK }] }, 20_000);
    for (const stop = Date.now() + 150_000; !done && Date.now() < stop; ) await sleep(200);
    console.log(`codex (the executor's own client): ${pieces} pieces (${chars} characters)${pieces ? `, from ${(first / 1000).toFixed(2)} s to ${(last / 1000).toFixed(2)} s` : ""}; the whole message (item/completed) at ${(whole / 1000).toFixed(2)} s, ${wholeChars} characters; turn ended: ${done ? "yes" : "no"}`);
  } finally { child.kill("SIGKILL"); }
}

async function opencode(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "as-partial-oc-"));
  const server = new OpenCodeExecServer({ binary: join(homedir(), ".opencode/bin/opencode"), home, config: {}, log: () => undefined });
  let sid = "";
  try {
    await server.start();
    const loc = { directory: cwd };
    // No tool may run: the probe's own session refuses all of them.
    // A model of a provider signed in on this Mac (`opencode auth list`); `PROBE_MODEL` for another.
    const [providerID, ...rest] = (process.env.PROBE_MODEL ?? "deepseek/deepseek-flash").split("/");
    const made = await server.call<{ data?: Json }>("POST", "/api/session", { title: "AgentSwitch partial probe", agent: "build", model: { providerID, id: rest.join("/") }, location: loc, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    sid = String(made.data?.id ?? "");
    if (!sid) { console.log(`opencode: no session (${JSON.stringify(made).slice(0, 160)})`); return; }
    // Its event stream, followed while the turn runs: each event's type counted, and the text pieces' lengths and times.
    const raw = server as unknown as { url: string; password: string };
    const events = new Map<string, number>();
    let deltaChars = 0, deltaFirst = 0, deltaLast = 0, deltas = 0;
    const follow = new AbortController();
    const t0 = Date.now();
    const stream = fetch(`${raw.url}/api/event`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${raw.password}`).toString("base64")}`, accept: "text/event-stream" }, signal: follow.signal }).then(async (res) => {
      if (!res.ok || !res.body) { events.set(`(http ${res.status})`, 1); return; }
      const reader = res.body.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += Buffer.from(value).toString("utf8");
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!data) continue;
          let e: Json; try { e = JSON.parse(data) as Json; } catch { continue; }
          const type = String(e.type ?? "?");
          events.set(type, (events.get(type) ?? 0) + 1);
          // A piece of text: wherever the event keeps it (`delta`, or a part's `text` growing), its length only.
          const props = (e.properties ?? e.data ?? e) as Json;
          const piece = typeof props.delta === "string" ? props.delta : typeof (props.delta as Json | undefined)?.text === "string" ? String((props.delta as Json).text) : null;
          if (piece !== null && /text|delta/i.test(type)) { deltas += 1; deltaChars += piece.length; deltaLast = Date.now() - t0; deltaFirst ||= deltaLast; }
        }
      }
    }).catch(() => undefined);
    await sleep(300);
    await server.call("POST", `/api/session/${encodeURIComponent(sid)}/prompt`, { text: ASK });
    const lengths: string[] = [];
    let lastLen = -1, grew = 0, idle = false, finalAt = 0, finalLen = 0;
    while (!idle && Date.now() - t0 < 150_000) {
      const res = await server.call<{ data?: Json[] }>("GET", `/api/session/${encodeURIComponent(sid)}/message?limit=50`);
      const messages = res.data ?? [];
      idle = messages.some((m) => m.type === "idle");
      // The answer's text so far: its length only.
      let len = 0, finished = false;
      for (const m of messages) {
        if (m.type !== "assistant") continue;
        for (const p of (Array.isArray(m.content) ? m.content as Json[] : [])) if (p.type === "text") len += String(p.text ?? "").length;
        if (m.time && typeof (m.time as Json).completed === "number") finished = true;
      }
      const at = ((Date.now() - t0) / 1000).toFixed(2);
      if (len !== lastLen) { lengths.push(`${at}s ${len}${finished ? " (message finished)" : ""}`); if (lastLen >= 0 && len > lastLen && !finished) grew += 1; lastLen = len; }
      if (finished && !finalAt) { finalAt = Date.now() - t0; finalLen = len; }
      await sleep(250);
    }
    // How it ended, by kinds only: each message's type, an assistant's model and error kind, the idle outcome.
    const res = await server.call<{ data?: Json[] }>("GET", `/api/session/${encodeURIComponent(sid)}/message?limit=50`);
    for (const m of res.data ?? []) {
      const err = m.error as Json | undefined;
      const model = m.model as Json | undefined;
      console.log(`  message ${String(m.type)}${m.type === "assistant" ? `: model ${String(model?.providerID ?? "?")}/${String(model?.id ?? model?.modelID ?? "?")}, parts ${(Array.isArray(m.content) ? (m.content as Json[]).map((p) => p.type).join(",") : "")}${err ? `, error ${String(err.type ?? err.name ?? "?")}` : ""}` : ""}${m.type === "idle" ? `: ${String(m.outcome)}` : ""}`);
    }
    follow.abort(); await stream;
    console.log(`opencode's event stream (/api/event): ${[...events].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
    console.log(`  pieces of text in it: ${deltas} (${deltaChars} characters)${deltas ? `, from ${(deltaFirst / 1000).toFixed(2)} s to ${(deltaLast / 1000).toFixed(2)} s` : ""}`);
    console.log(`opencode (the executor's way, every 250 ms): the unfinished answer was longer than the time before ${grew} times; finished at ${(finalAt / 1000).toFixed(2)} s, ${finalLen} characters; idle: ${idle ? "yes" : "no"}`);
    for (const l of lengths.slice(0, 5).concat(lengths.length > 8 ? ["…"] : [], lengths.slice(-3))) console.log(`  ${l}`);
  } finally {
    if (sid) await server.call("DELETE", `/api/session/${encodeURIComponent(sid)}`).then(() => console.log("  its session: deleted"), (err: Error) => console.log(`  its session: not deleted (${err.message})`));
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

async function pi(): Promise<void> {
  const local = "http://127.0.0.1:1234/v1";
  const listed = await fetch(`${local}/models`).then((r) => r.json() as Promise<{ data?: { id: string }[] }>).catch(() => null);
  const model = (listed?.data ?? []).map((m) => m.id).find((id) => !/embed/i.test(id));
  if (!model) { console.log("pi: no LM Studio model on this Mac (http://127.0.0.1:1234)"); return; }
  const agent = join(cwd, "agent"), home = join(cwd, "home"), log = join(cwd, "pieces.txt"), ext = join(cwd, "count.ts");
  mkdirSync(agent, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { lmstudio: { baseUrl: local, api: "openai-completions", apiKey: "lm-studio", models: [{ id: model }] } } }));
  // The probe's extension: each piece of the answer as pi streams it, its time and length.
  writeFileSync(ext, `import { appendFileSync } from "node:fs";
export default function count(pi: { on(e: string, h: (e: any) => void): void }): void {
  const t0 = Date.now();
  pi.on("message_update", (e) => { const a = e.assistantMessageEvent; if (a && a.type === "text_delta") appendFileSync(${JSON.stringify(log)}, (Date.now() - t0) + " " + String(a.delta ?? "").length + "\\n"); });
  pi.on("message_end", () => appendFileSync(${JSON.stringify(log)}, (Date.now() - t0) + " end\\n"));
}
`);
  writeFileSync(log, "");
  const piEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, LANG: "en_US.UTF-8", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
  const child = spawn(join(homedir(), ".local/bin/pi"), ["-p", "--no-session", "--no-tools", "--extension", ext, "--model", `lmstudio/${model}`, "用中文写三句话，说明终端怎样把字画到屏幕上。"], { cwd, env: piEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (d) => { stdout += d; });
  child.stderr!.on("data", (d) => { stderr += d; });
  const code = await new Promise<number | null>((ok) => { const t = setTimeout(() => { child.kill("SIGKILL"); ok(null); }, 240_000); child.on("exit", (c) => { clearTimeout(t); ok(c); }); });
  const rows = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const pieces = rows.filter((r) => !r.endsWith(" end")).map((r) => r.split(" ").map(Number));
  const end = rows.find((r) => r.endsWith(" end"));
  console.log(`pi (${model} on this Mac's LM Studio): exited ${code}; printed ${stdout.trim().length} characters${stderr.trim() ? `; stderr: ${stderr.trim().slice(0, 160)}` : ""}`);
  console.log(`  message_update text_delta: ${pieces.length} pieces (${pieces.reduce((n, p) => n + (p[1] ?? 0), 0)} characters)${pieces.length ? `, from ${((pieces[0]![0] ?? 0) / 1000).toFixed(2)} s to ${((pieces.at(-1)![0] ?? 0) / 1000).toFixed(2)} s` : ""}; message_end at ${end ? (Number(end.split(" ")[0]) / 1000).toFixed(2) + " s" : "—"}`);
}
