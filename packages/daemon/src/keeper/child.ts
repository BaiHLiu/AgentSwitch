/** One process the keeper keeps running (mac-app `Supervision`, `ProcessSupervisor`, `Leftovers`): started in a process
 *  group of its own, its output passed on line by line under its name, restarted when it exits or stops answering —
 *  1 s, doubling to 60 s, back to 1 s after a 30 s run — and stopped with its own signal, then SIGKILL. Its pid and start
 *  time are kept in a file so that a keeper that died without stopping it finds it and stops it first. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** A run this long counts as having worked: the next failure starts again from the first delay. */
export const STEADY_MS = 30_000;

/** The delay before the next start after `failures` failures in a row. */
export const backoff = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));

export type ChildSpec = {
  readonly name: string;
  readonly command: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly pidFile: string;
  readonly stopSignal: NodeJS.Signals;
  readonly stopTimeoutMs: number;
};

/** Linux's start time of a process (clock ticks after boot, `/proc/<pid>/stat` field 22), or null. Together with the pid
 *  it names one process: a pid is reused, the pair is not. */
export function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Stops what a pid file names when it is still that process: its group gets `signal`, then SIGKILL after `timeoutMs`.
 *  The file goes either way. */
export async function reap(pidFile: string, signal: NodeJS.Signals, timeoutMs: number, log: (s: string) => void): Promise<void> {
  if (!existsSync(pidFile)) return;
  const [pidText, started] = readFileSync(pidFile, "utf8").trim().split(/\s+/);
  rmSync(pidFile, { force: true });
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1 || !started || startTime(pid) !== started) return;
  log(`stopping ${pid} left from an earlier run`);
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { return; } }
  for (let waited = 0; waited < timeoutMs && alive(pid); waited += 100) await sleep(100);
  if (alive(pid)) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
}

/** Passes a stream on, a line at a time, each under `prefix`. */
function lines(stream: NodeJS.ReadableStream | null, prefix: string, write: (s: string) => void): void {
  let rest = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) write(`${prefix} ${line}`);
  });
  stream?.on("end", () => { if (rest) write(`${prefix} ${rest}`); });
}

export class Child {
  private proc: ChildProcess | null = null;
  private failures = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(private spec: ChildSpec, private readonly out: (line: string) => void = (l) => console.log(l)) {}

  /** What the next start runs (settings changed); the current run is not touched. */
  update(spec: ChildSpec): void { this.spec = spec; }

  get running(): boolean { return this.proc !== null; }
  get pid(): number | null { return this.proc?.pid ?? null; }
  /** How long the current run has lasted (0 when not running). */
  uptime(now = Date.now()): number { return this.proc ? now - this.startedAt : 0; }

  start(): void {
    if (this.proc || this.stopping) return;
    const [file, ...args] = this.spec.command;
    const proc = spawn(file!, args, { cwd: this.spec.cwd, env: this.spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.proc = proc;
    this.startedAt = Date.now();
    lines(proc.stdout, `[${this.spec.name}]`, this.out);
    lines(proc.stderr, `[${this.spec.name}]`, this.out);
    if (proc.pid) writeFileSync(this.spec.pidFile, `${proc.pid} ${startTime(proc.pid) ?? ""}\n`, { mode: 0o600 });
    this.exited = new Promise((done) => proc.once("close", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      rmSync(this.spec.pidFile, { force: true });
      done();
      if (this.stopping) return;
      this.failed(`exited (${signal ?? `code ${code}`})`);
    }));
    proc.once("error", (e) => this.out(`[keeper] ${this.spec.name} could not start: ${e.message}`));
  }

  /** A run that did not work: it is stopped if still there, and started again after the backoff. */
  failed(why: string): void {
    if (this.stopping) return;
    if (Date.now() - this.startedAt >= STEADY_MS) this.failures = 0;
    this.failures++;
    const delay = backoff(this.failures);
    this.out(`[keeper] ${this.spec.name} ${why}; starting again in ${delay / 1000} s`);
    void this.halt().then(() => {
      if (this.stopping) return;
      this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
    });
  }

  /** Stops the current run (its signal, then SIGKILL), without stopping the keeping. */
  async halt(): Promise<void> {
    const proc = this.proc;
    if (!proc?.pid) return;
    const group = -proc.pid;
    try { process.kill(group, this.spec.stopSignal); } catch { /* gone */ }
    const killed = setTimeout(() => { try { process.kill(group, "SIGKILL"); } catch { /* gone */ } }, this.spec.stopTimeoutMs);
    await this.exited;
    clearTimeout(killed);
  }

  /** Stops it for good: no more restarts. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.halt();
  }

  /** Stops the current run and starts a new one now (settings changed), with no backoff. */
  async restart(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopping = true;
    await this.halt();
    this.stopping = false;
    this.failures = 0;
    this.start();
  }
}
