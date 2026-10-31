/** The terminals list's filter line (ui/lib/listFilter.js): the Mac's TerminalListFilter, for the web page. */
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain browser module
import { choosing, filterAgents, filterIsOn, filterOf, keepsSession, keepsTerminal } from "../ui/lib/listFilter.js";

const t = (harness: string, status = "idle") => ({ harness, status });
const s = (harness: string, active = false) => ({ harness, active });

describe("the list's filter", () => {
  it("keeps one agent's terminals and sessions, and what is active: running terminals, sessions written now", () => {
    const codex = { agent: "codex", active: false };
    expect(keepsTerminal(codex, t("codex"))).toBe(true);
    expect(keepsTerminal(codex, t("claude-code"))).toBe(false);
    expect(keepsSession(codex, s("claude-code"))).toBe(false);
    const active = { agent: null, active: true };
    expect(keepsTerminal(active, t("pi", "working"))).toBe(true);
    expect(keepsTerminal(active, t("pi", "exited"))).toBe(false);
    expect(keepsSession(active, s("pi", true))).toBe(true);
    expect(keepsSession(active, s("pi"))).toBe(false);
    expect(keepsSession({ agent: "codex", active: true }, s("codex", true))).toBe(true);
    expect(keepsSession({ agent: "codex", active: true }, s("pi", true))).toBe(false);
  });

  it("chooses an agent, and the same again takes it off; Active stays as it was", () => {
    const f = choosing({ agent: null, active: true }, "codex");
    expect(f).toEqual({ agent: "codex", active: true });
    expect(choosing(f, "codex")).toEqual({ agent: null, active: true });
    expect(choosing(f, "pi")).toEqual({ agent: "pi", active: true });
    expect(filterIsOn({ agent: null, active: false })).toBe(false);
  });

  it("offers the agents in the list, in the page's order; none while there is one and no choice", () => {
    expect(filterAgents([t("pi")], [s("codex"), s("claude-code"), s("zed")])).toEqual(["claude-code", "codex", "pi", "zed"]);
    expect(filterAgents([t("codex")], [s("codex")])).toEqual([]);
    expect(filterAgents([t("codex")], [], "opencode")).toEqual(["codex", "opencode"]);
  });

  it("reads a kept filter, and nothing it does not know", () => {
    expect(filterOf(null)).toEqual({ agent: null, active: false });
    expect(filterOf({ agent: "codex", active: true })).toEqual({ agent: "codex", active: true });
    expect(filterOf({ agent: 3, active: "yes" })).toEqual({ agent: null, active: false });
  });
});
