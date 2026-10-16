// The made-up Mac the Files demo shows (docs/files-v0.md §8): a home folder, two projects with a terminal each, and a
// few files of every kind the preview handles. Nothing here is the user's: names, paths and contents are invented.
(() => {
const HOME = "/Users/you";

const APP_TS = `import { createStore } from "./store";
import { List } from "./components/List";

// The list, most recently used first; pinned rows stay on top.
export function mountApp(root: HTMLElement) {
  const store = createStore();
  const list = new List(root, {
    rows: () => store.sorted(),
    onOpen: (row) => store.touch(row.id),
  });
  store.subscribe(() => list.render());
  list.render();
  return () => list.dispose();
}
`;
const STORE_TS = `export type Row = { id: string; name: string; pinned: boolean; usedAt: number | null };

export function createStore(rows: Row[] = []) {
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((f) => f());
  return {
    sorted(): Row[] {
      return [...rows].sort((a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.usedAt ?? -1) - (a.usedAt ?? -1) ||
        a.name.localeCompare(b.name));
    },
    touch(id: string) {
      const row = rows.find((r) => r.id === id);
      if (row) { row.usedAt = Date.now(); changed(); }
    },
    subscribe(f: () => void) { listeners.add(f); return () => listeners.delete(f); },
  };
}
`;
const MAIN_TS = `import { mountApp } from "./app";

const root = document.getElementById("app");
if (root) mountApp(root);
`;
const LIST_TSX = `import type { Row } from "../store";

type Props = { rows: () => Row[]; onOpen: (row: Row) => void };

export class List {
  constructor(private root: HTMLElement, private props: Props) {}
  render() {
    this.root.replaceChildren(...this.props.rows().map((row) => {
      const li = document.createElement("li");
      li.textContent = row.pinned ? "📌 " + row.name : row.name;
      li.onclick = () => this.props.onOpen(row);
      return li;
    }));
  }
  dispose() { this.root.replaceChildren(); }
}
`;
const BUTTON_TSX = `export function Button(label: string, onClick: () => void) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
`;
const TEST_TS = `import { describe, expect, it } from "vitest";
import { createStore } from "../src/store";

describe("sorted", () => {
  it("puts pinned rows first, then the most recently used", () => {
    const s = createStore([
      { id: "a", name: "Alpha", pinned: false, usedAt: 10 },
      { id: "b", name: "Beta", pinned: true, usedAt: null },
      { id: "c", name: "Gamma", pinned: false, usedAt: 20 },
    ]);
    expect(s.sorted().map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});
`;
const README = `# lumen

A small list app: rows you used last come first, pinned rows stay on top.

## Run

    npm install
    npm run dev

## Layout

- \`src/store.ts\` — the rows and their order
- \`src/components/\` — what draws them
- \`docs/design.md\` — the rules the order follows
`;
const DESIGN_MD = `# 排序规则

1. 置顶的行在最前，置顶之间保持原来的相对顺序。
2. 其余的行按最近一次使用的时间，从新到旧。
3. 从没用过的排在最后，按名字。

排序放在模型里做，界面只读结果；列表、搜索和快捷键用的是同一份顺序。
`;
const PKG = `{
  "name": "lumen",
  "version": "0.4.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vite": "^7.1.0",
    "vitest": "^3.2.0"
  }
}
`;
const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
`;
const ENV = `PORT=5173
API_BASE=http://127.0.0.1:8080
`;
const AUTH_TS = `import { Router } from "./router";
import { issueTokens } from "../tokens";

export const auth = new Router();

auth.post("/api/login", async (req, res) => {
  const user = await req.app.users.check(req.body.name, req.body.password);
  if (!user) return res.status(401).json({ error: "bad credentials" });
  const { accessToken, refreshToken, expiresIn } = issueTokens(user);
  res.json({ accessToken, refreshToken, expiresIn });
});
`;
const FILES_TS = `import { Router } from "./router";

export const files = new Router();

files.get("/api/files/:id", async (req, res) => {
  const file = await req.app.db.file(req.params.id);
  return file ? res.json(file) : res.status(404).end();
});
`;
const DB_TS = `import { open } from "./sqlite";

export const db = open(process.env.DB_PATH ?? "harbor.db");
`;
const SERVER_TS = `import { createServer } from "node:http";
import { auth } from "./routes/auth";
import { files } from "./routes/files";

createServer((req, res) => auth.handle(req, res) || files.handle(req, res))
  .listen(Number(process.env.PORT ?? 8080));
`;
const SQL = `create table users (
  id integer primary key,
  name text not null unique,
  password_hash text not null
);
`;
const LOG = Array.from({ length: 40 }, (_, i) => `2026-10-16T13:${String(10 + Math.floor(i / 3)).padStart(2, "0")}:${String((i * 17) % 60).padStart(2, "0")}Z info  GET /api/files/${1000 + i} 200 ${4 + (i % 9)}ms`).join("\n") + "\n";
const NOTES = `# 十月

- 把 lumen 的排序改完
- harbor-api 的登录返回加 refreshToken
- 周五前整理一下 docs/
`;
const HARBOR_README = `# harbor-api

An HTTP service for the lumen app: sign-in and files.
`;
const ZSHRC = `export PATH="$HOME/.local/bin:$PATH"
alias gs="git status -sb"
`;

// d(name, children, extra) a folder; f(name, size, mtime, type, text, extra) a file.
const d = (name, children = [], x = {}) => ({ name, kind: "dir", children, ...x });
const f = (name, size, mtime, type, text = null, x = {}) => ({ name, kind: "file", size, mtime, type, text, ...x });
const ln = (name, target, x = {}) => ({ name, kind: "link", target, ...x });

const root = d("you", [
  d(".agentswitch", [
    d("nodes", [], { locked: true }),
    f("local-token", 64, "10/02", "binary", null, { locked: true }),
    d("terminals", [d("5a5a22a0", [f("settings.json", 2400, "Today 12:40", "text", "{ … }")])], { mtime: "Today 12:40" }),
    f("agentswitch.db", 18_400_000, "Today 13:04", "binary"),
  ], { hidden: true, mtime: "Today 13:04" }),
  d(".secret-gate", [], { hidden: true, locked: true }),
  d(".ssh", [f("config", 320, "8/21", "text", "Host github.com\n  IdentityFile ~/.ssh/id_ed25519\n")], { hidden: true, mtime: "8/21" }),
  f(".zshrc", 640, "9/30", "text", ZSHRC, { hidden: true }),
  d("Desktop", [f("screenshot.png", 412_000, "Today 11:20", "image", null, { pic: "shot" })], { mtime: "Today 11:20" }),
  d("Documents", [f("plan.pdf", 1_240_000, "10/12", "pdf", null, { pages: 6 })], { mtime: "10/12" }),
  d("Downloads", [f("dataset.zip", 182_000_000, "10/09", "archive")], { mtime: "10/09" }),
  d("Projects", [
    ln("current", `${HOME}/Projects/lumen`, { mtime: "10/14" }),
    d("harbor-api", [
      d(".git", [], { hidden: true, dim: true, mtime: "Today 12:58" }),
      d("logs", [f("server.log", 48_200_000, "Today 13:05", "text", LOG, { truncated: true, lines: "612,480" })], { mtime: "Today 13:05" }),
      d("migrations", [f("001_init.sql", 180, "9/22", "text", SQL)], { mtime: "9/22" }),
      d("node_modules", [], { dim: true, mtime: "10/01" }),
      d("src", [
        d("routes", [f("auth.ts", 420, "Today 12:58", "text", AUTH_TS, { lang: "TypeScript" }), f("files.ts", 260, "10/11", "text", FILES_TS, { lang: "TypeScript" })], { mtime: "Today 12:58" }),
        f("db.ts", 96, "9/22", "text", DB_TS, { lang: "TypeScript" }),
        f("server.ts", 230, "10/11", "text", SERVER_TS, { lang: "TypeScript" }),
      ], { mtime: "Today 12:58" }),
      f("package.json", 410, "10/01", "text", PKG.replace(/lumen/g, "harbor-api"), { lang: "JSON" }),
      f("README.md", 62, "9/22", "text", HARBOR_README, { lang: "Markdown" }),
    ], { mtime: "Today 12:58" }),
    d("lumen", [
      f(".env", 48, "10/02", "text", ENV, { hidden: true }),
      d(".git", [], { hidden: true, dim: true, mtime: "Today 13:02" }),
      d("docs", [f("design.md", 380, "10/14", "text", DESIGN_MD, { lang: "Markdown" }), f("logo.png", 24_600, "10/03", "image", null, { pic: "logo" })], { mtime: "10/14" }),
      d("node_modules", [], { dim: true, mtime: "10/14" }),
      d("src", [
        d("components", [f("Button.tsx", 180, "9/29", "text", BUTTON_TSX, { lang: "TypeScript JSX" }), f("List.tsx", 560, "Today 13:01", "text", LIST_TSX, { lang: "TypeScript JSX" })], { mtime: "Today 13:01" }),
        f("app.ts", 2_140, "Today 13:02", "text", APP_TS, { lang: "TypeScript" }),
        f("main.ts", 120, "10/02", "text", MAIN_TS, { lang: "TypeScript" }),
        f("store.ts", 3_980, "Today 13:02", "text", STORE_TS, { lang: "TypeScript" }),
      ], { mtime: "Today 13:02" }),
      d("tests", [f("app.test.ts", 640, "Today 13:01", "text", TEST_TS, { lang: "TypeScript" })], { mtime: "Today 13:01" }),
      f("package.json", 410, "10/01", "text", PKG, { lang: "JSON" }),
      f("README.md", 520, "10/14", "text", README, { lang: "Markdown" }),
      f("tsconfig.json", 210, "9/29", "text", TSCONFIG, { lang: "JSON" }),
    ], { mtime: "Today 13:02" }),
    d("notes", [f("2026-10.md", 140, "Yesterday", "text", NOTES, { lang: "Markdown" })], { mtime: "Yesterday" }),
  ], { mtime: "Today 13:05" }),
], { mtime: "Today 13:05" });

// The folders above home, as far as the demo goes: `/`, `/Users`.
const ABOVE = { "/": ["Applications", "Library", "System", "Users"], "/Users": ["Shared", "you"] };

// The terminals' list on the left (docs/terminal-v0.md §1): folders of the same parent merged, terminals and sessions.
const LIST = [
  { cwd: `${HOME}/Projects/lumen`, short: "~/Projects/lumen", git: "main ±2", rows: [
    { kind: "term", id: "t1", n: "01", name: "排序改成最近使用", ag: "cc", st: "busy", workdir: `${HOME}/Projects/lumen` },
    { kind: "session", name: "列表的空状态", ag: "cc", at: "2d" },
  ] },
  { cwd: `${HOME}/Projects/harbor-api`, short: "~/Projects/harbor-api", git: "auth ±1", rows: [
    { kind: "term", id: "t2", n: "02", name: "refreshToken 字段", ag: "codex", st: "idle", workdir: `${HOME}/Projects/harbor-api/src` },
    { kind: "session", name: "文件接口的分页", ag: "codex", at: "5d" },
  ] },
  { cwd: `${HOME}/Projects/notes`, short: "~/Projects/notes", git: "", rows: [
    { kind: "session", name: "十月的计划", ag: "pi", at: "6d" },
  ] },
];

window.FILES_DATA = { HOME, root, ABOVE, LIST };
})();
