// The simple view's rules (docs/simple-view-v0.md §2, §4, §5), for the web page's panes (docs/linux-app-v0.md, 2026-10-31,
// catop: 需要加上简略视图和另一种theme，让其基本与mac app 1：1复刻): how a session's record is laid out and worded. The
// same rules as the Mac's SessionRecord, RecordDisplay, ReplyHints, TerminalDraft, TerminalEffort, TerminalDaybreak,
// ModelName and ShellHighlight (AgentSwitchMacCore) — keep them in step. Pure: no page, no service.

// ---------- the record ----------

/** How many of the latest items a pane shows as it opens, how many more each `Earlier` brings, and the most it keeps
 *  for a reader who stays away from the end while the record grows. */
export const SHOWN_ITEMS = 60;
export const EARLIER_ITEMS = 80;
export const MOST_ITEMS = 400;
/** How long a new terminal with no session yet is shown as starting. */
export const STARTING_MS = 8000;
/** Characters of a long answer shown before `Show More`, and how long one is before it is folded at all. */
export const PREVIEW_CHARS = 2400;
export const FOLD_CHARS = 3600;
/** The reading column at its widest, the narrowest pane that has a side, and the side's width there. */
export const COLUMN = 780;
export const SIDE_FROM = 980;
export const sideWidth = (pane) => (pane >= SIDE_FROM ? Math.min(Math.max(Math.round(pane * 0.3), 300), 440) : null);

const STEP_KINDS = new Set(["read", "search", "list", "run", "edit", "write", "web", "agent", "todo", "think", "tool"]);
const ITEM_KINDS = new Set(["user", "answer", "work", "note"]);

/** A step as the page reads it: a kind it does not know is a tool by its name. */
export function stepOf(raw) {
  const kind = STEP_KINDS.has(raw?.kind) ? raw.kind : "tool";
  return {
    kind, text: String(raw?.text ?? ""), tool: raw?.tool ?? (kind === "tool" && raw?.kind && !STEP_KINDS.has(raw.kind) ? String(raw.kind) : null),
    note: raw?.note ? String(raw.note) : null, out: typeof raw?.out === "string" ? raw.out : null, failed: raw?.failed === true,
    added: Number.isInteger(raw?.added) ? raw.added : null, removed: Number.isInteger(raw?.removed) ? raw.removed : null,
    images: Math.max(0, Number(raw?.images) || 0),
  };
}

/** An item as the page reads it (`type` → `kind`); null for a kind a newer service added. */
export function itemOf(raw) {
  if (!raw || typeof raw.id !== "string" || !ITEM_KINDS.has(raw.type)) return null;
  return {
    id: raw.id, kind: raw.type, at: Number(raw.ts) || 0, text: String(raw.text ?? ""), images: Number(raw.images) || 0, queued: raw.queued === true,
    from: typeof raw.from === "string" ? raw.from : null, clipped: raw.clipped === true, thinking: raw.thinking === true, seconds: Number(raw.secs) || 0,
    steps: Array.isArray(raw.steps) ? raw.steps.map(stepOf) : [],
    questions: Array.isArray(raw.questions) ? raw.questions.filter((q) => q && Array.isArray(q.options)).map((q) => ({ title: String(q.title ?? ""), options: q.options.map(String) })) : [],
  };
}

/** Where an item begins in the agent's file, when its id says. */
export const offsetOf = (item) => { const n = Number(String(item.id).split(".")[0]); return Number.isFinite(n) && /^\d/.test(item.id) ? n : null; };

/** The latest page laid over what a pane holds: earlier pages it asked for stay, the page's own stretch is replaced.
 *  Nothing earlier held, a gap between the two, or a record without places: the page is the record. */
export function merged(held, page) {
  const first = page[0] ? offsetOf(page[0]) : null;
  const earliest = held[0] ? offsetOf(held[0]) : null;
  const last = [...held].reverse().find((i) => offsetOf(i) !== null);
  const lastAt = last ? offsetOf(last) : null;
  if (first === null || earliest === null || !(earliest < first) || lastAt === null || !(lastAt >= first)) return { items: page, replaced: true };
  return { items: [...held.filter((i) => (offsetOf(i) ?? Infinity) < first), ...page], replaced: false };
}

