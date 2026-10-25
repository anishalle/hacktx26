// Minimal incremental Server-Sent Events parser (WHATWG "event stream" format).
// Feed it decoded text as it arrives; it returns every complete event.

export type SseMessage = { event: string; data: string; id?: string };

export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private lastId: string | undefined;

  /** Push a chunk of decoded text. Returns events completed by this chunk. */
  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing \r might be the first half of \r\n split across chunks: wait for more.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      this.processLine(this.buffer.slice(start, i), out);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Flush at end of stream. Dispatches a final event even if the server omitted the blank line. */
  end(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buffer.length) {
      const rest = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      this.processLine(rest, out);
    }
    this.dispatch(out);
    return out;
  }

  private processLine(line: string, out: SseMessage[]) {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    let field = line;
    let value = '';
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        break; // `retry` and unknown fields are ignored
    }
  }

  private dispatch(out: SseMessage[]) {
    if (this.dataLines.length === 0) {
      this.eventName = '';
      return;
    }
    out.push({
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      ...(this.lastId !== undefined ? { id: this.lastId } : {}),
    });
    this.eventName = '';
    this.dataLines = [];
  }
}

type ByteReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };

/** Reads a byte stream and yields parsed SSE messages until the stream ends or `signal` aborts. */
export async function* readSse(
  body: { getReader(): ByteReader },
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        for (const msg of parser.feed(decoder.decode(value, { stream: true }))) yield msg;
      }
    }
    for (const msg of parser.feed(decoder.decode())) yield msg;
    for (const msg of parser.end()) yield msg;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
