export interface SseEvent {
  type: 'data' | 'done';
  payload?: string;
  event?: string;
}

export function parseSseEvents(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return;
    }
    const payload = dataLines.join('\n');
    if (payload.trim() === '[DONE]') {
      events.push({ type: 'done', event: eventName });
    } else {
      events.push({ type: 'data', payload, event: eventName });
    }
    eventName = undefined;
    dataLines = [];
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }
  dispatch();
  return events;
}
