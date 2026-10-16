/** Whether the simple view can have Claude Code's answer as it is written from the network (docs/simple-view-v0.md
 *  §5.14): its requests to api.anthropic.com go through a proxy of ours on this Mac, which opens that host alone (a
 *  certificate of a throw-away authority this one process is told to trust, `NODE_EXTRA_CA_CERTS`, as behind a
 *  company's inspecting proxy), passes every request and answer on as they are, and reads the pieces of text out of
 *  the answer's event stream. Every other host is a plain tunnel. One real model turn (`claude -p`, the cheapest
 *  model) — a probe, not a test.
 *
 *    node --import tsx scripts/claude_tap_probe.ts <out dir>
 *
 *  Nothing of a request is kept or printed but its method, its path, what its body holds by name and count, and three
 *  of its headers (the request's class and whether it names a prompt and a session); of an answer, its status, its
 *  type and the text it streamed. The authority is made here and removed at the end. */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate, gunzipSync } from "node:zlib";
import { PassThrough, type Readable } from "node:stream";

const out = resolve(process.argv[2] ?? "tap-probe");
const pki = join(out, "pki");
rmSync(pki, { recursive: true, force: true });
mkdirSync(pki, { recursive: true, mode: 0o700 });
const HOST = "api.anthropic.com";
const ssl = (...args: string[]) => execFileSync("/usr/bin/openssl", args, { cwd: pki, stdio: ["ignore", "ignore", "pipe"] });
ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=AgentSwitch probe authority");
ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${HOST}`);
writeFileSync(join(pki, "san.ext"), `subjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`);
ssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "san.ext");
const key = readFileSync(join(pki, "leaf.key")), cert = readFileSync(join(pki, "leaf.pem"));

const seen: string[] = [];
const say = (l: string) => { console.log(l); seen.push(l); };
let pieces = 0, text = "", firstAt = 0, lastAt = 0;
const t0 = Date.now();

/** A request inside the opened tunnel, passed on to the real host as it is; its answer back as it comes. */
const inner = createServer((req: IncomingMessage, res: ServerResponse) => {
  const up = httpsRequest({ host: HOST, port: 443, method: req.method, path: req.url, headers: { ...req.headers, host: HOST } }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    const type = String(answer.headers["content-type"] ?? "");
    const coding = String(answer.headers["content-encoding"] ?? "");
    say(`  ${req.method} ${(req.url ?? "").split("?")[0]} → ${answer.statusCode} ${type.split(";")[0]}${coding ? ` (${coding})` : ""}`);
    // What goes on is the answer's own bytes; what is read is a copy, unpacked.
    const copy = new PassThrough();
    const plain: Readable = coding === "gzip" ? copy.pipe(createGunzip()) : coding === "br" ? copy.pipe(createBrotliDecompress()) : coding === "deflate" ? copy.pipe(createInflate()) : copy;
    answer.on("data", (chunk: Buffer) => { res.write(chunk); if (type.includes("event-stream")) copy.write(chunk); });
    answer.on("end", () => { copy.end(); res.end(); });
    let buf = "";
    plain.on("error", () => undefined);
    plain.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8").replace(/\r\n/g, "\n");
      for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
        const event = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = event.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
        if (!data) continue;
        try {
          const d = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
          if (d.type === "content_block_delta" && d.delta?.type === "text_delta") {
            pieces += 1; text += d.delta.text ?? "";
            lastAt = Date.now() - t0; firstAt ||= lastAt;
          }
        } catch { /* not JSON */ }
      }
    });
  });
  up.on("error", (err) => { say(`  upstream error: ${err.message}`); res.destroy(); });
  // Which request is the conversation's own: what it carries, by name and count only.
  if ((req.url ?? "").startsWith("/v1/messages")) {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(parts);
        const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8")) as Record<string, unknown>;
        const sys = body.system;
        const sysLen = typeof sys === "string" ? sys.length : Array.isArray(sys) ? JSON.stringify(sys).length : 0;
        say(`    request: model ${String(body.model)}, ${Array.isArray(body.messages) ? body.messages.length : 0} messages, ${Array.isArray(body.tools) ? body.tools.length : 0} tools, system ${sysLen} chars, stream ${String(body.stream)}, keys ${Object.keys(body).join(",")}; request class ${String(req.headers["x-claude-code-request-class"])}, prompt id ${req.headers["x-claude-code-prompt-id"] ? "yes" : "none"}, session id ${req.headers["x-claude-code-session-id"] ? "yes" : "none"}`);
      } catch (err) { say(`    request: not read (${(err as Error).message})`); }
    });
  }
  req.pipe(up);
});

const proxy = createServer((_req, res) => { res.writeHead(400); res.end(); });
proxy.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
  const [host, port] = String(req.url).split(":");
  if (host === HOST) {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(client, { isServer: true, key, cert, ALPNProtocols: ["http/1.1"] });
    if (head.length) client.unshift(head);
    inner.emit("connection", tls);
    return;
  }
  // Every other host: a tunnel, not opened.
  const up = netConnect(Number(port) || 443, host!, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
  say(`  tunnel ${host}:${port}`);
});
await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", () => ok()));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(AGENTSWITCH_|SECRET_GATE_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$)/.test(k))) as Record<string, string>;
const child = spawn(join(homedir(), ".local/bin/claude"), ["-p", "用中文写四句话，说明终端怎样把字画到屏幕上。不要用任何工具。", "--model", "haiku", "--no-session-persistence"],
  { cwd: out, env: { ...env, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "127.0.0.1,localhost", NODE_EXTRA_CA_CERTS: join(pki, "ca.pem") }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });
const code = await new Promise<number | null>((ok) => { const timer = setTimeout(() => { child.kill("SIGKILL"); ok(null); }, 120_000); child.on("exit", (c) => { clearTimeout(timer); ok(c); }); });
say(`claude -p exited ${code}; it printed ${stdout.trim().length} characters${stderr.trim() ? `; stderr: ${stderr.trim().slice(0, 200)}` : ""}`);
say(`read from the stream: ${pieces} pieces of text, ${text.length} characters, from ${firstAt} ms to ${lastAt} ms`);
say(`the same text as it printed: ${text.trim() === stdout.trim() ? "yes" : `no (stream: ${JSON.stringify(text.slice(0, 80))}, printed: ${JSON.stringify(stdout.trim().slice(0, 80))})`}`);
writeFileSync(join(out, "tap.log"), seen.join("\n") + "\n");
proxy.close(); inner.close();
rmSync(pki, { recursive: true, force: true });
process.exit(0);
