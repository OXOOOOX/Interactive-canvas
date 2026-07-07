/**
 * waveform.js - browser / Doubao streaming ASR with waveform UI.
 */

import { startDoubaoStreamingRecognition } from './services/doubao-asr.js';

const SILENCE_TIMEOUT_MS = 2800;
const STARTUP_GRACE_MS = 1200;
const AUDIO_ACTIVITY_THRESHOLD = 0.018;
const MAX_RECENT_SUBMITTED_TRANSCRIPTS = 6;

let analyser = null;
let animFrameId = null;
let startTime = 0;

let audioCtx = null;
let streamGlobal = null;
let doubaoSession = null;
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
let latestSubmittedTranscript = '';
let latestSubmittedAt = 0;
let recentSubmittedTranscripts = [];
let autoSubmitBlockedTranscript = '';
let lastTranscriptSnapshot = '';
let turnCompleted = false;
let silenceRecoveryTimer = null;
let transcriptSilenceTimer = null;
let pendingAutoSubmitTimer = null;
let pausedStatusText = '等待模型回复';

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
    return getTranscriptText(incoming.source.slice(endSourceIndex + 1).replace(/^[\s,，.。!！?？;；:：、-]+/, ''));
  }

  if (
    incoming.normalized === submitted.normalized ||
    submitted.normalized.startsWith(incoming.normalized)
  ) {
    return '';
  }

  if (incoming.normalized.startsWith(submitted.normalized)) {
    const endIndex = incoming.map[submitted.normalized.length - 1] ?? -1;
    return getTranscriptText(incoming.source.slice(endIndex + 1).replace(/^[\s,，.。!！?？;；:：、-]+/, ''));
  }

  return incoming.source;
}

