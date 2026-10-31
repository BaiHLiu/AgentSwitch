// The window's icon as a file for the desktop entry: the mark in ink on the app icon's dark square.
//   node scripts/icon.js <out.png>
import { writeFileSync } from "node:fs";
import { markBitmap } from "../lib/mark.js";
import { png } from "../lib/png.js";

const cell = 8, pad = 2;
const mark = markBitmap("idle", { cell });
const size = Math.max(mark.width, mark.height) + 2 * pad * cell;
const rgba = Buffer.alloc(size * size * 4);
for (let i = 0; i < size * size; i++) rgba.set([11, 11, 12, 255], i * 4);
const ox = (size - mark.width) >> 1, oy = (size - mark.height) >> 1;
for (let y = 0; y < mark.height; y++) for (let x = 0; x < mark.width; x++) {
  const at = (y * mark.width + x) * 4, a = mark.data[at + 3] / 255;
  if (!a) continue;
  const to = ((y + oy) * size + x + ox) * 4;
  for (let k = 0; k < 3; k++) rgba[to + k] = Math.round(rgba[to + k] * (1 - a) + mark.data[at + 2 - k] * a);
}
writeFileSync(process.argv[2], png(size, size, rgba));
