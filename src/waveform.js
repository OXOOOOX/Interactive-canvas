/**
 * waveform.js — 浏览器 / 豆包流式语音识别 + 动态波浪支持
 */

import { startDoubaoStreamingRecognition } from './services/doubao-asr.js';

const SILENCE_TIMEOUT_MS = 1600;
const STARTUP_GRACE_MS = 900;
const AUDIO_ACTIVITY_THRESHOLD = 0.14;

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
let lastSpeechAt = 0;
let voiceSessionStartedAt = 0;
let latestInterimTranscript = '';
let latestFinalTranscript = '';
let latestSubmittedTranscript = '';
let turnCompleted = false;
let silenceRecoveryTimer = null;

let $waveformBar;
let $waveformCanvas;
let $waveTime;
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

function getTranscriptText(text) {
  return window.__VOICE_TRANSCRIPT_TEXT__?.(text) ?? (text || '').trim();
}

function isMeaningfulTranscript(text) {
  if (window.__VOICE_TRANSCRIPT_VALID__) {
    return window.__VOICE_TRANSCRIPT_VALID__(text);
  }
  return !!text && text.replace(/[^\w一-龥]/g, '').length > 0;
}

function shouldUseBrowserRecognition() {
  return !!getVoiceHelpers().shouldUseBrowserRecognition?.();
}

function getVoiceConfig() {
  return window.__GET_CONFIG__?.() || {};
}

function bindInputInterim(text) {
  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.value = text || '';
  }
}

function clearSilenceRecoveryTimer() {
  if (silenceRecoveryTimer) {
    clearTimeout(silenceRecoveryTimer);
    silenceRecoveryTimer = null;
  }
}

function resetTurnState({ clearSubmitted = false } = {}) {
  clearSilenceRecoveryTimer();
  silenceStopRequested = false;
  hasDetectedSpeech = false;
  lastSpeechAt = Date.now();
  voiceSessionStartedAt = Date.now();
  latestInterimTranscript = '';
  latestFinalTranscript = '';
  turnCompleted = false;
  if (clearSubmitted) {
    latestSubmittedTranscript = '';
  }
}

function scheduleSilenceRecoveryFallback() {
  clearSilenceRecoveryTimer();
  silenceRecoveryTimer = setTimeout(() => {
    silenceRecoveryTimer = null;
    recoverFromSilenceStop();
  }, 1400);
}

function flushPendingTranscriptIfNeeded() {
  if (!silenceStopRequested || turnCompleted || !isConversationActive) return false;
  if (!hasPendingMeaningfulTranscript()) return false;
  const pending = getPendingTranscript();
  clearSilenceRecoveryTimer();
  return submitRecognizedText(pending, { autoStopped: true });
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
  lastSpeechAt = Date.now();
  if (isMeaningfulTranscript(cleaned)) {
    hasDetectedSpeech = true;
  }
  return cleaned;
}

function markAudioActivity(level) {
  if (level < AUDIO_ACTIVITY_THRESHOLD) return;
  lastSpeechAt = Date.now();
  hasDetectedSpeech = true;
}

function getPendingTranscript() {
  return getTranscriptText(latestFinalTranscript || latestInterimTranscript || '');
}

function hasPendingMeaningfulTranscript() {
  return isMeaningfulTranscript(getPendingTranscript());
}

function clearListeningUi() {
  if ($waveformBar) $waveformBar.classList.remove('active');
  if ($recordBtn) $recordBtn.classList.remove('recording');
}

function beginVisualSession(resetTimer = false) {
  const wasActive = isConversationActive;
  isConversationActive = true;
  isPaused = false;
  resetTurnState({ clearSubmitted: true });
  if (resetTimer || !wasActive) {
    startTime = Date.now();
    updateTimer();
  }
  if ($recordBtn) $recordBtn.classList.add('recording');
  if ($waveformBar) $waveformBar.classList.add('active');
  if (!wasActive) {
    drawWaveform();
  }
}

function clearVisualSession() {
  cancelAnimationFrame(animFrameId);
  clearListeningUi();
  bindInputInterim('');
}

