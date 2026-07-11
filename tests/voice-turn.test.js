import test from 'node:test';
import assert from 'node:assert/strict';

import { isVadTurnSettled, shouldAcceptTranscriptUpdate } from '../src/utils/voice-turn.js';

const baseState = {
  hasLocalVadGate: true,
  alwaysOn: false,
  speechActive: false,
  lastSpeechEndAt: 1000,
  now: 2200,
  settleMs: 1200,
};

test('VAD-gated turn stays open while speech is active', () => {
  assert.equal(isVadTurnSettled({ ...baseState, speechActive: true }), false);
});

test('VAD-gated turn waits for the post-speech settle window', () => {
  assert.equal(isVadTurnSettled({ ...baseState, now: 2199 }), false);
  assert.equal(isVadTurnSettled(baseState), true);
});

test('always-on Doubao keeps transcript-only silence behavior', () => {
  assert.equal(isVadTurnSettled({ ...baseState, alwaysOn: true, speechActive: true }), true);
});

test('transcript updates require ASR ownership and the active session', () => {
  assert.equal(shouldAcceptTranscriptUpdate({
    transcriptOwner: 'asr',
    activeSessionId: 4,
    updateSessionId: 4,
  }), true);
  assert.equal(shouldAcceptTranscriptUpdate({
    transcriptOwner: 'asr',
    activeSessionId: 4,
    updateSessionId: 3,
  }), false);
  assert.equal(shouldAcceptTranscriptUpdate({
    transcriptOwner: 'user',
    activeSessionId: 4,
    updateSessionId: 4,
  }), false);
});

test('a new active session may recognize the same words as the previous session', () => {
  assert.equal(shouldAcceptTranscriptUpdate({
    transcriptOwner: 'asr',
    activeSessionId: 5,
    updateSessionId: 5,
  }), true);
});