const words = (text, n) => String(text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, n);

/** Whether the record's last answer is what was being written: the part is there, and what was shown of it can go. */
export function holds(items, written) {
  const head = words(written, 40);
  if (!head) return true;
  return items.slice(-4).some((i) => i.kind === "answer" && words(i.text, 1e9).startsWith(head));
}

/** The record with what the agent's screen said to commands, each a note where its time puts it. */
export function withNotices(items, notices) {
  if (!notices?.length) return items;
  const out = [...items];
  for (const n of notices) {
    const note = { id: `notice-${n.id}`, kind: "note", at: n.at, text: n.text, images: 0, queued: false, from: null, clipped: false, thinking: false, seconds: 0, steps: [], questions: [] };
    let index = 0;
    for (let k = out.length - 1; k >= 0; k--) if (out[k].at <= n.at) { index = k + 1; break; }
    out.splice(index, 0, note);
  }
  return out;
}

/** The questions still open at the record's end: those of its last answer, while nothing of yours comes after it. */
export function openQuestions(items, sent) {
  if (sent?.length) return [];
  const last = [...items].reverse().find((i) => i.kind === "user" || i.kind === "answer");
  return last?.kind === "answer" ? last.questions.filter((q) => q.options.length) : [];
}

/** The record with the replies sent and not yet in it at its end, each as a message of yours (`Queued` while it works). */
export function withSent(items, sent, working) {
  if (!sent?.length) return items;
  const recent = items.slice(-12).filter((i) => i.kind === "user" && i.from === null);
  const waiting = sent.filter((r) => !recent.some((i) => i.at >= r.at - 3000 && ((r.files ?? 0) > 0 || words(i.text, 24) === words(r.text, 24))));
  return [...items, ...waiting.map((r) => ({ id: `sent-${r.id}`, kind: "user", at: r.at ?? 0, text: r.text, images: 0, queued: working, from: null, clipped: false,
    thinking: false, seconds: 0, steps: [], questions: [] }))];
}

/** Where what a pane shows begins: at `start`, else at the latest `latest`. */
export function shownFrom(items, start, latest = SHOWN_ITEMS) {
  if (start) { const i = items.findIndex((x) => x.id === start); if (i >= 0) return i; }
  return Math.max(0, items.length - latest);
}

/** The start to keep as the record changes: a reader at its end has the latest again; one reading back keeps theirs. */
export function shownStart(items, start, atEnd, latest = SHOWN_ITEMS, most = MOST_ITEMS) {
  if (atEnd || !items.length) return null;
  const from = shownFrom(items, start, latest);
  return items.length - from > most ? null : items[from].id;
}

/** The start once `Earlier` is asked for, while the pane holds more than it shows; null when it shows all it holds. */
export function shownEarlier(items, start, more = EARLIER_ITEMS, latest = SHOWN_ITEMS) {
  const from = shownFrom(items, start, latest);
  return from > 0 ? items[Math.max(0, from - more)].id : null;
}

/** What a pane shows: `items` from `start` on, with what its screen said among them and what was sent at their end. */
export function shown(items, start, notices, sent, working, latest = SHOWN_ITEMS) {
  const from = shownFrom(items, start, latest);
  const all = withNotices(items, notices);
  const first = from > 0 ? Math.max(0, all.findIndex((x) => x.id === items[from].id)) : 0;
  return withSent(first > 0 ? all.slice(first) : all, sent, working);
}

// ---------- how the record is worded ----------

const COUNTED = { read: "Read", search: "Searched", list: "Listed", run: "Ran", edit: "Edited", write: "Edited", web: "Web", agent: "Agent", tool: "Tool" };

/** `8s`, `1m 12s`, `1h 03m`. */
export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** A run of work on one line: `Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 1`. */
export function summary(item, running = false) {
  const counts = [];
  for (const step of item.steps) {
    const word = COUNTED[step.kind];
    if (!word) continue;
    const at = counts.find((c) => c[0] === word);
    if (at) at[1]++; else counts.push([word, 1]);
  }
  const lead = running ? "Working" : "Worked";
  const head = item.seconds > 0 ? `${lead} ${duration(item.seconds)}` : lead;
  return [head, ...counts.map(([w, n]) => `${n > 1 && (w === "Agent" || w === "Tool") ? `${w}s` : w} ${n}`)].join(" · ");
}