async function teardownAudioMonitoring() {
  if (streamGlobal) {
    streamGlobal.getTracks().forEach(track => track.stop());
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
  try { recognition.stop(); } catch (e) {}
  if (resetInstance) {
    recognition = null;
  }
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

function pauseListeningUiOnly() {
  if (isPaused) return;
  isPaused = true;
  clearListeningUi();
}

function pauseListeningForPlayback() {
  pauseListeningUiOnly();
  silenceStopRequested = false;
  stopBrowserRecognition();
  stopDoubaoRecognition();
}

function submitRecognizedText(text, { autoStopped = false } = {}) {
  const cleaned = getTranscriptText(text);
  if (!isMeaningfulTranscript(cleaned)) return false;
  if (turnCompleted && latestSubmittedTranscript === cleaned) return false;

  pauseListeningUiOnly();
  stopBrowserRecognition();
  stopDoubaoRecognition();

  turnCompleted = true;
  latestSubmittedTranscript = cleaned;
  latestFinalTranscript = cleaned;
  latestInterimTranscript = '';
  silenceStopRequested = false;
  bindInputInterim('');

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
  if (!hasDetectedSpeech) return;

  silenceStopRequested = true;
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
  pauseListeningUiOnly();

  if (usingDoubaoRecognition) {
    stopDoubaoRecognition();
    return;
  }

  stopBrowserRecognition();
}

function shouldAutoStopForSilence(level) {
  if (!isConversationActive || isPaused || silenceStopRequested) return false;
  if (!hasDetectedSpeech) return false;
  if (!hasPendingMeaningfulTranscript()) return false;
  if (Date.now() - voiceSessionStartedAt < STARTUP_GRACE_MS) return false;
  if (level >= AUDIO_ACTIVITY_THRESHOLD) return false;
  return Date.now() - lastSpeechAt >= SILENCE_TIMEOUT_MS;
}

function computeAudioLevel(dataArray) {
  let total = 0;
  for (let i = 0; i < dataArray.length; i += 1) {
    total += dataArray[i] / 255;
  }
  return total / dataArray.length;
}

function createBrowserRecognition(SRec) {
  recognition = new SRec();
  recognition.lang = getVoiceLanguage();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
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
      bindInputInterim(interimTranscript);
      markTranscriptActivity(interimTranscript, { final: false });
    }

    if (finalTranscript) {
      markTranscriptActivity(finalTranscript, { final: true });
      submitRecognizedText(finalTranscript, { autoStopped: silenceStopRequested });
    }
  };

  recognition.onend = () => {
    if (silenceStopRequested) {
      recoverFromSilenceStop();
      return;
    }
    if (isConversationActive && !isPaused) {
      try { recognition.start(); } catch (e) {}
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech') {
      console.error('Speech recognition error:', event.error);
    }
  };
};

async function startBrowserConversation({ resetTimer = true } = {}) {
  usingDoubaoRecognition = false;
  const SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRec) {
    throw new Error('您的浏览器不支持原生语音识别，请使用 Chrome 或 Edge。');
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
      console.log('[waveform] Doubao onInterim:', text, 'isPaused=', isPaused);
      if (isPaused && !silenceStopRequested) return;
      bindInputInterim(text);
      markTranscriptActivity(text, { final: false });
    },
    onFinal(fullText) {
      console.log('[waveform] Doubao onFinal:', fullText, 'isPaused=', isPaused, 'silenceStopRequested=', silenceStopRequested);
      if (!isMeaningfulTranscript(fullText)) return;
      if (turnCompleted && latestSubmittedTranscript === getTranscriptText(fullText)) return;
      markTranscriptActivity(fullText, { final: true });
      submitRecognizedText(fullText, { autoStopped: silenceStopRequested });
    },
    onError(error) {
      console.error('[waveform] Doubao onError:', error);
    },
    onComplete(finalText) {
      console.log('[waveform] Doubao onComplete:', finalText);
      if (finalText) {
        markTranscriptActivity(finalText, { final: true });
      }
      flushPendingTranscriptIfNeeded();
    },
    onClose(finalText) {
      console.log('[waveform] Doubao onClose:', finalText);
      if (finalText) {
        markTranscriptActivity(finalText, { final: true });
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
  $recordBtn = document.getElementById('recordBtn');
  ctx = $waveformCanvas.getContext('2d');
  onTextComplete = completeCallback;

  $recordBtn.addEventListener('click', toggleConversation);

  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    console.warn('当前浏览器不支持原生 SpeechRecognition，需要 Chrome/Edge');
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
        throw new Error('您的浏览器不支持原生语音识别，请使用 Chrome 或 Edge。');
      }
      createBrowserRecognition(SRec);
    }

    try { recognition.start(); } catch (e) {}
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
    if (shouldUseBrowserRecognition()) {
      await startBrowserConversation({ resetTimer: true });
    } else {
      await startDoubaoConversation({ resetTimer: true });
    }
    notifyVoiceStarted();
  } catch (err) {
    console.error('麦克风权限被拒绝或启动失败:', err);
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

  stopBrowserRecognition({ resetInstance: true });
  stopDoubaoRecognition();

  await teardownAudioMonitoring();
  clearVisualSession();
  notifyVoiceStopped();
}

function drawWaveform() {
  if (!isConversationActive || !analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);

    const level = computeAudioLevel(dataArray);
    if (!isPaused) {
      markAudioActivity(level);
      if (shouldAutoStopForSilence(level)) {
        requestSilenceStop();
      }
    }

    const w = $waveformCanvas.width;
    const h = $waveformCanvas.height;
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
