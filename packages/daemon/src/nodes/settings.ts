/** What this node lets the nodes paired with it do beyond the remote list's own rules (docs/mesh-v0.md §10): keystrokes
 *  as they are into a terminal. Set on the node itself, like everything a node decides about itself; kept in
 *  `$AGENTSWITCH_HOME/mesh.json`. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MeshSettings = {
  /** A paired node may send keystrokes as they are (`POST /terminals/:id/write`): what a real terminal screen types
   *  with. Off, a paired node has the reply box and the named keys, as a phone does. */
  readonly keyboard: boolean;
};

export const DEFAULT_MESH: MeshSettings = { keyboard: true };
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
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { keyboard?: unknown };
      settings = { keyboard: typeof parsed.keyboard === "boolean" ? parsed.keyboard : DEFAULT_MESH.keyboard };
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
