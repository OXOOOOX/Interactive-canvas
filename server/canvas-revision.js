function normalizeCanvasForRevision(canvas = {}) {
  const blocks = (Array.isArray(canvas.blocks) ? canvas.blocks : [])
    .map(block => ({
      id: String(block?.id || ''),
      type: String(block?.type || ''),
      label: String(block?.label || ''),
      content: String(block?.content || ''),
      locked: Boolean(block?.locked),
      positionLocked: Boolean(block?.positionLocked),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const connections = (Array.isArray(canvas.connections) ? canvas.connections : [])
    .map(connection => ({
      fromId: String(connection?.fromId || ''),
      toId: String(connection?.toId || ''),
    }))
    .sort((a, b) => `${a.fromId}:${a.toId}`.localeCompare(`${b.fromId}:${b.toId}`));

  return {
    id: String(canvas.id || ''),
    title: String(canvas.title || ''),
    memory: String(canvas.memory || ''),
    blocks,
    connections,
  };
}

export function computeCanvasRevision(canvas = {}) {
  const source = JSON.stringify(normalizeCanvasForRevision(canvas));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export { normalizeCanvasForRevision };
