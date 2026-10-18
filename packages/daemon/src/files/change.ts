/** Changing this node's files from the Files column (docs/files-v0.md §12): a new folder or an empty file, a new name,
 *  the Trash and back out of it, and a file sent from a phone into a folder (§12.8). The same viewer as the reads
 *  (files/browse.ts): a paired device changes only what it may read, and only while this node lets paired devices
 *  change files; nobody changes AgentSwitch's own credential places, the folders holding them (moving one would carry
 *  the credentials with it) or `/` and the folders right under it.
 *
 *  Nothing is deleted outright unless asked to be after the Trash would not take it: what goes is moved to the Trash,
 *  where `restore` (⌘Z) or the Trash itself puts it back. */

import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { canonicalPath, isWithin, lineage } from "../core/paths.js";
import { holdsFixed, inScope, isLocked, type Refusal, type Viewer } from "./browse.js";

export type ChangeRefusal = Refusal | "exists" | "bad-name" | "no-trash" | "in-use" | "not-trash";
export type ChangeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ChangeRefusal; readonly more?: Record<string, unknown> };

const ok = <T>(value: T): ChangeResult<T> => ({ ok: true, value });
const no = <T>(error: ChangeRefusal, more?: Record<string, unknown>): ChangeResult<T> => ({ ok: false, error, ...(more ? { more } : {}) });

/** A terminal running in a folder: asked about before that folder is renamed or moved (§12.2). */
export type Running = { readonly id: string; readonly name: string; readonly workdir: string };

/** Moves `real` to the Trash and says where it went; throws a `TrashError` when it cannot. */
export type Trasher = (real: string) => Promise<string>;
export class TrashError extends Error {
  constructor(readonly code: "no-trash" | "permission" | "not-found", message: string) { super(message); }
}

/** A name of one item: not empty, not `.` or `..`, no slash, no control character, at most 255 bytes. */
export function goodName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !/[\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name) <= 255;
}

function errnoOf(err: unknown): ChangeRefusal {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY" ? "exists" : code === "EACCES" || code === "EPERM" || code === "EROFS" ? "permission" : code === "ENOTDIR" ? "not-folder" : "not-found";
}

const lstatOf = (p: string): Stats | null => { try { return lstatSync(p); } catch { return null; } };

/** One of the places nothing here changes: `/` and what is right under it, AgentSwitch's credential places, and the
 *  folders that hold one. `real` is where the thing really is. */
export function fixedPlace(real: string, viewer: Viewer): boolean {
  return isLocked(real, viewer) || holdsFixed(real, viewer);
}

/** Where an existing item really is, and that it may be changed by this viewer: in its scope, not a fixed place. The
 *  item itself is not followed if it is a link (a link is renamed or moved as a link). */
function changeable(p: string, viewer: Viewer): ChangeResult<string> {
  const st = lstatOf(p);
  if (!st) return no("not-found");
  let parent: string;
  try { parent = canonicalPath(realpathSync.native(dirname(p))); } catch (err) { return no(errnoOf(err)); }
  const real = parent === "/" ? `/${basename(p)}` : join(parent, basename(p));
  if (isLocked(parent, viewer)) return no("locked");
  // A link: where it points decides what it may hold, but the link itself is what moves.
  let target = real;
  if (st.isSymbolicLink()) { try { target = canonicalPath(realpathSync.native(p)); } catch { target = real; } }
  if (fixedPlace(real, viewer) || (target !== real && isLocked(target, viewer))) return no("locked");
  if (!inScope(real, viewer)) return no("scope");
  return ok(real);
}

/** The folder something new goes in, as it really is: the deepest part of `dir` there is, and what is left to make.
 *  It must be a folder, in scope, not locked; what is made must not land in a locked place either. */
