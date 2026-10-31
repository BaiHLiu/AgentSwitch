// A pane's simple view in a browser and in the Linux window (docs/simple-view-v0.md §5.2; docs/linux-app-v0.md, 2026-10-31,
// catop: 需要加上简略视图和另一种theme，让其基本与mac app 1：1复刻): the Mac's TerminalRecordPane and PaneRecord, as the page's
// own DOM. The record of the terminal's session in a reading column — what you said on the right, the agent's answers
// as Markdown, each run of work on one line that opens into its steps —, then what it is doing now and what waits for
// you; under it, floating, the reply box. While a pane shows it the pane holds no terminal size (its screen is put
// away), so the terminal can be in use elsewhere meanwhile. It takes the system's light or dark; the terminal view is
// always dark. The rules are lib/record.js's.

import * as R from "/ui/lib/record.js";
import { md, mdTyped } from "/ui/lib/markdown.js";
import { icon } from "/ui/lib/look.js";
import { SPIN } from "/ui/pixel.js";

const WRITING_KEEP_MS = 1500;
/** The reply being written to each terminal, kept while its pane shows something else. */
const kept = new Map();
/** Steps read whole, by `<harness>/<session>/<work>/<n>/<out length>`. */
const stepDetails = new Map();

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const raw = (html, cls = "") => { const s = h("span", { class: cls }); s.innerHTML = html; return s; };
const seg = (s) => encodeURIComponent(s);
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fold = (open, classic) => (classic ? raw(icon(open ? "chevdown" : "chevright", 10), "rv-fold") : h("span", { class: "rv-fold" }, open ? "▾" : "▸"));
const diffStat = (added, removed, plain = false) => h("span", { class: `rv-stat${plain ? " plain" : ""}` }, h("em", {}, `+${added}`), h("s", {}, `−${removed}`));

export class RecordView {
  /** `o`: api, upload, pathOf, chooseFiles, classic(), keyName(text), notify(text), onFocus(pane), openTerminal(pane),
   *  shortcut(e), lists() → {models, efforts}, agentMark(harness) → element, ago(ms) → words, gitWords(terminal), tilde(path),
   *  bracketed(word, key) → [nodes]. */
  constructor(o, pane) {
    this.o = o;
    this.pane = pane;
    this.shown = false;
    this.terminal = null;   // the terminal's info, as the list last said
    this.reset();
    this.verbose = false;
    this.side = (() => { try { return localStorage.getItem("terminals.recordSide") === "1"; } catch { return false; } })();
    this.nodes = new Map();  // item id → { key, node }
    this.openWork = new Set();
    this.openSteps = new Set();
    this.wholeAnswers = new Set();
    this.diffs = new Map();
    this.openFiles = new Set();
    this.dark = matchMedia("(prefers-color-scheme: dark)");
    this.dark.addEventListener("change", () => this.paintScheme());
    this.build();
    this.clockTimer = setInterval(() => this.tick(), 1000);
    this.spinTimer = setInterval(() => { if (!document.hidden && this.shown) for (const el of this.root.querySelectorAll(".rv-spin")) el.textContent = SPIN[(Number(el.dataset.f ?? 0) + 1) % SPIN.length], el.dataset.f = (Number(el.dataset.f ?? 0) + 1) % SPIN.length; }, 90);
  }

  reset() {
    this.id = null; this.harness = ""; this.session = null; this.toldSession = null;
    this.items = []; this.plan = []; this.usage = null; this.mode = null; this.more = false; this.cursor = 0; this.start = null;
    this.atEnd = true; this.loaded = false; this.loadingEarlier = false; this.reading = false; this.again = false;
    this.activity = null; this.subagents = []; this.activitySince = null; this.progress = null; this.sent = []; this.choices = null; this.notices = [];
    this.modelNow = null; this.daybreakNow = null; this.modeNow = null; this.suggestion = null; this.effortAsked = null;
    this.writing = null; this.writingDone = false; clearTimeout(this.writingTimer);
    this.changing = false; this.error = null; this.sending = false;
    this.draftFiles = []; this.hints = []; this.hintPick = 0; this.hintMark = null; this.hintsPutAway = null; this.commands = null;
  }

