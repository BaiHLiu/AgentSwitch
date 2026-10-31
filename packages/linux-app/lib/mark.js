// The app's mark for the tray and the window (docs/linux-app-v0.md §3), drawn from the same cells as the Mac's menu
// bar item (mac-app PixelArt.stackRows: P = the panel, p = its prompt, b = the window behind) — keep the two in step.
// State by shape and opacity alone, as there: idle the panel solid and the window behind faint; busy the window behind
// solid too; waiting the panel faint and its prompt lit; off the idle picture dithered.

export const STACK_ROWS = [
  "...bbbbbbbbbb.", ".............b", ".PPPPPPPPPP..b", "PPPPPPPPPPPP.b", "PPppPPPPPPPP.b", "PPPppPPPPPPP.b", "PPPPppPPPPPP.b",
  "PPPppPPPPPPP.b", "PPppPPppppPP..", "PPPPPPPPPPPP..", ".PPPPPPPPPP...",
];
export const STATES = ["idle", "busy", "waiting", "off"];
const FAINT = 0.4;

/** How a cell of `part` shows in `state`: 1 in full, FAINT, or 0 not at all. */
export function shows(part, state) {
  if (part === "P") return state === "waiting" ? FAINT : 1;
  if (part === "p") return state === "waiting" ? 1 : 0;
  if (part === "b") return state === "busy" ? 1 : FAINT;
  return 0;
}

/** The mark as BGRA pixels (Electron's `nativeImage.createFromBitmap`): `cell` pixels a cell, a cell of margin round
 *  it, in `ink` ([r, g, b]). */
export function markBitmap(state, { cell = 2, ink = [238, 238, 238] } = {}) {
  const cols = STACK_ROWS[0].length + 2, rows = STACK_ROWS.length + 2;
  const width = cols * cell, height = rows * cell;
  const data = Buffer.alloc(width * height * 4);
  STACK_ROWS.forEach((row, y) => [...row].forEach((part, x) => {
    let alpha = shows(part, state);
    if (state === "off" && (x + y) % 2 === 1) alpha = 0;
    if (!alpha) return;
    for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
      const at = (((y + 1) * cell + dy) * width + (x + 1) * cell + dx) * 4;
      data[at] = ink[2]; data[at + 1] = ink[1]; data[at + 2] = ink[0]; data[at + 3] = Math.round(alpha * 255);
    }
  }));
  return { width, height, data };
}

/** The tray's state from `/live` (null: the service does not answer). */
export function stateOf(snapshot) {
  if (!snapshot) return "off";
  if (snapshot.waiting > 0) return "waiting";
  if (snapshot.running > 0) return "busy";
  return "idle";
}
