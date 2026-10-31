// The panes' screens in a browser and in the Linux window (docs/linux-app-v0.md, 2026-10-31, catop: 让其基本与mac app 1：1
// 复刻): what the Mac window's native screens do for the page (docs/terminal-v0.md §1 分屏), done in the page — one xterm
// per pane, each following its own terminal's stream with this page's screen id and holding that terminal's size, or
// the pane's simple view in its place. The page keeps the layout and tells the screens where each pane is and what it
// shows (`place`), as it tells the Mac window (`screens`); the screens tell it back which pane was clicked, the grid a
// pane fits and where a pane's terminal is in use when not here.

/** Characters a shell would read as something else in a path (the Mac's TerminalDrop). */
const SPECIAL = new Set([" ", "\t", "\\", "'", '"', "`", "$", "&", ";", "|", "<", ">", "(", ")", "[", "]", "{", "}", "*", "?", "!", "#", "~", "^"]);
/** Paths as a drop types them: each special character escaped, separated by spaces. */
export const droppedPaths = (paths) => paths.map((p) => [...p].map((c) => (SPECIAL.has(c) ? `\\${c}` : c)).join("")).join(" ");
/** `text` as a paste: between the bracketed-paste marks when the program asked for them. */
export const pasted = (text, bracketed) => (bracketed ? `\x1b[200~${text.replaceAll("\x1b[201~", "")}\x1b[201~` : text);
/** Who has a terminal's size, as the page says where it is in use. */
export const placeOf = (by) => (by.startsWith("phone") ? "iphone" : by.startsWith("mac") ? "mac" : by.startsWith("node") ? "node" : "web");
/** Output that paints something (not just mode switches and cursor moves). */
const paints = (data) => data.replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[\x20-\x2f]*[\x30-\x7e]|\s/g, "").length > 0;
const WHEEL_GESTURE_GAP_MS = 120;

