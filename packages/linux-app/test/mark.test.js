import assert from "node:assert/strict";
import { test } from "node:test";
import { markBitmap, STACK_ROWS, stateOf } from "../lib/mark.js";

const alphaAt = (bmp, x, y, cell) => bmp.data[(((y + 1) * cell) * bmp.width + (x + 1) * cell) * 4 + 3];

test("the mark is the Mac's, a cell of margin round it", () => {
  const bmp = markBitmap("idle", { cell: 2 });
  assert.equal(bmp.width, (STACK_ROWS[0].length + 2) * 2);
  assert.equal(bmp.height, (STACK_ROWS.length + 2) * 2);
  assert.equal(bmp.data.length, bmp.width * bmp.height * 4);
  assert.equal(bmp.data[3], 0, "the margin is clear");
});

test("state by shape and opacity: the prompt lit only while something waits, the window behind solid while busy", () => {
  const [px, py] = [2, 4];   // a prompt cell ("p")
  const [bx, by] = [3, 0];   // the window behind ("b")
  assert.equal(alphaAt(markBitmap("idle", { cell: 1 }), px, py, 1), 0);
  assert.equal(alphaAt(markBitmap("waiting", { cell: 1 }), px, py, 1), 255);
  assert.equal(alphaAt(markBitmap("busy", { cell: 1 }), bx, by, 1), 255);
  assert.equal(alphaAt(markBitmap("idle", { cell: 1 }), bx, by, 1), Math.round(0.4 * 255));
});

test("the tray's state from /live", () => {
  assert.equal(stateOf(null), "off");
  assert.equal(stateOf({ waiting: 1, running: 3 }), "waiting");
  assert.equal(stateOf({ waiting: 0, running: 1 }), "busy");
  assert.equal(stateOf({ waiting: 0, running: 0 }), "idle");
});
