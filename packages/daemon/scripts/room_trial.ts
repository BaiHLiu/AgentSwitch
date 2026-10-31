/** A trial of docs/talk-v0.md with real agents, outside the service: two terminals of the running AgentSwitch talk to
 *  each other the way a room would make them (§4.2 送达, §0 the answer carried back). Not a test: it uses the real
 *  models, on your account, in your service.
 *
 *    npx tsx scripts/room_trial.ts <trial.json> <out dir>
 *
 *  trial.json: `{ "room": "…", "cwd": "<a folder both agents already trust>", "rounds": 6,
 *                 "first": { "harness": "codex", "name": "Codex" }, "second": { "harness": "claude-code", "name": "Claude Code" },
 *                 "opening": "…what you say to the first…", "preface": "…what the second is told the first time…" }`
 *
 *  It starts the two terminals in the service (`POST /terminals`, mode `manual`: each asks before it changes
 *  anything), says the opening to the first, and from then on hands each answer to the other, headed
 *  `〔讨论 · <room>〕<name> 对你说：` — what the room's `send` would do for them (the trial gives them no tools) — until
 *  one ends an answer with `[达成一致]` or `rounds` hand-overs are done. The terminals are left open. With `use` and
 *  `resume` it picks a trial up again in the terminals it had.
 *
 *  It types only when the service would: the terminal idle, nothing waiting for you, no list on its screen, and its
 *  own input box positively there and empty (`inputEmpty`, `choicesOnScreen` on the screen rebuilt from its stream —
 *  the checks the service makes before it types a command of its own). Anything else (a question of the agent's
 *  own, a permission it asks you for) it waits on, and says so; it never answers one. A turn's answer is read from
 *  the session's record (`GET /sessions/<agent>/<id>/record`), as the simple view reads it: the last answer since it
 *  was spoken to (a service before 2026-10-15 left a message pasted whole into Claude Code out of its record).
 *
 *  Writes `<out>/trial.jsonl` (each message: who, to whom, when, the text) and `<out>/screen-<n>-<who>.txt` (each
 *  terminal's screen when its turn ended). */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import headless from "@xterm/headless";
import { choicesOnScreen, inputEmpty, screenRows } from "../src/terminals/host.js";

type Side = { readonly harness: string; readonly name: string };
type Trial = { room: string; cwd: string; rounds: number; first: Side; second: Side; opening: string; preface: string;
  /** Terminals already open (a trial picked up again), and where it stood: whose answer comes next, said to it when,
   *  and how many answers were written down before. */
  use?: { first: string; second: string }; resume?: { speaker: "first" | "second"; since: string; answers: number } };
type Item = { type: string; text?: string; thinking?: boolean; id: string; ts: number };