/** A clock for what is going on now: `0:41`, `12:05`, `1:02:25`. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n) => String(n).padStart(2, "0");
  return s < 3600 ? `${Math.floor(s / 60)}:${two(s % 60)}` : `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** The turn's tokens as its line says them: `↓ 250 tokens`, `↓ 1.3k tokens`; null for none. */
export function turnTokens(progress) {
  const n = progress?.tokens;
  if (!(n > 0)) return null;
  const tidy = (v) => (v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1));
  const count = n < 1000 ? String(n) : n < 100_000 ? `${tidy(Math.round(n / 100) / 10)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${tidy(Math.round(n / 100_000) / 10)}M`;
  return `${progress.way === "up" ? "↑" : "↓"} ${count} ${n === 1 ? "token" : "tokens"}`;
}

/** Lines in and out over a run's steps; null when it changed no file. */
export function stat(steps) {
  if (!steps.some((s) => s.added !== null || s.removed !== null)) return null;
  return { added: steps.reduce((a, s) => a + (s.added ?? 0), 0), removed: steps.reduce((a, s) => a + (s.removed ?? 0), 0) };
}

const LABELS = { read: "Read", search: "Search", list: "List", run: "Run", edit: "Edit", write: "Write", web: "Web", agent: "Agent", todo: "Tasks", think: "Thought" };
/** What a step is, before what it worked on. */
export const label = (step) => LABELS[step.kind] ?? (step.tool || "Tool");
/** A step that names a file (shown by the end of its path) rather than a command or a query. */
export const namesFile = (step) => ["read", "edit", "write", "list"].includes(step.kind);
/** The steps a run shows when opened: its thinking only in the verbose transcript (each with its place in the run). */
export const shownSteps = (steps, verbose) => steps.map((step, index) => ({ step, index })).filter(({ step }) => verbose || step.kind !== "think");
/** A command opens into itself whole, a step that brought pictures back into them. */
export const stepOpens = (step) => step.kind === "run" || step.images > 0;

/** The classic look's small picture of a kind of step (lib/look.js icon names). */
export const STEP_ICONS = { read: "doc", search: "search", list: "folder", run: "terminal", edit: "pencil", write: "docplus", web: "globe", agent: "branch", todo: "checklist", think: "sparkle", tool: "wrench" };

/** The tool it is using, in one short word. */
export function toolWord(tool) {
  const t = String(tool ?? "").toLowerCase();
  if (["bash", "shell", "commandexecution", "exec_command", "local_shell"].includes(t)) return "Run";
  if (["read", "view", "notebookread"].includes(t)) return "Read";
  if (["write", "edit", "multiedit", "filechange", "apply_patch", "patch", "notebookedit"].includes(t)) return "Edit";
  if (["grep", "glob", "search", "ls", "list"].includes(t)) return "Search";
  if (["webfetch", "websearch", "web_search"].includes(t)) return "Web";
  if (["agent", "task"].includes(t)) return "Agent";
  if (t === "todowrite") return "Tasks";
  if (t === "compact") return "Compact";
  if (String(tool).startsWith("mcp__")) {
    const part = String(tool).split("_").filter(Boolean)[1];
    return part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : "Tool";
  }
  return String(tool ?? "");
}
/** The classic look's picture for what it is doing now; null while it uses no tool. */
export function toolIcon(tool) {
  if (!tool) return null;
  return { Run: "terminal", Read: "doc", Edit: "pencil", Search: "search", Web: "globe", Agent: "branch", Tasks: "checklist", Compact: "compact" }[toolWord(tool)] ?? "wrench";
}

