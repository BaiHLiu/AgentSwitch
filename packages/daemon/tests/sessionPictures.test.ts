/** The pictures a Codex record names only by where their file was (docs/simple-view-v0.md §4, 2026-10-11; user: 远程其他
 *  mac里codex的简略模式图片加载不出来): the service keeps a copy and shows it once the file is gone. Everything here is
 *  written in throw-away folders: no test reads the user's own sessions. */

import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountSessions } from "../src/api/sessions.js";
import type { ApiDeps } from "../src/api/shared.js";
import { SessionMonitor } from "../src/sessions/monitor.js";
import { KeptPictures } from "../src/sessions/pictures.js";
import { IMAGE_BYTES, type RecordItem } from "../src/sessions/record.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OTHER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const API = "/Users/u/code/api";
const line = (o: unknown) => JSON.stringify(o);
const at = (s: number) => new Date(Date.now() - 3600_000 + s * 1000).toISOString();
const item = (s: number, it: object) => line({ timestamp: at(s + 1), type: "event_msg", payload: { type: "item_completed", turn_id: "t", started_at_ms: Date.parse(at(s)), completed_at_ms: Date.parse(at(s + 1)), item: it } });
const sent = (s: number, text: string, ...files: string[]) => item(s, { type: "UserMessage", id: `u${s}`, content: [{ type: "text", text }, ...files.map((path) => ({ type: "local_image", path }))] });

const gone: string[] = [];
afterEach(() => { for (const dir of gone.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A temporary folder, as Codex's pasted pictures and a terminal's attached files are in. */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-pictures-")));
  gone.push(dir);
  return dir;
}

/** A folder that is not a temporary one (a project's own): under this package's cache, removed after the test. */
function lasting(): string {
  const cache = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(cache, "as-pictures-")));
  gone.push(dir);
  return dir;
}

function store(o: ConstructorParameters<typeof KeptPictures>[1] = {}) {
  const dir = scratch();
  return { dir, kept: new KeptPictures(join(dir, "home", "sessions", "pictures"), o) };
}

