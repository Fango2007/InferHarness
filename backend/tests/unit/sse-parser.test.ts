import { describe, expect, it } from 'vitest';

import { parseSseEvents } from '../../src/services/sse-parser.js';

describe('parseSseEvents', () => {
  it('parses data events and end markers', () => {
    const input = 'data: {"id":1}\n\n data: [DONE]\n\n';
    const events = parseSseEvents(input);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ type: 'data' });
  });

  it('parses named multiline events with CRLF and ignores comments', () => {
    const events = parseSseEvents([
      ': keep-alive',
      'event: content_block_delta',
      'data: {"type":"content_block_delta",',
      'data: "index":0}',
      '',
      ''
    ].join('\r\n'));
    expect(events).toEqual([
      {
        type: 'data',
        event: 'content_block_delta',
        payload: '{"type":"content_block_delta",\n"index":0}'
      }
    ]);
  });
});