/** How full the context is: `62%` when the record says how much it holds, else the tokens in it (`238k`). */
export function context(usage) {
  const used = usage?.used;
  if (!(used > 0)) return null;
  if (usage.window > 0) return `${Math.min(100, Math.round((used / usage.window) * 100))}%`;
  return used >= 1_000_000 ? `${(used / 1_000_000).toFixed(1)}M` : `${Math.max(1, Math.round(used / 1000))}k`;
}
const tokensWord = (n) => (n >= 1_000_000 ? (n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`) : `${Math.max(1, Math.round(n / 1000))}k`);
/** How full its context is, as a part and in words (`124k / 200k`); null when the agent does not say how large it is. */
export function contextMeter(usage) {
  if (!(usage?.used > 0) || !(usage?.window > 0)) return null;
  return { part: Math.min(1, usage.used / usage.window), words: `${tokensWord(usage.used)} / ${tokensWord(usage.window)}` };
}

/** The files the runs of work in `items` changed, the latest touched first, lines summed over those runs. */
export function changedFiles(items) {
  let order = [];
  const files = new Map();
  for (const item of items) {
    if (item.kind !== "work") continue;
    const touched = new Set();
    for (const step of item.steps) {
      if ((step.kind !== "edit" && step.kind !== "write") || step.failed || !step.text) continue;
      const held = files.get(step.text);
      files.set(step.text, { path: step.text, added: (held?.added ?? 0) + (step.added ?? 0), removed: (held?.removed ?? 0) + (step.removed ?? 0),
        runs: (held?.runs ?? 0) + (touched.has(step.text) ? 0 : 1), work: item.id });
      touched.add(step.text);
    }
    order = order.filter((p) => !touched.has(p));
    for (const p of item.steps.map((s) => s.text)) if (touched.has(p) && !order.includes(p)) order.push(p);
  }
  return order.reverse().map((p) => files.get(p)).filter(Boolean);
}

/** A path's name and the folder it is in. */
export function parts(path) {
  const slash = String(path).lastIndexOf("/");
  return slash < 0 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

const MODES = { default: "Ask", manual: "Ask", untrusted: "Ask", acceptEdits: "Edits", plan: "Plan", auto: "Auto", bypassPermissions: "Bypass", bypass: "Bypass",
  dontAsk: "Don't Ask", "on-request": "On Request", "on-failure": "On Failure", never: "Never Ask" };
/** The agent's own word for how it asks, as the screens say it; null for one this page does not know. */
export const modeName = (raw) => MODES[raw] ?? null;
/** Claude Code's ways of asking, as the menu lists them. */
export const CLAUDE_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
export const skipsPermissions = (raw) => raw === "bypassPermissions" || raw === "bypass";

/** The task list on one line: how many are done, and the one in progress (else the next). */
export function planLine(plan) {
  if (!plan?.length) return null;
  const now = plan.find((p) => p.state === "doing") ?? plan.find((p) => p.state === "todo");
  return { done: plan.filter((p) => p.state === "done").length, total: plan.length, now: now?.text ?? "" };
}

/** The start of a long text, cut where a paragraph ends near the limit, a code fence left open closed; null when short. */
export function preview(text, fold = FOLD_CHARS, keep = PREVIEW_CHARS) {
  if (text.length <= fold) return null;
  let head = text.slice(0, keep);
  const para = head.lastIndexOf("\n\n");
  const line = head.lastIndexOf("\n");
  if (para > keep / 2) head = head.slice(0, para);
  else if (line > keep / 2) head = head.slice(0, line);
  const fences = head.split("\n").filter((l) => l.trim().startsWith("```")).length;
  return fences % 2 === 1 ? `${head}\n\`\`\`` : head;
}

// ---------- the model, the way it asks, how hard it thinks ----------

const BRANDS = { deepseek: "DeepSeek", qwen: "Qwen", glm: "GLM", kimi: "Kimi", gemini: "Gemini", grok: "Grok", llama: "Llama", mistral: "Mistral", minimax: "MiniMax" };
const isNumber = (t) => /^\d[\d.]*$/.test(t);
const capitalised = (t) => (t && /[a-z]/.test(t[0]) ? t[0].toUpperCase() + t.slice(1) : t);
/** A model's id as people read it: `claude-opus-5-5` → `Opus 5.5`, `gpt-5.6-sol` → `GPT-5.6 Sol`. */
export function modelName(id) {
  let rest = String(id ?? "").trim();
  if (!rest) return String(id ?? "");
  let ctx = "";
  const m = /\[\d+[kKmM]\]$/.exec(rest);
  if (m) { ctx = ` (${m[0].slice(1, -1).toUpperCase()})`; rest = rest.slice(0, m.index); }
  rest = rest.slice(rest.lastIndexOf("/") + 1);
  const tokens = rest.split("-").filter((t) => t && !(t.length === 8 && /^\d+$/.test(t)) && t.toLowerCase() !== "latest");
  if (!tokens.length) return id;
  const first = tokens[0].toLowerCase();
  let name;
  if (first === "claude") {
    const rest2 = tokens.slice(1);
    name = [...rest2.filter((t) => !isNumber(t)).map(capitalised), ...(rest2.some(isNumber) ? [rest2.filter(isNumber).join(".")] : [])].join(" ");
  } else if (first === "gpt") {
    name = tokens.length > 1 ? [`GPT-${tokens[1]}`, ...tokens.slice(2).map(capitalised)].join(" ") : "GPT";
  } else {
    if (/^o\d/.test(first)) return id;
    const out = [];
    for (const t of [BRANDS[first] ?? capitalised(tokens[0]), ...tokens.slice(1).map(capitalised)]) {
      if (isNumber(t) && out.length && isNumber(out.at(-1))) out[out.length - 1] += `.${t}`; else out.push(t);
    }
    name = out.join(" ");
  }
  return name ? name + ctx : id;
}

/** Which of the listed models is the one in use: by its id, else by the name people read. */
export const isCurrent = (option, model) => !!model && (option.id === model || option.name === modelName(model));
/** The model, the way it asks, the level a terminal is at, as far as anything says. */
export const modelNow = (now, record, started) => now ?? record ?? started ?? null;
export const modeNow = (now, record, started) => now ?? record ?? started ?? null;
export const levelNow = (asked, record, started) => asked ?? record ?? started ?? null;

export const effortWord = (harness) => ({ codex: "Reasoning", opencode: "Variant", pi: "Thinking" }[harness] ?? "Effort");
export const effortName = (level) => (level === "xhigh" ? "XHigh" : String(level).split(/[-_]/).map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" "));
/** The levels of the model a running terminal is on: the listed model that is it, else the agent's default model's. */
export function levelsOf(models, any, harness, current) {
  const own = (models?.[harness] ?? []).find((o) => isCurrent(o, current))?.efforts;
  return own ?? any?.[harness] ?? [];
}

