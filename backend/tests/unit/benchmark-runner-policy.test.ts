import fs from 'fs';

import { describe, expect, it } from 'vitest';

import {
  BenchmarkStreamParseError,
  BenchmarkUpstreamStreamError,
  buildBenchmarkRequestPayload,
  isRetryableError,
  parseAnthropicSseStream,
  parseExecutionPolicy,
  parseGeminiSseStream,
  parseOllamaJsonlStream,
  parseOpenAiSseStream,
  retryDelayMs
} from '../../src/services/benchmark-runner.js';

function streamFixture(name: string): string {
  return fs.readFileSync(new URL(`../fixtures/streams/${name}`, import.meta.url), 'utf8');
}

describe('benchmark runner execution policy', () => {
  it('parses retry and cancellation defaults', () => {
    const policy = parseExecutionPolicy({});
    expect(policy.retry).toEqual({
      max_retries: 0,
      retry_on: [],
      backoff: 'none',
      base_delay_ms: 0,
      max_delay_ms: 0
    });
    expect(policy.cancellation.persist_partial_results).toBe(true);
    expect(policy.cancellation.max_consecutive_errors).toBeNull();
  });

  it('classifies only configured retryable errors', () => {
    const policy = parseExecutionPolicy({
      execution_policy: {
        retry_policy: { max_retries: 2, retry_on: ['http_503', 'timeout', 'connection_error'] }
      }
    }).retry;
    expect(isRetryableError('http_503', policy)).toBe(true);
    expect(isRetryableError('timeout', policy)).toBe(true);
    expect(isRetryableError('connection_error', policy)).toBe(true);
    expect(isRetryableError('http_400', policy)).toBe(false);
  });

  it('calculates fixed, linear, exponential, and capped backoff', () => {
    expect(retryDelayMs({ max_retries: 2, retry_on: [], backoff: 'none', base_delay_ms: 100, max_delay_ms: 1000 }, 2)).toBe(0);
    expect(retryDelayMs({ max_retries: 2, retry_on: [], backoff: 'fixed', base_delay_ms: 100, max_delay_ms: 1000 }, 2)).toBe(100);
    expect(retryDelayMs({ max_retries: 2, retry_on: [], backoff: 'linear', base_delay_ms: 100, max_delay_ms: 1000 }, 3)).toBe(300);
    expect(retryDelayMs({ max_retries: 2, retry_on: [], backoff: 'exponential', base_delay_ms: 100, max_delay_ms: 250 }, 3)).toBe(250);
  });

  it('combines OpenAI SSE deltas and [DONE] into a normalized stream', () => {
    const stream = parseOpenAiSseStream([
      'data: {"choices":[{"delta":{"content":"bench"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"mark"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n'));
    expect(stream.answer_text).toBe('benchmark');
    expect(stream.done).toBe(true);
    expect(stream.total_tokens).toBe(5);
    expect(stream.events[2]).toMatchObject({ raw: '[DONE]', done: true });
  });

  it('keeps whitespace deltas and reads final OpenAI usage chunks without content', () => {
    const stream = parseOpenAiSseStream([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":" "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      '',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n'));
    expect(stream.answer_text).toBe('hello world');
    expect(stream.done).toBe(true);
    expect(stream.input_tokens).toBe(4);
    expect(stream.output_tokens).toBe(3);
    expect(stream.total_tokens).toBe(7);
  });

  it('combines Ollama JSONL message chunks and final token metadata', () => {
    const stream = parseOllamaJsonlStream([
      JSON.stringify({ message: { content: 'bench' }, done: false }),
      JSON.stringify({ message: { content: 'mark' }, done: false }),
      JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 2 })
    ].join('\n'));
    expect(stream.answer_text).toBe('benchmark');
    expect(stream.done).toBe(true);
    expect(stream.input_tokens).toBe(4);
    expect(stream.output_tokens).toBe(2);
    expect(stream.total_tokens).toBe(6);
  });

  it('normalizes streamed tool calls across supported protocols', () => {
    const streams = [
      parseOpenAiSseStream(streamFixture('openai-tool.sse')),
      parseOllamaJsonlStream(streamFixture('ollama-tool.jsonl')),
      parseAnthropicSseStream(streamFixture('anthropic-tool.sse')),
      parseGeminiSseStream(streamFixture('gemini-tool.sse'))
    ];
    for (const stream of streams) {
      expect(stream.tool_calls?.[0]).toMatchObject({
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: { city: 'Paris', unit: 'celsius' }
        }
      });
      expect(stream.done).toBe(true);
      expect(stream.total_tokens).toBeGreaterThan(0);
    }
  });

  it('preserves Anthropic event names and rejects provider stream errors', () => {
    const stream = parseAnthropicSseStream(streamFixture('anthropic-tool.sse'));
    expect(stream.events[0]).toMatchObject({ event_name: 'message_start' });
    expect(() => parseAnthropicSseStream(streamFixture('anthropic-error.sse')))
      .toThrow(BenchmarkUpstreamStreamError);
  });

  it('normalizes native text streams and retains unknown valid Anthropic events', () => {
    const anthropic = parseAnthropicSseStream(streamFixture('anthropic-text.sse'));
    const gemini = parseGeminiSseStream(streamFixture('gemini-text.sse'));
    expect(anthropic.answer_text).toBe('benchmark answer');
    expect(anthropic.events).toContainEqual(expect.objectContaining({ event_name: 'ping' }));
    expect(gemini.answer_text).toBe('benchmark answer');
    expect(gemini.total_tokens).toBe(7);
  });

  it('rejects incomplete Anthropic tool arguments', () => {
    const malformed = streamFixture('anthropic-tool.sse')
      .replace('is\\",\\"unit\\":\\"celsius\\"}', 'is');
    expect(() => parseAnthropicSseStream(malformed)).toThrow(BenchmarkStreamParseError);
  });

  it('keeps whitespace-only Ollama chunks', () => {
    const stream = parseOllamaJsonlStream([
      JSON.stringify({ message: { content: 'hello' }, done: false }),
      JSON.stringify({ message: { content: ' ' }, done: false }),
      JSON.stringify({ message: { content: 'world' }, done: false }),
      JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 3 })
    ].join('\n'));
    expect(stream.answer_text).toBe('hello world');
    expect(stream.done).toBe(true);
    expect(stream.total_tokens).toBe(7);
  });

  it('reports malformed stream chunks clearly', () => {
    expect(() => parseOpenAiSseStream('data: {"choices":\n\n')).toThrow(BenchmarkStreamParseError);
    expect(() => parseOllamaJsonlStream('{"message":\n')).toThrow(/Malformed Ollama JSONL stream line 1/);
  });

  it('rejects streaming payloads when the operation does not support streaming', () => {
    const instantiation = {
      operation_spec: { protocol: 'openai_chat', supports_streaming: false },
      runtime_parameters: { stream: true },
      model_snapshot: { model: { model_id: 'mock-chat' } }
    };
    expect(() => buildBenchmarkRequestPayload(instantiation, { prompt: 'Hello' }))
      .toThrow(/supports_streaming/);
  });
});
