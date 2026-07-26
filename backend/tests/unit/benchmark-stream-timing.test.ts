import fs from 'fs';

import { describe, expect, it } from 'vitest';

import {
  createStreamTimingTracker,
  type StreamTimingTelemetry
} from '../../src/services/benchmark-stream-timing.js';
import type { ProviderProtocol } from '../../src/services/benchmark-metric-observations.js';

function streamFixture(name: string): string {
  return fs.readFileSync(new URL(`../fixtures/streams/${name}`, import.meta.url), 'utf8');
}

function track(
  protocol: ProviderProtocol,
  chunks: Array<{ text: string; at: number }>
): StreamTimingTelemetry {
  const tracker = createStreamTimingTracker(protocol, 0);
  for (const chunk of chunks) tracker.push(chunk.text, chunk.at);
  tracker.finish(chunks.at(-1)?.at ?? 0);
  return tracker.snapshot();
}

describe('semantic stream timing', () => {
  it.each([
    {
      protocol: 'openai_chat' as const,
      stream: [
        ': keep-alive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n'
      ]
    },
    {
      protocol: 'ollama_chat' as const,
      stream: [
        '{"message":{"role":"assistant","content":""},"done":false}\n',
        '{"message":{"content":"answer"},"done":false}\n',
        '{"done":true,"eval_count":1}\n'
      ]
    },
    {
      protocol: 'anthropic_messages' as const,
      stream: [
        'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]
    },
    {
      protocol: 'gemini_generate_content' as const,
      stream: [
        'data: {"usageMetadata":{"promptTokenCount":1}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}\n\n'
      ]
    }
  ])('ignores metadata and timestamps meaningful $protocol output', ({ protocol, stream }) => {
    const timing = track(protocol, stream.map((text, index) => ({ text, at: 10 + index * 10 })));

    expect(timing.first_output_at_ms).toBe(20 + (protocol === 'anthropic_messages' ? 10 : 0));
    expect(timing.last_output_at_ms).toBe(timing.first_output_at_ms);
    expect(timing.first_tool_call_at_ms).toBeNull();
    expect(timing.tool_calls_ready_at_ms).toBeNull();
  });

  it.each([
    ['openai_chat', 'openai-tool.sse'],
    ['ollama_chat', 'ollama-tool.jsonl'],
    ['anthropic_messages', 'anthropic-tool.sse'],
    ['gemini_generate_content', 'gemini-tool.sse']
  ] as const)('tracks first and ready tool timing for %s', (protocol, fixture) => {
    const timing = track(protocol, [
      { text: streamFixture(fixture), at: 50 }
    ]);

    expect(timing).toMatchObject({
      first_output_at_ms: 50,
      first_tool_call_at_ms: 50,
      tool_calls_ready_at_ms: 50,
      last_output_at_ms: 50,
      tool_call_started: true,
      tool_call_error: null
    });
  });

  it('waits for a fragmented SSE frame before marking output', () => {
    const timing = track('openai_chat', [
      { text: 'data: {"choices":[{"delta":{"content":"hel', at: 10 },
      { text: 'lo"}}]}\n\ndata: [DONE]\n\n', at: 25 }
    ]);

    expect(timing.first_output_at_ms).toBe(25);
    expect(timing.last_output_at_ms).toBe(25);
  });

  it('assigns one receipt time to multiple events in the same transport chunk', () => {
    const timing = track('openai_chat', [{
      text: [
        'data: {"choices":[{"delta":{"content":"a"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"b"}}]}',
        '',
        'data: [DONE]',
        ''
      ].join('\n'),
      at: 35
    }]);

    expect(timing.first_output_at_ms).toBe(35);
    expect(timing.last_output_at_ms).toBe(35);
  });

  it('preserves whitespace as model output while ignoring empty content', () => {
    const timing = track('openai_chat', [
      { text: 'data: {"choices":[{"delta":{"content":""}}]}\n\n', at: 10 },
      { text: 'data: {"choices":[{"delta":{"content":" "}}]}\n\n', at: 20 },
      { text: 'data: [DONE]\n\n', at: 30 }
    ]);

    expect(timing.first_output_at_ms).toBe(20);
  });

  it('handles decoded UTF-8 split across byte chunks without early output', () => {
    const tracker = createStreamTimingTracker('openai_chat', 0);
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"café"}}]}\n\ndata: [DONE]\n\n'
    );
    const split = bytes.indexOf(0xc3) + 1;
    const decoder = new TextDecoder();
    tracker.push(decoder.decode(bytes.slice(0, split), { stream: true }), 10);
    tracker.push(decoder.decode(bytes.slice(split), { stream: true }), 20);
    tracker.push(decoder.decode(), 20);
    tracker.finish(20);

    expect(tracker.snapshot().first_output_at_ms).toBe(20);
  });

  it.each([
    {
      protocol: 'openai_chat' as const,
      stream: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{"}}]}}]}',
        '',
        'data: [DONE]',
        ''
      ].join('\n')
    },
    {
      protocol: 'ollama_chat' as const,
      stream: [
        '{"message":{"tool_calls":[{"function":{"arguments":{"city":"Paris"}}}]},"done":false}',
        '{"done":true}',
        ''
      ].join('\n')
    },
    {
      protocol: 'anthropic_messages' as const,
      stream: [
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"lookup","input":{}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        ''
      ].join('\n')
    },
    {
      protocol: 'gemini_generate_content' as const,
      stream: 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"city":"Paris"}}}]}}]}\n\n'
    }
  ])('does not mark a malformed $protocol tool call ready', ({ protocol, stream }) => {
    const timing = track(protocol, [{ text: stream, at: 40 }]);

    expect(timing.tool_call_started).toBe(true);
    expect(timing.tool_calls_ready_at_ms).toBeNull();
    expect(timing.tool_call_error).toMatch(/complete and parseable/);
  });

  it('retains the final meaningful output timestamp before terminal metadata', () => {
    const timing = track('ollama_chat', [
      { text: '{"message":{"content":"first"},"done":false}\n', at: 10 },
      { text: '{"message":{"content":"last"},"done":false}\n', at: 30 },
      { text: '{"done":true,"eval_count":2}\n', at: 50 }
    ]);

    expect(timing.first_output_at_ms).toBe(10);
    expect(timing.last_output_at_ms).toBe(30);
  });
});