  // ---------- the parts that stay: built once ----------
  build() {
    this.root = h("div", { class: "rv" });
    this.scroll = h("div", { class: "rv-scroll" });
    this.col = h("div", { class: "rv-col" });
    this.head = h("div", { class: "rv-head" });
    this.earlierBtn = h("button", { class: "rv-earlier", type: "button", onclick: () => this.earlier() });
    this.status = h("div", { class: "rv-status" });
    this.list = h("div", { class: "rv-items" });
    this.live = h("div", { class: "rv-live" });
    this.cards = h("div", { class: "rv-cards" });
    this.col.append(this.head, this.earlierBtn, this.status, this.list, this.live, this.cards);
    this.scroll.append(this.col);
    this.latest = h("button", { class: "rv-latest", type: "button", hidden: true, onclick: () => { this.atEnd = true; this.toEnd(true); } }, "↓ Latest");
    this.dockEl = h("div", { class: "rv-dock" });
    this.main = h("div", { class: "rv-main" }, this.scroll, this.latest, this.dockEl);
    this.sideEl = h("div", { class: "rv-side", hidden: true });
    this.root.append(this.main, this.sideEl);
    this.scroll.addEventListener("scroll", () => {
      const end = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight <= 24;
      if (end !== this.atEnd) { this.atEnd = end; this.latest.hidden = end; }
    });
    // The record ends above the reply box, which floats over its foot.
    new ResizeObserver(() => {
      this.scroll.style.paddingBottom = `${this.dockEl.offsetHeight + 8}px`;
      this.root.style.setProperty("--dock-h", `${this.dockEl.offsetHeight}px`);
      if (this.atEnd) this.toEnd();
    }).observe(this.dockEl);
    new ResizeObserver(() => this.renderSide()).observe(this.root);
    this.root.addEventListener("mousedown", (e) => { if (!e.target.closest(".rv-pop")) this.o.onFocus(this.pane); }, true);
    this.root.addEventListener("dragover", (e) => { if (this.id && [...(e.dataTransfer?.types ?? [])].includes("Files")) { e.preventDefault(); this.root.classList.add("dropping"); } });
    this.root.addEventListener("dragleave", (e) => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove("dropping"); });
    this.root.addEventListener("drop", (e) => { this.root.classList.remove("dropping"); const f = [...(e.dataTransfer?.files ?? [])]; if (f.length && this.id) { e.preventDefault(); this.attachFiles(f); } });
    this.buildDock();
    this.paintScheme();
  }

  paintScheme() { this.root.classList.toggle("light", !this.dark?.matches); this.root.classList.toggle("dark", !!this.dark?.matches); }

  buildDock() {
    this.errLine = h("div", { class: "rv-err", hidden: true });
    this.clashLine = h("div", { class: "rv-clash", hidden: true });
    this.planBox = h("div", { class: "rv-plan", hidden: true });
    this.hintBox = h("div", { class: "rv-hints", hidden: true });
    this.strip = h("div", { class: "rv-strip", hidden: true });
    this.text = h("textarea", { class: "rv-text", rows: 1, spellcheck: "false", "aria-label": "Reply" });
    this.plusBtn = h("button", { class: "rv-plus", type: "button", title: "Attach", onclick: (e) => this.plusMenu(e) });
    this.chips = h("div", { class: "rv-chips" });
    this.ctxWord = h("span", { class: "rv-ctx" });
    this.sendBtn = h("button", { class: "rv-send", type: "button", onclick: () => (this.stops() ? this.interrupt() : this.send()) });
    this.box = h("div", { class: "rv-box" }, this.planBox, this.hintBox, this.strip, this.text,
      h("div", { class: "rv-foot" }, this.plusBtn, this.chips, h("span", { class: "rv-grow" }), this.ctxWord, this.sendBtn));
    this.dockEl.append(this.errLine, this.clashLine, this.box);
    this.dockEl.addEventListener("contextmenu", (e) => { e.preventDefault(); this.dockMenu(e); });
    this.text.addEventListener("input", () => { this.grow(); this.keepFiles(); this.typing(); this.renderSend(); });
    this.text.addEventListener("click", () => this.typing());
    this.text.addEventListener("keydown", (e) => this.key(e));
    this.text.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      this.attachFiles(files);
    });
    this.text.addEventListener("focus", () => this.o.onFocus(this.pane));
  }

  // ---------- following a terminal ----------
  /** Into `el`, for `terminal` (already following it: only what the list says of it now is taken). */
  show(el, terminal) {
    if (this.root.parentElement !== el) el.append(this.root);
    this.root.hidden = false;
    this.shown = true;
    if (!terminal) return;
    if (this.id !== terminal.id) this.follow(terminal);
    this.take(terminal);
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.root.hidden = true;
    this.stop();
  }

  dispose() {
    this.hide();
    clearInterval(this.clockTimer);
    clearInterval(this.spinTimer);
    this.root.remove();
  }

  focus() { if (this.terminal?.status !== "exited") this.text.focus(); }

  update(terminals) {
    if (!this.id) return;
    const t = terminals.find((x) => x.id === this.id);
    if (t) this.take(t);
  }

  stop() {
    if (this.id) {
      const text = this.text.value;
      if (text || this.draftFiles.length) kept.set(this.id, { text, files: this.draftFiles }); else kept.delete(this.id);
    }
    this.source?.close();
    this.source = null;
    this.reset();
    this.text.value = "";
    this.nodes.clear();
    this.list.replaceChildren();
    this.openWork.clear(); this.openSteps.clear(); this.wholeAnswers.clear(); this.diffs.clear(); this.openFiles.clear();
  }

  follow(terminal) {
    this.stop();
    this.id = terminal.id;
    this.harness = terminal.harness;
    const back = kept.get(terminal.id);
    if (back) { this.text.value = back.text; this.draftFiles = back.files; kept.delete(terminal.id); }
    this.grow();
    const id = terminal.id;
    const source = new EventSource(`/terminals/${id}/stream?view=record`);
    this.source = source;
    const handle = (type) => source.addEventListener(type, (e) => { if (this.source === source) this.event(type, e.data ? JSON.parse(e.data) : {}); });
    for (const type of ["activity", "record", "writing", "model", "mode", "suggestion", "daybreak", "progress", "sent", "choices", "notices", "status", "exit", "removed"]) handle(type);
  }

  /** What the list says of the terminal now. */
  take(terminal) {
    const before = this.terminal;
    this.terminal = terminal;
    if (terminal.status !== "working") this.stillNow();
    // The session it writes: the record's own stream says a change at once; until it has named one, the list's.
    if (!(this.toldSession && this.toldSession !== terminal.agentSessionId) && (terminal.agentSessionId ?? null) !== this.session) this.begin(terminal.agentSessionId ?? null);
    if (!before || before.status !== terminal.status || before.name !== terminal.name || before.workdir !== terminal.workdir || before.suggestion !== terminal.suggestion
      || before.modeNow !== terminal.modeNow || before.modelNow !== terminal.modelNow || before.daybreak !== terminal.daybreak) this.render();
  }

  begin(session) {
    this.session = session;
    this.items = []; this.plan = []; this.usage = null; this.mode = null; this.more = false; this.cursor = 0; this.error = null; this.effortAsked = null; this.start = null;
    this.nodes.clear(); this.list.replaceChildren(); this.diffs.clear(); this.openFiles.clear();
    this.loaded = session === null;
    this.render();
    this.refresh();
  }

  stillNow() { this.progress = null; this.activity = null; this.subagents = []; }

  event(type, data) {
    switch (type) {
      case "activity": {
        if (!sameJSON(data.activity ?? null, this.activity)) { this.activity = data.activity ?? null; this.activitySince = Date.now(); }
        this.subagents = data.subagents ?? [];
        return this.renderLive();
      }
      case "progress": this.progress = data.progress ?? null; return this.renderLive();
      case "sent": this.sent = data.replies ?? []; return this.render();
      case "choices": this.choices = data.choices ?? null; return this.render();
      case "notices": this.notices = data.notices ?? []; return this.render();
      case "record": {
        if (data.session) this.toldSession = data.session;
        if (data.session && data.session !== this.session) return this.begin(data.session);
        return this.refresh();
      }
      case "model": this.modelNow = data.model ?? null; return this.renderDock();
      case "mode": this.modeNow = data.mode ?? null; return this.renderDock();
      case "suggestion": this.suggestion = data.text || null; return this.renderDock();
      case "daybreak": this.daybreakNow = data.on ?? null; return this.renderDock();
      case "writing": return this.writes(data.done || !data.text ? null : { text: data.text, thinking: data.thinking === true });
      case "status":
        if (this.terminal) this.terminal = { ...this.terminal, status: data.status };
        this.activitySince = Date.now();
        if (data.status !== "working") this.stillNow();
        this.refresh();
        return this.render();
      case "exit":
        if (this.terminal) this.terminal = { ...this.terminal, status: "exited" };
        return this.render();
      case "removed": this.source?.close(); this.source = null; return undefined;
      default: return undefined;
    }
  }

  writes(now) {
    clearTimeout(this.writingTimer);
    if (now) { this.writingDone = false; this.writing = now; return this.renderLive(); }
    if (!this.writing) return undefined;
    this.writingDone = true;
    this.writingTimer = setTimeout(() => { if (this.writingDone) { this.writing = null; this.writingDone = false; this.renderLive(); } }, WRITING_KEEP_MS);
    return undefined;
  }

  /** The latest page; asked again while one is on its way, it is read once more after that one. */
  async refresh() {
    const id = this.session;
    if (!id) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      do {
        this.again = false;
        try {
          const page = await this.o.api("GET", `/sessions/${seg(this.harness)}/${seg(id)}/record?limit=${R.SHOWN_ITEMS}`);
          if (id !== this.session) return;
          this.takePage(page);
        } catch {
          if (id !== this.session) return;
          if (!this.loaded) { this.loaded = true; this.render(); }
        }
      } while (this.again);
    } finally { this.reading = false; }
  }

  takePage(page) {
    const items = (page.items ?? []).map(R.itemOf).filter(Boolean);
    if (this.writingDone && this.writing && R.holds(items, this.writing.text)) { clearTimeout(this.writingTimer); this.writing = null; this.writingDone = false; }
    this.plan = Array.isArray(page.plan) ? page.plan : [];
    if (this.usage && this.usage.effort !== page.usage?.effort) this.effortAsked = null;
    this.usage = page.usage ?? null;
    this.mode = page.mode ?? null;
    const { items: next, replaced } = R.merged(this.items, items);
    if (!sameJSON(next, this.items)) {
      this.start = R.shownStart(this.items, this.start, this.atEnd);
      this.items = next;
    }
    if (replaced) { this.cursor = page.cursor ?? 0; this.more = page.more === true; }
    this.loaded = true;
    this.error = null;
    this.render();
  }

  async earlier() {
    const before = R.shownEarlier(this.items, this.start);
    if (before) { this.start = before; this.keepPlace(() => this.render()); return; }
    const id = this.session;
    if (!id || !this.more || this.loadingEarlier) return;
    this.loadingEarlier = true;
    this.renderHead();
    try {
      const page = await this.o.api("GET", `/sessions/${seg(this.harness)}/${seg(id)}/record?limit=${R.EARLIER_ITEMS}&before=${this.cursor}`);
      if (id !== this.session) return;
      const known = new Set(this.items.map((i) => i.id));
      this.items = [...(page.items ?? []).map(R.itemOf).filter((i) => i && !known.has(i.id)), ...this.items];
      this.start = this.items[0]?.id ?? null;
      this.cursor = page.cursor ?? 0;
      this.more = page.more === true;
    } catch { /* stays as it is */ }
    this.loadingEarlier = false;
    this.keepPlace(() => this.render());
  }

  /** What is read stays where it is while something is put before it. */
  keepPlace(fn) {
    const fromBottom = this.scroll.scrollHeight - this.scroll.scrollTop;
    this.atEnd = false;
    fn();
    this.scroll.scrollTop = this.scroll.scrollHeight - fromBottom;
  }

  toEnd(smooth = false) {
    this.scroll.scrollTo({ top: this.scroll.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    this.latest.hidden = true;
  }

  // ---------- drawing ----------
  get working() { return this.terminal?.status === "working"; }
  get waiting() { return this.terminal?.status === "waiting" || (this.terminal?.permissions?.length ?? 0) > 0; }
  get classic() { return this.o.classic(); }

  render() {
    if (!this.shown || !this.terminal) return;
    const end = this.atEnd;
    this.renderHead();
    this.renderItems();
    this.renderLive(false);
    this.renderCards();
    this.renderDock();
    this.renderSide();
    if (end) this.toEnd();
  }

  renderHead() {
    const t = this.terminal;
    if (!t) return;
    const model = R.modelNow(this.modelNow ?? t.modelNow, this.usage?.model, t.model);
    const meta = [R.agentName(t.harness), model ? R.modelName(model) : null, this.o.gitWords(t)].filter(Boolean).join(" · ");
    this.head.replaceChildren(h("div", { class: "rv-name" }, t.name), h("div", { class: "rv-meta" }, meta), h("div", { class: "rv-path" }, this.o.tilde(t.workdir || t.cwd)));
    const waits = this.more || R.shownFrom(this.items, this.start) > 0;
    this.earlierBtn.hidden = !waits;
    this.earlierBtn.replaceChildren(...(this.loadingEarlier ? [h("span", { class: "rv-spin" }, SPIN[0]), " "] : []), "Earlier");
    // Nothing yet: being read, starting, or said so.
    let status = null;
    if (!this.loaded) status = h("div", { class: "rv-wait" }, h("span", { class: "rv-spin" }, SPIN[0]));
    else if (!this.items.length && !this.sent.length && !this.notices.length && !this.working && !(t.permissions?.length)) {
      if (!this.session && t.status === "exited") {
        status = h("div", { class: "rv-empty" }, h("p", {}, "没有启动起来就结束了。它最后说了什么在终端视图里。"),
          h("button", { class: "rv-link", type: "button", onclick: () => this.o.openTerminal(this.pane) }, ...this.o.bracketed("Open Terminal", "⌘⇧E")));
      } else if (!this.session && Date.now() - (t.createdAt ?? 0) < R.STARTING_MS) {
        status = h("div", { class: "rv-wait" }, h("span", { class: "rv-spin" }, SPIN[0]), h("div", { class: "rv-faint" }, "Starting…"));
        clearTimeout(this.startingTimer);
        this.startingTimer = setTimeout(() => this.render(), R.STARTING_MS);
      } else status = h("p", { class: "rv-faint" }, this.session ? "还没有记录。" : "还没有开始对话。在下面回复，或切到终端视图。");
    }
    this.status.replaceChildren(...(status ? [status] : []));
  }

  renderItems() {
    const shown = R.shown(this.items, this.start, this.notices, this.sent, this.working);
    const lastWork = this.items.at(-1)?.kind === "work" ? this.items.at(-1).id : null;
    const out = [];
    const seen = new Set();
    for (const item of shown) {
      const running = this.working && item.id === lastWork;
      const key = JSON.stringify([item, running, this.verbose, this.openWork.has(item.id), this.wholeAnswers.has(item.id), [...this.openSteps].filter((k) => k.startsWith(`${item.id}/`)),
        this.classic, item.kind === "user" ? this.o.ago(item.at) : ""]);
      seen.add(item.id);
      const held = this.nodes.get(item.id);
      if (held && held.key === key) { out.push(held.node); continue; }
      const node = this.itemNode(item, running);
      this.nodes.set(item.id, { key, node });
      out.push(node);
    }
    for (const id of this.nodes.keys()) if (!seen.has(id)) this.nodes.delete(id);
    // Moved, not rebuilt: a node that is already in its place stays (the selection in it, an image loaded).
    const now = [...this.list.children];
    if (now.length !== out.length || now.some((n, i) => n !== out[i])) this.list.replaceChildren(...out);
  }

  itemNode(item, running) {
    const source = this.session ? `/sessions/${seg(this.harness)}/${seg(this.session)}` : null;
    if (item.kind === "user" && item.from !== null) {
      return h("div", { class: "rv-from" }, h("div", { class: "rv-when" }, `From ${item.from || "Another Session"} · ${this.o.ago(item.at)}`),
        raw(mdTyped(item.text), "rv-said"));
    }
    if (item.kind === "user") {
      const pics = item.images > 0 && source
        ? h("div", { class: "rv-pics" }, ...Array.from({ length: Math.min(item.images, 6) }, (_, n) => h("img", { class: "rv-pic", loading: "lazy", src: `${source}/images/${seg(item.id)}/${n}`,
          onclick: () => this.viewPictures(Array.from({ length: item.images }, (_, k) => `${source}/images/${seg(item.id)}/${k}`), n) })),
        item.images > 6 ? h("span", { class: "rv-more-pics" }, `+${item.images - 6}`) : null)
        : item.images > 0 ? h("div", { class: "rv-faint" }, item.images === 1 ? "1 image" : `${item.images} images`) : null;
      return h("div", { class: `rv-user${item.queued ? " queued" : ""}` }, h("div", { class: "rv-when" }, item.queued ? "Queued" : this.o.ago(item.at)),
        item.text ? raw(mdTyped(item.text), "rv-bub") : null, pics);
    }
    if (item.kind === "answer") {
      const head = this.wholeAnswers.has(item.id) ? null : R.preview(item.text);
      const body = this.answerNode(head ?? item.text, item.thinking);
      return h("div", { class: "rv-answer" }, body,
        head !== null ? h("button", { class: "rv-link", type: "button", onclick: () => { this.wholeAnswers.add(item.id); this.renderItems(); } }, "Show More")
          : item.clipped ? h("div", { class: "rv-faint small" }, "这条回答很长，只读入了开头。") : null);
    }
    if (item.kind === "note") return h("div", { class: "rv-note" }, item.text);
    return this.workNode(item, running, source);
  }

  answerNode(text, thinking = false) {
    const el = raw(md(text), `rv-md${thinking ? " quiet" : ""}`);
    // A code block: its own frame, `Copy` above it.
    for (const pre of el.querySelectorAll("pre")) {
      const copy = h("button", { class: "rv-copy", type: "button" }, "Copy");
      copy.addEventListener("click", () => { void navigator.clipboard.writeText(pre.textContent ?? ""); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1600); });
      const frame = h("div", { class: "rv-code" }, copy);
      pre.replaceWith(frame);
      frame.append(pre);
    }
    return el;
  }

  workNode(item, running, source) {
    const steps = R.shownSteps(item.steps, this.verbose);
    const open = this.openWork.has(item.id) || this.verbose;
    const s = R.stat(item.steps);
    const line = h("div", { class: "rv-wrow" },
      h("button", { class: "rv-wfold", type: "button", disabled: this.verbose || !steps.length || undefined,
        onclick: () => { if (this.openWork.has(item.id)) this.openWork.delete(item.id); else this.openWork.add(item.id); this.renderItems(); } },
        fold(open, this.classic), h("span", { class: running ? "rv-shim" : "" }, R.summary(item, running))),
      s ? h("button", { class: "rv-statbtn", type: "button", title: "Changes", onclick: () => this.showChanges(item.id) }, diffStat(s.added, s.removed)) : null);
    const node = h("div", { class: "rv-work" }, line);
    if (open) for (const { step, index } of steps) node.append(this.stepNode(item, step, index, source));
    return node;
  }

  stepNode(item, step, index, source) {
    const key = `${item.id}/${index}`;
    const opens = R.stepOpens(step) && !!source;
    const open = opens && this.openSteps.has(key);
    const file = R.namesFile(step);
    const headParts = [
      this.classic ? raw(icon(R.STEP_ICONS[step.kind] ?? "wrench", 13), `rv-ki${step.failed ? " failed" : ""}`) : null,
      h("b", { class: step.failed ? "failed" : "" }, R.label(step)),
      step.note ? h("span", { class: "rv-said" }, step.note)
        : h("code", { class: `rv-x${file ? " file" : ""}`, title: step.text }, file ? step.text : step.text),
      opens ? fold(open, this.classic) : null,
      h("span", { class: "rv-grow" }),
      step.added !== null || step.removed !== null ? diffStat(step.added ?? 0, step.removed ?? 0, true) : null,
    ];
    const head = opens
      ? h("button", { class: "rv-step-head", type: "button", onclick: () => { if (this.openSteps.has(key)) this.openSteps.delete(key); else this.openSteps.add(key); this.renderItems(); } }, ...headParts)
      : h("div", { class: "rv-step-head" }, ...headParts);
    const node = h("div", { class: "rv-step" }, head);
    if (open) {
      if (step.kind === "run") {
        const detailKey = `${this.harness}/${this.session}/${key}/${step.out?.length ?? -1}`;
        const detail = stepDetails.get(detailKey);
        node.append(this.commandBlock(detail?.text ?? step.text));
        const out = detail?.out ?? step.out;
        if (out) node.append(h("pre", { class: `rv-out${step.failed ? " failed" : ""}` }, out));
        if (detail?.clipped) node.append(h("div", { class: "rv-faint small" }, "很长：只有命令的开头和输出的末尾。"));
        if (!detail) {
          void this.o.api("GET", `${source}/steps/${seg(item.id)}/${index}`).then((d) => {
            if (stepDetails.size > 400) stepDetails.clear();
            stepDetails.set(detailKey, d);
            this.nodes.delete(item.id);
            this.renderItems();
          }).catch(() => undefined);
        }
      }
      if (step.images > 0) {
        node.append(h("div", { class: "rv-pics step" }, ...Array.from({ length: step.images }, (_, k) => {
          const src = `${source}/steps/${seg(item.id)}/${index}/images/${k}`;
          return h("img", { class: "rv-pic tall", loading: "lazy", src, onclick: () => this.viewPictures(Array.from({ length: step.images }, (_, j) => `${source}/steps/${seg(item.id)}/${index}/images/${j}`), k) });
        })));
      }
    } else {
      if (step.note && step.kind === "run") node.append(h("code", { class: "rv-cmdline" }, step.text));
      if (step.out && (!step.note || step.failed || this.verbose)) node.append(h("pre", { class: `rv-out${step.failed ? " failed" : ""}`, style: `--lines:${this.verbose ? 14 : 4}` }, step.out));
    }
    return node;
  }

  commandBlock(command) {
    const code = h("pre", { class: "rv-cmdtext" }, ...R.shellRuns(command).map((r) => (r.kind === "plain" ? r.text : h("span", { class: `sh-${r.kind}` }, r.text))));
    const copy = h("button", { class: "rv-copy", type: "button" }, "Copy");
    copy.addEventListener("click", () => { void navigator.clipboard.writeText(command); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1600); });
    return h("div", { class: "rv-cmd" }, h("span", { class: "rv-ps" }, "$"), code, copy);
  }

  /** What it is writing now and what it is doing, redrawn alone as they come (often). */
  renderLive(follow = true) {
    if (!this.shown || !this.terminal) return;
    const end = this.atEnd;
    const parts = [];
    if (this.writing) {
      const el = this.answerNode(`${this.writing.text} ▍`, this.writing.thinking);
      el.classList.add("rv-writing");
      parts.push(el);
    }
    if (this.working && !(this.terminal.permissions?.length)) {
      const a = this.activity;
      const tokens = R.turnTokens(this.progress);
      const ic = this.classic ? R.toolIcon(a?.tool) : null;
      parts.push(h("div", { class: "rv-now" },
        ic ? raw(icon(ic, 13), "rv-ki") : null,
        h("span", { class: "rv-shim rv-nowwords" }, h("b", {}, a ? R.toolWord(a.tool) : "Working"),
          a ? (a.note ? h("span", { class: "rv-said" }, a.note) : h("code", {}, a.target)) : null),
        h("span", { class: "rv-grow" }),
        tokens ? h("span", { class: "rv-tm" }, tokens) : null,
        this.activitySince ? h("span", { class: "rv-tm rv-clock" }, R.clock((Date.now() - this.activitySince) / 1000)) : null));
      for (const s of this.subagents) {
        parts.push(h("div", { class: "rv-now sub" }, this.classic ? raw(icon("branch", 13), "rv-ki") : null,
          h("span", { class: "rv-shim rv-nowwords" }, h("b", {}, s.name), h("code", {}, s.doing ?? ""))));
      }
    }
    this.live.replaceChildren(...parts);
    if (follow && end) this.toEnd();
  }

  tick() {
    if (!this.shown || document.hidden || !this.activitySince) return;
    const el = this.live.querySelector(".rv-clock");
    if (el) el.textContent = R.clock((Date.now() - this.activitySince) / 1000);
  }

  renderCards() {
    const t = this.terminal;
    const asks = t.permissions?.length ?? 0;
    const cards = [];
    if (this.choices && !asks) {
      cards.push(this.choiceCard(this.choices.title, this.choices.options.map((o) => [o.label, o.detail]), this.choices.selected,
        "这是它自己屏幕上的列表：点一行，等于在终端里选中并回车。", true, (n) => this.choose(n)));
    } else if (t.status === "waiting" && !asks) {
      cards.push(h("div", { class: "rv-card" }, h("div", { class: "rv-card-hd waiting" }, "Waiting"),
        h("p", {}, "程序在等你操作。这是它自己画的界面，记录里没有：切到终端视图回答。"),
        h("button", { class: "rv-link", type: "button", onclick: () => this.o.openTerminal(this.pane) }, ...this.o.bracketed("Open Terminal", "⌘⇧E"))));
    } else if (!this.working && !asks) {
      for (const q of R.openQuestions(this.items, this.sent)) {
        cards.push(this.choiceCard(q.title, q.options.map((o) => [o, null]), null, "点一个作为回复发出；也可以在下面自己写。", false, (n) => this.answer(q.options[n])));
      }
    }
    if (t.status === "exited") cards.push(h("div", { class: "rv-exited" }, "Exited"));
    this.cards.replaceChildren(...cards);
  }

  choiceCard(title, rows, selected, foot, openTerminal, take) {
    return h("div", { class: "rv-card" },
      title ? h("div", { class: "rv-card-title" }, title) : null,
      h("div", { class: "rv-choices" }, ...rows.map(([label, detail], n) => h("button", { class: `rv-choice${n === selected ? " on" : ""}`, type: "button", onclick: () => take(n) },
        h("i", {}, String(n + 1)), h("span", {}, h("span", {}, label), detail ? h("small", {}, detail) : null)))),
      h("div", { class: "rv-card-ft" }, h("span", {}, foot), openTerminal ? h("button", { class: "rv-link", type: "button", onclick: () => this.o.openTerminal(this.pane) }, ...this.o.bracketed("Open Terminal", "⌘⇧E")) : null));
  }

  // ---------- the side: how full the context is, the task list, the files changed ----------
  renderSide() {
    if (!this.shown || !this.terminal) return;
    const files = R.changedFiles(this.items);
    const width = this.side && (this.plan.length || files.length) ? R.sideWidth(this.root.clientWidth) : null;
    this.sideEl.hidden = !width;
    this.root.classList.toggle("with-side", !!width);
    if (!width) return;
    this.sideEl.style.width = `${width}px`;
    const parts = [];
    const meter = R.contextMeter(this.usage);
    if (meter) {
      parts.push(h("div", { class: "rv-sec" }, h("div", { class: "rv-sec-hd" }, "Context", h("span", {}, meter.words)),
        h("div", { class: "rv-meter" }, h("i", { style: `width:${Math.round(meter.part * 100)}%` }))));
    }
    const line = R.planLine(this.plan);
    if (line) parts.push(h("div", { class: "rv-sec" }, h("div", { class: "rv-sec-hd" }, `Tasks ${line.done}/${line.total}`), this.planRows()));
    if (files.length) {
      const added = files.reduce((a, f) => a + f.added, 0), removed = files.reduce((a, f) => a + f.removed, 0);
      parts.push(h("div", { class: "rv-sec" }, h("div", { class: "rv-sec-hd" }, "Changes ", diffStat(added, removed, true), h("span", {}, ` · ${files.length} ${files.length === 1 ? "file" : "files"}`)),
        ...files.map((f) => {
          const open = this.openFiles.has(f.path);
          const { name, folder } = R.parts(f.path);
          const row = h("button", { class: "rv-file", type: "button", onclick: () => { if (open) this.openFiles.delete(f.path); else { this.openFiles.add(f.path); void this.loadChanges(f.work); } this.renderSide(); } },
            fold(open, this.classic), h("span", { class: "rv-file-name" }, name, h("small", {}, folder)), h("span", { class: "rv-grow" }), diffStat(f.added, f.removed, true));
          const diff = open ? (this.diffs.get(f.work) ?? []).find((d) => d.path === f.path) : null;
          return h("div", {}, row, open ? (diff ? this.diffNode(diff, false) : h("div", { class: "rv-faint small pad" }, this.diffs.has(f.work) ? "没有记录到改动。" : "…")) : null,
            open && f.runs > 1 ? h("div", { class: "rv-faint small pad" }, `最近一次的改动；这个文件一共改了 ${f.runs} 次。`) : null);
        })));
    }
    this.sideEl.replaceChildren(...parts);
  }

  planRows() {
    return h("div", { class: "rv-tlist" }, ...this.plan.map((p) => h("div", { class: p.state }, h("i", {}, p.state === "done" ? "[x]" : p.state === "doing" ? "[>]" : "[ ]"), h("span", {}, p.text))));
  }

  async loadChanges(work) {
    const id = this.session;
    if (!id) return;
    const r = await this.o.api("GET", `/sessions/${seg(this.harness)}/${seg(id)}/changes?work=${seg(work)}`).catch(() => ({ files: [] }));
    if (id !== this.session) return;
    this.diffs.set(work, r.files ?? []);
    this.renderSide();
  }

  diffNode(file, header = true) {
    const rows = [];
    for (const hunk of file.hunks ?? []) {
      if (hunk.header) rows.push(h("span", { class: "h" }, hunk.header));
      for (const l of hunk.lines) rows.push(h("span", { class: l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "" }, l || " "));
    }
    return h("div", { class: "rv-diff" },
      header ? h("div", { class: "rv-diff-hd" }, h("code", {}, file.path), h("span", { class: "rv-grow" }), diffStat(file.added, file.removed, true)) : null,
      h("pre", {}, ...rows),
      file.clipped ? h("div", { class: "rv-faint small pad" }, "改动很长，只显示开头。") : null);
  }

  /** What a run of work changed, or the last turn (`work` null): a sheet over the pane. */
  async showChanges(work) {
    if (!this.session) return;
    const body = h("div", { class: "rv-sheet-bd" }, h("div", { class: "rv-wait" }, h("span", { class: "rv-spin" }, SPIN[0])));
    const total = h("span", {});
    const close = () => { veil.remove(); document.removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    const veil = h("div", { class: "rv-veil", onmousedown: (e) => { if (e.target === veil) close(); } },
      h("div", { class: "rv-sheet" }, h("div", { class: "rv-sheet-hd" }, h("b", {}, "Changes"), total, h("span", { class: "rv-grow" }),
        h("button", { class: "rv-link", type: "button", onclick: close }, ...this.o.bracketed("Done", "esc"))), body));
    document.addEventListener("keydown", esc, true);
    this.root.append(veil);
    const r = await this.o.api("GET", `/sessions/${seg(this.harness)}/${seg(this.session)}/changes${work ? `?work=${seg(work)}` : ""}`).catch(() => ({ files: [] }));
    const files = r.files ?? [];
    if (files.length) total.replaceChildren(diffStat(files.reduce((a, f) => a + f.added, 0), files.reduce((a, f) => a + f.removed, 0)));
    body.replaceChildren(...(files.length ? files.map((f) => this.diffNode(f)) : [h("p", { class: "rv-faint" }, "没有记录到改动。")]));
  }

  viewPictures(srcs, at) {
    let n = at;
    const img = h("img", { class: "rv-view-img" });
    const count = h("span", { class: "rv-faint" });
    const show = () => { img.src = srcs[n]; count.textContent = srcs.length > 1 ? `${n + 1} / ${srcs.length}` : ""; };
    const close = () => { veil.remove(); document.removeEventListener("keydown", keys, true); };
    const step = (d) => { n = (n + d + srcs.length) % srcs.length; show(); };
    const copy = async () => {
      try { const blob = await (await fetch(srcs[n])).blob(); await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]); } catch (e) { this.o.notify(`未能复制：${e.message}`); }
    };
    const keys = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    };
    const veil = h("div", { class: "rv-veil pictures", onmousedown: (e) => { if (e.target === veil) close(); } },
      h("div", { class: "rv-viewer" }, img, h("div", { class: "rv-viewer-ft" }, count, h("span", { class: "rv-grow" }),
        srcs.length > 1 ? h("button", { class: "rv-link", type: "button", onclick: () => step(-1) }, ...this.o.bracketed("Previous", "←")) : null,
        srcs.length > 1 ? h("button", { class: "rv-link", type: "button", onclick: () => step(1) }, ...this.o.bracketed("Next", "→")) : null,
        h("button", { class: "rv-link", type: "button", onclick: copy }, ...this.o.bracketed("Copy", null)),
        h("button", { class: "rv-link", type: "button", onclick: close }, ...this.o.bracketed("Done", "esc")))));
    document.addEventListener("keydown", keys, true);
    this.root.append(veil);
    show();
  }

  // ---------- the reply box ----------
  stops() { return this.working && !this.waiting && !this.text.value.trim() && !this.sending; }
  canSend() { return !this.sending && !!this.id && !!this.text.value.trim() && this.terminal?.status !== "exited"; }

  renderDock() {
    if (!this.shown || !this.terminal) return;
    const t = this.terminal;
    this.errLine.hidden = !this.error;
    this.errLine.textContent = this.error ?? "";
    const clash = this.daybreakClash();
    this.clashLine.hidden = !clash;
    this.clashLine.textContent = clash ?? "";
    // The task list on a line, while there is no side for it.
    const line = R.planLine(this.plan);
    const beside = !this.sideEl.hidden;
    this.planBox.hidden = !line || beside;
    if (line && !beside) {
      this.planBox.replaceChildren(h("button", { class: "rv-plan-line", type: "button", onclick: () => { this.planOpen = !this.planOpen; this.renderDock(); } },
        fold(!!this.planOpen, this.classic), h("b", {}, `Tasks ${line.done}/${line.total}`), h("span", {}, line.now)), this.planOpen ? this.planRows() : null);
    }
    this.renderHints();
    this.renderStrip();
    const resting = t.status === "idle";
    this.text.placeholder = R.placeholder(this.stops(), this.suggestion ?? t.suggestion, resting);
    this.text.disabled = t.status === "exited";
    this.plusBtn.disabled = t.status === "exited";
    this.plusBtn.replaceChildren(this.classic ? raw(icon("plus", 16)) : "+");
    this.renderChips();
    const ctx = R.context(this.usage);
    this.ctxWord.textContent = ctx && (!beside || !R.contextMeter(this.usage)) ? `Context ${ctx}` : "";
    this.renderSend();
  }

  renderSend() {
    const stops = this.stops();
    const active = this.canSend() || stops;
    this.sendBtn.disabled = !active;
    this.sendBtn.classList.toggle("on", active);
    this.sendBtn.title = stops ? "Stop esc" : "Send ↩ · New Line ⇧↩";
    this.sendBtn.replaceChildren(this.sending ? h("span", { class: "rv-spin" }, SPIN[0]) : this.classic ? raw(icon(stops ? "stop" : "arrowup", stops ? 12 : 14)) : (stops ? "■" : "↑"));
    this.text.placeholder = R.placeholder(stops, this.suggestion ?? this.terminal?.suggestion, this.terminal?.status === "idle");
  }

  /** `Edits · Opus 5.5 ▾ · High ▾ · Daybreak On ▾`: how it asks, its model, how hard it thinks, Codex's switch. */
  renderChips() {
    const t = this.terminal;
    const { models, efforts } = this.o.lists();
    const harness = t.harness;
    const rawMode = R.modeNow(this.modeNow ?? t.modeNow, this.mode, t.mode);
    const mode = R.modeName(rawMode) ?? (rawMode ? rawMode[0].toUpperCase() + rawMode.slice(1) : null);
    const current = R.modelNow(this.modelNow ?? t.modelNow, this.usage?.model, t.model);
    const levels = R.levelsOf(models, efforts, harness, current);
    const level = R.levelNow(this.effortAsked, this.usage?.effort, t.effort);
    const daybreak = this.daybreakNow ?? t.daybreak ?? null;
    const options = R.daybreakOffered(models[harness] ?? [], daybreak);
    const waiting = this.waiting;
    const modeLock = harness === "claude-code" ? R.locked({ harness, status: t.status, waiting }) : "这个 agent 的权限方式在启动时选定。";
    const modelLock = R.locked({ harness, status: t.status, waiting, sets: t.sets ?? null }) ?? (options.length ? null : "还没有读到它的模型列表。");
    const effortLock = R.locked({ harness, status: t.status, waiting, whileWorking: harness === "claude-code", sets: t.sets ?? null });
    const dayLock = R.locked({ harness, status: t.status, waiting, whileWorking: true, sets: true });
    const chev = () => (this.classic ? raw(icon("chevdown", 9)) : h("span", {}, "▾"));
    const chip = (words, { lock, tone = "", menu }) => (lock || this.changing
      ? h("span", { class: `rv-chip off ${tone}`, title: lock ?? "" }, ...(this.changing && !lock ? [h("span", { class: "rv-spin" }, SPIN[0]), " "] : []), words)
      : h("button", { class: `rv-chip ${tone}`, type: "button", onclick: menu }, words, chev()));
    const dot = () => h("span", { class: "rv-dot" }, "·");
    const parts = [];
    if (mode) {
      parts.push(chip(mode, { lock: modeLock, tone: R.skipsPermissions(rawMode) ? "bad" : "", menu: (e) => this.menu(e, R.CLAUDE_MODES.map((m) => ({ title: R.modeName(m), checked: R.modeName(m) === R.modeName(rawMode), run: () => this.setMode(m, R.modeName(m)) }))) }));
      parts.push(dot());
    }
    const older = options.filter((o) => o.older);
    parts.push(chip(current ? R.modelName(current) : "Model", { lock: modelLock, tone: this.daybreakClash() ? "warn" : "", menu: (e) => this.menu(e, [
      ...options.filter((o) => !o.older).map((o) => ({ title: o.name, checked: R.isCurrent(o, current), run: () => this.setModel(o.id) })),
      ...(older.length ? [{ separator: true }, { title: "Older", disabled: true }, ...older.map((o) => ({ title: o.name, checked: R.isCurrent(o, current), run: () => this.setModel(o.id), indent: true }))] : []),
      ...(harness === "claude-code" ? [{ separator: true }, { title: "Claude Code 会把它记成新会话的默认模型", disabled: true }] : []),
    ]) }));
    if (levels.length && !effortLock) {
      parts.push(dot(), chip(level ? R.effortName(level) : R.effortWord(harness), { lock: null, menu: (e) => this.effortPicker(e, levels, level) }));
    } else if (level) parts.push(dot(), h("span", { class: "rv-chip off", title: effortLock ?? "" }, R.effortName(level)));
    if (daybreak !== null && daybreak !== undefined) {
      parts.push(dot(), chip(R.daybreakWord(daybreak), { lock: dayLock, menu: (e) => this.menu(e, [
        { title: "On", checked: daybreak, run: () => this.setDaybreak(true) }, { title: "Off", checked: !daybreak, run: () => this.setDaybreak(false) },
        { separator: true }, { title: R.DAYBREAK_NOTE, disabled: true }]) }));
    }
    this.chips.replaceChildren(...parts);
  }

  daybreakClash() {
    const t = this.terminal;
    const on = this.daybreakNow ?? t?.daybreak;
    if (on === null || on === undefined) return null;
    const current = R.modelNow(this.modelNow ?? t.modelNow, this.usage?.model, t.model);
    const option = (this.o.lists().models[t.harness] ?? []).find((o) => R.isCurrent(o, current));
    return R.daybreakClash(option, on, current ? R.modelName(current) : null);
  }

  /** A menu of the page's own over the box (above it): `[{title, checked, disabled, run, separator, indent}]`. */
  menu(e, entries) {
    this.closePop();
    const pop = h("div", { class: "rv-pop rv-menu" }, ...entries.map((x) => (x.separator ? h("div", { class: "rv-sep" })
      : h("button", { class: `rv-mi${x.indent ? " in" : ""}`, type: "button", disabled: x.disabled || undefined, onclick: () => { this.closePop(); x.run?.(); } },
        h("span", { class: "rv-check" }, x.checked ? "✓" : ""), h("span", {}, x.title)))));
    this.openPop(pop, e.currentTarget ?? e.target, e);
  }

  effortPicker(e, levels, level) {
    this.closePop();
    const at = Math.max(0, levels.indexOf(level));
    const top = levels.length - 1;
    const word = R.effortWord(this.harness);
    const pop = h("div", { class: "rv-pop effort" },
      h("div", { class: `rv-eh${at === top ? " top" : ""}` }, word, h("span", {}, level ? R.effortName(level) : "Default")),
      h("div", { class: `rv-eslider${at === top ? " top" : ""}`, style: `--at:${top ? at / top : 0}` }, h("div", { class: "fill" }),
        ...levels.map((l, k) => h("button", { type: "button", title: R.effortName(l), style: `--k:${top ? k / top : 0}`, class: l === level ? "on" : "", onclick: () => { this.closePop(); this.setEffort(l); } })),
        h("div", { class: "knob" })),
      h("div", { class: "rv-ee" }, h("span", {}, R.effortName(levels[0])), h("span", {}, R.effortName(levels[top]))),
      this.harness === "claude-code" ? h("p", {}, "会记成这个模型的默认；Max 只用于这一次。") : null);
    this.openPop(pop, e.currentTarget ?? e.target, e);
  }

  openPop(pop, anchor, e) {
    this.root.append(pop);
    const r = (anchor ?? this.box).getBoundingClientRect(), root = this.root.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left - root.left), root.width - pop.offsetWidth - 8);
    const above = r.top - root.top - pop.offsetHeight - 6;
    pop.style.left = `${x}px`;
    pop.style.top = `${above >= 8 ? above : r.bottom - root.top + 6}px`;
    this.pop = pop;
    const away = (ev) => { if (!pop.contains(ev.target)) this.closePop(); };
    const esc = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); this.closePop(); } };
    setTimeout(() => { document.addEventListener("mousedown", away, true); document.addEventListener("keydown", esc, true); }, 0);
    this.popOff = () => { document.removeEventListener("mousedown", away, true); document.removeEventListener("keydown", esc, true); };
    e?.stopPropagation?.();
  }

  closePop() { this.pop?.remove(); this.pop = null; this.popOff?.(); this.popOff = null; }

  plusMenu(e) {
    this.menu(e, [{ title: "Files…", run: () => this.chooseFiles() }, { title: "Paste Image", run: () => this.pasteImage() }]);
  }

  dockMenu(e) {
    const entries = [{ title: this.verbose ? "Transcript: Normal" : "Transcript: Verbose", run: () => { this.verbose = !this.verbose; this.nodes.clear(); this.render(); } }];
    if (this.session && (this.harness === "claude-code" || this.harness === "codex")) entries.push({ title: "Changes of the Last Turn", run: () => this.showChanges(null) });
    entries.push({ title: this.side ? "Hide Side Pane" : "Show Side Pane", run: () => { this.side = !this.side; try { localStorage.setItem("terminals.recordSide", this.side ? "1" : "0"); } catch { /* kept for now */ } this.renderSide(); this.renderDock(); } });
    this.closePop();
    const pop = h("div", { class: "rv-pop rv-menu" }, ...entries.map((x) => h("button", { class: "rv-mi", type: "button", onclick: () => { this.closePop(); x.run(); } }, h("span", { class: "rv-check" }), h("span", {}, x.title))));
    this.root.append(pop);
    const root = this.root.getBoundingClientRect();
    pop.style.left = `${Math.min(e.clientX - root.left, root.width - pop.offsetWidth - 8)}px`;
    pop.style.top = `${Math.max(8, e.clientY - root.top - pop.offsetHeight)}px`;
    this.pop = pop;
    const away = (ev) => { if (!pop.contains(ev.target)) this.closePop(); };
    setTimeout(() => document.addEventListener("mousedown", away, true), 0);
    this.popOff = () => document.removeEventListener("mousedown", away, true);
  }

  grow() {
    this.text.style.height = "auto";
    this.text.style.height = `${Math.min(Math.max(this.text.scrollHeight, 22), 200)}px`;
  }

  key(e) {
    if (e.isComposing || e.keyCode === 229) return;
    // The list the box offers takes ↑ ↓ tab ↩ esc while it is open.
    if (this.hints.length) {
      if (e.key === "ArrowUp") { e.preventDefault(); this.hintPick = (this.hintPick + this.hints.length - 1) % this.hints.length; return this.renderHints(); }
      if (e.key === "ArrowDown") { e.preventDefault(); this.hintPick = (this.hintPick + 1) % this.hints.length; return this.renderHints(); }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return this.takeHint(this.hints[Math.min(this.hintPick, this.hints.length - 1)]); }
      if (e.key === "Escape") { e.preventDefault(); this.hintsPutAway = this.text.value; return this.closeHints(); }
    }
    if (e.key === "Escape" && this.hintMark) { e.preventDefault(); this.hintsPutAway = this.text.value; return this.closeHints(); }
    const offered = this.suggestion ?? this.terminal?.suggestion;
    if (e.key === "Tab" && !this.text.value && offered && this.terminal?.status === "idle") { e.preventDefault(); this.text.value = offered; this.grow(); return this.renderSend(); }
    if (e.key === "Escape" && this.stops()) { e.preventDefault(); return this.interrupt(); }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); return this.send(); }
    // The page's own keys (split, the other view, close) from the box too.
    if (this.o.shortcut(e)) return undefined;
    return undefined;
  }

  // ---------- what the box offers for what is typed ----------
  typing() {
    clearTimeout(this.hintTimer);
    this.hintAbort = (this.hintAbort ?? 0) + 1;
    const ticket = this.hintAbort;
    const text = this.text.value, caret = this.text.selectionStart ?? text.length;
    if (!this.id) return;
    if (text === this.hintsPutAway) return this.closeHints();
    this.hintsPutAway = null;
    const ask = R.hintAsk(text, caret, this.harness);
    if (!ask) return this.closeHints();
    if (ask.mark) { this.hints = []; this.hintPick = 0; this.hintMark = ask.mark; return this.renderHints(); }
    this.hintMark = null;
    if (ask.commands !== undefined) {
      const rows = (all) => R.matching(ask.commands, all).map((c) => ({ title: c.name, detail: c.description, tag: c.source === "builtin" ? null : c.source, from: 0, to: caret, typed: R.typedCommand(c) }));
      if (this.commands?.id === this.id) return this.offer(rows(this.commands.all));
      const id = this.id;
      void this.o.api("GET", `/terminals/${id}/commands`).then((r) => { if (id !== this.id || ticket !== this.hintAbort) return; this.commands = { id, all: r.commands ?? [] }; this.offer(rows(this.commands.all)); }).catch(() => undefined);
      return undefined;
    }
    const id = this.id;
    this.hintTimer = setTimeout(() => {
      void this.o.api("GET", `/terminals/${id}/files?q=${encodeURIComponent(ask.files)}`).then((r) => {
        if (id !== this.id || ticket !== this.hintAbort) return;
        this.offer((r.files ?? []).slice(0, R.HINTS_SHOWN).map((path) => { const p = R.parts(path); return { title: p.name, detail: p.folder, from: ask.at, to: caret, typed: R.typedFile(path, this.harness) }; }));
      }).catch(() => undefined);
    }, 90);
    return undefined;
  }

  offer(rows) { this.hints = rows; this.hintPick = Math.min(this.hintPick, Math.max(0, rows.length - 1)); this.renderHints(); }
  closeHints() { this.hints = []; this.hintMark = null; this.hintPick = 0; this.renderHints(); }

  takeHint(row) {
    const text = this.text.value;
    this.text.value = text.slice(0, row.from) + row.typed + text.slice(row.to);
    const caret = row.from + row.typed.length;
    this.text.setSelectionRange(caret, caret);
    this.closeHints();
    this.grow();
    this.renderSend();
    this.text.focus();
  }

  renderHints() {
    const open = this.hints.length || this.hintMark;
    this.hintBox.hidden = !open;
    if (!open) return this.hintBox.replaceChildren();
    if (this.hintMark) return this.hintBox.replaceChildren(h("div", { class: "rv-hint mark" }, h("b", {}, `${this.hintMark.sign} ${this.hintMark.word}`), h("span", {}, this.hintMark.says)));
    this.hintBox.replaceChildren(...this.hints.map((r, n) => h("button", { class: `rv-hint${n === this.hintPick ? " on" : ""}`, type: "button",
      onmousedown: (e) => { e.preventDefault(); this.takeHint(r); } }, h("b", {}, r.title), h("span", {}, r.detail ?? ""), r.tag ? h("i", {}, r.tag) : null)));
    return undefined;
  }

  // ---------- the reply's files ----------
  keepFiles() {
    const text = this.text.value;
    const before = this.draftFiles.length;
    this.draftFiles = this.draftFiles.filter((f) => text.includes(f.token));
    if (this.draftFiles.length !== before) this.renderStrip();
  }

  renderStrip() {
    this.strip.hidden = !this.draftFiles.length;
    this.strip.replaceChildren(...this.draftFiles.map((f) => h("span", { class: "rv-chipfile" },
      f.url ? h("img", { src: f.url }) : h("b", {}, `#${f.number}`), h("span", {}, f.name),
      h("button", { type: "button", title: "Remove", onclick: () => { this.draftFiles = this.draftFiles.filter((x) => x !== f); this.text.value = R.withoutToken(this.text.value, f.token); this.renderStrip(); this.renderSend(); } }, "×"))));
  }

  /** Files for the reply (dropped, pasted, chosen): their placeholders typed where the caret is. A file of this machine
   *  (the Linux window) is named by its path; anything else goes to the service first, as the phone's do. */
  attachFiles(files) {
    if (!this.id) return;
    const tokens = [];
    for (const file of files) {
      if (this.draftFiles.length >= R.MAX_FILES) { this.error = `每次最多 ${R.MAX_FILES} 个附件`; break; }
      const number = Math.max(0, ...this.draftFiles.map((f) => f.number)) + 1;
      const image = file.type?.startsWith("image/") || R.isImageName(file.name);
      const token = R.fileToken(image, number);
      const path = this.o.pathOf?.(file) || null;
      this.draftFiles.push({ token, number, name: file.name || (image ? "image.png" : "file"), path, file: path ? null : file, url: image ? URL.createObjectURL(file) : null });
      tokens.push(token);
    }
    this.typeTokens(tokens);
  }

  /** Paths of this machine (the Linux window's `Files…`). */
  attachPaths(paths) {
    if (!this.id) return;
    const tokens = [];
    for (const path of paths) {
      if (this.draftFiles.length >= R.MAX_FILES) { this.error = `每次最多 ${R.MAX_FILES} 个附件`; break; }
      const number = Math.max(0, ...this.draftFiles.map((f) => f.number)) + 1;
      const name = path.split("/").filter(Boolean).pop() ?? path;
      const token = R.fileToken(R.isImageName(name), number);
      this.draftFiles.push({ token, number, name, path, file: null, url: null });
      tokens.push(token);
    }
    this.typeTokens(tokens);
  }

  typeTokens(tokens) {
    if (!tokens.length) return this.renderDock();
    const at = this.text.selectionStart ?? this.text.value.length;
    const text = this.text.value;
    const typed = R.typedTokens(tokens, text[at - 1]);
    this.text.value = text.slice(0, at) + typed + text.slice(at);
    this.text.setSelectionRange(at + typed.length, at + typed.length);
    this.error = null;
    this.grow();
    this.renderDock();
    this.text.focus();
    return undefined;
  }

  async chooseFiles() {
    const paths = await this.o.chooseFiles?.();
    if (Array.isArray(paths)) return this.attachPaths(paths);
    const picker = h("input", { type: "file", multiple: true, hidden: true });
    picker.addEventListener("change", () => { this.attachFiles([...picker.files]); picker.remove(); });
    this.root.append(picker);
    picker.click();
    return undefined;
  }

  async pasteImage() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        return this.attachFiles([new File([blob], `image.${type.split("/")[1] || "png"}`, { type })]);
      }
      this.error = "剪贴板中无图片";
    } catch { this.error = "剪贴板中无图片"; }
    this.renderDock();
    return undefined;
  }

  // ---------- sending, and what it changes ----------
  async send() {
    if (!this.canSend()) return;
    const id = this.id, text = this.text.value;
    const files = this.draftFiles.filter((f) => text.includes(f.token));
    this.sending = true;
    this.renderSend();
    try {
      const attachments = files.filter((f) => f.path).map((f) => ({ token: f.token, path: f.path }));
      const sent = files.filter((f) => !f.path);
      if (sent.length) {
        const ids = await this.o.upload(sent.map((f) => ({ file: f.file })));
        if (ids.length !== sent.length) throw new Error("文件未能送达");
        sent.forEach((f, k) => attachments.push({ token: f.token, upload: ids[k] }));
      }
      await this.o.api("POST", `/terminals/${id}/input`, { text, seal: false, attachments });
      if (this.text.value === text) {
        for (const f of this.draftFiles) if (f.url) URL.revokeObjectURL(f.url);
        this.text.value = ""; this.draftFiles = []; this.closeHints(); this.grow();
      }
      this.suggestion = null;
      this.error = null;
      this.atEnd = true;
    } catch (err) { this.error = err.message; }
    this.sending = false;
    this.renderDock();
  }

  interrupt() { if (this.id) this.o.api("POST", `/terminals/${this.id}/keys`, { keys: ["esc"] }).catch(() => undefined); }

  answer(option) {
    if (!this.id || this.sending) return;
    this.o.api("POST", `/terminals/${this.id}/input`, { text: option, seal: false, attachments: [] }).then(() => { this.error = null; }, (e) => { this.error = e.message; this.renderDock(); });
  }

  choose(n) {
    const option = this.choices?.options?.[n];
    if (!this.id || !option) return;
    this.o.api("POST", `/terminals/${this.id}/choices`, { pick: n, label: option.label }).then(() => { this.error = null; }, (e) => { this.error = e.message; this.renderDock(); });
  }

  async change(path, body, busy, done) {
    if (!this.id || this.changing) return;
    this.changing = true;
    this.renderDock();
    try {
      const r = await this.o.api("POST", `/terminals/${this.id}/${path}`, body);
      done?.(r);
      this.error = null;
    } catch (err) {
      if (err.status === 409) this.error = busy;
      else if (err.status === 400 && path === "mode") this.error = `这个会话不能切到 ${R.modeName(body.mode)}：它启动时没有开放这种方式。`;
      else this.error = R.refusal(err.message) ?? err.message;
    }
    this.changing = false;
    this.renderDock();
  }

  setModel(model) { void this.change("model", { model }, "它正在工作或等待回答，结束后再切换模型。"); }
  setMode(mode) { void this.change("mode", { mode }, "它正在工作或等待回答，结束后再切换。", (r) => { this.modeNow = r?.mode ?? mode; }); }
  setDaybreak(on) { void this.change("daybreak", { on }, "Codex 没有切换：它正在等待回答，或它的屏幕上写着原因。", (r) => { this.daybreakNow = r?.on ?? on; }); }
  setEffort(effort) {
    const was = this.effortAsked;
    this.effortAsked = effort;
    void this.change("effort", { effort }, "它正在等待回答，回答后再调整。").then(() => { if (this.error) { this.effortAsked = was; this.renderDock(); } });
  }
}
