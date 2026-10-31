// The desktop's monospace font for the terminal screens (docs/linux-app-v0.md): GNOME's `monospace-font-name`
// ("Adwaita Mono 11"), what its own terminals use. Points become CSS pixels (96 per inch: × 4/3), to the half pixel.
import { execFileSync } from "node:child_process";

/** "'Adwaita Mono 11'" (as gsettings prints it) → { family: "Adwaita Mono", size: 14.5 }; null when it is not one. */
export function parseFontName(printed) {
  const m = /^'?(.+?)\s+(\d+(?:\.\d+)?)'?\s*$/.exec(String(printed ?? "").trim());
  if (!m) return null;
  const pt = Number(m[2]);
  if (!(pt >= 5 && pt <= 72)) return null;
  // A style after the family ("JetBrains Mono Bold 11") is not part of a CSS family.
  const family = m[1].replace(/\s+(Regular|Book|Medium|Bold|Light|Italic|Oblique|SemiBold|Semi-Bold|ExtraLight|Thin|Heavy|Black)$/gi, "").replace(/["\\]/g, "");
  return family ? { family, size: Math.round((pt * 4) / 3 * 2) / 2 } : null;
}

/** GNOME's monospace font, or null off GNOME (the service's list stands). */
export function desktopMonoFont(run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })) {
  try { return parseFontName(run("gsettings", ["get", "org.gnome.desktop.interface", "monospace-font-name"])); } catch { return null; }
}
