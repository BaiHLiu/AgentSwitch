/** What an agent's tab may keep of what its page does while nobody looks (agentMcp.ts applies it to every Playwright
 *  MCP tab as it is made, and to every agent page once).
 *
 *  Playwright MCP's `Tab` keeps every console message and request of its page from the agent's last snapshot on
 *  (`_recentEventEntries`), every request since the last navigation it made itself (`_requests`), and writes every
 *  console message to a log file in the connection's folder. Each message also holds a handle on each of its arguments,
 *  in the service and in the page, until Playwright's own cap (100 000 handles). A page an agent left open that logs as
 *  it runs — a dev server's page, a few lines a second — kept 390 000 events in 14 hours: the service grew to 2 GB, all
 *  but 0.6 GB of it that one tab, and the log file to 39 MB (2026-10-22, user: agent switch有内存泄露问题，我mbp上的已经
 *  占用了1G多了).
 *
 *  Kept now, as much as Playwright keeps of a page itself: the newest 100 requests (`page.requests()`) and the newest
 *  200 events (`page.consoleMessages()`); downloads are never let go, being the only events a snapshot shows. The log
 *  file takes 5 000 lines between two snapshots and leaves out the rest. A message's argument handles are let go as it
 *  arrives: Playwright MCP reads a message's text, never its arguments. These are members of Playwright MCP's `Tab`
 *  (0.0.82 in playwright-core 1.64); a tab that is not as expected is left as it is. */

/** The newest requests a tab keeps, as Playwright keeps of a page's (`page.requests()`). */
export const TAB_REQUESTS = 100;
/** The newest events a tab keeps between two snapshots, as Playwright keeps of a page's console messages. */
export const TAB_EVENTS = 200;
/** The lines the console log file takes between two snapshots. */
export const TAB_LOG_LINES = 5_000;

type Entry = { readonly type?: string };
type LogFile = { appendLine(wallTime: number, text: string): void; take(relativeTo?: string): Promise<string | undefined> };
/** The members of Playwright MCP's `Tab` (tools/backend/tab.ts) that are limited. */
type TabBuffers = {
  _recentEventEntries: Entry[];
  _requests: unknown[];
  _consoleLog: LogFile;
  _addLogEntry(entry: Entry): void;
  _resetLogs(): void;
};
type ConsolePage = { on(event: "console", listener: (message: { args?(): readonly { dispose?(): Promise<void> }[] }) => void): unknown };

const limited = new WeakSet<object>();
const isFunction = (f: unknown): boolean => typeof f === "function";
const isDownload = (entry: Entry): boolean => entry.type === "download-start" || entry.type === "download-finish";

/** Limits one Playwright MCP tab. False: not a tab as expected (left as it is). */
export function limitTab(tab: unknown): boolean {
  if (!tab || typeof tab !== "object") return false;
  if (limited.has(tab)) return true;
  const t = tab as TabBuffers;
  if (!isFunction(t._addLogEntry) || !isFunction(t._resetLogs) || !Array.isArray(t._recentEventEntries) || !Array.isArray(t._requests)) return false;
  const addLogEntry = t._addLogEntry.bind(tab);
  const resetLogs = t._resetLogs.bind(tab);
  // Methods of this one tab object (Playwright MCP calls them on `this`); the class is untouched.
  Object.assign(tab, {
    _addLogEntry: (entry: Entry) => {
      addLogEntry(entry);
      // Read anew each time: a snapshot hands the list on and starts another.
      const events = t._recentEventEntries;
      while (events.length > TAB_EVENTS) {
        const oldest = events.findIndex((e) => !isDownload(e));
        if (oldest < 0) break;
        events.splice(oldest, 1);
      }
      if (t._requests.length > TAB_REQUESTS) t._requests.splice(0, t._requests.length - TAB_REQUESTS);
    },
    // A navigation through the tab starts another log file.
    _resetLogs: () => { resetLogs(); limitLog(t._consoleLog); },
  });
  limitLog(t._consoleLog);
  limited.add(tab);
  return true;
}

function limitLog(log: unknown): void {
  if (!log || typeof log !== "object" || limited.has(log)) return;
  const l = log as LogFile;
  if (!isFunction(l.appendLine) || !isFunction(l.take)) return;
  const appendLine = l.appendLine.bind(log);
  const take = l.take.bind(log);
  let lines = 0;
  Object.assign(log, {
    appendLine: (wallTime: number, text: string) => { if (lines++ < TAB_LOG_LINES) appendLine(wallTime, text); },
    take: (relativeTo?: string) => { lines = 0; return take(relativeTo); },
  });
  limited.add(log);
}

/** Lets go of each console message's argument handles as it arrives on `page`. */
export function releaseConsoleArgs(page: unknown): void {
  if (!page || typeof page !== "object" || !isFunction((page as Partial<ConsolePage>).on)) return;
  try {
    (page as ConsolePage).on("console", (message) => {
      for (const arg of message.args?.() ?? []) void arg.dispose?.().catch(() => undefined);
    });
  } catch { /* not a page that tells its console */ }
}
