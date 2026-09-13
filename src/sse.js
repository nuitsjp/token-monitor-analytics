// A notification is complete only after its terminating blank line.
export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (chunk.done && buffer.endsWith('\r')) buffer += '\n';
      while (true) {
        const position = buffer.search(/[\r\n]/);
        if (position < 0 || (buffer[position] === '\r' && position === buffer.length - 1)) break;
        const line = buffer.slice(0, position);
        const length = buffer[position] === '\r' && buffer[position + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(position + length);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value || 'message';
          if (field === 'data') data.push(value);
        }
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
