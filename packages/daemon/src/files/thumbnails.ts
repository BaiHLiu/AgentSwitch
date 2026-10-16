/** A picture's small copy for a screen that is not on this node (docs/files-v0.md §7.1 `/files/thumbnail`): a phone
 *  shows it before it fetches the whole file. Made on a Mac by `sips` (512 points on the long side, JPEG); elsewhere,
 *  or when `sips` cannot read it, a small enough picture is given as it is. The last few are kept in memory by where
 *  the file is and when it changed. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { contentType } from "./names.js";

export const THUMBNAIL_SIDE = 512;
/** Without a small copy, a picture up to this size is given whole. */
export const WHOLE_UP_TO = 5 * 1024 * 1024;
const KEPT = 64;
const SIPS = "/usr/bin/sips";
const SIPS_TIMEOUT_MS = 15_000;
/** What a phone can show as it is. */
const SHOWN_AS_IS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"]);

export type Thumbnail = { readonly bytes: Buffer; readonly type: string };
/** Makes a JPEG of `input` at `out`; resolves whether it did. */
export type ThumbnailMaker = (input: string, out: string) => Promise<boolean>;

export const sipsMaker: ThumbnailMaker = (input, out) => new Promise((resolve) => {
  execFile(SIPS, ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(THUMBNAIL_SIDE), input, "--out", out], { timeout: SIPS_TIMEOUT_MS }, (err) => resolve(!err));
});

export class Thumbnails {
  private readonly kept = new Map<string, Thumbnail>();
  private dir: string | null = null;

  constructor(private readonly maker: ThumbnailMaker | null = process.platform === "darwin" ? sipsMaker : null) {}

  /** The small copy of the picture at `real` (size and mtime say which version), or null when there is none to give. */
  async of(real: string, size: number, mtime: number): Promise<Thumbnail | null> {
    const key = `${real}\0${size}\0${mtime}`;
    const have = this.kept.get(key);
    if (have) { this.kept.delete(key); this.kept.set(key, have); return have; }
    const made = await this.make(real, size);
    if (!made) return null;
    this.kept.set(key, made);
    while (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!);
    return made;
  }

  private async make(real: string, size: number): Promise<Thumbnail | null> {
    if (this.maker) {
      this.dir ??= mkdtempSync(join(tmpdir(), "agentswitch-thumbs-"));
      const out = join(this.dir, `${createHash("sha256").update(real).digest("hex").slice(0, 16)}-${process.hrtime.bigint()}.jpg`);
      try {
        if (await this.maker(real, out)) return { bytes: readFileSync(out), type: "image/jpeg" };
      } catch { /* fall through */ } finally { rmSync(out, { force: true }); }
    }
    const ext = extname(real).toLowerCase();
    if (size <= WHOLE_UP_TO && SHOWN_AS_IS.has(ext)) {
      try { return { bytes: readFileSync(real), type: contentType(real) === "application/octet-stream" ? `image/${ext.slice(1)}` : contentType(real) }; } catch { return null; }
    }
    return null;
  }

  close(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
}