function getFreshTranscriptAfterSubmitted(text = '') {
  const anchors = getSubmittedTranscriptAnchors();
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

function bindInputInterim(text) {
  const chatInput = document.getElementById('chatInput');
  if (!chatInput) return;
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

function scheduleTranscriptSilenceStop() {
  clearTranscriptSilenceTimer();
  transcriptSilenceTimer = setTimeout(() => {
    transcriptSilenceTimer = null;
    if (Date.now() - lastTranscriptAt >= SILENCE_TIMEOUT_MS) {
      requestSilenceStop();
      return;
    }
    if (isConversationActive && !isPaused && !silenceStopRequested) {
      scheduleTranscriptSilenceStop();
    }
  }, SILENCE_TIMEOUT_MS + 80);
}

function resetTurnState({ clearSubmitted = false } = {}) {
  clearSilenceRecoveryTimer();
  clearTranscriptSilenceTimer();
  clearPendingAutoSubmitTimer();
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  const now = Date.now();
  lastTranscriptAt = now;
  lastAudioActivityAt = now;
  voiceSessionStartedAt = now;
  latestInterimTranscript = '';
  latestFinalTranscript = '';
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
  return getTranscriptText(latestFinalTranscript || latestInterimTranscript || inputText || '');
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
    .replace(/[\s,，.。!?！？;；:：'"“”‘’、\-—_()[\]{}<>《》]/g, '');
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

function setVoiceVisualState(state, label) {
  const isListening = state === 'listening';
  const isPausedState = state === 'paused';
  const isVisible = isListening || isPausedState;
  if (label) pausedStatusText = label;

  if ($waveformBar) {
    $waveformBar.classList.toggle('active', isVisible);
    $waveformBar.classList.toggle('is-listening', isListening);
    $waveformBar.classList.toggle('is-paused', isPausedState);
    $waveformBar.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
  }

  if ($recordBtn) {
    $recordBtn.classList.toggle('recording', isListening);
    $recordBtn.classList.toggle('paused', isPausedState);
  }

  if ($waveStatus) {
    $waveStatus.textContent = isListening ? '正在收听' : isPausedState ? pausedStatusText : '';
  }
}

function beginVisualSession(resetTimer = false) {
  const wasActive = isConversationActive;
  isConversationActive = true;
  isPaused = false;
  resetTurnState({ clearSubmitted: resetTimer || !wasActive });
  if (resetTimer || !wasActive) {
    startTime = Date.now();
    updateTimer();
  }
  setVoiceVisualState('listening');
  if (!wasActive) drawWaveform();
}

function clearVisualSession() {
  cancelAnimationFrame(animFrameId);
  setVoiceVisualState('idle');
  bindInputInterim('');
}

async function teardownAudioMonitoring() {
  if (streamGlobal) {
    streamGlobal.getTracks().forEach((track) => track.stop());
    streamGlobal = null;
  }
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
}

async function setupAudioMonitoring(stream) {
  await teardownAudioMonitoring();
  streamGlobal = stream;
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
  if (!doubaoSession) return;
  const session = doubaoSession;
  doubaoSession = null;
  session.stop().catch(() => {});
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

function pauseListeningUiOnly(label = '等待模型回复') {
  pausedStatusText = label;
  if (isPaused) {
    setVoiceVisualState('paused', label);
    return;
  }
  isPaused = true;
  setVoiceVisualState('paused', label);
}

function pauseListeningForPlayback() {
  pauseListeningUiOnly('语音播报中');
  silenceStopRequested = false;
  clearTranscriptSilenceTimer();
  stopBrowserRecognition();
  stopDoubaoRecognition();
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

  latestSubmittedTranscript = cleaned;
  latestSubmittedAt = Date.now();
  rememberSubmittedTranscript(cleaned);
  autoSubmitBlockedTranscript = '';
  turnCompleted = true;
  latestFinalTranscript = '';
  latestInterimTranscript = '';
  lastTranscriptSnapshot = '';
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  lastTranscriptAt = Date.now();
  lastAudioActivityAt = Date.now();
  voiceSessionStartedAt = Date.now();
  bindInputInterim('');
  setVoiceVisualState('listening');

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
  if (!isVoiceAutoSubmitAllowed()) {
    blockAutoSubmitForCurrentPending();
    return;
  }

  silenceStopRequested = true;
  clearTranscriptSilenceTimer();
  const submitted = flushPendingTranscriptIfNeeded();
  if (submitted) {
    return;
  }

  scheduleSilenceRecoveryFallback();
  schedulePendingAutoSubmit();
  pauseListeningUiOnly('等待模型回复');

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
    throw new Error('当前浏览器不支持原生语音识别，请使用 Chrome 或 Edge。');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await setupAudioMonitoring(stream);
  createBrowserRecognition(SRec);
  beginVisualSession(resetTimer);
  recognition.start();
}

async function startDoubaoConversation({ resetTimer = true } = {}) {
  usingDoubaoRecognition = true;
  const config = getVoiceConfig();
  const session = await startDoubaoStreamingRecognition(config, {
    onInterim(text) {
      if (!isConversationActive) return;
      if (isPaused && !silenceStopRequested) return;
      const combinedInterim = getFreshTranscriptAfterSubmitted(mergeTranscriptText(latestFinalTranscript, text));
      if (!combinedInterim) return;
      bindInputInterim(combinedInterim);
      markTranscriptActivity(combinedInterim, { final: false });
    },
    onFinal(fullText) {
      if (!isConversationActive) return;
      if (!isMeaningfulTranscript(fullText)) return;
      if (
        turnCompleted &&
        normalizeTranscriptForDedupe(latestSubmittedTranscript) === normalizeTranscriptForDedupe(fullText)
      ) return;
      const filteredFinal = getFreshTranscriptAfterSubmitted(fullText);
      if (!filteredFinal) return;
      const mergedFinal = mergeTranscriptText(latestFinalTranscript, filteredFinal);
      markTranscriptActivity(mergedFinal, { final: true });
      bindInputInterim(mergedFinal);
      if (silenceStopRequested) {
        submitRecognizedText(mergedFinal, { autoStopped: true });
      }
    },
    onError(error) {
      console.error('[waveform] Doubao onError:', error);
    },
    onComplete(finalText) {
      if (!isConversationActive) return;
      const filteredFinal = getFreshTranscriptAfterSubmitted(finalText);
      if (filteredFinal) {
        markTranscriptActivity(mergeTranscriptText(latestFinalTranscript, filteredFinal), { final: true });
      }
      flushPendingTranscriptIfNeeded();
    },
    onClose(finalText) {
      if (!isConversationActive) {
        if (doubaoSession === session) {
          doubaoSession = null;
        }
        return;
      }
      const filteredFinal = getFreshTranscriptAfterSubmitted(finalText);
      if (filteredFinal) {
        markTranscriptActivity(mergeTranscriptText(latestFinalTranscript, filteredFinal), { final: true });
      }
      if (doubaoSession === session) {
        doubaoSession = null;
      }
      if (silenceStopRequested) {
        recoverFromSilenceStop();
      }
    },
  });

  doubaoSession = session;
  await setupAudioMonitoring(session.stream);
  beginVisualSession(resetTimer);
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

  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    console.warn('当前浏览器不支持原生 SpeechRecognition，需要 Chrome 或 Edge');
  }
}

export function pauseListening() {
  if (isPaused) return;
  pauseListeningForPlayback();
}

export async function resumeListening() {
  if (!isConversationActive) return;
  if (resumePromise) return resumePromise;

  resumePromise = (async () => {
    if (!isConversationActive) return;

    if (usingDoubaoRecognition) {
      if (!doubaoSession) {
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
        throw new Error('当前浏览器不支持原生语音识别，请使用 Chrome 或 Edge。');
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
      notifyVoiceStartFailed('语音转写已关闭');
      return;
    }
    if (shouldUseBrowserRecognition()) {
      await startBrowserConversation({ resetTimer: true });
    } else {
      await startDoubaoConversation({ resetTimer: true });
    }
    notifyVoiceStarted();
  } catch (err) {
    console.error('麦克风权限被拒绝或语音启动失败', err);
    notifyVoiceStartFailed(err.message);
    alert(`语音启动失败：${err.message}`);
    await stopConversation();
  }
}

export async function stopConversation() {
  isConversationActive = false;
  isPaused = false;
  usingDoubaoRecognition = false;
  resumePromise = null;
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  turnCompleted = false;
  latestInterimTranscript = '';
  latestFinalTranscript = '';
  latestSubmittedTranscript = '';
  latestSubmittedAt = 0;
  recentSubmittedTranscripts = [];
  autoSubmitBlockedTranscript = '';
  lastTranscriptSnapshot = '';
  clearTranscriptSilenceTimer();
  clearPendingAutoSubmitTimer();

  stopBrowserRecognition({ resetInstance: true });
  stopDoubaoRecognition();

  await teardownAudioMonitoring();
  clearVisualSession();
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
      const hue = 270 + (i / bufferLength) * 90;
      ctx.fillStyle = isPaused
        ? `rgba(150, 150, 150, ${0.4 + value * 0.4})`
        : `hsla(${hue}, 80%, 60%, ${0.4 + value * 0.6})`;
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
