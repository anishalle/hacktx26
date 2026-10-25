import { readSse, SseParser } from '../sse';

describe('SseParser', () => {
  it('parses named events with JSON data', () => {
    const p = new SseParser();
    const out = p.feed('event: meta\ndata: {"unread_count":1204}\n\nevent: done\ndata: {}\n\n');
    expect(out).toEqual([
      { event: 'meta', data: '{"unread_count":1204}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('handles frames split at arbitrary byte boundaries', () => {
    const input = 'event: bullet\ndata: {"text":"hi"}\n\nevent: term\ndata: {"term":"Grandma"}\n\n';
    for (let cut = 1; cut < input.length; cut++) {
      const p = new SseParser();
      const out = [...p.feed(input.slice(0, cut)), ...p.feed(input.slice(cut)), ...p.end()];
      expect(out.map((e) => e.event)).toEqual(['bullet', 'term']);
      expect(out[1].data).toBe('{"term":"Grandma"}');
    }
  });

  it('supports CRLF and CR line endings, including CRLF split across chunks', () => {
    const p = new SseParser();
    const out = [...p.feed('event: a\r'), ...p.feed('\ndata: 1\r\n\r'), ...p.feed('\nevent: b\rdata: 2\r\r'), ...p.end()];
    expect(out).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('joins multi-line data, ignores comments and defaults the event name', () => {
    const p = new SseParser();
    const out = p.feed(': keep-alive\ndata: line one\ndata: line two\nretry: 100\n\n');
    expect(out).toEqual([{ event: 'message', data: 'line one\nline two' }]);
  });

  it('ignores events with no data and resets the event name between events', () => {
    const p = new SseParser();
    const out = p.feed('event: ghost\n\ndata: x\n\n');
    expect(out).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('strips only one leading space from values and keeps colons in data', () => {
    const p = new SseParser();
    const out = p.feed('data:  two spaces: yes\n\ndata:nospace\n\n');
    expect(out.map((e) => e.data)).toEqual([' two spaces: yes', 'nospace']);
  });

  it('flushes a trailing event without a blank line at end of stream', () => {
    const p = new SseParser();
    expect(p.feed('event: done\ndata: {"elapsed_ms":5}')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'done', data: '{"elapsed_ms":5}' }]);
  });
});

describe('readSse', () => {
  function streamOf(chunks: string[]) {
    const enc = new TextEncoder();
    let i = 0;
    return {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
        cancel: async () => {},
      }),
    };
  }

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"“Grandma” 🏐"}\n\n');
    // Split in the middle of the emoji's 4-byte sequence.
    const cut = bytes.length - 6;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    };
    const out = [];
    for await (const m of readSse(body)) out.push(m);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].data).text).toBe('“Grandma” 🏐');
  });

  it('yields events from a chunked stream in order', async () => {
    const out = [];
    for await (const m of readSse(streamOf(['event: meta\nda', 'ta: 1\n\nevent: done\n', 'data: 2\n\n']))) out.push(m);
    expect(out).toEqual([
      { event: 'meta', data: '1' },
      { event: 'done', data: '2' },
    ]);
  });
});
