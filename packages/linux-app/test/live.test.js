import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePath, LiveNotes, pageOf, wordsOf } from "../lib/live.js";

const ask = (id, askId, extra = {}) => ({ id, kind: "terminal", title: `t ${id}`, step: "Allow? npm test", needsYou: true, startedAt: 1, ask: { kind: "permission", id: askId }, ...extra });
const end = (id, at, ok = true, extra = {}) => ({ id, kind: "terminal", title: `t ${id}`, line: ok ? "Done" : "Failed", ok, at, ...extra });
const snap = (rows = [], ended = []) => ({ rows, ended, running: 0, waiting: rows.filter((r) => r.needsYou).length, open: 1, now: 0 });

test("what waits or has ended when the window starts is known; what comes after is said once", () => {
  const n = new LiveNotes();
  assert.deepEqual(n.next(snap([ask("a1", "p1")], [end("a2", 10)])), []);
  const said = n.next(snap([ask("a1", "p1"), ask("b1", "p2")], [end("a2", 10), end("c1", 20, false)]));
  assert.deepEqual(said.map((x) => [x.id, x.cue]), [["b1", "needsYou"], ["c1", "failed"]]);
  assert.deepEqual(n.next(snap([ask("a1", "p1"), ask("b1", "p2")], [end("a2", 10), end("c1", 20, false)])), []);
});

test("a second request of the same terminal is said; one answered and gone is not said again", () => {
  const n = new LiveNotes();
  n.next(snap([ask("a1", "p1")]));
  assert.deepEqual(n.next(snap([ask("a1", "p2")])).map((x) => x.key), ["a1#p2"]);
  assert.deepEqual(n.next(snap([])), []);
});

test("while the window is in front nothing is said, and what came then is known after", () => {
  const n = new LiveNotes();
  n.next(snap());
  assert.deepEqual(n.next(snap([ask("a1", "p1")], [end("a2", 5)]), { quiet: true }), []);
  assert.deepEqual(n.next(snap([ask("a1", "p1")], [end("a2", 5)])), []);
});

test("another node's rows are its own: the same id on two nodes is two things", () => {
  const n = new LiveNotes();
  n.next(snap([ask("t5", "p1")]));
  const said = n.next(snap([ask("t5", "p1"), ask("t5", "p1", { node: { id: "n2", name: "dellarch" } })]));
  assert.equal(said.length, 1);
  assert.equal(said[0].key, "n2/t5#p1");
  assert.equal(wordsOf(said[0]).summary, "t t5 · dellarch");
  assert.equal(pageOf(said[0]), "/ui/terminal.html");
});

test("a terminal's permission request is answered from its note; a question or a task's approval is not", () => {
  const n = new LiveNotes();
  n.next(snap());
  const [note] = n.next(snap([ask("ab12", "p9")]));
  assert.equal(decidePath(note), "/terminals/ab12/permissions/p9");
  assert.equal(decidePath({ ...note, node: { id: "n2", name: "x" } }), "/nodes/n2/terminals/ab12/permissions/p9");
  assert.equal(decidePath({ ...note, ask: { kind: "question", id: "q1" } }), null);
  assert.equal(decidePath({ ...note, kind: "task" }), null);
});

test("a note opens its terminal, or its task on Dispatch", () => {
  assert.equal(pageOf({ kind: "terminal", id: "ab12cd34", node: null }), "/ui/terminal.html?id=ab12cd34");
  assert.equal(pageOf({ kind: "task", id: "t-1", node: null }), "/ui?task=t-1");
  const n = new LiveNotes();
  n.next(snap());
  const [done] = n.next(snap([], [{ kind: "task", id: "r1", taskId: "t-9", title: "fix", line: "Done", ok: true, at: 3 }]));
  assert.equal(done.id, "t-9");
  assert.deepEqual(wordsOf(done), { summary: "fix", body: "Done" });
});