/** A pane's terminal screen: its own xterm and stream. */
class Screen {
  constructor(o, pane) {
    this.o = o;
    this.pane = pane;
    this.id = null;
    this.source = null;
    this.lastSeq = 0;
    this.sizeOwner = null;
    this.takenTo = null;
    this.claimOnConnect = false;
    this.exited = false;
    this.keys = "";
    this.keyTimer = null;
    this.sending = Promise.resolve();
    this.wheel = { travel: 0, dir: 0, last: 0, queued: 0, sending: false };
    this.root = document.createElement("div");
    this.root.className = "wscreen";
    const { Terminal, FitAddon, Unicode11Addon, WebLinksAddon } = o.xterm;
    this.term = new Terminal({ ...o.termOptions, linkHandler: o.linkHandler });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.loadAddon(new WebLinksAddon(o.linkHandler.activate, { hover: o.linkHandler.hover, leave: o.linkHandler.leave }));
    this.term.unicode.activeVersion = "11";
    this.term.open(this.root);
    if (o.termOptions.theme?.background) this.root.style.background = o.termOptions.theme.background;
    this.term.onData((data) => this.typed(data));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
        if (e.type === "keydown") { e.preventDefault(); this.namedKey("shift-enter"); }
        return false;
      }
      return !(e.type === "keydown" && o.shortcut(e));
    });
    this.term.attachCustomWheelEventHandler((ev) => this.onWheel(ev));
    // A click into the screen: the pane takes the focus, and this screen the terminal's size.
    this.root.addEventListener("mousedown", () => { o.onFocus(this.pane); this.reclaim(true); }, true);
    this.term.textarea?.addEventListener("keydown", () => this.reclaim(true), true);
    this.term.textarea?.addEventListener("focus", () => o.onFocus(this.pane));
    // A picture alone on the clipboard is sent to the terminal's folder and its path pasted (the Mac's ⌘V, docs/terminal-v0.md
    // §1 Mac "粘贴图片"); text is xterm's own paste.
    this.root.addEventListener("paste", (e) => this.onPaste(e), true);
    this.root.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) { e.preventDefault(); this.root.classList.add("dropping"); } });
    this.root.addEventListener("dragleave", () => this.root.classList.remove("dropping"));
    this.root.addEventListener("drop", (e) => this.onDrop(e));
    this.resizing = new ResizeObserver(() => { clearTimeout(this.fitTimer); this.fitTimer = setTimeout(() => this.fitAndTell(), 60); });
    this.resizing.observe(this.root);
  }

  /** Into `el` (the pane's screen area), showing terminal `id` (null: none). */
  show(el, id) {
    if (this.root.parentElement !== el) el.append(this.root);
    this.root.hidden = false;
    if (id === this.id) return;
    this.closeStream();
    this.id = id;
    this.exited = false;
    this.sizeOwner = null;
    this.takenTo = null;
    this.o.onAway(this.pane, null);
    this.term.reset();
    if (!id) return;
    this.fit.fit();
    this.o.onGrid(this.pane, { cols: this.term.cols, rows: this.term.rows });
    this.claimOnConnect = this.o.inUse();
    this.follow(id);
  }

  /** Put away (the pane shows its simple view, or is gone): no stream, no size held. */
  hide() {
    this.closeStream();
    this.id = null;
    this.root.hidden = true;
    this.o.onAway(this.pane, null);
  }

  dispose() {
    this.hide();
    this.resizing.disconnect();
    this.term.dispose();
    this.root.remove();
  }

  closeStream() {
    this.source?.close();
    this.source = null;
  }

  mine() { return this.sizeOwner === this.o.screenId; }

  follow(id) {
    const source = new EventSource(`/terminals/${id}/stream?screen=${this.o.screenId}`);
    this.source = source;
    const on = (type, fn) => source.addEventListener(type, (e) => { if (this.source === source) fn(JSON.parse(e.data)); });
    on("snapshot", (ev) => {
      this.term.reset();
      if (ev.cols !== this.term.cols || ev.rows !== this.term.rows) this.term.resize(ev.cols, ev.rows);
      this.term.write(ev.data);
      this.lastSeq = ev.seq;
      if (paints(ev.data)) this.o.painted(this.pane);
      // Drawn at the size it had; now fit this pane and have the agent redraw to it (a snapshot drops its links).
      setTimeout(() => { if (this.id === id && !this.fitTo(id) && !this.exited) this.o.api("POST", `/terminals/${id}/redraw`).catch(() => undefined); }, 0);
    });
    on("output", (ev) => {
      if (ev.seq <= this.lastSeq) return;
      this.term.write(ev.data);
      this.lastSeq = ev.seq;
      if (paints(ev.data)) this.o.painted(this.pane);
    });
    on("resize", (ev) => {
      if (this.claimOnConnect) {
        this.claimOnConnect = false;
        if (!ev.by || ev.by === this.o.screenId) { this.sizeOwner = ev.by ?? null; return this.claim(); }
      }
      this.sizeOwner = ev.by ?? null;
      if (this.mine()) return this.o.onAway(this.pane, null);
      // Its owner left: taken from this pane it stays as it was left until taken back by hand; never taken, it is ours.
      if (!ev.by && !this.takenTo && this.o.inUse()) return this.claim();
      if (ev.by) this.takenTo = placeOf(ev.by);
      if (ev.cols !== this.term.cols || ev.rows !== this.term.rows) this.term.resize(ev.cols, ev.rows);
      this.o.onAway(this.pane, ev.by ? placeOf(ev.by) : this.takenTo);
    });
    on("exit", (ev) => { this.exited = true; this.term.write(`\r\n\x1b[2m[Exited · code ${ev.code ?? "?"}]\x1b[0m\r\n`); });
    on("removed", () => this.closeStream());
  }

  /** The size is this pane's: what it fits, told to the service. */
  claim() {
    if (!this.id || this.exited) return;
    this.fit.fit();
    this.takenTo = null;
    this.sizeOwner = this.o.screenId;
    this.o.onAway(this.pane, null);
    this.o.api("POST", `/terminals/${this.id}/resize`, { cols: this.term.cols, rows: this.term.rows, screen: this.o.screenId }).catch(() => undefined);
  }

  /** `active`: the user acts here (a key, a click) and takes the size; else only a size nobody has. */
  reclaim(active) {
    if (!this.id || !this.o.inUse()) return;
    if (this.mine()) this.fitAndTell();
    else if (active || (!this.sizeOwner && !this.takenTo)) this.claim();
  }

  fitTo(id) {
    if (this.id !== id || !this.mine()) return false;
    const before = [this.term.cols, this.term.rows];
    this.fit.fit();
    if (this.term.cols !== before[0] || this.term.rows !== before[1]) {
      this.o.api("POST", `/terminals/${id}/resize`, { cols: this.term.cols, rows: this.term.rows, screen: this.o.screenId }).catch(() => undefined);
      return true;
    }
    return false;
  }

  fitAndTell() {
    if (this.root.hidden || !this.root.isConnected) return;
    const before = [this.term.cols, this.term.rows];
    if (this.mine() || !this.id) this.fit.fit();
    this.o.onGrid(this.pane, { cols: this.term.cols, rows: this.term.rows });
    if (this.id && this.mine() && (this.term.cols !== before[0] || this.term.rows !== before[1])) {
      this.o.api("POST", `/terminals/${this.id}/resize`, { cols: this.term.cols, rows: this.term.rows, screen: this.o.screenId }).catch(() => undefined);
    }
  }

  // ---------- keys, in the order they were pressed ----------
  inOrder(send) { this.sending = this.sending.then(send).catch((e) => this.o.notify(e.message)); }
  flushKeys() {
    clearTimeout(this.keyTimer);
    this.keyTimer = null;
    if (!this.keys || !this.id) return;
    const data = this.keys, id = this.id;
    this.keys = "";
    this.inOrder(() => this.o.api("POST", `/terminals/${id}/write`, { data }));
  }
  typed(data) {
    if (!this.id || this.exited) return;
    this.keys += data;
    clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(() => this.flushKeys(), 6);
  }
  namedKey(name) {
    if (!this.id || this.exited) return;
    this.flushKeys();
    const id = this.id;
    this.inOrder(() => this.o.api("POST", `/terminals/${id}/keys`, { keys: [name] }));
  }

  // ---------- the wheel over a program that scrolls itself (as the page's own screen does it) ----------
  onWheel(ev) {
    if (ev.shiftKey || !this.id || this.exited) return true;
    if (this.term.modes.mouseTrackingMode === "none" && this.term.buffer.active.type !== "alternate") return true;
    ev.preventDefault();
    if (ev.deltaY === 0) return false;
    const cell = this.root.querySelector(".xterm-rows > div")?.getBoundingClientRect().height || 16;
    const px = ev.deltaMode === 1 ? ev.deltaY * cell : ev.deltaMode === 2 ? ev.deltaY * cell * this.term.rows : ev.deltaY;
    const w = this.wheel, now = performance.now();
    let notches = 0;
    if (now - w.last > WHEEL_GESTURE_GAP_MS || Math.sign(px) !== w.dir) { w.dir = Math.sign(px); w.travel = 0; notches = w.dir; }
    else { w.travel += px; notches = Math.trunc(w.travel / (2 * cell)); w.travel -= notches * 2 * cell; }
    w.last = now;
    if (notches) this.queueWheel(notches);
    return false;
  }
  queueWheel(n) {
    const w = this.wheel;
    w.queued += n;
    if (w.sending) return;
    w.sending = true;
    const id = this.id;
    (async () => {
      while (w.queued !== 0 && this.id === id) {
        const count = Math.min(20, Math.abs(w.queued));
        const key = w.queued < 0 ? "wheel-up" : "wheel-down";
        w.queued -= Math.sign(w.queued) * count;
        await this.o.api("POST", `/terminals/${id}/keys`, { keys: Array(count).fill(key) }).catch((e) => this.o.notify(e.message));
      }
      w.queued = 0;
      w.sending = false;
    })();
  }

  // ---------- files ----------
  /** A picture alone on the clipboard: sent to the terminal's folder, its path pasted there. */
  onPaste(e) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length || !this.id || this.exited) return;
    const text = e.clipboardData.getData("text/plain");
    const paths = files.map((f) => this.o.pathOf?.(f)).filter(Boolean);
    e.preventDefault();
    e.stopPropagation();
    // Files of this machine copied in its file manager: their paths, as a drop types them (the node is this machine).
    if (paths.length === files.length && paths.length) return this.typePaths(paths);
    if (text && !files.every((f) => f.type.startsWith("image/"))) { this.typed(pasted(text, this.term.modes.bracketedPasteMode)); return; }
    void this.sendFiles(files);
  }
  onDrop(e) {
    this.root.classList.remove("dropping");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length || !this.id || this.exited) return;
    e.preventDefault();
    this.o.onFocus(this.pane);
    const paths = files.map((f) => this.o.pathOf?.(f)).filter(Boolean);
    if (paths.length === files.length) this.typePaths(paths);
    else void this.sendFiles(files);
  }
  typePaths(paths) {
    this.typed(pasted(`${droppedPaths(paths)} `, this.term.modes.bracketedPasteMode));
    this.term.focus();
  }
  /** Files with no path here (a browser on another machine, a picture off the clipboard): staged with the service,
   *  then their paths pasted into the terminal after what was typed before (`POST /terminals/:id/attach`). */
  async sendFiles(files) {
    const id = this.id;
    const sent = files.slice(0, 10);
    if (files.length > 10) this.o.notify("每次最多粘贴 10 个文件，其余的没有发送");
    try {
      const uploads = await this.o.upload(sent.map((file) => ({ file })));
      this.flushKeys();
      this.inOrder(() => this.o.api("POST", `/terminals/${id}/attach`, { uploads }));
    } catch (err) { this.o.notify(`文件未能发送：${err.message}`); }
  }
}

