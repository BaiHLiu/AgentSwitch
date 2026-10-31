/** What an agent's tab keeps of a page nobody looks at (src/browser/tabLimits.ts). Pinned on Playwright MCP's own `Tab`
 *  class (playwright-core's bundle, as the daemon loads it) over a stand-in for the Playwright page: a page that logs
 *  and sends without end leaves the tab with its newest requests and events only, downloads kept; the console log file
 *  takes a bounded number of lines between snapshots, a navigation's new file too; each console message's argument
 *  handles are let go as it arrives. */

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TAB_EVENTS, TAB_LOG_LINES, TAB_REQUESTS, limitTab, releaseConsoleArgs } from "../src/browser/tabLimits.js";

type Entry = { readonly type: string };
type McpTab = {
  _recentEventEntries: Entry[];
  _consoleLog: { take(): Promise<string | undefined> };
  _addLogEntry(entry: object): void;
  _resetLogs(): void;
  requests(): Promise<{ url(): string }[]>;
  waitForInitialized(): Promise<void>;
};
type TabClass = new (context: object, page: object, onPageClose: (tab: unknown) => void) => McpTab;
const { Tab } = (createRequire(import.meta.url)("playwright-core/lib/coreBundle") as { tools: { Tab: TabClass } }).tools;

function request(url: string) {
  return { url: () => url, method: () => "GET", postData: () => null, timing: () => ({ startTime: Date.now() }), existingResponse: () => null, failure: () => null, isNavigationRequest: () => false, resourceType: () => "fetch" };
}

function message(text: string) {
  return { type: () => "log", text: () => text, timestamp: () => Date.now(), location: () => ({ url: "http://127.0.0.1:5173/", lineNumber: 1 }) };
}

/** A Playwright page as Playwright MCP's tab reads it: nothing recorded before, and the events it listens to. */
class PwPage extends EventEmitter {
  async requests() { return []; }
  async consoleMessages() { return []; }
  async pageErrors() { return []; }
}

async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-tab-limits-")));
  const files: string[] = [];
  // Playwright MCP's per-connection context, as far as its tab uses it; every log file a name of its own.
  const context = { config: {}, redactSecrets: (t: string) => t, outputFile: async (t: { prefix: string; ext: string }) => { files.push(join(dir, `${t.prefix}-${files.length}.${t.ext}`)); return files.at(-1)!; } };
  const page = new PwPage();
  const tab = new Tab(context, page, () => undefined);
  expect(limitTab(tab)).toBe(true);
  await tab.waitForInitialized();
  const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  return { page, tab, files, lines };
}

describe("an agent's tab of a page nobody looks at", () => {
  it("keeps the newest requests and events, and every download", async () => {
    const { page, tab } = await setup();
    tab._addLogEntry({ type: "download-start", wallTime: Date.now(), download: {} });
    for (let i = 0; i < 2_000; i++) {
      page.emit("request", request(`http://127.0.0.1:5173/@vite/ping?${i}`));
      page.emit("console", message(`[vite] tick ${i}`));
    }
    expect(tab._recentEventEntries).toHaveLength(TAB_EVENTS);
    expect(tab._recentEventEntries[0]!.type).toBe("download-start");
    expect((tab._recentEventEntries.at(-1) as unknown as { message: { text: string } }).message.text).toBe("[vite] tick 1999");
    const urls = (await tab.requests()).map((r) => r.url());
    expect(urls).toHaveLength(TAB_REQUESTS);
    expect(urls.at(-1)).toBe("http://127.0.0.1:5173/@vite/ping?1999");
    expect(urls[0]).toBe(`http://127.0.0.1:5173/@vite/ping?${2_000 - TAB_REQUESTS}`);
    // A snapshot hands the list on and starts another: that one is limited too.
    tab._recentEventEntries = [];
    for (let i = 0; i < 500; i++) page.emit("console", message(`[vite] again ${i}`));
    expect(tab._recentEventEntries).toHaveLength(TAB_EVENTS);
  });

  it("its console log file takes so many lines between snapshots, a navigation's new file too", async () => {
    const { page, tab, files, lines } = await setup();
    for (let i = 0; i < TAB_LOG_LINES + 300; i++) page.emit("console", message(`line ${i}`));
    await tab._consoleLog.take();   // a snapshot: after the writes so far
    expect(lines(files[0]!)).toBe(TAB_LOG_LINES);
    for (let i = 0; i < 10; i++) page.emit("console", message(`after ${i}`));
    await tab._consoleLog.take();
    expect(lines(files[0]!)).toBe(TAB_LOG_LINES + 10);
    tab._resetLogs();   // what a navigation through the tab does
    for (let i = 0; i < TAB_LOG_LINES + 300; i++) page.emit("console", message(`next ${i}`));
    await tab._consoleLog.take();
    expect(files).toHaveLength(2);
    expect(lines(files[1]!)).toBe(TAB_LOG_LINES);
  });

  it("a tab that is not Playwright MCP's as expected is left as it is", () => {
    const odd = { _addLogEntry: () => undefined };
    expect(limitTab(odd)).toBe(false);
    expect(limitTab(null)).toBe(false);
  });
});

describe("an agent page's console messages", () => {
  it("let go of their argument handles as they arrive", async () => {
    const page = new EventEmitter();
    releaseConsoleArgs(page);
    const disposed: string[] = [];
    const handle = (name: string) => ({ dispose: async () => { disposed.push(name); } });
    page.emit("console", { args: () => [handle("a"), handle("b")] });
    page.emit("console", { args: () => [] });
    page.emit("console", {});   // a message without arguments to give
    const failing = { dispose: async () => { throw new Error("target closed"); } };
    page.emit("console", { args: () => [failing, handle("c")] });
    await new Promise((r) => setTimeout(r, 0));
    expect(disposed).toEqual(["a", "b", "c"]);
    releaseConsoleArgs({});   // not a page that tells its console: nothing to do
  });
});
