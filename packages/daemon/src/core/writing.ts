/** What an agent is writing at the moment (docs/simple-view-v0.md §5.14): the text of the part of its answer it is
 *  writing — its whole text so far, not the last piece, so a screen that misses one still shows the rest — and whether
 *  it is what it thinks on the way. Shown while it is written and dropped once the whole answer is in the record (or
 *  the task's events): it is never stored. */
export type Writing = { readonly text: string; readonly thinking?: boolean };

/** How often what is being written is sent on at most: an answer comes in tens or hundreds of pieces. */
export const WRITING_MS = 150;

/** Sends what is being written, at most every `ms`: the latest text, and `null` (nothing is being written) at once. */
export class WritingFeed {
  private latest: Writing | null = null;
  private sent: Writing | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;

  constructor(private readonly send: (writing: Writing | null) => void, private readonly ms = WRITING_MS, private readonly now: () => number = Date.now) {}

  /** The part being written is this now. */
  set(writing: Writing): void {
    this.latest = writing;
    if (this.timer) return;
    const wait = this.last + this.ms - this.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
  }

  /** Nothing is being written (the part is done and is in the record, the turn ended): said at once. */
  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.latest = null;
    if (this.sent === null) return;
    this.sent = null;
    this.send(null);
  }

  private flush(): void {
    const w = this.latest;
    if (!w || (this.sent && this.sent.text === w.text && !!this.sent.thinking === !!w.thinking)) return;
    this.last = this.now();
    this.sent = w;
    this.send(w);
  }
}

/** The text of the part being written, from its pieces as they come: a new part (another block, another message)
 *  starts again. */
export class WritingText {
  private key: string | null = null;
  private text = "";
  private thinking = false;

  /** A piece of part `key`; the part's whole text so far. */
  add(key: string, piece: string, thinking = false): Writing {
    if (key !== this.key || thinking !== this.thinking) { this.key = key; this.text = ""; this.thinking = thinking; }
    this.text += piece;
    return thinking ? { text: this.text, thinking: true } : { text: this.text };
  }

  reset(): void { this.key = null; this.text = ""; this.thinking = false; }
}
