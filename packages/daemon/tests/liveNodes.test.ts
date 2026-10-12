/** What this node's `GET /live` adds from the nodes it uses (docs/mesh-v0.md §5.2 跨节点的提醒; 2026-10-11, user: 我用其他
 *  mac的时候没有实时通知): their rows that wait and their results, each with its node. */

import { describe, expect, it } from "vitest";
import { withNodes, type LiveSnapshot } from "../src/api/live.js";
import { steadyAhead } from "../src/nodes/nodes.js";

const own: LiveSnapshot = {
  rows: [{ id: "t5", kind: "task", title: "这台的任务", step: "", doing: "Run", model: null, agent: null, startedAt: 9_000, needsYou: false, ask: null }],
  running: 1, waiting: 0, ended: [{ kind: "task", id: "t4", taskId: "t4", title: "这台的结果", line: "好了", ok: true, at: 9_500 }], open: 2, now: 10_000,
};
const studio = (body: Record<string, unknown>) => ({ id: "7c1e5a90b3d2", name: "Studio", body });

describe("this node's live summary with its nodes'", () => {
  it("is its own when it uses no node, or none has anything for the user", () => {
    expect(withNodes(own, [])).toBe(own);
    expect(withNodes(own, [studio({ rows: [{ id: "t1", kind: "task", title: "在跑", needsYou: false, startedAt: 1 }], ended: [], now: 5 })])).toBe(own);
    expect(withNodes(own, [studio({})])).toBe(own);
  });

  it("lists what waits there and what ended there with the node, counts it, and moves its times to this node's clock", () => {
    const got = withNodes(own, [studio({
      now: 5_000,   // that node's clock is 5 s behind
      rows: [
        { id: "t5", kind: "task", title: "那台的任务", step: "要删掉吗？", doing: "Allow?", model: "Opus", agent: null, startedAt: 4_000, needsYou: true,
          ask: { kind: "approval", id: "a1", tool: "Bash", target: "rm -rf build", where: "~/site" } },
        { id: "k2", kind: "terminal", title: "只是在跑", needsYou: false, startedAt: 4_500 },
        { id: "k3", kind: "terminal", title: "别的节点转来的", needsYou: true, startedAt: 4_500, node: { id: "x", name: "Third" } },
      ],
      ended: [{ kind: "terminal", id: "k9", title: "那台的终端", line: "测试通过", ok: true, at: 4_800 }, { kind: "task", taskId: "t8", title: "旧式的", line: "", ok: false, at: 4_000 }],
    })]);
    expect(got.rows.map((r) => [r.node?.name ?? "-", r.id, r.needsYou])).toEqual([["Studio", "t5", true], ["-", "t5", false]]);   // what waits comes first
    expect(got.rows[0]).toMatchObject({ node: { id: "7c1e5a90b3d2", name: "Studio" }, title: "那台的任务", startedAt: 9_000, model: "Opus",
      ask: { kind: "approval", id: "a1", tool: "Bash", target: "rm -rf build", where: "~/site" } });
    expect(got.waiting).toBe(1);
    expect(got.running).toBe(1);   // what runs there is not this node's count
    expect(got.open).toBe(2);
    expect(got.ended.map((e) => [e.node?.name ?? "-", e.id, e.at, e.ok])).toEqual([["Studio", "k9", 9_800, true], ["-", "t4", 9_500, true], ["Studio", "t8", 9_000, false]]);
  });

  it("reads another machine's answer field by field", () => {
    const got = withNodes(own, [studio({
      now: "soon",
      rows: [null, 7, { needsYou: true }, { id: "", needsYou: true }, { id: "k1", needsYou: "yes" },
        { id: "k1", kind: "nonsense", title: 5, needsYou: true, startedAt: "x", ask: { kind: "question", id: "q", options: ["a", 3, "b"], answerable: "true" } },
        { id: "k2", needsYou: true, ask: { kind: "run", id: "z" } }],
      ended: [{ id: "k1" }, { id: "k1", ok: true, at: null, title: {} }, "x"],
    })]);
    const theirs = got.rows.filter((r) => r.node);
    expect(theirs.map((r) => r.id)).toEqual(["k1", "k2"]);
    expect(theirs[0]).toMatchObject({ kind: "task", title: "", startedAt: 10_000, ask: { kind: "question", id: "q", options: ["a", "b"], answerable: false } });
    expect(theirs[1]!.ask).toBeNull();
    expect(got.ended.filter((e) => e.node)).toEqual([{ node: { id: "7c1e5a90b3d2", name: "Studio" }, kind: "task", id: "k1", title: "", line: "", ok: true, at: 10_000 }]);
  });

  it("takes no more than a card's worth from one node", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `k${i}`, kind: "terminal", title: "t", needsYou: true, startedAt: i }));
    const ended = Array.from({ length: 50 }, (_, i) => ({ kind: "terminal", id: `e${i}`, title: "t", line: "", ok: true, at: i }));
    const got = withNodes(own, [studio({ now: 10_000, rows, ended })]);
    expect(got.rows.filter((r) => r.node)).toHaveLength(20);
    expect(got.waiting).toBe(20);
    expect(got.ended).toHaveLength(10);
  });
  it("gives a result there the same time on every read of one answer, and of the next", () => {
    // The node's answer is kept two seconds and read every second (user, 2026-10-12: 远程的mac任务完成之后会在我这里无限提示:
    // the time moved with each read, so the Mac took one result for a new one every second).
    const body = { now: 5_000, rows: [{ id: "k1", kind: "terminal", title: "等着", needsYou: true, startedAt: 4_000 }], ended: [{ kind: "terminal", id: "k9", title: "那台的终端", line: "好了", ok: true, at: 4_800 }] };
    const heard = { ...studio(body), ahead: 5_000 };
    const first = withNodes(own, [heard]);
    const later = withNodes({ ...own, now: 11_000 }, [heard]);
    expect(first.ended.find((e) => e.node)!.at).toBe(9_800);
    expect(later.ended.find((e) => e.node)!.at).toBe(9_800);
    expect(later.rows.find((r) => r.node)!.startedAt).toBe(9_000);
    // The next answer came a little slower: the clocks are held as far apart as they were.
    const ahead = steadyAhead(5_000, 5_040);
    expect(ahead).toBe(5_000);
    expect(withNodes({ ...own, now: 12_000 }, [{ ...studio({ ...body, now: 7_000 }), ahead }]).ended.find((e) => e.node)!.at).toBe(9_800);
  });

  it("measures the clocks again when they have moved apart", () => {
    expect(steadyAhead(undefined, 5_040)).toBe(5_040);
    expect(steadyAhead(5_000, 3_600_000)).toBe(3_600_000);
    expect(steadyAhead(5_000, -4_000)).toBe(-4_000);
  });
});