/** Codex's Daybreak switch: the models to choose from as it stands, why the model it is on cannot run, its word. */
export const daybreakOffered = (options, on) => (on === null || on === undefined ? options : options.filter((o) => o.daybreak !== (on ? "never" : "only")));
export function daybreakClash(option, on, name = null) {
  if (on === null || on === undefined || !option) return null;
  const n = name ?? option.name;
  if (on && option.daybreak === "never") return `Codex 的模型列表里 ${n} 不支持 Daybreak，开着时它的下一轮会被 Codex 拒绝。换一个模型，或关掉 Daybreak。`;
  if (!on && option.daybreak === "only") return `Codex 的模型列表里 ${n} 只在 Daybreak 开着时可用，下一轮会被 Codex 拒绝。换一个模型，或打开 Daybreak。`;
  return null;
}
export const daybreakWord = (on) => (on ? "Daybreak On" : "Daybreak Off");
export const DAYBREAK_NOTE = "对之后的新一轮生效；Codex 会把它记成新会话的默认";

const AGENT_NAMES = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi" };
export const agentName = (h) => AGENT_NAMES[h] ?? h;

/** Why the model, the level or the way of asking cannot be changed from here now; null when it can. */
export function locked({ harness, status, waiting = false, whileWorking = false, sets = null }) {
  if (status === "exited") return "终端已结束。";
  const direct = sets ?? ["claude-code", "pi", "opencode", "codex"].includes(harness);
  if (!direct) return harness === "codex" ? "在回复框里用 /model 切换（Codex 在它自己的列表里选模型和思考强度）。" : `${agentName(harness)} 的这个终端只能在它自己的界面里选：切到终端视图操作。`;
  if (waiting || status === "waiting") return "它正在等待回答，回答后再调整。";
  if (status !== "idle" && !whileWorking) return "它正在工作，结束后再调整。";
  return null;
}

