import { parseSseEvents } from './sse-parser.js';
import type { ProviderProtocol } from './benchmark-metric-observations.js';

export interface StreamTimingTelemetry {
  first_output_at_ms: number | null;
  first_tool_call_at_ms: number | null;
  tool_calls_ready_at_ms: number | null;
  last_output_at_ms: number | null;
  tool_call_started: boolean;
  tool_call_error: string | null;
}

export interface StreamTimingTracker {
  push(decodedChunk: string, receivedAtMs: number): void;
  finish(receivedAtMs: number): void;
  snapshot(): StreamTimingTelemetry;
}

interface ToolParts {
  name: string;
  arguments: string | Record<string, unknown>;
}

interface AnthropicToolBlock {
  name: string;
  initialInput: unknown;
  partialJson: string;
}

export interface StreamSemanticEvent {
  text_fragments: string[];
  has_tool_fragment: boolean;
  terminal: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseObject(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (objectValue(value)) return true;
  if (typeof value !== 'string') return false;
  try {
    return objectValue(JSON.parse(value) as unknown) !== null;
  } catch {
    return false;
  }
}

export function classifyStreamSemanticEvent(
  protocol: ProviderProtocol,
  record: Record<string, unknown>,
  eventName?: string
): StreamSemanticEvent {
  const textFragments: string[] = [];
  let hasToolFragment = false;
  let terminal = false;

  if (protocol === 'openai_chat') {
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      const choiceRecord = objectValue(choice);
      const delta = objectValue(choiceRecord?.delta);
      const message = objectValue(choiceRecord?.message);
      const content = typeof delta?.content === 'string'
        ? delta.content
        : typeof message?.content === 'string' ? message.content : null;
      if (content !== null && content.length > 0) textFragments.push(content);
      const calls = Array.isArray(delta?.tool_calls)
        ? delta.tool_calls
        : Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      hasToolFragment = hasToolFragment || calls.some((call) => {
        const fn = objectValue(objectValue(call)?.function);
        return (typeof fn?.name === 'string' && fn.name.length > 0)
          || (typeof fn?.arguments === 'string' && fn.arguments.length > 0)
          || objectValue(fn?.arguments) !== null;
      });
    }
  } else if (protocol === 'ollama_chat') {
    const message = objectValue(record.message);
    const content = typeof message?.content === 'string'
      ? message.content
      : typeof record.response === 'string' ? record.response : null;
    if (content !== null && content.length > 0) textFragments.push(content);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    hasToolFragment = calls.some((call) => {
      const fn = objectValue(objectValue(call)?.function);
      return (typeof fn?.name === 'string' && fn.name.length > 0)
        || (typeof fn?.arguments === 'string' && fn.arguments.length > 0)
        || objectValue(fn?.arguments) !== null;
    });
    terminal = record.done === true;
  } else if (protocol === 'anthropic_messages') {
    const eventType = eventName
      ?? (typeof record.type === 'string' ? record.type : undefined);
    if (eventType === 'content_block_start') {
      const block = objectValue(record.content_block);
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        textFragments.push(block.text);
      }
      hasToolFragment = block?.type === 'tool_use'
        && typeof block.name === 'string'
        && block.name.length > 0;
    } else if (eventType === 'content_block_delta') {
      const delta = objectValue(record.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        textFragments.push(delta.text);
      }
      hasToolFragment = delta?.type === 'input_json_delta'
        && typeof delta.partial_json === 'string'
        && delta.partial_json.length > 0;
    }
    terminal = eventType === 'message_stop';
  } else {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    for (const candidate of candidates) {
      const parts = objectValue(objectValue(candidate)?.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const partRecord = objectValue(part);
        if (typeof partRecord?.text === 'string' && partRecord.text.length > 0) {
          textFragments.push(partRecord.text);
        }
        const fn = objectValue(partRecord?.functionCall);
        hasToolFragment = hasToolFragment || Boolean(
          fn
          && (
            (typeof fn.name === 'string' && fn.name.length > 0)
            || objectValue(fn.args) !== null
          )
        );
      }
    }
  }

  return {
    text_fragments: textFragments,
    has_tool_fragment: hasToolFragment,
    terminal
  };
}

