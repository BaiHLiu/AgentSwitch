/** A pairing link as a QR code a terminal can show (docs/mesh-v0.md §4.3 `pair`): two rows of modules a line with the
 *  half blocks, black on white set outright so it scans whatever the terminal's colours, with a quiet zone around it. */

import qrcode from "qrcode-generator";

const QUIET = 2;

/** The modules of `text` (true = dark), quiet zone included; the smallest version that holds it at level L. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "L");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount(), size = n + 2 * QUIET;
  return Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => {
    const row = r - QUIET, col = c - QUIET;
    return row >= 0 && col >= 0 && row < n && col < n && qr.isDark(row, col);
  }));
}

/** The code as terminal lines: `▀` is a dark upper and light lower module, `▄` the reverse, `█` both, a space neither. */
export function qrLines(text: string, ansi = true): string[] {
  const m = qrModules(text);
  const lines: string[] = [];
  for (let r = 0; r < m.length; r += 2) {
    let line = "";
    for (let c = 0; c < m.length; c++) {
      const top = m[r]![c]!, bottom = m[r + 1]?.[c] ?? false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines;
}