function rollout(root: string, lines: string[]): string {
  const dir = join(root, "codex", "2026", "10", "11");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-2026-10-11T10-00-00-x1.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const notice = (kept: KeptPictures, record: string) => { const st = statSync(record); kept.noticed(record, st.size, st.mtimeMs); return kept.settled(); };

describe("a picture a record names by its file's place", () => {
  it("is shown from the file while that is there, and from the service's copy once it is gone", () => {
    const { dir, kept } = store();
    const shot = join(dir, "codex-clipboard-1.png");
    writeFileSync(shot, PNG);
    expect(kept.sent(shot)).toEqual({ type: "image/png", data: PNG });
    const copies = readdirSync(kept.dir);
    expect(copies).toHaveLength(1);
    // The user's alone, like the records themselves.
    expect(statSync(kept.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(kept.dir, copies[0]!)).mode & 0o777).toBe(0o600);
    rmSync(shot);
    expect(kept.sent(shot)).toEqual({ type: "image/png", data: PNG });
    // A record may spell the temporary folder either way (`/var/folders/…` is `/private/var/folders/…`).
    if (shot.startsWith("/private/var/")) expect(kept.sent(shot.slice("/private".length))).toEqual({ type: "image/png", data: PNG });
    // One nobody kept is nothing, as before.
    expect(kept.sent(join(dir, "codex-clipboard-2.png"))).toBeNull();
  });

  it("is copied again when the file was written anew, and only then", () => {
    const { dir, kept } = store();
    const shot = join(dir, "shot.png");
    writeFileSync(shot, PNG);
    expect(kept.keep(shot)).toBe(true);
    const copy = join(kept.dir, readdirSync(kept.dir)[0]!);
    const first = lstatSync(copy).ino;
    expect(kept.keep(shot)).toBe(true);
    expect(lstatSync(copy).ino).toBe(first);   // the same file: left as it is
    writeFileSync(shot, OTHER);
    expect(kept.sent(shot)).toEqual({ type: "image/png", data: OTHER });
    rmSync(shot);
    expect(kept.sent(shot)).toEqual({ type: "image/png", data: OTHER });
    expect(readdirSync(kept.dir)).toHaveLength(1);
  });

  it("is neither copied nor shown when it is not a picture's file, too large, or in a folder no agent may read", () => {
    const dir = scratch();
    const closed = join(dir, "gate");
    mkdirSync(closed);
    const kept = new KeptPictures(join(dir, "home", "sessions", "pictures"), { closed: [closed] });
    const key = join(dir, "id_rsa"), large = join(dir, "large.png"), inside = join(closed, "key.png"), disguised = join(dir, "notes.png"), reaching = join(dir, "reach.png");
    writeFileSync(key, "not a picture");
    writeFileSync(large, Buffer.alloc(IMAGE_BYTES + 1));
    writeFileSync(inside, PNG);
    // A link with a picture's name to a file that has none, and one into the closed folder.
    symlinkSync(key, disguised);
    symlinkSync(inside, reaching);
    for (const file of [key, large, inside, disguised, reaching, "shot.png", ""]) {
      expect(kept.keep(file), file).toBe(false);
      expect(kept.sent(file), file).toBeNull();
      expect(kept.seen(file), file).toBeNull();
    }
    expect(existsSync(kept.dir)).toBe(false);
    // Its own copies are not pictures to copy again.
    const shot = join(dir, "shot.png");
    writeFileSync(shot, PNG);
    expect(kept.keep(shot)).toBe(true);
    expect(kept.keep(join(kept.dir, readdirSync(kept.dir)[0]!))).toBe(false);
    expect(readdirSync(kept.dir)).toHaveLength(1);
  });

  it("a file a step looked at is copied only from a temporary folder: a project's own pictures stay where they are", () => {
    const { dir, kept } = store();
    const shot = join(dir, "screenshot.png"), logo = join(lasting(), "logo.png");
    writeFileSync(shot, PNG);
    writeFileSync(logo, OTHER);
    expect(kept.seen(shot)).toEqual({ type: "image/png", data: PNG });
    expect(kept.seen(logo)).toEqual({ type: "image/png", data: OTHER });
    rmSync(shot);
    rmSync(logo);
    expect(kept.seen(shot)).toEqual({ type: "image/png", data: PNG });
    expect(kept.seen(logo)).toBeNull();
    // One sent with a message is kept wherever its file is: it is what the user said.
    writeFileSync(logo, OTHER);
    expect(kept.sent(logo)).toEqual({ type: "image/png", data: OTHER });
    rmSync(logo);
    expect(kept.sent(logo)).toEqual({ type: "image/png", data: OTHER });
  });

  it("copies do not pile up: past their time they go, then the oldest until the rest fits; a link put among them is not read", async () => {
    let clock = Date.now();
    const dir = scratch();
    const kept = new KeptPictures(join(dir, "home", "sessions", "pictures"), { maxBytes: 2500, maxAgeMs: 24 * 3600_000, now: () => clock });
    const files = ["a.png", "b.png", "c.png"].map((name) => join(dir, name));
    for (const file of files) {
      writeFileSync(file, Buffer.alloc(1000, 7));
      expect(kept.keep(file)).toBe(true);
      await new Promise((r) => setTimeout(r, 15));
    }
    for (const file of files) rmSync(file);
    kept.tidy(true);
    // 3000 bytes held, 2500 allowed: the oldest goes.
    expect(files.map((file) => kept.sent(file) !== null)).toEqual([false, true, true]);
    // A link someone put where a copy would be: not followed, and gone at the next tidying.
    const secret = join(dir, "peers.json");
    writeFileSync(secret, "token");
    const planted = join(dir, "planted.png");
    writeFileSync(planted, PNG);
    expect(kept.keep(planted)).toBe(true);
    const copy = readdirSync(kept.dir).map((name) => join(kept.dir, name)).find((path) => statSync(path).size === PNG.length)!;
    rmSync(planted);
    rmSync(copy);
    symlinkSync(secret, copy);
    expect(kept.sent(planted)).toBeNull();
    kept.tidy(true);
    expect(existsSync(copy)).toBe(false);
    // A day and more later nothing is left.
    clock += 25 * 3600_000;
    kept.tidy(true);
    expect(readdirSync(kept.dir)).toEqual([]);
  });
});

describe("a Codex record read for the picture files it names", () => {
  it("keeps what was sent with a message and what a step looked at in a temporary folder, before anyone opens them", async () => {
    const { dir, kept } = store();
    const pasted = join(dir, "codex-clipboard-a.png"), attached = join(dir, "agentswitch-attach", "t1", "shot.png"), viewed = join(dir, "page.png"), logo = join(lasting(), "logo.png");
    mkdirSync(dirname(attached), { recursive: true });
    for (const file of [pasted, attached, viewed]) writeFileSync(file, PNG);
    writeFileSync(logo, OTHER);
    const record = rollout(dir, [
      line({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: API } }),
      sent(1, "看这两张", pasted, attached, join(dir, "never-there.png")),
      // The same words in what a tool printed are not a picture of the record's.
      item(3, { type: "CommandExecution", id: "c1", command: ["bash", "-lc", "grep local_image ."], aggregated_output: `{"type":"local_image","path":"${logo}"}`, exit_code: 0 }),
      item(5, { type: "ImageView", id: "v1", path: viewed }),
      item(6, { type: "ImageView", id: "v2", path: logo }),
    ]);
    await notice(kept, record);
    for (const file of [pasted, attached, viewed, logo]) rmSync(file);
    rmSync(dirname(attached), { recursive: true });
    expect(kept.sent(pasted)).toEqual({ type: "image/png", data: PNG });
    expect(kept.sent(attached)).toEqual({ type: "image/png", data: PNG });
    expect(kept.seen(viewed)).toEqual({ type: "image/png", data: PNG });
    expect(kept.seen(logo)).toBeNull();
    expect(readdirSync(kept.dir)).toHaveLength(3);
  });

  it("reads only what the record grew by; a line still being written is read once it is whole", async () => {
    const { dir, kept } = store();
    const first = join(dir, "codex-clipboard-1.png"), second = join(dir, "codex-clipboard-2.png"), third = join(dir, "codex-clipboard-3.png");
    for (const file of [first, second, third]) writeFileSync(file, PNG);
    const record = rollout(dir, [line({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: API } }), sent(1, "一", first)]);
    await notice(kept, record);
    expect(readdirSync(kept.dir)).toHaveLength(1);
    // The first one's file goes and its line is not read again: the copy is not asked of the file a second time.
    rmSync(first);
    const whole = sent(2, "二", second), cut = sent(3, "三", third);
    appendFileSync(record, `${whole}\n${cut.slice(0, cut.length - 20)}`);
    await notice(kept, record);
    expect(readdirSync(kept.dir)).toHaveLength(2);
    appendFileSync(record, `${cut.slice(cut.length - 20)}\n`);
    await notice(kept, record);
    expect(readdirSync(kept.dir)).toHaveLength(3);
    for (const file of [second, third]) rmSync(file);
    for (const file of [first, second, third]) expect(kept.sent(file)).toEqual({ type: "image/png", data: PNG });
  });

  it("a record last written long ago is not read whole when it is first met, only what it grows by", async () => {
    const { dir, kept } = store();
    const old = join(dir, "old.png"), fresh = join(dir, "fresh.png");
    for (const file of [old, fresh]) writeFileSync(file, PNG);
    const record = rollout(dir, [line({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: API } }), sent(1, "旧的", old)]);
    const before = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(record, before, before);
    await notice(kept, record);
    expect(existsSync(kept.dir)).toBe(false);
    appendFileSync(record, `${sent(2, "新的", fresh)}\n`);
    await notice(kept, record);
    rmSync(old);
    rmSync(fresh);
    expect(kept.sent(fresh)).toEqual({ type: "image/png", data: PNG });
    expect(kept.sent(old)).toBeNull();
  });
});