function placeFor(p: string, viewer: Viewer): ChangeResult<{ readonly real: string; readonly existing: string }> {
  let existing = dirname(p);
  const rest: string[] = [basename(p)];
  while (!lstatOf(existing)) {
    if (existing === "/") return no("not-found");
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  let realExisting: string;
  try { realExisting = canonicalPath(realpathSync.native(existing)); } catch (err) { return no(errnoOf(err)); }
  try { if (!statSync(realExisting).isDirectory()) return no("not-folder"); } catch (err) { return no(errnoOf(err)); }
  const real = join(realExisting, ...rest);
  if (isLocked(realExisting, viewer) || isLocked(real, viewer)) return no("locked");
  if (realExisting === "/") return no("locked");
  if (!inScope(realExisting, viewer)) return no("scope");
  return ok({ real, existing: realExisting });
}

/** The terminals whose folder is `real` or inside it. */
function runningIn(real: string, running: readonly Running[]): readonly Running[] {
  return running.filter((t) => { const w = canonicalPath(t.workdir); return isWithin(w, real, lineage(w)) || w === real; });
}

/** A new folder at `p` (and the folders on the way that are not there yet). `top` is the first one made: what an undo
 *  takes away. */
export function newFolder(p: string, viewer: Viewer): ChangeResult<{ readonly path: string; readonly top: string }> {
  if (lstatOf(p)) return no("exists");
  if (!goodName(basename(p))) return no("bad-name");
  const where = placeFor(p, viewer);
  if (!where.ok) return where;
  try {
    const top = mkdirSync(p, { recursive: true });
    return ok({ path: p, top: top ?? p });
  } catch (err) { return no(errnoOf(err)); }
}

/** A new empty file at `p`, the folders on the way made as needed. */
export function newFile(p: string, viewer: Viewer): ChangeResult<{ readonly path: string; readonly top: string }> {
  if (lstatOf(p)) return no("exists");
  if (!goodName(basename(p))) return no("bad-name");
  const where = placeFor(p, viewer);
  if (!where.ok) return where;
  try {
    const top = mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "", { flag: "wx" });
    return ok({ path: p, top: top ?? p });
  } catch (err) { return no(errnoOf(err)); }
}

/** `p` given another name in the same folder. A folder a terminal runs in is asked about first (`force` once asked). */
export function renameItem(p: string, name: string, viewer: Viewer, running: readonly Running[], force = false): ChangeResult<{ readonly path: string }> {
  if (!goodName(name)) return no("bad-name");
  const real = changeable(p, viewer);
  if (!real.ok) return real;
  const to = join(dirname(p), name);
  if (to === p) return ok({ path: p });
  const there = lstatOf(to), here = lstatOf(p);
  // A disk that does not tell case apart has `App.ts` and `app.ts` as one: renaming one to the other is a rename.
  if (there && !(here && there.dev === here.dev && there.ino === here.ino)) return no("exists");
  if (!force && here?.isDirectory()) {
    const busy = runningIn(real.value, running);
    if (busy.length) return no("in-use", { terminals: busy.map((t) => ({ id: t.id, name: t.name })) });
  }
  try { renameSync(p, to); return ok({ path: to }); } catch (err) { return no(errnoOf(err)); }
}

export type Moved = { readonly path: string; readonly trashed: string | null };

/** `paths` to the Trash (or, with `permanent`, deleted: only after the Trash would not take them). All are checked
 *  before any moves; a folder a terminal runs in is asked about first. One the Trash will not take is left where it is
 *  and named in `no-trash`; the others go. */
export async function toTrash(paths: readonly string[], viewer: Viewer, running: readonly Running[], trasher: Trasher, opts: { readonly permanent?: boolean; readonly force?: boolean } = {}): Promise<ChangeResult<{ readonly moved: readonly Moved[] }>> {
  const reals: string[] = [];
  for (const p of paths) {
    const r = changeable(p, viewer);
    if (!r.ok) return no(r.error, { path: p });
    reals.push(r.value);
  }
  if (!opts.force) {
    const busy = reals.flatMap((r) => runningIn(r, running));
    if (busy.length) return no("in-use", { terminals: [...new Map(busy.map((t) => [t.id, { id: t.id, name: t.name }])).values()] });
  }
  const moved: Moved[] = [];
  const refused: string[] = [];
  for (const [i, p] of paths.entries()) {
    if (opts.permanent) {
      try { rmSync(p, { recursive: true, force: false }); moved.push({ path: p, trashed: null }); } catch (err) { return no(errnoOf(err), { path: p, moved }); }
      continue;
    }
    // Where it went, when that could be told (an undo needs it); the Trash has it either way.
    try { moved.push({ path: p, trashed: (await trasher(reals[i]!)) || null }); }
    catch (err) {
      if (err instanceof TrashError && err.code === "no-trash") { refused.push(p); continue; }
      if (err instanceof TrashError) return no(err.code, { path: p, moved });
      return no("permission", { path: p, moved });
    }
  }
  return refused.length ? no("no-trash", { paths: refused, moved }) : ok({ moved });
}

