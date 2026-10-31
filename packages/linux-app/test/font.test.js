import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopMonoFont, parseFontName } from "../lib/font.js";

test("GNOME's monospace font: its family, and its points as CSS pixels to the half", () => {
  assert.deepEqual(parseFontName("'Adwaita Mono 11'\n"), { family: "Adwaita Mono", size: 14.5 });
  assert.deepEqual(parseFontName("'JetBrains Mono Bold 10.5'"), { family: "JetBrains Mono", size: 14 });
  assert.deepEqual(parseFontName("'Monospace 12'"), { family: "Monospace", size: 16 });
  assert.equal(parseFontName("''"), null);
  assert.equal(parseFontName("'Noto Mono 400'"), null);
});

test("off GNOME (no gsettings) the service's fonts stand", () => {
  assert.equal(desktopMonoFont(() => { throw new Error("no gsettings"); }), null);
  assert.deepEqual(desktopMonoFont(() => "'Adwaita Mono 11'"), { family: "Adwaita Mono", size: 14.5 });
});
