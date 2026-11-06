// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * SSE reading (design 6.2): parse line by line, support half lines across chunks; multi-line data is joined with \n as the specification says.
 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  const flushEvent = function* (): Generator<string> {
    if (data.length) {
      yield data.join('\n');
      data = [];
    }
  };
  const handleLine = function* (line: string): Generator<string> {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      yield* flushEvent();
      return;
    }
    if (line.startsWith(':')) return; // Comment / heartbeat
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      yield* handleLine(line);
    }
  }
  buf += decoder.decode();
  if (buf) yield* handleLine(buf);
  yield* flushEvent();
}
