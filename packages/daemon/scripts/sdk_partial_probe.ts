/** What Dispatch's Claude Code runs give while an answer is written (docs/simple-view-v0.md §5.14): the Agent SDK as the
 *  executor runs it (src/executors/claude.ts), once with `includePartialMessages: false` (what the executor has) and
 *  once with `true` — how many pieces of the answer come before the whole of it, and when. A real model turn each, the
 *  cheapest model, no tools, no session kept (`persistSession: false`) — a probe, not a test.
 *
 *    node --import tsx scripts/sdk_partial_probe.ts */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const ASK = "用中文写一段大约 300 字的说明：终端怎样把字画到屏幕上。不要用任何工具，直接写。";
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(AGENTSWITCH_|SECRET_GATE_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/.test(k))) as Record<string, string>;
const cwd = mkdtempSync(join(tmpdir(), "as-sdk-partial-"));

try {
  for (const partial of [false, true]) {
    const t0 = Date.now();
    const kinds = new Map<string, number>();
    let pieces = 0, pieceChars = 0, firstPiece = 0, lastPiece = 0, whole = 0, wholeChars = 0, result = "";
    for await (const msg of query({ prompt: ASK, options: {
      cwd, model: "haiku", includePartialMessages: partial, persistSession: false, settingSources: [], maxTurns: 1, env,
      canUseTool: async () => ({ behavior: "deny", message: "no tools in this probe" }),
    } })) {
      const m = msg as SDKMessage & { event?: { type?: string; delta?: { type?: string; text?: string } } };
      const kind = m.type === "stream_event" ? `stream_event:${m.event?.type}` : m.type;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
        pieces += 1; pieceChars += (m.event.delta.text ?? "").length;
        lastPiece = Date.now() - t0; firstPiece ||= lastPiece;
      }
      if (m.type === "assistant") {
        const text = (m.message.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
        if (text) { whole = Date.now() - t0; wholeChars = text.length; }
      }
      if (m.type === "result") result = `${m.subtype}${"result" in m ? `, ${String(m.result).length} characters` : ""}`;
    }
    console.log(`includePartialMessages: ${partial}`);
    console.log(`  messages: ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
    console.log(`  pieces of the answer: ${pieces} (${pieceChars} characters)${pieces ? `, from ${(firstPiece / 1000).toFixed(2)} s to ${(lastPiece / 1000).toFixed(2)} s` : ""}`);
    console.log(`  the whole answer (assistant message): at ${(whole / 1000).toFixed(2)} s, ${wholeChars} characters; result: ${result}`);
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
