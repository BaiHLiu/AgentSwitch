/** Connections to another node's remote listener (docs/mesh-v0.md §5.2): HTTPS held to the certificate the node was
 *  paired with. Its certificate is self-signed, so no authority is asked; the socket is handed to HTTP only after its
 *  certificate's SHA-256 has been compared with the pin — a request, and the token in it, never leaves on any other
 *  connection. Sockets are kept open between requests: a key typed into another node's terminal is one request. */

import { createHash, timingSafeEqual } from "node:crypto";
import type { ClientRequestArgs, IncomingMessage } from "node:http";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import type { Duplex, Readable } from "node:stream";
import { connect } from "node:tls";
import { isAllowedSource } from "../remote/address.js";

/** Until a connection is up and its certificate checked. */
export const CONNECT_TIMEOUT_MS = 4_000;
/** One address's `GET /healthz` when looking for where a node answers. */
const PROBE_TIMEOUT_MS = 2_500;
/** An address that answered this recently is used without asking again. */
const REACH_TTL_MS = 30_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** Tailscale's names for a node (`mac.tail1234.ts.net`): the one kind of host name a payload may carry. */
const TAILNET_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/i;

/** True for an address this node may dial as another node: an IP in the networks the remote listener itself accepts
 *  (private, link-local, Tailscale, loopback), or a Tailscale name. A payload cannot send this node anywhere else. */
export function dialable(address: string): boolean {
  return isIP(address) ? isAllowedSource(address) : TAILNET_NAME.test(address);
}

export class PinMismatch extends Error {
  constructor(readonly host: string) { super(`the certificate at ${host} is not the one this node was paired with`); }
}

const fingerprintOf = (der: Buffer): Buffer => createHash("sha256").update(der).digest();

type Created = (err: Error | null, stream: Duplex) => void;

/** An https agent whose every socket has shown the pinned certificate before HTTP gets it. */
class PinnedAgent extends Agent {
  private readonly pin: Buffer;

  constructor(fingerprint: string, private readonly connectTimeoutMs: number) {
    super({ keepAlive: true, maxSockets: 32 });
    this.pin = Buffer.from(fingerprint, "hex");
  }

  override createConnection(options: ClientRequestArgs, callback?: Created): Duplex | null | undefined {
    const host = String(options.host ?? "");
    const socket = connect({ host, port: Number(options.port), rejectUnauthorized: false, ALPNProtocols: ["http/1.1"], ...(isIP(host) ? {} : { servername: host }) });
    let settled = false;
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Node reads only the error when there is one; the socket named beside it is already destroyed.
      if (err) { socket.destroy(); callback?.(err, socket); } else callback?.(null, socket);
    };
    const timer = setTimeout(() => settle(new Error(`no answer from ${host} within ${this.connectTimeoutMs} ms`)), this.connectTimeoutMs);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerX509Certificate();
      const shown = cert ? fingerprintOf(cert.raw) : Buffer.alloc(0);
      settle(shown.length === this.pin.length && timingSafeEqual(shown, this.pin) ? null : new PinMismatch(host));
    });
    socket.once("error", (err) => settle(err));
    return undefined;
  }
}

/** Where a node listens and what it must show. */
export type Target = { readonly host: string; readonly port: number; readonly fingerprint: string };

export type Sent = {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | Readable | null;
  /** Aborting it drops the request, and the response if one has begun. */
  readonly signal?: AbortSignal;
  /** Until the response's head; a body (an event stream) may go on as long as it likes. */
  readonly headTimeoutMs?: number;
};

export type Reachable = { readonly fingerprint: string; readonly port: number; readonly last: string | null; readonly lan: readonly string[]; readonly tailnet: readonly string[] };

export type DialerOptions = {
  readonly connectTimeoutMs?: number;
  readonly now?: () => number;
  /** Tests: which addresses may be dialed (default `dialable`). */
  readonly allow?: (address: string) => boolean;
};

export class Dialer {
  private readonly agents = new Map<string, PinnedAgent>();
  private readonly good = new Map<string, { readonly host: string; readonly at: number }>();
  private readonly now: () => number;
  private readonly allow: (address: string) => boolean;

  constructor(private readonly opts: DialerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.allow = opts.allow ?? dialable;
  }

