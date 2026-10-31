/** An agent's tab of a page that logs without end, tried for real (src/browser/tabLimits.ts): the Camoufox the service
 *  would use, without a window, on a folder of its own in a temporary place; Playwright MCP as the service runs it for
 *  an agent (agentMcp.ts), which takes one snapshot of the tab and then leaves it. The page logs 2 000 console messages
 *  a second, each with an object, and sends 100 requests a second. Every few seconds: the service's heap after a
 *  collection, what the agent's tab keeps (events, requests) and the Playwright objects the service holds.
 *  Nothing of the user's is changed (only the engine's program is read from AgentSwitch's folder).
 *
 *    node --expose-gc --import tsx scripts/tab_limits_probe.ts [seconds]   (default 40) */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { playwrightEngine } from "../src/browser/agentMcp.js";
import type { JsonRpcMessage } from "../src/browser/agents.js";
import { playwrightInUse } from "../src/browser/engine/loader.js";
import { EngineKit, engineRoot } from "../src/browser/engine/kit.js";
import { sharedBrowser } from "../src/browser/setup.js";
import type { TabOwner } from "../src/browser/types.js";

const say = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OWNER: TabOwner = { kind: "terminal", id: "probe1", label: "claude · probe" };
const PAGE = `<title>noisy</title><script>
  let n = 0;
  setInterval(() => { for (let i = 0; i < 20; i++) console.log("[dev] tick", n++, { n, text: "x".repeat(80) }); fetch("/ping?" + n).catch(() => {}); }, 10);
</script><p>noisy</p>`;

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 40);
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) { say("run with node --expose-gc"); return; }
  const home = mkdtempSync(join(process.env.PROBE_TMP ?? tmpdir(), "as-tab-limits-"));
  const site = createServer((req, res) => {
    if (req.url?.startsWith("/ping")) { res.writeHead(204).end(); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const kit = new EngineKit({ root: engineRoot(process.env.AGENTSWITCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentSwitch")) });
  if (!kit.executable()) { say("no Camoufox installed in AgentSwitch's folder: nothing to try with"); site.close(); rmSync(home, { recursive: true, force: true }); return; }
  const browser = sharedBrowser({ home, userHome: home, protected: { roots: [], exempt: [] }, ownPorts: () => [], headless: true, kit });
  try {
    const tab = await browser.host.open(OWNER, at);
    say(`engine ${browser.engine()}, tab ${tab.id} on ${at}`);
    // The agent: one connection, as the bridge makes it, and one snapshot.
    const waiting = new Map<number, (m: JsonRpcMessage) => void>();
    let conn: Awaited<ReturnType<ReturnType<typeof playwrightEngine>>> | null = null;
    const send = (m: JsonRpcMessage) => {
      const msg = m as JsonRpcMessage & { id?: number; method?: string };
      if (msg.method === "roots/list" && msg.id !== undefined) { conn?.receive({ jsonrpc: "2.0", id: msg.id, result: { roots: [] } } as JsonRpcMessage); return; }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)!(m); waiting.delete(msg.id); }
    };
    let id = 0;
    const call = (method: string, params: object) => new Promise<JsonRpcMessage>((ok) => { const n = ++id; waiting.set(n, ok); conn!.receive({ jsonrpc: "2.0", id: n, method, params } as JsonRpcMessage); });
    conn = await playwrightEngine(browser.host, () => undefined)({ owner: OWNER, outputDir: join(home, "agent"), send });
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
    conn.receive({ jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcMessage);
    await call("tools/call", { name: "browser_snapshot", arguments: {} });
    const page = browser.host.page(tab.id)?.playwright?.() as { _connection?: { _objects?: Map<unknown, unknown> } };
    const { tools } = playwrightInUse().require("playwright-core/lib/coreBundle") as { tools: { Tab: { forPage(p: unknown): { _recentEventEntries: unknown[]; _requests: unknown[] } | undefined } } };
    const mcpTab = tools.Tab.forPage(page);
    say("seconds   heap after gc   tab events   tab requests   Playwright objects");
    const t0 = Date.now();
    for (let s = 0; s <= seconds; s += 5) {
      await sleep(Math.max(0, t0 + s * 1000 - Date.now()));
      gc();
      const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
      say(`${String(s).padStart(7)}   ${`${heap} MB`.padStart(13)}   ${String(mcpTab?._recentEventEntries.length ?? "—").padStart(10)}   ${String(mcpTab?._requests.length ?? "—").padStart(12)}   ${String(page._connection?._objects?.size ?? "—").padStart(18)}`);
    }
    await conn.close();
  } finally {
    await browser.host.shutdown();
    await browser.stop();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
