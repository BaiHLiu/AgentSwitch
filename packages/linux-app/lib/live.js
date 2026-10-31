// What the window says on the desktop (docs/linux-app-v0.md §3), from `GET /live` as the Mac's Live Activity reads
// it: a terminal or task that starts to wait for you, and a result (a task that ended, a terminal's turn). What waits
// or has ended when the window starts is taken as known, as the Mac and the phone do; while the window is in front,
// nothing is said (its page shows the cards) and what came is taken as known.

/** A row's or a result's id among every node's: its own here, `<node>/<id>` on another. */
export const keyOf = (id, node) => (node ? `${node.id}/${id}` : id);

/** At most this many results are remembered (each is in `/live` for a minute only). */
const REMEMBERED = 200;

export class LiveNotes {
  #asks = null;
  #ends = new Set();

  /** The notes for what is new in `snapshot`; `quiet`: none, the new taken as known. */
  next(snapshot, { quiet = false } = {}) {
    const first = this.#asks === null;
    const asks = new Map();
    for (const row of snapshot?.rows ?? []) {
      if (row.needsYou) asks.set(`${keyOf(row.id, row.node)}#${row.ask?.id ?? row.startedAt}`, row);
    }
    const notes = [];
    for (const [key, row] of asks) {
      if (first || quiet || this.#asks.has(key)) continue;
      notes.push({ key, cue: "needsYou", kind: row.kind, id: row.id, node: row.node ?? null, title: row.title, body: row.step });
    }
    this.#asks = new Set(asks.keys());
    for (const end of snapshot?.ended ?? []) {
      const key = `${keyOf(end.id, end.node)}@${end.at}`;
      if (this.#ends.has(key)) continue;
      this.#ends.add(key);
      if (first || quiet) continue;
      notes.push({ key, cue: end.ok ? "done" : "failed", kind: end.kind, id: end.kind === "task" ? (end.taskId ?? end.id) : end.id,
        node: end.node ?? null, title: end.title, body: end.line });
    }
    while (this.#ends.size > REMEMBERED) this.#ends.delete(this.#ends.values().next().value);
    return notes;
  }
}

/** The page a note opens: the terminal on the Terminals page, a task on Dispatch (the console); another node's, the
 *  page alone (its ids are that node's). */
export function pageOf(note) {
  if (note.node) return note.kind === "terminal" ? "/ui/terminal.html" : "/ui";
  return note.kind === "terminal" ? `/ui/terminal.html?id=${encodeURIComponent(note.id)}` : `/ui?task=${encodeURIComponent(note.id)}`;
}

/** What a note says: its title, with the node it is on; what it waits for, or what it came to (the service's words). */
export function wordsOf(note) {
  return { summary: `${note.title}${note.node ? ` · ${note.node.name}` : ""}`, body: note.body };
}
