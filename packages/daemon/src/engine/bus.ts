/** In-process fan-out of task events to live SSE subscribers. Persistence is the store's job. */

import { EventEmitter } from "node:events";
import type { TaskEvent } from "./types.js";
import type { Writing } from "../core/writing.js";

/** SSE subscribers plus internal listeners; far above normal use, so a leak still warns. */
const MAX_LISTENERS = 1000;

export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(MAX_LISTENERS);
  }

  publish(event: TaskEvent): void {
    this.emitter.emit(event.taskId, event);
    this.emitter.emit("*", event);
  }

  /** Returns an unsubscribe function. */
  subscribe(taskId: string | "*", listener: (event: TaskEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }

  // ---- what a task's run is writing (docs/simple-view-v0.md §5.14): sent on, never stored, no sequence number; the
  // latest kept for a stream that joins while it is written. Apart from the events: nothing that reads every event
  // (reports, the scheduler) sees it.
  private readonly writer = new EventEmitter().setMaxListeners(MAX_LISTENERS);
  private readonly writings = new Map<string, Writing>();

  publishWriting(taskId: string, writing: Writing | null): void {
    if (writing) this.writings.set(taskId, writing);
    else if (!this.writings.delete(taskId)) return;
    this.writer.emit(taskId, writing);
  }

  writingOf(taskId: string): Writing | null { return this.writings.get(taskId) ?? null; }

  subscribeWriting(taskId: string, listener: (writing: Writing | null) => void): () => void {
    this.writer.on(taskId, listener);
    return () => this.writer.off(taskId, listener);
  }
}
