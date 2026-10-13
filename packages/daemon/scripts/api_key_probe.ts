/** A profile that pays by a key (docs/profiles-v0.md §3.6), for real: the service's own launcher and hook program and
 *  YOUR Claude Code and Codex programs, each on a throw-away home folder — not your sign-ins, settings or sessions.
 *  No model is called: the address the key is sent to is a stand-in on this Mac that answers 401 and writes down what
 *  it was sent. The same stand-in plays the service for the hook program's `key` call, with a made-up key.
 *
 *    npx tsx scripts/api_key_probe.ts            # CLAUDE_BIN=… CODEX_BIN=… to try other programs
 *
 *  What it shows, a line each: Claude Code, started with the settings the launcher wrote, asks the hook program for
 *  the key and sends it to the address as `x-api-key` and `Authorization`; Codex, started with the launcher's
 *  arguments, does the same as `Authorization` — in a folder that is signed in another way, whose own key is not sent;
 *  and the key is in neither's arguments, environment or files. Not a test: it runs the real programs. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentLauncher } from "../src/terminals/launch.js";

const KEY = "sk-probe-made-up-key-0001", OTHER = "sk-probe-the-folders-own-key";
const TOKEN = "probe-hook-token";
const seen: { path: string; apiKey: string | undefined; bearer: string | undefined }[] = [];
let asked = 0;

const server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => {
    if (req.url === "/terminals/key") {
      asked += 1;
      const ok = req.headers.authorization === `Bearer ${TOKEN}` && Boolean(req.headers["x-agentswitch-terminal"]);
      res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
      return res.end(JSON.stringify(ok ? { key: KEY } : { error: "forbidden" }));
    }
    seen.push({ path: (req.url ?? "").split("?")[0]!, apiKey: req.headers["x-api-key"] as string | undefined, bearer: req.headers.authorization });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "probe" } }));
  });
});

const run = (file: string, args: string[], env: Record<string, string>, cwd: string, ms: number): Promise<void> => new Promise((done) => {
  const child = spawn(file, args, { env, cwd, stdio: ["ignore", "ignore", "ignore"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  child.on("exit", () => { clearTimeout(timer); done(); });
  child.on("error", () => { clearTimeout(timer); done(); });
});

/** Whether any file under `dir` holds `text`. */
function holds(dir: string, text: string): string | null {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) { const found = holds(path, text); if (found) return found; }
    else if (stat.size < 8_000_000 && readFileSync(path).includes(text)) return path;
  }
  return null;
}

const say = (ok: boolean, line: string) => console.log(`${ok ? "ok  " : "FAIL"} ${line}`);

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const root = mkdtempSync(join(tmpdir(), "agentswitch-key-probe-"));
const claude = process.env.CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
const codexDir = join(homedir(), ".local", "share", "agentswitch", "cli", "codex", "beta");
const codex = process.env.CODEX_BIN ?? (existsSync(codexDir) ? join(codexDir, readdirSync(codexDir).sort().at(-1)!, "bin", "codex") : "codex");
const env = { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TERM: "dumb" };
const launch = agentLauncher({ binaries: { "claude-code": claude, codex }, hookUrl: () => base, stateDir: join(root, "state"), env });
let failed = false;
const check = (ok: boolean, line: string) => { if (!ok) failed = true; say(ok, line); };

try {
  for (const dir of ["home", "work", "claude-home", "codex-home"]) (await import("node:fs")).mkdirSync(join(root, dir), { recursive: true });

  if (existsSync(claude)) {
    const plan = launch({ id: "probe-claude", harness: "claude-code", cwd: join(root, "work"), mode: "manual", hookToken: TOKEN, configHome: join(root, "claude-home"), api: { name: "Probe", baseUrl: base } });
    const settings = plan.args[plan.args.indexOf("--settings") + 1]!;
    await run(plan.file, ["-p", "hi", "--settings", settings], plan.env, join(root, "work"), 25_000);
    const sent = seen.filter((r) => r.path === "/v1/messages");
    check(sent.length > 0 && sent.every((r) => r.apiKey === KEY && r.bearer === `Bearer ${KEY}`), `Claude Code sent the key to the address as x-api-key and Authorization (${sent.length} request(s), the hook program asked ${asked} time(s))`);
    check(!JSON.stringify(plan).includes(KEY) && !holds(join(root, "state"), KEY) && !holds(join(root, "claude-home"), KEY), "Claude Code: the key is in no argument, environment or file");
  } else say(true, `no Claude Code at ${claude}: skipped`);

  if (existsSync(codex)) {
    seen.length = 0;
    const before = asked;
    // The folder it runs in is signed in another way: that key is not the one sent.
    writeFileSync(join(root, "codex-home", "auth.json"), JSON.stringify({ OPENAI_API_KEY: OTHER, auth_mode: "apikey" }));
    const plan = launch({ id: "probe-codex", harness: "codex", cwd: join(root, "work"), mode: "manual", hookToken: TOKEN, api: { name: "Probe", baseUrl: `${base}/v1` } });
    const provider = plan.args.filter((_, i) => i > 0 && plan.args[i - 1] === "-c" && /^model_provider/.test(plan.args[i]!)).flatMap((v) => ["-c", v]);
    await run(plan.file, ["exec", "--skip-git-repo-check", ...provider, "-m", "gpt-5", "hi"], { ...plan.env, CODEX_HOME: join(root, "codex-home") }, join(root, "work"), 25_000);
    const sent = seen.filter((r) => r.path === "/v1/responses");
    check(sent.length > 0 && sent.every((r) => r.bearer === `Bearer ${KEY}`), `Codex sent the key to the address as Authorization (${sent.length} request(s), the hook program asked ${asked - before} time(s))`);
    check(!seen.some((r) => r.bearer?.includes(OTHER)), "Codex: the key the folder itself is signed in with was not sent");
    check(!JSON.stringify(plan).includes(KEY) && !holds(join(root, "codex-home"), KEY), "Codex: the key is in no argument, environment or file");
  } else say(true, `no Codex at ${codex}: skipped`);
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