describe("over the API", () => {
  function listed(withStore: boolean) {
    const dir = scratch();
    const pasted = join(dir, "codex-clipboard-a.png"), viewed = join(dir, "page.png");
    writeFileSync(pasted, PNG);
    writeFileSync(viewed, OTHER);
    rollout(dir, [
      line({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: API, originator: "codex_cli_rs" } }),
      line({ timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "看这张" }] } }),
      sent(1, "看这张", pasted),
      item(3, { type: "ImageView", id: "v1", path: viewed }),
      item(5, { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "看到了。" }] }),
    ]);
    const kept = withStore ? new KeptPictures(join(dir, "home", "sessions", "pictures")) : undefined;
    const monitor = new SessionMonitor({ claudeProjects: join(dir, "claude"), codexSessions: join(dir, "codex"), opencodeDb: join(dir, "none.db"), excluded: [], ...(kept ? { pictures: kept } : {}) });
    const app = new Hono();
    mountSessions(app, { sessions: monitor } as unknown as ApiDeps);
    return { app, kept, monitor, pasted, viewed };
  }

  it("a Codex message's picture and a step's are still served after their files are gone, though nobody had opened them", async () => {
    const { app, kept, pasted, viewed } = listed(true);
    // A screen reads the list, as every screen does; nothing asks for a picture.
    expect(((await (await app.request("/sessions")).json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(["x1"]);
    await kept!.settled();
    rmSync(pasted);
    rmSync(viewed);
    const items = ((await (await app.request("/sessions/codex/x1/record")).json()) as { items: RecordItem[] }).items;
    const said = items.find((it) => it.type === "user")!, work = items.find((it) => it.type === "work")!;
    expect(said).toMatchObject({ images: 1 });
    const picture = await app.request(`/sessions/codex/x1/images/${said.id}/0`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await picture.arrayBuffer())).toEqual(PNG);
    const shot = await app.request(`/sessions/codex/x1/steps/${work.id}/0/images/0`);
    expect(shot.status).toBe(200);
    expect(Buffer.from(await shot.arrayBuffer())).toEqual(OTHER);
    expect((await app.request(`/sessions/codex/x1/images/${said.id}/1`)).status).toBe(404);
  });

  it("the timer's round keeps them too, with no screen reading anything", async () => {
    const { app, kept, monitor, pasted } = listed(true);
    monitor.keepPictures();
    await kept!.settled();
    rmSync(pasted);
    const said = ((await (await app.request("/sessions/codex/x1/record")).json()) as { items: RecordItem[] }).items.find((it) => it.type === "user")!;
    expect((await app.request(`/sessions/codex/x1/images/${said.id}/0`)).status).toBe(200);
  });

  it("without the store a picture lasts as long as its file, as before", async () => {
    const { app, pasted } = listed(false);
    const said = ((await (await app.request("/sessions/codex/x1/record")).json()) as { items: RecordItem[] }).items.find((it) => it.type === "user")!;
    expect((await app.request(`/sessions/codex/x1/images/${said.id}/0`)).status).toBe(200);
    rmSync(pasted);
    expect((await app.request(`/sessions/codex/x1/images/${said.id}/0`)).status).toBe(404);
  });
});
