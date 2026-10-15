/** What this node lets the nodes paired with it do beyond the remote list's own rules (docs/mesh-v0.md §10): keystrokes
 *  as they are into a terminal, and tool terminals (docs/yazi-v0.md §3). Set on the node itself, like everything a node decides about itself; kept in
 *  `$AGENTSWITCH_HOME/mesh.json`. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MeshSettings = {
  /** A paired node may send keystrokes as they are (`POST /terminals/:id/write`): what a real terminal screen types
   *  with. Off, a paired node has the reply box and the named keys, as a phone does. */
  readonly keyboard: boolean;
  /** A paired node (not a phone) may open a tool terminal (yazi) beside a terminal here, and see and use the ones open
   *  (docs/yazi-v0.md §3). Off by default: yazi runs shell commands, and nothing asks first. */
  readonly files: boolean;
};

export const DEFAULT_MESH: MeshSettings = { keyboard: true, files: false };
const FILE = "mesh.json";

/** Read once per home and kept: only this process writes the file, and every keystroke of a paired node asks. */
const known = new Map<string, MeshSettings>();

export function loadMesh(home: string): MeshSettings {
  const have = known.get(home);
  if (have) return have;
  const path = join(home, FILE);
  let settings = DEFAULT_MESH;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { keyboard?: unknown; files?: unknown };
      settings = {
        keyboard: typeof parsed.keyboard === "boolean" ? parsed.keyboard : DEFAULT_MESH.keyboard,
        files: typeof parsed.files === "boolean" ? parsed.files : DEFAULT_MESH.files,
      };
    } catch { /* an unreadable file is the default */ }
  }
  known.set(home, settings);
  return settings;
}

export function saveMesh(home: string, settings: MeshSettings): void {
  const path = join(home, FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  known.set(home, settings);
}
