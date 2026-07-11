/**
 * waveform.js - browser / Doubao streaming ASR with waveform UI.
 */

import { applyDoubaoTranscriptUpdate, startDoubaoStreamingRecognition } from './services/doubao-asr.js';
import { createLocalVadGate } from './services/local-vad.js';
import { isVadTurnSettled, shouldAcceptTranscriptUpdate } from './utils/voice-turn.js';

const SILENCE_TIMEOUT_MS = 2800;
const STARTUP_GRACE_MS = 1200;
const AUDIO_ACTIVITY_THRESHOLD = 0.018;
const DOUBAO_VAD_EMPTY_TAIL_MS = 1800;
const DOUBAO_VAD_END_SETTLE_MS = 1200;
const MAX_RECENT_SUBMITTED_TRANSCRIPTS = 6;

let analyser = null;
let animFrameId = null;
let startTime = 0;

let audioCtx = null;
let streamGlobal = null;
let streamGlobalOwned = true;
let doubaoSession = null;
let localVadGate = null;
let doubaoStartPromise = null;
let usingDoubaoRecognition = false;
let resumePromise = null;
let recognition = null;

export let isConversationActive = false;
let isPaused = false;
let silenceStopRequested = false;
let hasDetectedSpeech = false;
let lastTranscriptAt = 0;
let lastAudioActivityAt = 0;
let voiceSessionStartedAt = 0;
let latestInterimTranscript = '';
let latestFinalTranscript = '';
let latestTranscriptSnapshot = '';
let latestSubmittedTranscript = '';
let latestSubmittedAt = 0;
let recentSubmittedTranscripts = [];
let autoSubmitBlockedTranscript = '';
let lastTranscriptSnapshot = '';
let turnCompleted = false;
let silenceRecoveryTimer = null;
let transcriptSilenceTimer = null;
let pendingAutoSubmitTimer = null;
let doubaoVadEmptyTailTimer = null;
let localVadSpeechActive = false;
let lastLocalVadSpeechEndAt = 0;
let pausedStatusText = '\u7b49\u5f85\u6a21\u578b\u56de\u590d';
let voiceVisualState = 'idle';
let lastVadError = '';
let transcriptOwner = 'asr';
let doubaoSessionSequence = 0;
let activeDoubaoSessionId = 0;
let ignoredStaleTranscriptCallbacks = 0;
let lastTranscriptUpdateMode = '';
let lastTranscriptReplaceAt = 0;
let lastTranscriptAppendAt = 0;
let lastManualPauseAt = 0;
let manualEditPausePromise = null;
let manualEditListenersBound = false;

let $waveformBar;
let $waveformCanvas;
let $waveTime;
let $waveStatus;
let $waveSubmitBtn;
let $recordBtn;
let ctx = null;
let onTextComplete = () => {};

function getVoiceHelpers() {
  return window.__VOICE_MODE_HELPERS__ || {};
}

function getVoiceUi() {
  return window.__VOICE_UI__ || {};
}

function getVoiceLanguage() {
  return window.__GET_VOICE_LANGUAGE__?.() || 'zh-CN';
}

function getVoiceConfig() {
  return window.__GET_CONFIG__?.() || {};
}

function shouldUseDoubaoAlwaysOn() {
  return getVoiceConfig().doubaoAlwaysOnAsr === true;
}

function isVoiceAutoSubmitAllowed() {
  if (window.__VOICE_AUTO_SUBMIT_ALLOWED__) {
    return window.__VOICE_AUTO_SUBMIT_ALLOWED__() !== false;
  }
  return window.__CHAT_MODEL_BUSY__ !== true;
}

function getTranscriptText(text) {
  return window.__VOICE_TRANSCRIPT_TEXT__?.(text) ?? (text || '').trim();
}

function isMeaningfulTranscript(text) {
  if (window.__VOICE_TRANSCRIPT_VALID__) {
    return window.__VOICE_TRANSCRIPT_VALID__(text);
  }
  return !!text && text.replace(/[^\w\u4e00-\u9fa5]/g, '').length > 0;
}

function normalizeTranscriptForDedupe(text = '') {
  return getTranscriptText(text)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, '');
}

function normalizeTranscriptWithMap(text = '') {
  const source = getTranscriptText(text);
  let normalized = '';
  const map = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i].toLowerCase();
    if (/[\w\u4e00-\u9fa5]/.test(char)) {
      normalized += char;
      map.push(i);
    }
  }
  return { source, normalized, map };
}

function stripLeadingTranscriptSeparator(text = '') {
  return getTranscriptText(text).replace(/^[\s,\uFF0C.\u3002!\uFF01?\uFF1F;\uFF1B:\uFF1A\u3001-]+/, '');
}

function rememberSubmittedTranscript(text = '') {
  const cleaned = getTranscriptText(text);
  if (!isMeaningfulTranscript(cleaned)) return;
  const normalized = normalizeTranscriptForDedupe(cleaned);
  recentSubmittedTranscripts = [
    cleaned,
    ...recentSubmittedTranscripts.filter(item => normalizeTranscriptForDedupe(item) !== normalized),
  ].slice(0, MAX_RECENT_SUBMITTED_TRANSCRIPTS);
}