/** Why the service did not make a change, in the page's words where it is one of the reasons it gives. */
export function refusal(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("no session yet")) return "它还没有会话：发出第一句话之后才能切换。";
  if (r.startsWith("not a model of its")) return "它那边没有这个模型。";
  if (r.startsWith("not a level of that model") || r.startsWith("that model takes no level")) return "这个模型没有这一档。";
  if (r.startsWith("its server is not running") || r.startsWith("this agent chooses")) return "这个终端现在不能从这里切换：切到终端视图操作。";
  return null;
}

// ---------- the reply box ----------

const SHELLS = new Set(["claude-code", "codex", "opencode", "pi"]);
export const HINTS_SHOWN = 8;

/** What the text up to the caret asks for: commands after a `/`, files after an `@`, a word on `!` and `$`; null. */
export function hintAsk(text, caret, harness) {
  const head = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  if (head.startsWith("/") && !/\s/.test(head)) {
    const rest = text.slice(head.length);
    if (!rest || /^\s/.test(rest)) return { commands: head.slice(1) };
  }
  const word = head.split(/\s/).at(-1) ?? "";
  if (word.startsWith("@") && !word.slice(1).includes("@")) return { files: word.slice(1), at: head.length - word.length };
  if (head.startsWith("!") && SHELLS.has(harness)) return { mark: { sign: "!", word: "Shell", says: "这一行作为命令在它的 shell 里运行，输出进入对话。" } };
  if (head.startsWith("$") && harness === "codex" && !/\s/.test(head)) return { mark: { sign: "$", word: "Skills", says: "Codex 的技能与应用列表在它自己的屏幕上选：切到终端视图输入 $。" } };
  return null;
}

/** The commands `typed` may be the start of: names that start with it first, then names with a word that does. */
export function matching(typed, commands, limit = HINTS_SHOWN) {
  const t = typed.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(t));
  const inside = t ? commands.filter((c) => !c.name.toLowerCase().startsWith(t) && c.name.toLowerCase().split(/[:\-_]/).some((w) => w.startsWith(t))) : [];
  const found = [...starts, ...inside];
  if (found.length === 1 && found[0].name.toLowerCase() === t) return [];
  return found.slice(0, limit);
}
export const typedCommand = (c) => `/${c.name} `;
/** What choosing a file types in place of the `@…` word (Codex takes the bare path). */
export function typedFile(path, harness) {
  const spaced = /\s/.test(path);
  if (harness === "codex") return spaced ? `"${path}" ` : `${path} `;
  return spaced ? `@"${path}" ` : `@${path} `;
}

/** The reply's files: each stands in the text as `[Image #n]` or `[File #n]`. */
export const MAX_FILES = 10;
export const fileToken = (image, n) => (image ? `[Image #${n}]` : `[File #${n}]`);
export const isImageName = (name) => /\.(png|jpe?g|gif|webp|heic)$/i.test(String(name));
/** `tokens` as typed at the caret: a space before when the text there has none, a space after each. */
export const typedTokens = (tokens, before) => (tokens.length ? ((before === undefined || before === null || /\s/.test(before)) ? "" : " ") + tokens.map((t) => `${t} `).join("") : "");
/** `text` without `token` and the space typed after it. */
export const withoutToken = (text, token) => text.split(`${token} `).join("").split(token).join("");

/** What the empty box says: what Claude Code offers as your next message while it rests, else the box's own word. */
export const placeholder = (stops, offered, resting) => (resting && offered ? `${offered}  ·  tab` : stops ? "Reply · esc to Stop" : "Reply");

// ---------- a command in colour ----------