/** The user's own home as the system knows it, whatever `$HOME` says: where the system's Trash is (a service started
 *  with another `$HOME` still has its items moved to the user's `~/.Trash`). */
export const accountHome = (): string => { try { return userInfo().homedir; } catch { return homedir(); } };

/** The Trash folders an undo may take something back out of: the user's (under `home` and under the account's own
 *  home), a volume's own, the freedesktop one. */
export function inTrash(real: string, home: string = homedir()): boolean {
  const uid = process.getuid?.() ?? 0;
  const h = canonicalPath(home);
  const roots = [join(h, ".Trash"), join(canonicalPath(accountHome()), ".Trash"), join(canonicalPath(process.env.XDG_DATA_HOME ?? join(h, ".local", "share")), "Trash", "files")];
  if (roots.some((r) => real.startsWith(r + "/"))) return true;
  return /^\/Volumes\/[^/]+\/\.Trashes\/\d+\//.test(real) && real.split("/")[4] === String(uid);
}

/** ⌘Z after `toTrash`: `trashed` back where it was (`path`). Only out of a Trash, only into a folder this viewer may
 *  change, never over something already there. */
export function restore(trashed: string, path: string, viewer: Viewer, home: string = homedir()): ChangeResult<{ readonly path: string }> {
  let real: string;
  try { real = canonicalPath(realpathSync.native(trashed)); } catch (err) { return no(errnoOf(err)); }
  if (!inTrash(real, home)) return no("not-trash");
  if (lstatOf(path)) return no("exists");
  const where = placeFor(path, viewer);
  if (!where.ok) return where;
  if (!lstatOf(dirname(path))) return no("not-found");
  try {
    renameSync(trashed, path);
    // The freedesktop Trash keeps a note of each item beside it: the item is gone, so is the note.
    const info = join(dirname(dirname(real)), "info", `${basename(real)}.trashinfo`);
    if (existsSync(info)) rmSync(info, { force: true });
    return ok({ path });
  } catch (err) { return no(errnoOf(err)); }
}

/** `IMG_0412 2.HEIC`: the first name not taken in `dir`, as Finder names the second of two (`Keep Both`). */
export function keepBothName(dir: string, name: string): string {
  const ext = extname(name), stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let k = 2; ; k++) {
    const next = `${stem} ${k}${stem === name ? "" : ext}`;
    if (!lstatOf(join(dir, next))) return next;
  }
}

export type Conflict = "fail" | "replace" | "keep";

/** Where an upload is written as it comes, beside where it goes: half of one never has the real name. */
export function partPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}-${Date.now().toString(36)}.agentswitch-part`);
}

/** Before an upload's bytes are taken: the folder it goes in may take it, and with `fail` the name is free. */
export function uploadPlace(p: string, viewer: Viewer, conflict: Conflict): ChangeResult<{ readonly dir: string }> {
  if (!goodName(basename(p))) return no("bad-name");
  const dir = dirname(p);
  const st = lstatOf(dir);
  if (!st) return no("not-found");
  const where = placeFor(p, viewer);
  if (!where.ok) return where;
  const here = lstatOf(p);
  if (here && conflict === "fail") return no("exists");
  if (here && conflict === "replace") { const r = changeable(p, viewer); if (!r.ok) return r; if (here.isDirectory()) return no("exists"); }
  return ok({ dir });
}

/** An upload written whole to `part`: given its name. `replace` sends what was there to the Trash first; `keep` takes
 *  the next free name. */
export async function landUpload(part: string, p: string, conflict: Conflict, viewer: Viewer, trasher: Trasher): Promise<ChangeResult<{ readonly path: string }>> {
  let target = p;
  if (lstatOf(p)) {
    if (conflict === "fail") { unlinkQuiet(part); return no("exists"); }
    if (conflict === "keep") target = join(dirname(p), keepBothName(dirname(p), basename(p)));
    else {
      const r = changeable(p, viewer);
      if (!r.ok) { unlinkQuiet(part); return r; }
      try { await trasher(r.value); } catch (err) { unlinkQuiet(part); return no(err instanceof TrashError ? err.code : "permission"); }
    }
  }
  try { renameSync(part, target); return ok({ path: target }); } catch (err) { unlinkQuiet(part); return no(errnoOf(err)); }
}

export function unlinkQuiet(p: string): void {
  try { unlinkSync(p); } catch { /* already gone */ }
}

// ---------- the Trash itself ----------

/** macOS: the system's own Trash, as Finder uses it (`NSFileManager.trashItem`), through the scripting bridge every
 *  Mac has — no separate tool to ship. The bridge cannot be trusted to hand back where the item went (reading the
 *  method's out-argument crashed the script, 2026-10-18), so it is only asked to move it, and the item is found again
 *  in that disk's Trash by its identity: a move within one disk keeps the inode. */
export function macTrash(home: string = accountHome()): Trasher {
  return (real) => new Promise((resolve, reject) => {
    const before = lstatOf(real);
    if (!before) return reject(new TrashError("not-found", real));
    const script = `const framework = "Foundation"; ObjC.import(framework);