export function createStreamTimingTracker(
  protocol: ProviderProtocol,
  _attemptStartedAtMs: number
): StreamTimingTracker {
  let buffer = '';
  let firstOutputAtMs: number | null = null;
  let firstToolCallAtMs: number | null = null;
  let toolCallsReadyAtMs: number | null = null;
  let lastOutputAtMs: number | null = null;
  let toolCallStarted = false;
  let toolCallError: string | null = null;
  let terminalAtMs: number | null = null;
  let frameCount = 0;
  const openAiTools = new Map<number, ToolParts>();
  const anthropicBlocks = new Map<number, AnthropicToolBlock>();

  const markOutput = (receivedAtMs: number) => {
    firstOutputAtMs ??= receivedAtMs;
    lastOutputAtMs = receivedAtMs;
  };

  const markTool = (receivedAtMs: number) => {
    toolCallStarted = true;
    firstToolCallAtMs ??= receivedAtMs;
    markOutput(receivedAtMs);
  };

  const validateTools = (): boolean => {
    if (toolCallError) return false;
    if (protocol === 'openai_chat') {
      return [...openAiTools.values()].every(
        (tool) => tool.name.trim().length > 0 && parseObject(tool.arguments)
      );
    }
    if (protocol === 'anthropic_messages') {
      return anthropicBlocks.size === 0;
    }
    return true;
  };

  const markTerminal = (receivedAtMs: number) => {
    terminalAtMs = receivedAtMs;
    if (toolCallStarted) {
      if (validateTools()) {
        toolCallsReadyAtMs = receivedAtMs;
      } else {
        toolCallError ??= 'Stream terminated before all tool calls were complete and parseable.';
      }
    }
  };

  const processOpenAi = (record: Record<string, unknown>) => {
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      const choiceRecord = objectValue(choice);
      const delta = objectValue(choiceRecord?.delta);
      const message = objectValue(choiceRecord?.message);
      const calls = Array.isArray(delta?.tool_calls)
        ? delta.tool_calls
        : Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      calls.forEach((call, callIndex) => {
        const callRecord = objectValue(call);
        const index = typeof callRecord?.index === 'number' ? callRecord.index : callIndex;
        const fn = objectValue(callRecord?.function);
        const current = openAiTools.get(index) ?? { name: '', arguments: '' };
        if (typeof fn?.name === 'string' && fn.name.length > 0) {
          current.name += fn.name;
        }
        if (typeof fn?.arguments === 'string' && fn.arguments.length > 0) {
          current.arguments = typeof current.arguments === 'string'
            ? current.arguments + fn.arguments
            : fn.arguments;
        } else if (objectValue(fn?.arguments)) {
          current.arguments = fn?.arguments as Record<string, unknown>;
        }
        openAiTools.set(index, current);
      });
    }
  };

  const processOllama = (record: Record<string, unknown>) => {
    const message = objectValue(record.message);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      const fn = objectValue(objectValue(call)?.function);
      if (typeof fn?.name !== 'string' || fn.name.trim().length === 0 || !parseObject(fn.arguments)) {
        toolCallError = 'Ollama tool call was not complete and parseable.';
      }
    }
  };

  const processAnthropic = (
    record: Record<string, unknown>,
    eventName: string | undefined
  ) => {
    const eventType = eventName
      ?? (typeof record.type === 'string' ? record.type : undefined);
    if (eventType === 'content_block_start') {
      const index = typeof record.index === 'number' ? record.index : null;
      const block = objectValue(record.content_block);
      if (index !== null && block?.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : '';
        anthropicBlocks.set(index, {
          name,
          initialInput: block.input,
          partialJson: ''
        });
      }
    } else if (eventType === 'content_block_delta') {
      const index = typeof record.index === 'number' ? record.index : null;
      const delta = objectValue(record.delta);
      if (
        index !== null
        && delta?.type === 'input_json_delta'
        && typeof delta.partial_json === 'string'
      ) {
        const block = anthropicBlocks.get(index);
        if (block) {
          block.partialJson += delta.partial_json;
        }
      }
    } else if (eventType === 'content_block_stop') {
      const index = typeof record.index === 'number' ? record.index : null;
      const block = index === null ? undefined : anthropicBlocks.get(index);
      if (block) {
        if (block.name.trim().length === 0 || !parseObject(block.partialJson || block.initialInput)) {
          toolCallError = 'Anthropic tool call was not complete and parseable.';
        }
        anthropicBlocks.delete(index as number);
      }
    }
  };

  const processGemini = (record: Record<string, unknown>) => {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    for (const candidate of candidates) {
      const parts = objectValue(objectValue(candidate)?.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const partRecord = objectValue(part);
        const fn = objectValue(partRecord?.functionCall);
        if (fn) {
          if (typeof fn.name !== 'string' || fn.name.trim().length === 0 || !parseObject(fn.args)) {
            toolCallError = 'Gemini tool call was not complete and parseable.';
          }
        }
      }
    }
  };

  const processRecord = (
    record: Record<string, unknown>,
    receivedAtMs: number,
    eventName?: string
  ) => {
    frameCount += 1;
    const semanticEvent = classifyStreamSemanticEvent(protocol, record, eventName);
    if (semanticEvent.text_fragments.length > 0) markOutput(receivedAtMs);
    if (semanticEvent.has_tool_fragment) markTool(receivedAtMs);
    if (protocol === 'openai_chat') processOpenAi(record);
    else if (protocol === 'ollama_chat') processOllama(record);
    else if (protocol === 'anthropic_messages') processAnthropic(record, eventName);
    else processGemini(record);
    if (semanticEvent.terminal) markTerminal(receivedAtMs);
  };

  const processSseFrame = (frame: string, receivedAtMs: number) => {
    for (const event of parseSseEvents(`${frame}\n\n`)) {
      if (event.type === 'done') {
        markTerminal(receivedAtMs);
        continue;
      }
      try {
        const record = objectValue(JSON.parse(event.payload ?? '') as unknown);
        if (record) processRecord(record, receivedAtMs, event.event);
      } catch {
        if (toolCallStarted) toolCallError = 'Stream contained malformed tool-call data.';
      }
    }
  };

  const processJsonlFrame = (frame: string, receivedAtMs: number) => {
    if (frame.trim().length === 0) return;
    try {
      const record = objectValue(JSON.parse(frame) as unknown);
      if (record) processRecord(record, receivedAtMs);
    } catch {
      if (toolCallStarted) toolCallError = 'Stream contained malformed tool-call data.';
    }
  };

  const drain = (receivedAtMs: number) => {
    if (protocol === 'ollama_chat') {
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const frame = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        processJsonlFrame(frame, receivedAtMs);
        newline = buffer.indexOf('\n');
      }
      return;
    }

    let match = /\r?\n\r?\n/.exec(buffer);
    while (match?.index !== undefined) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      processSseFrame(frame, receivedAtMs);
      match = /\r?\n\r?\n/.exec(buffer);
    }
  };

  return {
    push(decodedChunk, receivedAtMs) {
      if (decodedChunk.length === 0) return;
      buffer += decodedChunk;
      drain(receivedAtMs);
    },
    finish(receivedAtMs) {
      drain(receivedAtMs);
      if (buffer.trim().length > 0) {
        if (protocol === 'ollama_chat') processJsonlFrame(buffer.replace(/\r$/, ''), receivedAtMs);
        else processSseFrame(buffer, receivedAtMs);
      }
      buffer = '';
      if (protocol === 'gemini_generate_content' && frameCount > 0 && terminalAtMs === null) {
        markTerminal(receivedAtMs);
      }
    },
    snapshot() {
      return {
        first_output_at_ms: firstOutputAtMs,
        first_tool_call_at_ms: firstToolCallAtMs,
        tool_calls_ready_at_ms: toolCallsReadyAtMs,
        last_output_at_ms: lastOutputAtMs,
        tool_call_started: toolCallStarted,
        tool_call_error: toolCallError
      };
    }
  };
}
