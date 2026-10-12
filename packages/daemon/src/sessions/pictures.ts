/** The pictures a record names only by where their file was (docs/simple-view-v0.md §4, 2026-10-11; user: 远程其他mac里
 *  codex的简略模式图片加载不出来). Codex keeps a picture sent with a message as a path: one pasted into it is a
 *  `codex-clipboard-….png` in the system's temporary folder, which macOS empties after about three days; one sent from
 *  another screen sits in the terminal's attach folder, which goes with the terminal. So the service keeps a copy of each,
 *  by the place the record names, and shows the copy once the file itself is gone.
 *
 *  The copies are under the service's home (`sessions/pictures`): no managed executor writes there (the home is a
 *  protected root), and they are as readable as the agents' own records are. Never a file from a folder no agent may
 *  read (the gate's, the other nodes' tokens, the browser's kept sessions), whatever name a record gives it, and never
 *  through a link to a file that is not a picture by its own name. Nothing larger than a picture is shown (12 MB); in all
 *  at most `maxBytes`, none kept longer than `maxAgeMs`. */

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, isWithin } from "../core/paths.js";
import { obj } from "./jsonl.js";
import { codexPictureFiles, IMAGE_BYTES, pictureFile, pictureType, type PictureReader, type RecordImage } from "./record.js";

export const KEPT_BYTES = 512 * 1024 * 1024;
/** As long as the list looks back for sessions. */
export const KEPT_AGE_MS = 90 * 24 * 3600_000;
/** A record met for the first time is read whole when it was written this recently: an older one's temporary files are
 *  gone already, and its other pictures are kept when a screen asks for them. */
const FIRST_LOOK_MS = 7 * 24 * 3600_000;
const TIDY_EVERY_MS = 3600_000;
/** A line longer than this is passed over (a record's longest lines are what its tools printed). */
const LINE_BYTES = 64 * 1024 * 1024;
const TEMPORARY = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

export type KeptPicturesOptions = {
  /** Folders nothing is copied from or shown from, canonical (the executors' read-denied roots). */
  readonly closed?: readonly string[];
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
};

type Place = { readonly from: string; readonly to: string; readonly type: string };

export class KeptPictures {
  private readonly closed: readonly string[];
  private readonly temporary: readonly string[];
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  /** How far each record has been read for the pictures it names. */
  private readonly looked = new Map<string, number>();
  private readonly waiting: string[] = [];
  private working: Promise<void> | null = null;
  private tidied = 0;

  constructor(readonly dir: string, o: KeptPicturesOptions = {}) {
    this.closed = [...(o.closed ?? []), canonicalPath(dir)];
    this.temporary = [...new Set([tmpdir(), ...TEMPORARY].map(canonicalPath))];
    this.maxBytes = o.maxBytes ?? KEPT_BYTES;
    this.maxAgeMs = o.maxAgeMs ?? KEPT_AGE_MS;
    this.now = o.now ?? Date.now;
  }

  /** A picture sent with a message: the file while it is there (a copy is kept then), else the copy. */
  readonly sent: PictureReader = (file) => this.show(file, true);
  /** A picture file a step looked at: the same, but only one from a temporary folder is copied — a project's own
   *  pictures stay where they are, and would crowd the others out. */
  readonly seen: PictureReader = (file) => this.show(file, false);

  /** A copy of `file` as it is now, unless one is held already. False: nothing to keep (not a picture by its name, in
   *  a closed folder, gone, too large). */
  keep(file: string): boolean {
    const at = this.place(file);
    return at !== null && this.copy(at);
  }

  /** The picture files in `dir`, kept now: the folder is about to go (a terminal's attached files). */
  keepIn(dir: string): number {
    let kept = 0;
    try { for (const name of readdirSync(dir)) if (this.keep(join(dir, name))) kept += 1; } catch { /* no such folder */ }
    return kept;
  }

  /** A Codex record as the list sees it. What it grew by since it was last read is read for the picture files it
   *  names — in the background, one record at a time — and each is copied while it is still there. */
  noticed(record: string, size: number, mtime: number): void {
    const done = this.looked.get(record);
    if (done === undefined) this.looked.set(record, this.now() - mtime < FIRST_LOOK_MS ? 0 : size);
    else if (size < done) this.looked.set(record, 0);   // written anew
    if (size <= this.looked.get(record)! || this.waiting.includes(record)) return;
    this.waiting.push(record);
    this.working ??= this.work();
  }

  /** Once every record noticed so far has been read (tests, and before the service stops). */
  async settled(): Promise<void> {
    while (this.working) await this.working;
  }

