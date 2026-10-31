/** The Files column's changes (docs/files-v0.md §12.5, §12.8): `POST /files/folder`, `/files/file`, `/files/rename`,
 *  `/files/trash`, `/files/restore`, and `PUT /files/content` (a file sent into a folder, written as it comes). This
 *  node's own screens may change what they may read; a paired device only while this node lets paired devices read
 *  and change its files, inside its scope. Every change leaves a line in the audit (who, what, where; never contents). */

import type { Context, Hono } from "hono";
import { createWriteStream } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { askedPath, type Viewer } from "../files/browse.js";
import { landUpload, newFile, newFolder, partPath, renameItem, restore, systemTrash, toTrash, unlinkQuiet, uploadPlace, type ChangeRefusal, type Conflict } from "../files/change.js";
import { viewerFor, type FileAccess } from "./browse.js";

/** The most one file sent from a phone may be (§12.8), and what a phone may fetch to share (§12.3). */
export const MAX_UPLOAD = 200 * 1024 * 1024;

const STATUS: Record<ChangeRefusal | "files-off" | "changes-off" | "too-large", 400 | 403 | 404 | 409 | 413> = {
  "bad-path": 400, "bad-name": 400, "not-folder": 400, folder: 400, "not-found": 404, locked: 403, scope: 403, permission: 403,
  "files-off": 403, "changes-off": 403, exists: 409, "no-trash": 409, "in-use": 409, "not-trash": 400, "too-large": 413,
};
const refuse = (c: Context, error: keyof typeof STATUS, more: Record<string, unknown> = {}) => c.json({ error, ...more }, STATUS[error]);

const PathBody = z.object({ path: z.string().min(1).max(4096) });
const RenameBody = z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(255), force: z.boolean().optional() });
const TrashBody = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(500), permanent: z.boolean().optional(), force: z.boolean().optional() });
const RestoreBody = z.object({ trashed: z.string().min(1).max(4096), path: z.string().min(1).max(4096) });

/** Who changes: this node's screens; a paired device while both switches are on (`changes` absent: on). */
export function changerFor(access: FileAccess, env: unknown): Viewer | "files-off" | "changes-off" {
  const viewer = viewerFor(access, env);
  if (viewer === "files-off") return viewer;
  if (remoteCaller(env) && access.remote().changes === false) return "changes-off";
  return viewer;
}

export function mountFileChanges(app: Hono, access: FileAccess): void {
  const trasher = access.trash ?? systemTrash();
  const running = () => access.running?.() ?? [];
  const audit = (c: Context, action: string, path: string, more: Record<string, unknown> = {}) => {
    const caller = remoteCaller(c.env);
    access.audit?.record({ device: caller?.deviceId ?? "this-node", action, path, ...more });
  };
  /** The changer and the body, or the answer that refuses. */
  const body = async <T extends z.ZodTypeAny>(c: Context, schema: T): Promise<{ viewer: Viewer; data: z.infer<T> } | Response> => {
    const viewer = changerFor(access, c.env);
    if (typeof viewer === "string") return refuse(c, viewer);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    return { viewer, data: parsed.data };
  };
  const path = (raw: string): string | null => askedPath(raw, access.home);

  for (const [route, make, action] of [["/files/folder", newFolder, "new-folder"], ["/files/file", newFile, "new-file"]] as const) {
    app.post(route, async (c) => {
      const b = await body(c, PathBody);
      if (b instanceof Response) return b;
      const p = path(b.data.path);
      if (!p || p === "/") return refuse(c, "bad-path");
      const r = make(p, b.viewer);
      if (!r.ok) return refuse(c, r.error, r.more);
      audit(c, action, r.value.path);
      return c.json(r.value, 201);
    });
  }

  app.post("/files/rename", async (c) => {
    const b = await body(c, RenameBody);
    if (b instanceof Response) return b;
    const p = path(b.data.path);
    if (!p || p === "/") return refuse(c, "bad-path");
    const r = renameItem(p, b.data.name, b.viewer, running(), b.data.force ?? false);
    if (!r.ok) return refuse(c, r.error, r.more);
    audit(c, "rename", p, { to: r.value.path });
    return c.json(r.value);
  });

  app.post("/files/trash", async (c) => {
    const b = await body(c, TrashBody);
    if (b instanceof Response) return b;
    const paths = b.data.paths.map(path);
    if (paths.some((p) => !p || p === "/")) return refuse(c, "bad-path");
    const r = await toTrash(paths as string[], b.viewer, running(), trasher, { permanent: b.data.permanent ?? false, force: b.data.force ?? false });
    const moved = r.ok ? r.value.moved : ((r.more?.moved as { path: string; trashed: string | null }[] | undefined) ?? []);
    for (const m of moved) audit(c, b.data.permanent ? "delete" : "trash", m.path);
    if (!r.ok) return refuse(c, r.error, r.more);
    return c.json(r.value);
  });

  app.post("/files/restore", async (c) => {
    const b = await body(c, RestoreBody);
    if (b instanceof Response) return b;
    const p = path(b.data.path), from = path(b.data.trashed);
    if (!p || !from || p === "/") return refuse(c, "bad-path");
    const r = restore(from, p, b.viewer, access.home);
    if (!r.ok) return refuse(c, r.error, r.more);
    audit(c, "restore", p);
    return c.json(r.value);
  });

  // A file from a phone (§12.8): its bytes as they are, written as they come beside where they go, named when whole.
  app.put("/files/content", async (c) => {
    const viewer = changerFor(access, c.env);
    if (typeof viewer === "string") return refuse(c, viewer);
    const p = path(c.req.query("path") ?? "");
    if (!p || p === "/" || dirname(p) === p) return refuse(c, "bad-path");
    const conflict = (c.req.query("conflict") ?? "fail") as Conflict;
    if (!["fail", "replace", "keep"].includes(conflict)) return c.json({ error: "conflict is fail, replace or keep" }, 400);
    const said = Number(c.req.header("content-length") ?? NaN);
    if (Number.isFinite(said) && said > MAX_UPLOAD) return refuse(c, "too-large", { limit: MAX_UPLOAD });
    const place = uploadPlace(p, viewer, conflict);
    if (!place.ok) return refuse(c, place.error, place.more);
    const part = partPath(p);
    const written = await writeBody(c.req.raw.body, part, MAX_UPLOAD);
    if (written === "too-large") return refuse(c, "too-large", { limit: MAX_UPLOAD });
    if (written === "failed") return refuse(c, "permission");
    const landed = await landUpload(part, p, conflict, viewer, access.trash ?? trasher);
    if (!landed.ok) return refuse(c, landed.error, landed.more);
    audit(c, "upload", landed.value.path, { bytes: written });
    return c.json({ path: landed.value.path, name: basename(landed.value.path), size: written }, 201);
  });
}

/** The request's body into `part`, no more than `limit` bytes; the file is gone again unless all of it came. */
async function writeBody(body: ReadableStream<Uint8Array> | null, part: string, limit: number): Promise<number | "too-large" | "failed"> {
  const out = createWriteStream(part, { flags: "wx", mode: 0o644 });
  const opened = new Promise<void>((resolve, reject) => { out.once("open", () => resolve()); out.once("error", reject); });
  try { await opened; } catch { return "failed"; }
  let bytes = 0;
  const reader = body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel().catch(() => {}); throw new Error("too-large"); }
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    return bytes;
  } catch (err) {
    out.destroy();
    unlinkQuiet(part);
    return (err as Error).message === "too-large" ? "too-large" : "failed";
  }
}
