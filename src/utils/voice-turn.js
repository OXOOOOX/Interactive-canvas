export function isVadTurnSettled({
  hasLocalVadGate,
  alwaysOn,
  speechActive,
  lastSpeechEndAt,
  now,
  settleMs,
}) {
  if (!hasLocalVadGate || alwaysOn) return true;
  if (speechActive || !lastSpeechEndAt) return false;
  return now - lastSpeechEndAt >= settleMs;
}

export function shouldAcceptTranscriptUpdate({ transcriptOwner, activeSessionId, updateSessionId }) {
  if (transcriptOwner !== 'asr') return false;
  if (!activeSessionId || !updateSessionId) return false;
  return activeSessionId === updateSessionId;
}
