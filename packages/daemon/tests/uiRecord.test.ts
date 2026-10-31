/** The web page's simple view rules (ui/lib/record.js): the Mac's SessionRecord, RecordDisplay, ReplyHints, TerminalDraft,
 *  TerminalEffort, TerminalDaybreak, ModelName and ShellHighlight, for the panes of the browser and the Linux window. */
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain browser module
import * as R from "../ui/lib/record.js";

type Item = { id: string; kind: string; at: number; text: string; steps: { kind: string; text: string; added: number | null; removed: number | null; failed: boolean }[]; questions: { title: string; options: string[] }[]; from: string | null };
const item = (raw: Record<string, unknown>): Item => R.itemOf(raw);
const work = (id: string, steps: Record<string, unknown>[], secs = 0) => item({ id, type: "work", ts: 1, secs, steps });

describe("the record", () => {
  it("reads items and steps as the service sends them, a kind it does not know left out or a tool", () => {
    expect(R.itemOf({ id: "1", type: "future" })).toBeNull();
    const w = work("5", [{ kind: "edit", text: "a.ts", added: 3, removed: 1 }, { kind: "mcp__x", text: "q" }]);
    expect(w.steps[1]).toMatchObject({ kind: "tool", tool: "mcp__x" });
    expect(item({ id: "2", type: "user", ts: 9, text: "hi", from: "Room" })).toMatchObject({ kind: "user", at: 9, from: "Room" });
  });

  it("lays the latest page over what is held, keeping earlier pages; a gap or no places: the page alone", () => {
    const held = ["100", "200", "300"].map((id) => item({ id, type: "answer", ts: 1, text: id }));
    const page = ["300", "400"].map((id) => item({ id, type: "answer", ts: 1, text: id }));
    expect(R.merged(held, page).items.map((i: Item) => i.id)).toEqual(["100", "200", "300", "400"]);
    expect(R.merged(held, page).replaced).toBe(false);
    const far = ["900"].map((id) => item({ id, type: "answer", ts: 1, text: id }));
    expect(R.merged(held, far)).toMatchObject({ replaced: true });
    expect(R.merged([], page).items).toBe(page);
  });

  it("shows the latest items, keeps a reader's place while they read back, and Earlier opens what is held first", () => {
    const items = Array.from({ length: 100 }, (_, n) => item({ id: String(n), type: "note", ts: n, text: "" }));
    expect(R.shownFrom(items, null)).toBe(40);
    expect(R.shownStart(items, null, true)).toBeNull();
    expect(R.shownStart(items, null, false)).toBe("40");
    expect(R.shownEarlier(items, null)).toBe("0");
    expect(R.shownEarlier(items, "0")).toBeNull();
  });

  it("puts what was sent and not yet in the record at its end, queued while it works, and drops one the record has", () => {
    const items = [item({ id: "1", type: "user", ts: 10_000, text: "hello there" })];
    const sent = [{ id: "a", text: "hello there", at: 10_500, files: 0 }, { id: "b", text: "and more", at: 11_000, files: 0 }];
    const out = R.withSent(items, sent, true);
    expect(out.map((i: Item & { queued: boolean }) => [i.id, i.queued])).toEqual([["1", false], ["sent-b", true]]);
  });

  it("places a screen's notice by its time, before everything when it is older than all of it", () => {
    const items = [item({ id: "1", type: "user", ts: 10, text: "a" }), item({ id: "2", type: "answer", ts: 30, text: "b" })];
    expect(R.withNotices(items, [{ id: "n", text: "Daybreak off", at: 20 }]).map((i: Item) => i.id)).toEqual(["1", "notice-n", "2"]);
    expect(R.withNotices(items, [{ id: "m", text: "x", at: 1 }])[0].id).toBe("notice-m");
  });

  it("knows the answer it was writing is in the record by its first words, and the questions still open", () => {
    const items = [item({ id: "1", type: "answer", ts: 1, text: "Here is   the plan for today", questions: [{ title: "Go?", options: ["Yes", "No"] }] })];
    expect(R.holds(items, "Here is the plan")).toBe(true);
    expect(R.holds(items, "Something else")).toBe(false);
    expect(R.openQuestions(items, [])).toHaveLength(1);
    expect(R.openQuestions(items, [{ id: "x", text: "y", at: 2 }])).toEqual([]);
  });
});

