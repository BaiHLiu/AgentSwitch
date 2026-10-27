/** A folder spelled as the disk spells it (core/paths.ts `diskSpelling`): a terminal opened as `~/x/pi` on a Mac's disk
 *  is in `~/x/Pi`, and listed with the sessions recorded there (2026-10-17: the list showed one folder as two). */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diskSpelling, keptDiskSpelling } from "../src/core/paths.js";

describe("a folder as the disk spells it", () => {
  it("takes the disk's case where the disk ignores case, keeps links, and leaves what is not there as given", () => {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-spelling-"));
    mkdirSync(join(root, "Worktop", "Pi", "src"), { recursive: true });
    symlinkSync(join(root, "Worktop", "Pi"), join(root, "link"));
    // A Mac's disk ignores case; a Linux one does not, and there `pi` is not `Pi`.
    const ignoresCase = existsSync(join(root, "worktop", "pi"));
    expect(diskSpelling(join(root, "Worktop", "Pi", "src"))).toBe(join(root, "Worktop", "Pi", "src"));
    expect(diskSpelling(join(root, "worktop", "pi", "SRC"))).toBe(ignoresCase ? join(root, "Worktop", "Pi", "src") : join(root, "worktop", "pi", "SRC"));
    // A link stays a link (realpath would follow it); what is not there stays as typed.
    expect(diskSpelling(join(root, "link"))).toBe(join(root, "link"));
    expect(diskSpelling(join(root, "Worktop", "nope", "x"))).toBe(join(root, "Worktop", "nope", "x"));
    expect(diskSpelling(join(root, "Worktop", "Pi", "..", "Pi"))).toBe(join(root, "Worktop", "Pi"));
    expect(keptDiskSpelling("")).toBe("");
    // On a Linux disk there is no `worktop` to resolve: it stays as typed, as anything not there does.
    if (ignoresCase) expect(realpathSync(diskSpelling(join(root, "worktop")))).toBe(realpathSync(join(root, "Worktop")));
    else expect(diskSpelling(join(root, "worktop"))).toBe(join(root, "worktop"));
  });

  it("does not take another folder that differs only in case on a disk that tells them apart", () => {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-spelling-"));
    mkdirSync(join(root, "Pi"));
    if (existsSync(join(root, "pi"))) return;   // a Mac's disk: one folder, the case above covers it
    mkdirSync(join(root, "pi"));
    expect(diskSpelling(join(root, "pi"))).toBe(join(root, "pi"));
    expect(diskSpelling(join(root, "PI"))).toBe(join(root, "PI"));
  });
});
