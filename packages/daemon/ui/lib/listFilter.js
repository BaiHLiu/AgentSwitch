// What of the terminals list is shown (docs/terminal-v0.md §1 Mac, 2026-10-11, user: 这里要加上筛选某个agent的会话 和筛选活跃
// 会话的功能; the web page since 2026-10-31, docs/linux-app-v0.md): one agent's terminals and sessions alone, and what is
// active alone — the terminals that run, and the sessions the service says are being written now. Both can be on. The
// same rules as the Mac's TerminalListFilter.

/** The agents in the page's order (others after them, by name). */
export const AGENT_ORDER = ["claude-code", "codex", "opencode", "pi"];

/** The filter as kept: `{ agent: string | null, active: boolean }`; anything else is no filter. */
export function filterOf(kept) {
  const agent = typeof kept?.agent === "string" && kept.agent ? kept.agent : null;
  return { agent, active: kept?.active === true };
}

export const filterIsOn = (f) => f.agent !== null || f.active;

/** `agent` alone; chosen again, every agent's. */
export const choosing = (f, agent) => ({ ...f, agent: f.agent === agent ? null : agent });

export const keepsTerminal = (f, t) => (f.agent === null || t.harness === f.agent) && (!f.active || t.status !== "exited");
export const keepsSession = (f, s) => (f.agent === null || s.harness === f.agent) && (!f.active || s.active === true);

/** The agents to choose from: those with a terminal or a session in the list, and the one chosen even when nothing of
 *  its is left (so it can be taken off). None while there is one agent and no choice. */
export function filterAgents(terminals, sessions, chosen = null) {
  const there = new Set([...terminals.map((t) => t.harness), ...sessions.map((s) => s.harness)]);
  const listed = [...AGENT_ORDER.filter((a) => there.has(a)), ...[...there].filter((a) => !AGENT_ORDER.includes(a)).sort()];
  if (chosen && !listed.includes(chosen)) listed.push(chosen);
  return listed.length > 1 || chosen ? listed : [];
}