describe("how the record is worded", () => {
  it("says a run of work on one line, kinds in the order they first came, thinking and tasks not counted", () => {
    const w = work("1", [{ kind: "read", text: "a" }, { kind: "run", text: "ls" }, { kind: "think", text: "" }, { kind: "read", text: "b" },
      { kind: "agent", text: "x" }, { kind: "agent", text: "y" }, { kind: "todo", text: "" }], 72);
    expect(R.summary(w)).toBe("Worked 1m 12s · Read 2 · Ran 1 · Agents 2");
    expect(R.summary(work("2", [], 0), true)).toBe("Working");
  });

  it("words durations, clocks and the turn's tokens as the Mac does", () => {
    expect([R.duration(8), R.duration(72), R.duration(3780)]).toEqual(["8s", "1m 12s", "1h 03m"]);
    expect([R.clock(41), R.clock(725), R.clock(3745)]).toEqual(["0:41", "12:05", "1:02:25"]);
    expect([R.turnTokens({ tokens: 250 }), R.turnTokens({ tokens: 1300 }), R.turnTokens({ tokens: 12000, way: "up" }), R.turnTokens({ tokens: 0 })])
      .toEqual(["↓ 250 tokens", "↓ 1.3k tokens", "↑ 12k tokens", null]);
  });

  it("sums a run's lines, labels its steps and lists the files changed, the latest touched first", () => {
    const a = work("10", [{ kind: "edit", text: "a.ts", added: 2, removed: 1 }, { kind: "write", text: "b.ts", added: 5, removed: 0 }]);
    const b = work("20", [{ kind: "edit", text: "a.ts", added: 1, removed: 0 }, { kind: "edit", text: "c.ts", added: 1, removed: 1, failed: true }]);
    expect(R.stat(a.steps)).toEqual({ added: 7, removed: 1 });
    expect(R.stat(work("3", [{ kind: "read", text: "x" }]).steps)).toBeNull();
    expect(R.label({ kind: "tool", tool: "Skill" })).toBe("Skill");
    expect(R.changedFiles([a, b]).map((f: { path: string; runs: number; added: number }) => [f.path, f.runs, f.added])).toEqual([["a.ts", 2, 3], ["b.ts", 1, 5]]);
  });

  it("says how full the context is, the mode in its word, the task list on a line", () => {
    expect(R.context({ used: 124_000, window: 200_000 })).toBe("62%");
    expect(R.context({ used: 238_400 })).toBe("238k");
    expect(R.contextMeter({ used: 124_000, window: 200_000 })).toEqual({ part: 0.62, words: "124k / 200k" });
    expect([R.modeName("acceptEdits"), R.modeName("bypassPermissions"), R.modeName("weird")]).toEqual(["Edits", "Bypass", null]);
    expect(R.planLine([{ text: "a", state: "done" }, { text: "b", state: "doing" }, { text: "c", state: "todo" }])).toEqual({ done: 1, total: 3, now: "b" });
  });

  it("folds a long answer where a paragraph ends, closing a code fence the cut left open", () => {
    expect(R.preview("short")).toBeNull();
    const long = `${"a".repeat(1500)}\n\n\`\`\`\n${"b".repeat(3000)}`;
    const head = R.preview(long);
    expect(head.startsWith("a".repeat(1500))).toBe(true);
    const fenced = `${"a".repeat(2000)}\n\`\`\`\n${"b".repeat(2000)}`;
    expect(R.preview(fenced).endsWith("\n```")).toBe(true);
  });

  it("names models as people read them", () => {
    expect(R.modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(R.modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(R.modelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(R.modelName("google/gemini-2-5-pro")).toBe("Gemini 2.5 Pro");
    expect(R.modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 (1M)");
    expect(R.isCurrent({ id: "opus", name: "Opus 5.5" }, "claude-opus-5-5")).toBe(true);
  });

  it("says why a control cannot change anything now, and what the service's refusals mean", () => {
    expect(R.locked({ harness: "claude-code", status: "idle" })).toBeNull();
    expect(R.locked({ harness: "claude-code", status: "working" })).toBe("它正在工作，结束后再调整。");
    expect(R.locked({ harness: "claude-code", status: "working", whileWorking: true })).toBeNull();
    expect(R.locked({ harness: "codex", status: "idle", sets: false })).toContain("/model");
    expect(R.locked({ harness: "pi", status: "exited" })).toBe("终端已结束。");
    expect(R.refusal("no session yet: send something")).toContain("还没有会话");
  });

  it("offers the levels of the model it is on, and Codex's models as its Daybreak switch stands", () => {
    const models = { "claude-code": [{ id: "opus", name: "Opus 5.5", efforts: ["low", "high"] }] };
    expect(R.levelsOf(models, { "claude-code": ["low", "medium"] }, "claude-code", "claude-opus-5-5")).toEqual(["low", "high"]);
    expect(R.levelsOf(models, { "claude-code": ["low", "medium"] }, "claude-code", "other")).toEqual(["low", "medium"]);
    expect([R.effortName("xhigh"), R.effortName("very-high")]).toEqual(["XHigh", "Very High"]);
    const opts = [{ id: "a", name: "A", daybreak: "never" }, { id: "b", name: "B", daybreak: "only" }, { id: "c", name: "C" }];
    expect(R.daybreakOffered(opts, true).map((o: { id: string }) => o.id)).toEqual(["b", "c"]);
    expect(R.daybreakClash(opts[0], true)).toContain("不支持 Daybreak");
    expect(R.daybreakClash(opts[2], true)).toBeNull();
  });
});

describe("the reply box", () => {
  it("asks for commands after a slash, files after an @, and says what ! and $ do", () => {
    expect(R.hintAsk("/com", 4, "claude-code")).toEqual({ commands: "com" });
    expect(R.hintAsk("/compact now", 12, "claude-code")).toBeNull();
    expect(R.hintAsk("look at @src/ho", 15, "claude-code")).toEqual({ files: "src/ho", at: 8 });
    expect(R.hintAsk("mail me@host", 12, "claude-code")).toBeNull();
    expect(R.hintAsk("!ls", 3, "codex")).toMatchObject({ mark: { word: "Shell" } });
    expect(R.hintAsk("$x", 2, "codex")).toMatchObject({ mark: { word: "Skills" } });
    expect(R.hintAsk("$x", 2, "claude-code")).toBeNull();
  });

  it("narrows commands by their start, then by a word inside, and types what is chosen", () => {
    const all = [{ name: "compact" }, { name: "clear" }, { name: "frontend:lint" }, { name: "lint-all" }];
    expect(R.matching("c", all).map((c: { name: string }) => c.name)).toEqual(["compact", "clear"]);
    expect(R.matching("lint", all).map((c: { name: string }) => c.name)).toEqual(["lint-all", "frontend:lint"]);
    expect(R.matching("clear", all)).toEqual([]);
    expect(R.typedCommand({ name: "compact" })).toBe("/compact ");
    expect([R.typedFile("a b.ts", "claude-code"), R.typedFile("a.ts", "codex")]).toEqual(['@"a b.ts" ', "a.ts "]);
  });

  it("stands a reply's files in its text as placeholders, and takes one out with its space", () => {
    expect(R.fileToken(true, 2)).toBe("[Image #2]");
    expect(R.typedTokens(["[File #1]"], "x")).toBe(" [File #1] ");
    expect(R.typedTokens(["[File #1]"], " ")).toBe("[File #1] ");
    expect(R.withoutToken("see [File #1] and [Image #2] here", "[File #1]")).toBe("see and [Image #2] here");
    expect(R.isImageName("shot.PNG")).toBe(true);
    expect(R.placeholder(false, "Run the tests", true)).toBe("Run the tests  ·  tab");
    expect(R.placeholder(true, null, false)).toBe("Reply · esc to Stop");
  });
});

describe("a command in colour", () => {
  const kinds = (s: string) => R.shellRuns(s).filter((r: { kind: string }) => r.kind !== "plain").map((r: { text: string; kind: string }) => `${r.kind}:${r.text}`);
  it("colours the word each command begins with, quotes, comments and a here-document's body", () => {
    expect(kinds('cd /x && git log --oneline | head -5 # last')).toEqual(["command:cd", "command:git", "command:head", "comment:# last"]);
    expect(kinds('FOO=1 make "all" 2>&1 | tee out')).toEqual(["command:make", 'string:"all"', "command:tee"]);
    expect(kinds("cat <<'EOF' > f\nhello\nEOF\necho done")).toEqual(["command:cat", "string:'EOF'", "string:hello\nEOF", "command:echo"]);
    expect(R.shellRuns("a b").map((r: { text: string }) => r.text).join("")).toBe("a b");
  });
});