function run(argv) { return $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null) ? "ok" : "no"; }`;
    // (The framework's name is spelled through a variable: the build's check of what the code imports reads the source.)
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, real], { timeout: 60_000 }, (error, stdout) => {
      if (String(stdout ?? "").trim() !== "ok") {
        if (!lstatOf(real)) return reject(new TrashError("not-found", real));
        // Still there: a folder it may not be moved out of, or a disk with no Trash.
        let writable = true;
        try { accessSync(dirname(real), constants.W_OK); } catch { writable = false; }
        return reject(new TrashError(writable ? "no-trash" : "permission", error?.message ?? `the Trash did not take ${real}`));
      }
      resolve(foundInTrash(before, home) ?? "");
    });
  });
}

/** Where an item now in a Trash is: the Trash on its own disk (the user's for the startup disk, `.Trashes/<uid>` for
 *  another), searched by device and inode. */
export function foundInTrash(was: Stats, home: string = accountHome()): string | null {
  const uid = process.getuid?.() ?? 0;
  const places = [join(home, ".Trash")];
  try { for (const v of readdirSync("/Volumes")) places.push(join("/Volumes", v, ".Trashes", String(uid))); } catch { /* none */ }
  for (const dir of places) {
    const st = lstatOf(dir);
    if (!st || st.dev !== was.dev) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const it = lstatOf(join(dir, name));
      if (it && it.ino === was.ino && it.dev === was.dev) return join(dir, name);
    }
  }
  return null;
}

/** Linux: the freedesktop Trash (`$XDG_DATA_HOME/Trash`): the item into `files/` under a free name, a note of where it
 *  was in `info/`. Only from the same disk as that Trash; from another, `no-trash`. */
export function freedesktopTrash(home: string = homedir(), now: () => Date = () => new Date()): Trasher {
  return async (real) => {
    const base = join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "Trash");
    const files = join(base, "files"), info = join(base, "info");
    mkdirSync(files, { recursive: true, mode: 0o700 });
    mkdirSync(info, { recursive: true, mode: 0o700 });
    const st = lstatOf(real);
    if (!st) throw new TrashError("not-found", real);
    if (statSync(files).dev !== st.dev) throw new TrashError("no-trash", `${real} is on another disk than the Trash`);
    const taken = new Set(readdirSync(files));
    let name = basename(real);
    for (let k = 2; taken.has(name) || existsSync(join(info, `${name}.trashinfo`)); k++) name = `${basename(real)}.${k}`;
    const stamp = now().toISOString().slice(0, 19);
    // The note is made first and exclusively: two at once never take the same name.
    const fd = openSync(join(info, `${name}.trashinfo`), "wx", 0o600);
    try { writeFileSync(fd, `[Trash Info]\nPath=${encodeURI(real)}\nDeletionDate=${stamp}\n`); } finally { closeSync(fd); }
    try { renameSync(real, join(files, name)); }
    catch (err) { rmSync(join(info, `${name}.trashinfo`), { force: true }); throw new TrashError(errnoOf(err) === "permission" ? "permission" : "not-found", String(err)); }
    return join(files, name);
  };
}

export const systemTrash = (): Trasher => (process.platform === "darwin" ? macTrash() : freedesktopTrash());