const LEADING = new Set(["if", "then", "else", "elif", "while", "until", "do", "time", "!", "{", "exec", "sudo", "env", "nohup", "xargs"]);
const CLOSING = new Set(["fi", "done", "esac", "for", "case", "in", "function", "select", "}"]);
const BREAKS = new Set([" ", "\t", "\n", ";", "|", "&", "(", ")", "<", ">", "'", '"', "`"]);
/** A shell command in parts for colouring: the word each command begins with, what is quoted (a here-document's body
 *  with it), comments, the rest. `[{text, kind}]`, kind one of plain, command, string, comment. */
export function shellRuns(source) {
  const c = [...String(source)];
  const runs = [];
  let plain = "";
  const flush = () => { if (plain) { runs.push({ text: plain, kind: "plain" }); plain = ""; } };
  const emit = (text, kind) => { if (!text) return; if (kind === "plain") plain += text; else { flush(); runs.push({ text, kind }); } };
  let i = 0, first = true, docs = [];
  while (i < c.length) {
    const ch = c[i];
    if (ch === "\n") {
      emit("\n", "plain"); i++; first = true;
      for (const doc of docs) {
        let body = "";
        while (i < c.length) {
          let end = i;
          while (end < c.length && c[end] !== "\n") end++;
          const line = c.slice(i, end).join("");
          body += line;
          if (end < c.length) body += "\n";
          i = Math.min(end + 1, c.length);
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.mark) break;
        }
        if (body.endsWith("\n")) { emit(body.slice(0, -1), "string"); emit("\n", "plain"); } else emit(body, "string");
      }
      docs = [];
      continue;
    }
    if (ch === " " || ch === "\t") { emit(ch, "plain"); i++; continue; }
    if (ch === "\\" && i + 1 < c.length) { emit(ch + c[i + 1], "plain"); i += 2; continue; }
    if (ch === "#" && (i === 0 || [" ", "\t", "\n", ";"].includes(c[i - 1]))) {
      let end = i;
      while (end < c.length && c[end] !== "\n") end++;
      emit(c.slice(i, end).join(""), "comment"); i = end; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let end = i + 1;
      while (end < c.length && c[end] !== ch) { if (ch !== "'" && c[end] === "\\" && end + 1 < c.length) end++; end++; }
      end = Math.min(end + 1, c.length);
      emit(c.slice(i, end).join(""), "string"); i = end; first = false; continue;
    }
    if (ch === "<" && c[i + 1] === "<" && c[i + 2] !== "<") {
      let at = i + 2, tabs = false;
      if (c[at] === "-") { tabs = true; at++; }
      emit(c.slice(i, at).join(""), "plain");
      while (at < c.length && (c[at] === " " || c[at] === "\t")) { emit(c[at], "plain"); at++; }
      let end = at;
      if (c[end] === "'" || c[end] === '"') {
        const q = c[end]; end++;
        while (end < c.length && c[end] !== q && c[end] !== "\n") end++;
        end = Math.min(end + 1, c.length);
      } else while (end < c.length && !BREAKS.has(c[end])) end++;
      const word = c.slice(at, end).join("");
      const mark = word.replace(/^['"\\]+|['"\\]+$/g, "");
      emit(word, "string");
      if (mark) docs.push({ mark, tabs });
      i = end; continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(") {
      emit(ch, "plain"); i++;
      const redirects = ch === "&" && ((i >= 2 && (c[i - 2] === ">" || c[i - 2] === "<")) || c[i] === ">");
      if (!redirects) first = true;
      continue;
    }
    if (ch === ")" || ch === "<" || ch === ">") { emit(ch, "plain"); i++; continue; }
    let end = i, opens = false;
    while (end < c.length && !BREAKS.has(c[end])) {
      if (c[end] === "\\" && end + 1 < c.length) { end += 2; continue; }
      if (c[end] === "$" && c[end + 1] === "(") { end += 2; opens = true; break; }
      end++;
    }
    if (end === i) end = i + 1;
    const word = c.slice(i, end).join("");
    if (opens) { emit(word, "plain"); first = true; }
    else if (!first) emit(word, "plain");
    else if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word) || LEADING.has(word)) emit(word, "plain");
    else if (CLOSING.has(word)) { emit(word, "plain"); first = false; }
    else { emit(word, "command"); first = false; }
    i = end;
  }
  flush();
  return runs;
}