function getSubmittedTranscriptAnchors() {
  const seen = new Set();
  return [latestSubmittedTranscript, ...recentSubmittedTranscripts]
    .map(item => getTranscriptText(item))
    .filter(Boolean)
    .filter(item => {
      const normalized = normalizeTranscriptForDedupe(item);
      if (normalized.length < 2 || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function getNewTranscriptAfterSubmitted(text = '') {
  if (!turnCompleted || !latestSubmittedTranscript) return getTranscriptText(text);

  const incoming = normalizeTranscriptWithMap(text);
  const submitted = normalizeTranscriptWithMap(latestSubmittedTranscript);
  if (!incoming.normalized || !submitted.normalized) return incoming.source;

  const submittedIndex = incoming.normalized.lastIndexOf(submitted.normalized);
  if (submittedIndex >= 0) {
    const endNormalizedIndex = submittedIndex + submitted.normalized.length - 1;
    const endSourceIndex = incoming.map[endNormalizedIndex] ?? -1;
    return getTranscriptText(incoming.source.slice(endSourceIndex + 1).replace(/^[\s,\uFF0C.\u3002!\uFF01?\uFF1F;\uFF1B:\uFF1A\u3001-]+/, ''));
  }

  if (
    incoming.normalized === submitted.normalized ||
    submitted.normalized.startsWith(incoming.normalized)
  ) {
    return '';
  }

  if (incoming.normalized.startsWith(submitted.normalized)) {
    const endIndex = incoming.map[submitted.normalized.length - 1] ?? -1;
    return getTranscriptText(incoming.source.slice(endIndex + 1).replace(/^[\s,\uFF0C.\u3002!\uFF01?\uFF1F;\uFF1B:\uFF1A\u3001-]+/, ''));
  }

  return incoming.source;
}

function getFreshTranscriptAfterSubmitted(text = '', anchors = getSubmittedTranscriptAnchors()) {
  if (!anchors.length) return getTranscriptText(text);

  const incoming = normalizeTranscriptWithMap(text);
  if (!incoming.normalized) return incoming.source;

  let bestEndNormalizedIndex = -1;
  for (const anchor of anchors) {
    const anchorNormalized = normalizeTranscriptForDedupe(anchor);
    const anchorIndex = incoming.normalized.lastIndexOf(anchorNormalized);
    if (anchorIndex >= 0) {
      bestEndNormalizedIndex = Math.max(bestEndNormalizedIndex, anchorIndex + anchorNormalized.length - 1);
    }
  }

  if (bestEndNormalizedIndex >= 0) {
    const endSourceIndex = incoming.map[bestEndNormalizedIndex] ?? -1;
    return stripLeadingTranscriptSeparator(incoming.source.slice(endSourceIndex + 1));
  }

  for (const anchor of anchors) {
    const anchorData = normalizeTranscriptWithMap(anchor);
    if (!anchorData.normalized) continue;
    if (
      incoming.normalized === anchorData.normalized ||
      anchorData.normalized.startsWith(incoming.normalized)
    ) {
      return '';
    }
    if (incoming.normalized.startsWith(anchorData.normalized)) {
      const endIndex = incoming.map[anchorData.normalized.length - 1] ?? -1;
      return stripLeadingTranscriptSeparator(incoming.source.slice(endIndex + 1));
    }
  }

  return incoming.source;
}

function shouldUseBrowserRecognition() {
  return !!getVoiceHelpers().shouldUseBrowserRecognition?.();
}

function isRecognitionEnabled() {
  return getVoiceHelpers().isRecognitionEnabled?.() !== false;
}

function bindInputInterim(text, { force = false } = {}) {
  const chatInput = document.getElementById('chatInput');
  if (!chatInput) return;
  if (transcriptOwner === 'user' && !force) return;
  chatInput.value = text || '';
  chatInput.style.height = 'auto';
  chatInput.style.height = text ? `${Math.min(chatInput.scrollHeight, 120)}px` : 'auto';
}

function clearSilenceRecoveryTimer() {
  if (!silenceRecoveryTimer) return;
  clearTimeout(silenceRecoveryTimer);
  silenceRecoveryTimer = null;
}

function clearTranscriptSilenceTimer() {
  if (!transcriptSilenceTimer) return;
  clearTimeout(transcriptSilenceTimer);
  transcriptSilenceTimer = null;
}

function clearPendingAutoSubmitTimer() {
  if (!pendingAutoSubmitTimer) return;
  clearTimeout(pendingAutoSubmitTimer);
  pendingAutoSubmitTimer = null;
}

function clearDoubaoVadEmptyTailTimer() {
  if (!doubaoVadEmptyTailTimer) return;
  clearTimeout(doubaoVadEmptyTailTimer);
  doubaoVadEmptyTailTimer = null;
}

function isLocalVadTurnSettled(now = Date.now()) {
  return isVadTurnSettled({
    hasLocalVadGate: !!localVadGate,
    alwaysOn: shouldUseDoubaoAlwaysOn(),
    speechActive: localVadSpeechActive,
    lastSpeechEndAt: lastLocalVadSpeechEndAt,
    now,
    settleMs: DOUBAO_VAD_END_SETTLE_MS,
  });
}

function scheduleTranscriptSilenceStop() {
  clearTranscriptSilenceTimer();
  transcriptSilenceTimer = setTimeout(() => {
    transcriptSilenceTimer = null;
    if (shouldAutoStopForSilence()) {
      requestSilenceStop();
      return;
    }
    if (isConversationActive && !isPaused && !silenceStopRequested) {
      scheduleTranscriptSilenceStop();
    }
  }, SILENCE_TIMEOUT_MS + 80);
}

function resetTurnState({ clearSubmitted = false, preserveVadState = false } = {}) {
  clearSilenceRecoveryTimer();
  clearTranscriptSilenceTimer();
  clearPendingAutoSubmitTimer();
  clearDoubaoVadEmptyTailTimer();
  if (!preserveVadState) {
    localVadSpeechActive = false;
    lastLocalVadSpeechEndAt = 0;
  }
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  const now = Date.now();
  lastTranscriptAt = now;
  lastAudioActivityAt = now;
  voiceSessionStartedAt = now;
  latestInterimTranscript = '';
  latestFinalTranscript = '';
  latestTranscriptSnapshot = '';
  lastTranscriptSnapshot = '';
  turnCompleted = false;
  if (clearSubmitted) {
    latestSubmittedTranscript = '';
    latestSubmittedAt = 0;
    recentSubmittedTranscripts = [];
    autoSubmitBlockedTranscript = '';
  }
}

function scheduleSilenceRecoveryFallback() {
  clearSilenceRecoveryTimer();
  silenceRecoveryTimer = setTimeout(() => {
    silenceRecoveryTimer = null;
    recoverFromSilenceStop();
  }, 1400);
}

function getPendingTranscript() {
  const inputText = document.getElementById('chatInput')?.value || '';
  return getTranscriptText(latestTranscriptSnapshot || latestFinalTranscript || latestInterimTranscript || inputText || '');
}

function hasPendingMeaningfulTranscript() {
  return isMeaningfulTranscript(getPendingTranscript());
}

function blockAutoSubmitForCurrentPending() {
  const pending = getPendingTranscript();
  if (!isMeaningfulTranscript(pending)) return;
  autoSubmitBlockedTranscript = normalizeTranscriptForDedupe(pending);
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  lastTranscriptAt = Date.now();
  lastAudioActivityAt = Date.now();
  voiceSessionStartedAt = Date.now();
}

function flushPendingTranscriptIfNeeded() {
  if (!silenceStopRequested || turnCompleted || !isConversationActive) return false;
  if (!hasPendingMeaningfulTranscript()) return false;
  if (!isVoiceAutoSubmitAllowed()) {
    blockAutoSubmitForCurrentPending();
    return false;
  }
  const pending = getPendingTranscript();
  clearSilenceRecoveryTimer();
  clearPendingAutoSubmitTimer();
  return submitRecognizedText(pending, { autoStopped: true });
}

function schedulePendingAutoSubmit() {
  clearPendingAutoSubmitTimer();
  pendingAutoSubmitTimer = setTimeout(() => {
    pendingAutoSubmitTimer = null;
    if (flushPendingTranscriptIfNeeded()) return;
    recoverFromSilenceStop();
  }, 800);
}

function resumeAfterSilenceFallback() {
  clearSilenceRecoveryTimer();
  silenceStopRequested = false;
  void resumeListening();
}

function recoverFromSilenceStop() {
  if (!silenceStopRequested || turnCompleted || !isConversationActive) return;
  if (flushPendingTranscriptIfNeeded()) return;
  resumeAfterSilenceFallback();
}

function markTranscriptActivity(text, { final = false } = {}) {
  clearDoubaoVadEmptyTailTimer();
  const cleaned = getTranscriptText(text);
  if (final) {
    latestFinalTranscript = cleaned;
  } else {
    latestInterimTranscript = cleaned;
  }
  if (isMeaningfulTranscript(cleaned)) {
    if (
      autoSubmitBlockedTranscript &&
      normalizeTranscriptForDedupe(cleaned) !== autoSubmitBlockedTranscript
    ) {
      autoSubmitBlockedTranscript = '';
    }
    if (
      turnCompleted &&
      normalizeTranscriptForDedupe(cleaned) !== normalizeTranscriptForDedupe(latestSubmittedTranscript)
    ) {
      turnCompleted = false;
    }
    if (cleaned !== lastTranscriptSnapshot) {
      lastTranscriptSnapshot = cleaned;
      lastTranscriptAt = Date.now();
    }
    hasDetectedSpeech = true;
    if (!transcriptSilenceTimer) scheduleTranscriptSilenceStop();
  }
  return cleaned;
}

function mergeTranscriptText(current, incoming) {
  const base = getTranscriptText(current || '');
  const next = getTranscriptText(incoming || '');
  if (!next) return base;
  if (!base) return next;

  const normalizeForMerge = (value) => String(value || '')
    .toLowerCase()
    .replace(/[\s,\uFF0C.\u3002!?\uFF01\uFF1F;\uFF1B:\uFF1A'"\u201C\u201D\u2018\u2019\u3001\-\u2014_()[\]{}<>\u300A\u300B]/g, '');
  const normalizedBase = normalizeForMerge(base);
  const normalizedNext = normalizeForMerge(next);
  const commonPrefixLength = (a, b) => {
    const max = Math.min(a.length, b.length);
    let index = 0;
    while (index < max && a[index] === b[index]) index += 1;
    return index;
  };

  if (normalizedBase && normalizedNext) {
    if (normalizedNext === normalizedBase || normalizedNext.startsWith(normalizedBase)) return next;
    if (normalizedBase.startsWith(normalizedNext)) return base;
    if (normalizedBase.endsWith(normalizedNext)) return base;

    const commonPrefix = commonPrefixLength(normalizedBase, normalizedNext);
    const shorterLength = Math.min(normalizedBase.length, normalizedNext.length);
    if (commonPrefix >= 6 && commonPrefix / shorterLength >= 0.55) {
      return next.length >= base.length * 0.6 ? next : base;
    }
  }

  if (next === base || next.startsWith(base)) return next;
  if (base.endsWith(next)) return base;

  const maxOverlap = Math.min(base.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === next.slice(0, size)) {
      return getTranscriptText(`${base}${next.slice(size)}`);
    }
  }

  return getTranscriptText(`${base}${/[a-zA-Z0-9]$/.test(base) && /^[a-zA-Z0-9]/.test(next) ? ' ' : ''}${next}`);
}

function appendFinalTranscript(text) {
  const cleaned = getTranscriptText(text);
  if (!cleaned) return '';
  const combined = mergeTranscriptText(latestFinalTranscript, cleaned);
  latestFinalTranscript = combined;
  latestInterimTranscript = '';
  if (isMeaningfulTranscript(combined)) {
    if (
      autoSubmitBlockedTranscript &&
      normalizeTranscriptForDedupe(combined) !== autoSubmitBlockedTranscript
    ) {
      autoSubmitBlockedTranscript = '';
    }
    if (
      turnCompleted &&
      normalizeTranscriptForDedupe(combined) !== normalizeTranscriptForDedupe(latestSubmittedTranscript)
    ) {
      turnCompleted = false;
    }
    if (combined !== lastTranscriptSnapshot) {
      lastTranscriptSnapshot = combined;
      lastTranscriptAt = Date.now();
    }
    hasDetectedSpeech = true;
    if (!transcriptSilenceTimer) scheduleTranscriptSilenceStop();
  }
  return combined;
}

function markAudioActivity(level) {
  if (level >= AUDIO_ACTIVITY_THRESHOLD) {
    lastAudioActivityAt = Date.now();
  }
}

function getVoiceStatusText(state) {
  if (state === 'vad-standby') return '\u4eba\u58f0\u76d1\u542c';
  if (state === 'vad-checking') return '\u786e\u8ba4\u4eba\u58f0';
  if (state === 'vad-paused') return pausedStatusText || '\u4eba\u58f0\u8bc6\u522b\u6682\u505c';
  if (state === 'vad-error') return '\u68c0\u6d4b\u6545\u969c';
  if (state === 'manual-edit') return '\u624b\u52a8\u7f16\u8f91';
  if (state === 'doubao-streaming') return '\u8c46\u5305\u8bc6\u522b';
  if (state === 'listening') return '\u6b63\u5728\u6536\u542c';
  if (state === 'paused') return pausedStatusText;
  return '';
}

function getVoiceStatusTitle(state) {
  if (state === 'vad-standby') return '\u672c\u5730\u4eba\u58f0\u68c0\u6d4b\u8fd0\u884c\u4e2d';
  if (state === 'vad-checking') return '\u6b63\u5728\u786e\u8ba4\u662f\u5426\u4e3a\u4eba\u58f0';
  if (state === 'vad-paused') return `\u4eba\u58f0\u8bc6\u522b\u6682\u505c${pausedStatusText ? `\uff1a${pausedStatusText}` : ''}`;
  if (state === 'vad-error') return '\u672c\u5730\u4eba\u58f0\u68c0\u6d4b\u6545\u969c\uff0c\u5df2\u6539\u7528\u8c46\u5305\u5e38\u5f00\u8bc6\u522b';
  if (state === 'manual-edit') return '\u4eba\u58f0\u8bc6\u522b\u6682\u505c\uff1a\u6b63\u5728\u624b\u52a8\u7f16\u8f91';
  return getVoiceStatusText(state);
}

function setVoiceVisualState(state, label) {
  const isListening = state === 'listening';
  const isVadStandby = state === 'vad-standby';
  const isVadChecking = state === 'vad-checking';
  const isVadPaused = state === 'vad-paused';
  const isVadError = state === 'vad-error';
  const isManualEdit = state === 'manual-edit';
  const isDoubaoStreaming = state === 'doubao-streaming';
  const isPausedState = state === 'paused';
  const isVisible = isListening || isVadStandby || isVadChecking || isVadPaused || isVadError || isManualEdit || isDoubaoStreaming || isPausedState;
  if (label) pausedStatusText = label;
  voiceVisualState = state;

  if ($waveformBar) {
    $waveformBar.classList.toggle('active', isVisible);
    $waveformBar.classList.toggle('is-listening', isListening);
    $waveformBar.classList.toggle('is-vad-standby', isVadStandby);
    $waveformBar.classList.toggle('is-vad-checking', isVadChecking);
    $waveformBar.classList.toggle('is-vad-paused', isVadPaused);
    $waveformBar.classList.toggle('is-vad-error', isVadError);
    $waveformBar.classList.toggle('is-manual-edit', isManualEdit);
    $waveformBar.classList.toggle('is-doubao-streaming', isDoubaoStreaming);
    $waveformBar.classList.toggle('is-paused', isPausedState || isVadPaused || isManualEdit);
    $waveformBar.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
  }

  if ($recordBtn) {
    $recordBtn.classList.toggle('recording', isListening);
    $recordBtn.classList.toggle('paused', isPausedState || isVadPaused || isManualEdit);
  }

  if ($waveStatus) {
    $waveStatus.textContent = getVoiceStatusText(state);
    $waveStatus.title = getVoiceStatusTitle(state);
  }
}

function beginVisualSession(resetTimer = false, state = 'listening', { resetTurn = true } = {}) {
  const wasActive = isConversationActive;
  isConversationActive = true;
  isPaused = false;
  if (resetTurn) {
    resetTurnState({ clearSubmitted: resetTimer || !wasActive });
  }
  if (resetTimer || !wasActive) {
    startTime = Date.now();
    updateTimer();
  }
  setVoiceVisualState(state);
  if (!wasActive) drawWaveform();
}

function clearVisualSession({ preserveInput = false } = {}) {
  cancelAnimationFrame(animFrameId);
  setVoiceVisualState('idle');
  if (!preserveInput) bindInputInterim('', { force: true });
}

async function teardownAudioMonitoring() {
  if (streamGlobal) {
    if (streamGlobalOwned) {
      streamGlobal.getTracks().forEach((track) => track.stop());
    }
    streamGlobal = null;
    streamGlobalOwned = true;
  }
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
}

async function setupAudioMonitoring(stream, { ownsStream = true } = {}) {
  await teardownAudioMonitoring();
  streamGlobal = stream;
  streamGlobalOwned = ownsStream;
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
}

function stopBrowserRecognition({ resetInstance = false } = {}) {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (e) {}
  if (resetInstance) recognition = null;
}

function stopDoubaoRecognition() {
  clearDoubaoVadEmptyTailTimer();
  activeDoubaoSessionId = 0;
  if (!doubaoSession) return;
  const session = doubaoSession;
  doubaoSession = null;
  session.stop().catch(() => {});
  if (localVadGate && isConversationActive && !isPaused && !shouldUseDoubaoAlwaysOn()) {
    setVoiceVisualState('vad-standby');
  }
}

async function stopLocalVadGate() {
  if (!localVadGate) return;
  const gate = localVadGate;
  localVadGate = null;
  localVadSpeechActive = false;
  lastLocalVadSpeechEndAt = 0;
  await gate.stop().catch((error) => console.warn('[waveform] local VAD stop failed:', error));
}

function notifyVoiceStarted() {
  getVoiceUi().announceVoiceStarted?.(usingDoubaoRecognition ? 'doubao' : 'browser');
  getVoiceUi().syncRoute?.(false);
}

function notifyVoiceWaiting() {
  getVoiceUi().announceVoiceWaiting?.();
}

function notifyVoiceStopped() {
  getVoiceUi().announceVoiceStopped?.();
}

function notifyVoiceCaptured() {
  getVoiceUi().announceVoiceCaptured?.();
}

function notifyVoiceAutoStopped() {
  getVoiceUi().announceVoiceAutoStopped?.();
}

function notifyVoiceStartFailed(message) {
  getVoiceUi().announceVoiceStartFailed?.(message);
}

function pauseListeningUiOnly(label = '\u7b49\u5f85\u6a21\u578b\u56de\u590d') {
  pausedStatusText = label;
  const pausedState = usingDoubaoRecognition && !shouldUseDoubaoAlwaysOn() ? 'vad-paused' : 'paused';
  if (isPaused) {
    setVoiceVisualState(pausedState, label);
    return;
  }
  isPaused = true;
  setVoiceVisualState(pausedState, label);
}

async function pauseListeningForPlayback(reason = '\u8bed\u97f3\u64ad\u62a5\u4e2d') {
  pauseListeningUiOnly(reason);
  silenceStopRequested = false;
  clearTranscriptSilenceTimer();
  stopBrowserRecognition();
  stopDoubaoRecognition();
  await stopLocalVadGate();
}

function enterManualEditMode() {
  if (!isConversationActive || transcriptOwner === 'user') return manualEditPausePromise || Promise.resolve();

  transcriptOwner = 'user';
  lastManualPauseAt = Date.now();
  isPaused = true;
  silenceStopRequested = false;
  clearTranscriptSilenceTimer();
  clearPendingAutoSubmitTimer();
  clearDoubaoVadEmptyTailTimer();
  stopBrowserRecognition();
  stopDoubaoRecognition();
  setVoiceVisualState('manual-edit');

  manualEditPausePromise = stopLocalVadGate().finally(() => {
    manualEditPausePromise = null;
  });
  return manualEditPausePromise;
}

async function resumeAfterManualEdit() {
  if (!isConversationActive || transcriptOwner !== 'user') return;
  await manualEditPausePromise;
  if (doubaoStartPromise) {
    await doubaoStartPromise.catch(() => {});
  }
  transcriptOwner = 'asr';
  isPaused = false;
  latestTranscriptSnapshot = '';
  latestFinalTranscript = '';
  latestInterimTranscript = '';
  lastTranscriptSnapshot = '';
  await resumeListening();
}

function submitRecognizedText(text, { autoStopped = false } = {}) {
  const cleaned = getTranscriptText(text);
  if (!isMeaningfulTranscript(cleaned)) return false;
  if (autoStopped && !isVoiceAutoSubmitAllowed()) {
    blockAutoSubmitForCurrentPending();
    return false;
  }
  if (turnCompleted && normalizeTranscriptForDedupe(latestSubmittedTranscript) === normalizeTranscriptForDedupe(cleaned)) return false;
  if (latestSubmittedTranscript === cleaned && Date.now() - latestSubmittedAt < 2500) return false;

  clearTranscriptSilenceTimer();
  clearPendingAutoSubmitTimer();
  clearDoubaoVadEmptyTailTimer();

  latestSubmittedTranscript = cleaned;
  latestSubmittedAt = Date.now();
  rememberSubmittedTranscript(cleaned);
  autoSubmitBlockedTranscript = '';
  turnCompleted = true;
  latestFinalTranscript = '';
  latestInterimTranscript = '';
  latestTranscriptSnapshot = '';
  lastTranscriptSnapshot = '';
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  lastTranscriptAt = Date.now();
  lastAudioActivityAt = Date.now();
  voiceSessionStartedAt = Date.now();
  bindInputInterim('');
  if (usingDoubaoRecognition && !shouldUseDoubaoAlwaysOn()) {
    setVoiceVisualState(lastVadError ? 'vad-error' : 'vad-standby');
  } else {
    setVoiceVisualState('listening');
  }

  if (autoStopped) {
    notifyVoiceAutoStopped();
  } else {
    notifyVoiceCaptured();
  }

  onTextComplete(cleaned);
  return true;
}

function requestSilenceStop() {
  if (!isConversationActive || isPaused || silenceStopRequested) return;
  if (turnCompleted) return;
  if (!hasDetectedSpeech) return;
  if (Date.now() - voiceSessionStartedAt < STARTUP_GRACE_MS) return;
  if (!isLocalVadTurnSettled()) return;
  if (!isVoiceAutoSubmitAllowed()) {
    blockAutoSubmitForCurrentPending();
    return;
  }

  silenceStopRequested = true;
  clearTranscriptSilenceTimer();
  const submitted = flushPendingTranscriptIfNeeded();
  if (submitted) {
    if (usingDoubaoRecognition) {
      stopDoubaoRecognition();
    } else {
      stopBrowserRecognition();
    }
    return;
  }

  scheduleSilenceRecoveryFallback();
  schedulePendingAutoSubmit();
  pauseListeningUiOnly('\u7b49\u5f85\u6a21\u578b\u56de\u590d');

  if (usingDoubaoRecognition) {
    stopDoubaoRecognition();
    return;
  }
  stopBrowserRecognition();
}

function submitCurrentVoiceTurn() {
  if (!isConversationActive || isPaused || turnCompleted) return false;
  const pending = getPendingTranscript();
  if (!isMeaningfulTranscript(pending)) return false;
  silenceStopRequested = true;
  clearTranscriptSilenceTimer();
  return submitRecognizedText(pending, { autoStopped: false });
}

function shouldAutoStopForSilence() {
  if (!isConversationActive || isPaused || silenceStopRequested) return false;
  if (turnCompleted) return false;
  if (!hasDetectedSpeech) return false;
  if (!hasPendingMeaningfulTranscript()) return false;
  if (autoSubmitBlockedTranscript && normalizeTranscriptForDedupe(getPendingTranscript()) === autoSubmitBlockedTranscript) return false;
  if (Date.now() - voiceSessionStartedAt < STARTUP_GRACE_MS) return false;
  if (!isLocalVadTurnSettled()) return false;
  return Date.now() - lastTranscriptAt >= SILENCE_TIMEOUT_MS;
}

function computeAudioLevel(timeDomainArray) {
  let sumSquares = 0;
  for (let i = 0; i < timeDomainArray.length; i += 1) {
    const centered = (timeDomainArray[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / timeDomainArray.length);
}

function createBrowserRecognition(SRec) {
  recognition = new SRec();
  recognition.lang = getVoiceLanguage();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    if (!isConversationActive) return;
    if (isPaused && !silenceStopRequested) return;

    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    if (interimTranscript) {
      const combinedInterim = getFreshTranscriptAfterSubmitted(mergeTranscriptText(latestFinalTranscript, interimTranscript));
      if (combinedInterim) {
        bindInputInterim(combinedInterim);
        markTranscriptActivity(combinedInterim, { final: false });
      }
    }

    if (finalTranscript) {
      const filteredFinal = getFreshTranscriptAfterSubmitted(finalTranscript);
      if (!filteredFinal) return;
      const combinedFinal = appendFinalTranscript(filteredFinal);
      bindInputInterim(combinedFinal);
      if (silenceStopRequested) {
        submitRecognizedText(combinedFinal, { autoStopped: true });
      }
    }
  };

  recognition.onend = () => {
    if (silenceStopRequested) {
      recoverFromSilenceStop();
      return;
    }
    if (isConversationActive && !isPaused) {
      try {
        recognition.start();
      } catch (e) {}
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech') {
      console.error('Speech recognition error:', event.error);
    }
  };
}

async function startBrowserConversation({ resetTimer = true } = {}) {
  usingDoubaoRecognition = false;
  const SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRec) {
    throw new Error('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u539f\u751f\u8bed\u97f3\u8bc6\u522b\uff0c\u8bf7\u4f7f\u7528 Chrome \u6216 Edge\u3002');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await setupAudioMonitoring(stream);
  createBrowserRecognition(SRec);
  beginVisualSession(resetTimer);
  recognition.start();
}

function acceptDoubaoTranscriptUpdate(update) {
  if (!isConversationActive) return false;
  if (!shouldAcceptTranscriptUpdate({
    transcriptOwner,
    activeSessionId: activeDoubaoSessionId,
    updateSessionId: update?.sessionId,
  })) {
    ignoredStaleTranscriptCallbacks += 1;
    return false;
  }

  const filteredText = getTranscriptText(update.text);
  if (update.updateMode === 'append' && !isMeaningfulTranscript(filteredText)) return false;

  latestTranscriptSnapshot = applyDoubaoTranscriptUpdate(latestTranscriptSnapshot, {
    ...update,
    text: filteredText,
  });
  lastTranscriptUpdateMode = update.updateMode;
  if (update.updateMode === 'append') {
    lastTranscriptAppendAt = Date.now();
  } else {
    lastTranscriptReplaceAt = Date.now();
  }

  latestFinalTranscript = update.final ? latestTranscriptSnapshot : '';
  latestInterimTranscript = update.final ? '' : latestTranscriptSnapshot;
  bindInputInterim(latestTranscriptSnapshot);
  if (isMeaningfulTranscript(latestTranscriptSnapshot)) {
    markTranscriptActivity(latestTranscriptSnapshot, { final: update.final });
  } else {
    latestFinalTranscript = '';
    latestInterimTranscript = '';
    lastTranscriptSnapshot = '';
    hasDetectedSpeech = false;
    clearTranscriptSilenceTimer();
  }
  if (silenceStopRequested) {
    submitRecognizedText(latestTranscriptSnapshot, { autoStopped: true });
  }
  return true;
}

async function startDoubaoConversation({
  resetTimer = true,
  stream = null,
  preAudioBytes = null,
  closeStreamOnStop = true,
  monitorOwnsStream = true,
  visualState = null,
} = {}) {
  if (doubaoStartPromise) return doubaoStartPromise;

  const sessionId = ++doubaoSessionSequence;
  activeDoubaoSessionId = sessionId;
  transcriptOwner = 'asr';
  resetTurnState({ preserveVadState: true });

  doubaoStartPromise = (async () => {
    usingDoubaoRecognition = true;
    const config = getVoiceConfig();
    const session = await startDoubaoStreamingRecognition(config, {
      onTranscript(update) {
        acceptDoubaoTranscriptUpdate(update);
      },
      onError(error) {
        console.error('[waveform] Doubao onError:', error);
      },
      onComplete(finalText, detail = {}) {
        if (detail.sessionId !== activeDoubaoSessionId || transcriptOwner !== 'asr') {
          ignoredStaleTranscriptCallbacks += 1;
          return;
        }
        if (finalText && finalText !== latestTranscriptSnapshot) {
          acceptDoubaoTranscriptUpdate({
            sessionId,
            sequence: detail.sequence,
            text: finalText,
            updateMode: 'replace',
            final: true,
          });
        }
        flushPendingTranscriptIfNeeded();
      },
      onClose(finalText, detail = {}) {
        if (detail.sessionId !== activeDoubaoSessionId || transcriptOwner !== 'asr') {
          ignoredStaleTranscriptCallbacks += 1;
          return;
        }
        if (finalText && finalText !== latestTranscriptSnapshot) {
          acceptDoubaoTranscriptUpdate({
            sessionId,
            sequence: detail.sequence,
            text: finalText,
            updateMode: 'replace',
            final: true,
          });
        }
        doubaoSession = null;
        activeDoubaoSessionId = 0;
        if (silenceStopRequested) {
          recoverFromSilenceStop();
        }
      },
    }, {
      stream,
      preAudioBytes,
      closeStreamOnStop,
      sessionId,
    });

    if (
      activeDoubaoSessionId !== sessionId ||
      transcriptOwner !== 'asr' ||
      !isConversationActive
    ) {
      await session.stop().catch(() => {});
      return null;
    }
    doubaoSession = session;
    await setupAudioMonitoring(session.stream, { ownsStream: monitorOwnsStream });
    beginVisualSession(
      resetTimer,
      visualState || (usingDoubaoRecognition ? 'doubao-streaming' : 'listening'),
      { resetTurn: false },
    );
    return session;
  })();

  try {
    return await doubaoStartPromise;
  } finally {
    doubaoStartPromise = null;
  }
}

async function startDoubaoVadConversation({ resetTimer = true } = {}) {
  usingDoubaoRecognition = true;
  let visualStarted = false;
  const gate = await createLocalVadGate({
    async onStreamReady(stream) {
      if (!isConversationActive) return;
      await setupAudioMonitoring(stream, { ownsStream: false });
      beginVisualSession(resetTimer, 'vad-standby');
      visualStarted = true;
    },
    onSpeechMaybeStart() {
      localVadSpeechActive = true;
      lastLocalVadSpeechEndAt = 0;
      clearDoubaoVadEmptyTailTimer();
      if (!isConversationActive || isPaused || doubaoSession || doubaoStartPromise) return;
      console.info('[voice-vad] maybe speech detected; confirming before Doubao start');
      setVoiceVisualState('vad-checking');
    },
    onIgnoredSpeechStart(detail) {
      console.info('[voice-vad] ignored speech trigger:', detail);
      localVadSpeechActive = false;
      lastLocalVadSpeechEndAt = Date.now();
      if (!isConversationActive || isPaused || doubaoSession || doubaoStartPromise) return;
      setVoiceVisualState('vad-standby');
    },
    onVADMisfire() {
      console.info('[voice-vad] misfire ignored');
      localVadSpeechActive = false;
      lastLocalVadSpeechEndAt = Date.now();
      if (!isConversationActive || isPaused || doubaoSession || doubaoStartPromise) return;
      setVoiceVisualState('vad-standby');
    },
    onSpeechStart(detail) {
      localVadSpeechActive = true;
      lastLocalVadSpeechEndAt = 0;
      clearDoubaoVadEmptyTailTimer();
      if (!isConversationActive || isPaused || doubaoSession || doubaoStartPromise) return;
      console.info('[voice-vad] confirmed speech; starting Doubao ASR:', detail);
      void startDoubaoConversation({
        resetTimer: false,
        stream: gate.stream,
        preAudioBytes: gate.getPreRollPcm(),
        closeStreamOnStop: false,
        monitorOwnsStream: false,
      }).catch((error) => {
        console.error('[waveform] VAD triggered Doubao start failed:', error);
        notifyVoiceStartFailed(error.message);
      });
    },
    onSpeechEnd() {
      localVadSpeechActive = false;
      lastLocalVadSpeechEndAt = Date.now();
      if (!isConversationActive || isPaused) return;
      if (!doubaoSession) {
        gate.resetPreRoll();
        return;
      }
      const sessionAtSpeechEnd = doubaoSession;
      clearDoubaoVadEmptyTailTimer();
      if (!hasPendingMeaningfulTranscript()) {
        doubaoVadEmptyTailTimer = setTimeout(() => {
          doubaoVadEmptyTailTimer = null;
          if (!isConversationActive || isPaused || doubaoSession !== sessionAtSpeechEnd) return;
          if (hasPendingMeaningfulTranscript()) return;
          stopDoubaoRecognition();
          resetTurnState();
          setVoiceVisualState('vad-standby');
        }, DOUBAO_VAD_EMPTY_TAIL_MS);
      }
      gate.resetPreRoll();
    },
  });

  localVadGate = gate;
  await gate.start();
  if (!visualStarted && gate.stream) {
    await setupAudioMonitoring(gate.stream, { ownsStream: false });
    beginVisualSession(resetTimer, 'vad-standby');
  }
}

async function startDoubaoInputConversation(options = {}) {
  if (shouldUseDoubaoAlwaysOn()) {
    return startDoubaoConversation(options);
  }

  try {
    lastVadError = '';
    return await startDoubaoVadConversation(options);
  } catch (error) {
    lastVadError = error?.message || String(error);
    console.warn('[waveform] local VAD unavailable, falling back to always-on Doubao ASR:', error);
    notifyVoiceStartFailed(`\u672c\u5730\u4eba\u58f0\u68c0\u6d4b\u4e0d\u53ef\u7528\uff0c\u5df2\u4e34\u65f6\u6539\u7528\u8c46\u5305\u5e38\u5f00\u8bc6\u522b: ${lastVadError}`);
    return startDoubaoConversation({ ...options, visualState: 'vad-error' });
  }
}

export function initWaveform(completeCallback) {
  $waveformBar = document.getElementById('waveformBar');
  $waveformCanvas = document.getElementById('waveformCanvas');
  $waveTime = document.getElementById('waveTime');
  $waveStatus = document.getElementById('waveStatus');
  $waveSubmitBtn = document.getElementById('waveSubmitBtn');
  $recordBtn = document.getElementById('recordBtn');
  ctx = $waveformCanvas?.getContext('2d') || null;
  onTextComplete = completeCallback;

  $recordBtn?.addEventListener('click', toggleConversation);
  $waveSubmitBtn?.addEventListener('click', submitCurrentVoiceTurn);
  if (!manualEditListenersBound) {
    manualEditListenersBound = true;
    const chatInput = document.getElementById('chatInput');
    const requestManualEdit = () => {
      void enterManualEditMode();
    };
    chatInput?.addEventListener('focus', requestManualEdit);
    chatInput?.addEventListener('pointerdown', requestManualEdit);
    document.addEventListener('chat:manual-input-committed', () => {
      void resumeAfterManualEdit().catch((error) => {
        console.error('[waveform] resume after manual edit failed:', error);
        notifyVoiceStartFailed(error.message);
      });
    });
  }

  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    console.warn('闂佽崵鍠愮划搴㈡櫠濡ゅ懎绠伴柛娑橈攻濞呯娀鏌ｅΟ娆炬⒖缁绢厼鎳愰悿鈧┑顔矫崥瀣礊瀹€鍕拺闂傚牃鏅濈粊鐑芥煕閺傛鍎戠紒顕呭幗瀵板嫰骞囬鍌氭憢婵＄偑鍊栭悧妤冪矙閹达附鍎婃い鏇楀亾闁哄本绋戣灒闁绘挸瀛╅悘渚€姊?SpeechRecognition闂傚倷鐒︾€笛呯矙閹达附鍎楅柛灞惧搸閳ь剚甯″畷婊勬媴閻熺増姣?Chrome 闂?Edge');
  }
}

export async function pauseListening(reason) {
  if (isPaused) return;
  await pauseListeningForPlayback(reason);
}

export async function resumeListening() {
  if (!isConversationActive) return;
  if (resumePromise) return resumePromise;

  resumePromise = (async () => {
    if (!isConversationActive) return;

    if (usingDoubaoRecognition) {
      if (!shouldUseDoubaoAlwaysOn()) {
        if (!localVadGate) {
          await startDoubaoInputConversation({ resetTimer: false });
        } else {
          beginVisualSession(false, 'vad-standby');
        }
      } else if (!doubaoSession) {
        await startDoubaoConversation({ resetTimer: false });
      } else {
        beginVisualSession(false);
      }
      notifyVoiceWaiting();
      return;
    }

    beginVisualSession(false);
    if (!recognition) {
      const SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SRec) {
        throw new Error('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u539f\u751f\u8bed\u97f3\u8bc6\u522b\uff0c\u8bf7\u4f7f\u7528 Chrome \u6216 Edge\u3002');
      }
      createBrowserRecognition(SRec);
    }

    try {
      recognition.start();
    } catch (e) {}
    notifyVoiceWaiting();
  })();

  try {
    await resumePromise;
  } finally {
    resumePromise = null;
  }
}

export function isListeningActive() {
  return isConversationActive && !isPaused;
}

export function isUsingDoubaoRecognition() {
  return usingDoubaoRecognition;
}

export function hasActiveDoubaoSession() {
  return !!doubaoSession;
}

if (typeof window !== 'undefined') {
  window.__VOICE_DEBUG_STATE__ = () => ({
    isConversationActive,
    isPaused,
    usingDoubaoRecognition,
    doubaoAlwaysOn: shouldUseDoubaoAlwaysOn(),
    hasLocalVadGate: !!localVadGate,
    hasDoubaoSession: !!doubaoSession,
    voiceVisualState,
    lastVadError,
    latestInterimTranscript,
    latestFinalTranscript,
    latestTranscriptSnapshot,
    transcriptOwner,
    activeDoubaoSessionId,
    lastTranscriptUpdateMode,
    ignoredStaleTranscriptCallbacks,
    lastTranscriptReplaceAt,
    lastTranscriptAppendAt,
    lastManualPauseAt,
    localVadSpeechActive,
    lastLocalVadSpeechEndAt,
    localVadTurnSettled: isLocalVadTurnSettled(),
  });
}

async function toggleConversation() {
  if (isConversationActive) {
    await stopConversation();
  } else {
    await startConversation();
  }
}

async function startConversation() {
  try {
    if (!isRecognitionEnabled()) {
      notifyVoiceStartFailed('\u8bed\u97f3\u8f6c\u5199\u5df2\u5173\u95ed');
      return;
    }
    transcriptOwner = 'asr';
    if (shouldUseBrowserRecognition()) {
      await startBrowserConversation({ resetTimer: true });
    } else {
      await startDoubaoInputConversation({ resetTimer: true });
    }
    notifyVoiceStarted();
  } catch (err) {
    console.error('\u9ea6\u514b\u98ce\u6743\u9650\u88ab\u62d2\u7edd\u6216\u8bed\u97f3\u542f\u52a8\u5931\u8d25', err);
    notifyVoiceStartFailed(err.message);
    alert(`\u8bed\u97f3\u542f\u52a8\u5931\u8d25\uff1a${err.message}`);
    await stopConversation();
  }
}

export async function stopConversation() {
  const preserveManualInput = transcriptOwner === 'user';
  isConversationActive = false;
  isPaused = false;
  usingDoubaoRecognition = false;
  resumePromise = null;
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  turnCompleted = false;
  latestInterimTranscript = '';
  latestFinalTranscript = '';
  latestTranscriptSnapshot = '';
  latestSubmittedTranscript = '';
  latestSubmittedAt = 0;
  recentSubmittedTranscripts = [];
  autoSubmitBlockedTranscript = '';
  lastTranscriptSnapshot = '';
  activeDoubaoSessionId = 0;
  clearTranscriptSilenceTimer();
  clearPendingAutoSubmitTimer();

  stopBrowserRecognition({ resetInstance: true });
  stopDoubaoRecognition();
  await stopLocalVadGate();

  await teardownAudioMonitoring();
  clearVisualSession({ preserveInput: preserveManualInput });
  transcriptOwner = 'asr';
  notifyVoiceStopped();
}

function drawWaveform() {
  if (!isConversationActive || !analyser || !$waveformCanvas || !ctx) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const timeDomainArray = new Uint8Array(analyser.fftSize);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    if (!analyser || !$waveformCanvas || !ctx) return;

    analyser.getByteFrequencyData(dataArray);
    analyser.getByteTimeDomainData(timeDomainArray);

    const audioLevel = computeAudioLevel(timeDomainArray);
    if (!isPaused) {
      markAudioActivity(audioLevel);
      if (shouldAutoStopForSilence()) {
        requestSilenceStop();
      }
    }

    const { width: w, height: h } = $waveformCanvas;
    ctx.clearRect(0, 0, w, h);

    const barWidth = (w / bufferLength) * 2;
    let x = 0;

    for (let i = 0; i < bufferLength; i += 1) {
      const value = dataArray[i] / 255;
      const barH = value * h * 0.85;
      const gradientOffset = (i / bufferLength) * 24;
      const baseHue = voiceVisualState === 'vad-standby'
        ? 174
        : voiceVisualState === 'vad-checking'
          ? 42
        : voiceVisualState === 'vad-error' || voiceVisualState === 'doubao-streaming'
          ? 350
          : 270;
      const hue = baseHue + gradientOffset;
      ctx.fillStyle = isPaused
        ? `rgba(150, 150, 150, ${0.4 + value * 0.4})`
        : `hsla(${hue}, 78%, 54%, ${0.4 + value * 0.6})`;
      ctx.fillRect(x, (h - barH) / 2, barWidth - 1, barH);
      x += barWidth;
    }
  }

  draw();
}

function updateTimer() {
  if (!isConversationActive) return;

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const secs = String(elapsed % 60).padStart(2, '0');
  if ($waveTime) {
    $waveTime.textContent = `${mins}:${secs}`;
  }

  setTimeout(updateTimer, 500);
}