  /** Copies past their time go; then the oldest, until what is left fits. At most once an hour unless `now`. */
  tidy(now = false): void {
    const at = this.now();
    if (!now && at - this.tidied < TIDY_EVERY_MS) return;
    this.tidied = at;
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return; }
    const held: { path: string; size: number; at: number }[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        const st = lstatSync(path);
        // Only what this class wrote belongs here: a link or a folder someone put in goes.
        if (!st.isFile() || at - st.ctimeMs > this.maxAgeMs || (name.endsWith(".tmp") && at - st.ctimeMs > TIDY_EVERY_MS)) rmSync(path, { recursive: true, force: true });
        else held.push({ path, size: st.size, at: st.ctimeMs });
      } catch { /* gone meanwhile */ }
    }
    let total = held.reduce((n, f) => n + f.size, 0);
    if (total <= this.maxBytes) return;
    for (const f of held.sort((a, b) => a.at - b.at)) {
      if (total <= this.maxBytes * 0.9) break;
      try { rmSync(f.path, { force: true }); total -= f.size; } catch { /* next */ }
    }
  }

  private show(file: string, always: boolean): RecordImage | null {
    const at = this.place(file);
    if (!at) return null;
    const own = pictureFile(at.from);
    if (own) {
      if (always || this.isTemporary(at.from)) this.copy(at);
      return own;
    }
    return this.held(at);
  }

  /** Where `file` is read from and where its copy goes; null for a name that is not a picture's, a link to a file
   *  that is not a picture by its own name, or a place in a closed folder. A file that is gone keeps the spelling the
   *  record gave it, so its copy is found by the same name it was kept under. */
  private place(file: string): Place | null {
    const type = pictureType(file);
    if (!type) return null;
    const from = canonicalPath(file);
    if (!pictureType(from) || this.closed.some((root) => isWithin(from, root))) return null;
    const name = createHash("sha256").update(from).digest("hex").slice(0, 40);
    return { from, to: join(this.dir, `${name}.${from.split(".").pop()!.toLowerCase()}`), type };
  }

  private isTemporary(from: string): boolean {
    return this.temporary.some((root) => from.startsWith(`${root}/`));
  }

  private copy(at: Place): boolean {
    try {
      const st = statSync(at.from);
      if (!st.isFile() || st.size <= 0 || st.size > IMAGE_BYTES) return false;
      const have = regular(at.to);
      // The same file as when it was copied: nothing to do (the copy carries the file's own time).
      if (have && have.size === st.size && Math.abs(have.mtimeMs - st.mtimeMs) < 2) return true;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${at.to}.${process.pid}.tmp`;
      copyFileSync(at.from, tmp);
      if (statSync(tmp).size > IMAGE_BYTES) { rmSync(tmp, { force: true }); return false; }   // it grew while it was copied
      chmodSync(tmp, 0o600);
      utimesSync(tmp, new Date(this.now()), st.mtime);
      renameSync(tmp, at.to);
      this.tidy();
      return true;
    } catch {
      return false;
    }
  }

  private held(at: Place): RecordImage | null {
    let fd: number;
    try { fd = openSync(at.to, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size <= 0 || st.size > IMAGE_BYTES) return null;
      const data = Buffer.alloc(st.size);
      let n = 0;
      while (n < data.length) { const got = readSync(fd, data, n, data.length - n, n); if (got <= 0) break; n += got; }
      return n === data.length ? { type: at.type, data } : null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  private async work(): Promise<void> {
    try {
      for (let record = this.waiting.shift(); record !== undefined; record = this.waiting.shift()) {
        try { this.looked.set(record, await this.look(record, this.looked.get(record) ?? 0)); } catch { /* gone or unreadable: the next notice tries again */ }
      }
    } finally {
      this.working = null;
    }
  }

  /** Reads `record` from `from` on, a line at a time, and keeps what its lines name. Returns where the last whole line
   *  ended: a line still being written is read next time. */
  private async look(record: string, from: number): Promise<number> {
    let done = from;
    let parts: Buffer[] = [];
    let held = 0;
    for await (const chunk of createReadStream(record, { start: from, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
      let i = 0;
      for (;;) {
        const stop = chunk.indexOf(10, i);
        if (stop < 0) {
          held += chunk.length - i;
          if (held > LINE_BYTES) parts = []; else parts.push(chunk.subarray(i));
          break;
        }
        if (held + stop - i <= LINE_BYTES) this.said(parts.length ? Buffer.concat([...parts, chunk.subarray(i, stop)]) : chunk.subarray(i, stop));
        done += held + stop - i + 1;
        parts = [];
        held = 0;
        i = stop + 1;
      }
    }
    return done;
  }

  private said(line: Buffer): void {
    if (line.indexOf("local_image") < 0 && line.indexOf("ImageView") < 0) return;
    let value: unknown;
    try { value = JSON.parse(line.toString("utf8")); } catch { return; }
    const named = codexPictureFiles(obj(value));
    for (const file of named.sent) this.keep(file);
    for (const file of named.seen) { const at = this.place(file); if (at && this.isTemporary(at.from)) this.copy(at); }
  }
}

/** `path` as a file of its own (not a link, not a folder), or null. */
function regular(path: string): { size: number; mtimeMs: number } | null {
  try { const st = lstatSync(path); return st.isFile() ? st : null; } catch { return null; }
}