  private agent(fingerprint: string): PinnedAgent {
    const have = this.agents.get(fingerprint);
    if (have) return have;
    const made = new PinnedAgent(fingerprint, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    this.agents.set(fingerprint, made);
    return made;
  }

  /** One request to one address. Resolves with the response's head; its body is the caller's to read or destroy.
   *  A request that had nothing of its own to send and died on a socket kept from an earlier one — the other node
   *  closed it as this one was written — is made once more on a new socket. */
  async send(target: Target, sent: Sent): Promise<IncomingMessage> {
    if (!this.allow(target.host)) throw new Error(`${target.host} is not an address a node can be at`);
    try {
      return await this.once(target, sent);
    } catch (err) {
      const stale = (err as { reused?: boolean }).reused === true && ["ECONNRESET", "EPIPE"].includes((err as NodeJS.ErrnoException).code ?? "");
      if (!stale || (sent.body && !Buffer.isBuffer(sent.body)) || sent.signal?.aborted) throw err;
      return this.once(target, sent);
    }
  }

  private once(target: Target, sent: Sent): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ host: target.host, port: target.port, method: sent.method, path: sent.path, headers: { ...sent.headers }, agent: this.agent(target.fingerprint) });
      const timer = sent.headTimeoutMs ? setTimeout(() => req.destroy(new Error(`no answer from ${target.host} within ${sent.headTimeoutMs} ms`)), sent.headTimeoutMs) : undefined;
      const aborted = (): void => { req.destroy(new Error("aborted")); };
      sent.signal?.addEventListener("abort", aborted, { once: true });
      req.once("response", (res) => {
        clearTimeout(timer);
        sent.signal?.removeEventListener("abort", aborted);
        const drop = (): void => { res.destroy(); };
        sent.signal?.addEventListener("abort", drop, { once: true });
        res.once("close", () => sent.signal?.removeEventListener("abort", drop));
        resolve(res);
      });
      req.once("error", (err) => { clearTimeout(timer); sent.signal?.removeEventListener("abort", aborted); reject(Object.assign(err, { reused: req.reusedSocket })); });
      if (sent.signal?.aborted) { aborted(); return; }
      const body = sent.body;
      if (!body) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else { body.once("error", (err) => req.destroy(err)); body.pipe(req); }
    });
  }

  /** A whole exchange in JSON. A body that is not JSON reads as `{}`. */
  async json(target: Target, method: string, path: string, opts: { readonly token?: string; readonly json?: unknown; readonly timeoutMs?: number } = {}): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const body = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : null;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await this.send(target, {
        method, path, body, signal: abort.signal,
        headers: { accept: "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}) },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_JSON_BYTES) { res.destroy(); throw new Error("the answer is too large"); }
        chunks.push(chunk);
      }
      let parsed: unknown = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
      return { status: res.statusCode ?? 0, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The address a node answers at now: the one that last did when that is recent, else whichever of its addresses
   *  answers `GET /healthz` first, all asked together. Null when none does. */
  async reach(node: Reachable, fresh = false): Promise<string | null> {
    const cached = this.good.get(node.fingerprint);
    if (!fresh && cached && this.now() - cached.at < REACH_TTL_MS) return cached.host;
    const candidates = [...new Set([...(cached ? [cached.host] : []), ...(node.last ? [node.last] : []), ...node.lan, ...node.tailnet])].filter((a) => this.allow(a));
    if (!candidates.length) return null;
    const probes = candidates.map(async (host) => {
      const r = await this.json({ host, port: node.port, fingerprint: node.fingerprint }, "GET", "/healthz", { timeoutMs: PROBE_TIMEOUT_MS });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return host;
    });
    const host = await Promise.any(probes).catch(() => null);
    if (host) this.good.set(node.fingerprint, { host, at: this.now() });
    else this.good.delete(node.fingerprint);
    return host;
  }

  /** Why none of a node's addresses answered, in a line: a certificate that is not the pinned one is said as such. */
  async whyNot(node: Reachable): Promise<string> {
    const candidates = [...new Set([...(node.last ? [node.last] : []), ...node.lan, ...node.tailnet])].filter((a) => this.allow(a));
    if (!candidates.length) return "it has no address this node may dial";
    const results = await Promise.all(candidates.map((host) => this.json({ host, port: node.port, fingerprint: node.fingerprint }, "GET", "/healthz", { timeoutMs: PROBE_TIMEOUT_MS }).then(() => null, (err: Error) => err)));
    const mismatch = results.find((e) => e instanceof PinMismatch);
    return mismatch ? mismatch.message : `no answer at ${candidates.join(", ")}`;
  }

  /** The address just failed: the next request looks again. */
  forget(fingerprint: string): void {
    this.good.delete(fingerprint);
  }

  /** A node is gone: its open sockets with it. */
  drop(fingerprint: string): void {
    this.good.delete(fingerprint);
    this.agents.get(fingerprint)?.destroy();
    this.agents.delete(fingerprint);
  }

  close(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    this.good.clear();
  }
}
