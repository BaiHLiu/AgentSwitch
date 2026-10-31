// The node's own service as the window reaches it (docs/linux-app-v0.md §1): its local listener on 127.0.0.1, its
// token in the data folder. The token stays in the main process; the page signs in with a one-time link.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 4711;

/** The data folder: `$AGENTSWITCH_HOME`, else `~/.agentswitch` (as the keeper has it). */
export function agentswitchHome(env = process.env) {
  return env.AGENTSWITCH_HOME || join(env.HOME || homedir(), ".agentswitch");
}

/** The local port the keeper runs the service on: `node.json`'s `ports.local` (agentswitch config › Node), else 4711. */
export function localPort(home) {
  try {
    const port = JSON.parse(readFileSync(join(home, "node.json"), "utf8"))?.ports?.local;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch { /* no file, or not one the keeper could read either */ }
  return DEFAULT_PORT;
}

/** The service's address: `AGENTSWITCH_URL` for a service elsewhere on this machine, else the keeper's port. */
export function serviceBase(env = process.env, home = agentswitchHome(env)) {
  return (env.AGENTSWITCH_URL || `http://127.0.0.1:${localPort(home)}`).replace(/\/+$/, "");
}

/** The local token (`local-token`, 0600). Throws while the service has not made one yet. */
export function readToken(home) {
  const token = readFileSync(join(home, "local-token"), "utf8").trim();
  if (!token) throw new Error("local-token is empty");
  return token;
}

/** A one-time sign-in link to `next` (a page of the console, `/ui/terminal.html`): good once, within a minute. */
export async function consoleLink({ base, token, next, fetch = globalThis.fetch }) {
  const res = await fetch(`${base}/local/console-link${next ? `?next=${encodeURIComponent(next)}` : ""}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
  });
  if (!res.ok) throw new Error(`the service refused to sign in (${res.status})`);
  const { path } = await res.json();
  if (typeof path !== "string" || !path.startsWith("/ui/login?")) throw new Error("the service answered no sign-in link");
  return `${base}${path}`;
}

/** `GET /live` with the token: what waits for you, what runs, what just ended. */
export async function live({ base, token, fetch = globalThis.fetch, signal }) {
  const res = await fetch(`${base}/live`, { headers: { authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw new Error(`GET /live: ${res.status}`);
  return res.json();
}

/** Whether a page the window was sent to is this service's own (anything else opens in the system's browser). */
export function ownPage(base, url) {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}