export class WebScreens {
  /** `o`: xterm ({Terminal, FitAddon, Unicode11Addon, WebLinksAddon}), termOptions, linkHandler, screenId, api, upload,
   *  pathOf, shortcut(e), inUse(), notify(text), painted(pane), onFocus(pane), onGrid(pane, grid), onAway(pane, place),
   *  record(pane) → a simple view ({ show(el, terminal), hide(), dispose(), focus() }). */
  constructor(o) {
    this.o = o;
    this.screens = new Map();   // pane → Screen
    this.records = new Map();   // pane → its simple view
  }

  /** Each pane: `{ pane, id, el, simple, focused, terminal }` (id null: an empty pane, or one a terminal is being made in). */
  place(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.pane);
      let screen = this.screens.get(p.pane);
      if (!screen) { screen = new Screen(this.o, p.pane); this.screens.set(p.pane, screen); }
      if (p.id && p.simple) {
        screen.hide();
        let record = this.records.get(p.pane);
        if (!record) { record = this.o.record(p.pane); this.records.set(p.pane, record); }
        record.show(p.el, p.terminal);
      } else {
        this.records.get(p.pane)?.hide();
        if (p.id) screen.show(p.el, p.id);
        else { screen.hide(); }
      }
    }
    for (const [pane, screen] of this.screens) if (!seen.has(pane)) { screen.dispose(); this.screens.delete(pane); }
    for (const [pane, record] of this.records) if (!seen.has(pane)) { record.dispose(); this.records.delete(pane); }
  }

  /** The terminals' list changed: each simple view takes what it now says of its terminal. */
  update(terminals) {
    for (const record of this.records.values()) record.update?.(terminals);
  }

  /** The keyboard to pane `pane`: its terminal screen, or its simple view's reply box. */
  focus(pane) {
    const record = this.records.get(pane);
    if (record?.shown) return record.focus();
    const screen = this.screens.get(pane);
    if (screen?.id) screen.term.focus();
  }

  /** A line of our own under the program's output in pane `pane`. */
  note(pane, text) {
    const screen = this.screens.get(pane);
    if (screen?.id) screen.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
  }

  claim(pane) { this.screens.get(pane)?.claim(); }
  reclaimAll(active) { for (const s of this.screens.values()) s.reclaim(active); }
  selection(pane) { const t = this.screens.get(pane)?.term; return t?.hasSelection() ? t.getSelection() : ""; }
  selectAll(pane) { this.screens.get(pane)?.term.selectAll(); }
  /** The look changed: the simple views draw again in it. */
  relook() { for (const r of this.records.values()) { r.nodes.clear(); r.render(); } }
  /** The look's terminal settings changed (a font, a theme): every screen takes them. */
  setOptions(options) { for (const s of this.screens.values()) Object.assign(s.term.options, options); }
}
