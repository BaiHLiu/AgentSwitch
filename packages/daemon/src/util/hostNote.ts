/** What the models are told about the machine they work on. Their instructions were written on a Mac and say "the
 *  Mac"; on any other machine one paragraph says what it is instead (mesh-v0 §4.4 文案). */

import { homedir } from "node:os";

/** Empty on macOS; elsewhere a paragraph that maps "the Mac" onto this machine. */
export function hostNote(platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return "";
  const os = platform === "linux" ? "Linux" : platform;
  return `This machine: where these instructions say "the Mac" or "this Mac", read "this machine". It runs ${os}, not ` +
    `macOS; the user's home folder is ${home}. There is no Finder, \`open\`, ~/Library or /Users here: open files and ` +
    `addresses with \`xdg-open\` only when a person at this machine is to see them, and look for the user's files under ${home}.`;
}

/** `text` with the host note after it, or `text` alone on macOS. */
export const withHostNote = (text: string): string => { const note = hostNote(); return note ? `${text}\n\n${note}` : text; };