const [trialFile, out] = process.argv.slice(2);
if (!trialFile || !out) { console.error("usage: room_trial.ts <trial.json> <out dir>"); process.exit(2); }
const trial = JSON.parse(readFileSync(trialFile, "utf8")) as Trial;
const dir: string = out;
mkdirSync(dir, { recursive: true });
const HOME = process.env.AGENTSWITCH_HOME ?? join(homedir(), "Library/Application Support/AgentSwitch");
const BASE = `http://127.0.0.1:${process.env.AGENTSWITCH_PORT ?? "4711"}`;
const TOKEN = readFileSync(join(HOME, "local-token"), "utf8").trim();
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const HEADER = (name: string) => `〔讨论 · ${trial.room}〕${name} 对你说：`;
const DONE = "[达成一致]";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const say = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`);
const log = (rec: Record<string, unknown>) => appendFileSync(join(dir, "trial.jsonl"), JSON.stringify({ t: now(), ...rec }) + "\n");

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: init?.method ?? "GET", headers: H, ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** A terminal of the trial: its screen rebuilt from its stream, as the service keeps it. */
class Member {
  id = "";
  readonly term = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 2000 });
  constructor(readonly side: Side) {}

  /** A terminal already open: followed, not started. */
  use(id: string): void {
    this.id = id;
    say(`${this.side.name}: terminal ${this.id} (open already)`);
    void this.follow();
  }

  async start(): Promise<void> {
    const { terminal } = await api<{ terminal: { id: string } }>("/terminals", { method: "POST", body: { harness: this.side.harness, cwd: trial.cwd, mode: "manual", cols: 120, rows: 40 } });
    this.id = terminal.id;
    say(`${this.side.name}: terminal ${this.id}`);
    void this.follow();
  }

  /** The terminal's stream: its snapshot, then what it prints, into the screen kept here. */
  private async follow(): Promise<void> {
    for (;;) {
      try {
        const res = await fetch(`${BASE}/terminals/${this.id}/stream`, { headers: H });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const decoder = new TextDecoder();
        let buf = "", event = "", data = "";
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trimStart();
            else if (line === "") { if (event && data) this.take(event, data); event = ""; data = ""; }
          }
        }
      } catch { /* the stream broke: again */ }
      await sleep(1000);
    }
  }

  private take(event: string, data: string): void {
    const ev = JSON.parse(data) as { cols?: number; rows?: number; data?: string };
    if (event === "snapshot") {
      this.term.reset();
      if (ev.cols && ev.rows) this.term.resize(ev.cols, ev.rows);
      this.term.write(ev.data ?? "");
    } else if (event === "output") this.term.write(ev.data ?? "");
    else if (event === "resize" && ev.cols && ev.rows) this.term.resize(ev.cols, ev.rows);
  }

  private async flushed(): Promise<void> { await new Promise<void>((r) => this.term.write("", r)); }

  async screen(): Promise<string[]> {
    await this.flushed();
    return screenRows(this.term, this.term.rows).map((r) => r.text);
  }

  async info(): Promise<{ status: string; permissions: unknown[]; choices: unknown; agentSessionId: string | null }> {
    return (await api<{ terminal: { status: string; permissions: unknown[]; choices: unknown; agentSessionId: string | null } }>(`/terminals/${this.id}`)).terminal;
  }

  /** Whether the service would type now: idle, nothing asked, no list, its input box there and empty. */
  async ready(): Promise<string | null> {
    const i = await this.info();
    if (i.status !== "idle") return `status ${i.status}`;
    if (i.permissions?.length) return "a permission waits for you";
    if (i.choices) return "a list on its screen";
    await this.flushed();
    const rows = screenRows(this.term, this.term.rows);
    if (choicesOnScreen(rows.map((r) => r.text))) return "a list on its screen";
    if (!inputEmpty(rows)) return "its input box is not there, or not empty";
    return null;
  }

  async waitReady(what: string, ms: number): Promise<void> {
    const until = Date.now() + ms;
    let said = "";
    for (;;) {
      const why = await this.ready();
      if (!why) return;
      if (why !== said && !why.startsWith("status working")) { say(`${this.side.name}: waiting (${why}) ${what}`); said = why; }
      if (Date.now() > until) {
        writeFileSync(join(dir, `stuck-${this.side.name}.txt`), (await this.screen()).join("\n"));
        throw new Error(`${this.side.name} not ready ${what}: ${why}`);
      }
      await sleep(1500);
    }
  }

  /** Types `text` as a reply, then waits for the turn it starts to begin. */
  async deliver(text: string): Promise<void> {
    await api(`/terminals/${this.id}/input`, { method: "POST", body: { text } });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      if ((await this.info()).status === "working") return;
      await sleep(700);
    }
    say(`${this.side.name}: no turn began within a minute`);
  }

  /** Its answer to what was said to it at `since`: the last answer in its record from then on. */
  async answer(since: number): Promise<string> {
    const sid = (await this.info()).agentSessionId;
    if (!sid) throw new Error(`${this.side.name}: no session yet`);
    for (let tries = 0; tries < 10; tries++) {
      const rec = await api<{ items: Item[] }>(`/sessions/${this.side.harness}/${sid}/record?limit=80`);
      const answers = rec.items.filter((it) => it.type === "answer" && !it.thinking && it.text?.trim() && it.ts >= since - 2000);
      if (answers.length) return answers[answers.length - 1]!.text!.trim();
      await sleep(2000);
    }
    throw new Error(`${this.side.name}: no answer found in its record`);
  }
}

async function main(): Promise<void> {
  const a = new Member(trial.first), b = new Member(trial.second);
  let speaker = a, listener = b, since = Date.now(), round = 0, prefaced = false;
  if (trial.use && trial.resume) {
    a.use(trial.use.first);
    b.use(trial.use.second);
    await sleep(2000);
    if (trial.resume.speaker === "second") [speaker, listener] = [b, a];
    since = Date.parse(trial.resume.since);
    round = trial.resume.answers;
    prefaced = trial.resume.speaker === "second" || round > 1;
  } else {
    await a.start();
    await b.start();
    await Promise.all([a.waitReady("to start", 180_000), b.waitReady("to start", 180_000)]);
    writeFileSync(join(dir, "terminals.json"), JSON.stringify({ [trial.first.name]: a.id, [trial.second.name]: b.id }, null, 2));
    // You open: to the first, with what the room is.
    const opening = `${HEADER("You")}\n${trial.opening}`;
    log({ from: "You", to: trial.first.name, kind: "you", text: trial.opening });
    say(`You → ${trial.first.name}`);
    since = Date.now();
    await a.deliver(opening);
  }

  for (;;) {
    await speaker.waitReady("after its turn", 20 * 60_000);
    const text = await speaker.answer(since);
    round += 1;
    writeFileSync(join(dir, `screen-${String(round).padStart(2, "0")}-${speaker.side.name.replace(/\s+/g, "")}.txt`), (await speaker.screen()).join("\n"));
    const done = text.includes(DONE);
    log({ from: speaker.side.name, to: listener.side.name, kind: "answer", round, text, done });
    say(`${speaker.side.name} answered (${text.length} chars)${done ? ", agreed" : ""}`);
    if (done || round >= trial.rounds) break;
    // Handed to the other as the room would, the first time with what the room is.
    const header = HEADER(speaker.side.name);
    const body = `${header}\n${!prefaced ? `${trial.preface}\n\n` : ""}${text}`;
    prefaced = true;
    await listener.waitReady("before it is spoken to", 20 * 60_000);
    say(`${speaker.side.name} → ${listener.side.name}`);
    since = Date.now();
    await listener.deliver(body);
    [speaker, listener] = [listener, speaker];
  }
  say(`ended after ${round} answers`);
  process.exit(0);
}

main().catch((err) => { say(`stopped: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
