/**
 * waveform.js — 浏览器 / 豆包流式语音识别 + 动态波浪支持
 */

import { startDoubaoStreamingRecognition } from './services/doubao-asr.js';

let analyser = null;
let animFrameId = null;
let startTime = 0;

let audioCtx = null;
let streamGlobal = null;
let doubaoSession = null;
let usingDoubaoRecognition = false;

// Speech Recognition
let recognition = null;

// VAD / 状态
export let isConversationActive = false;
let isPaused = false;

let $waveformBar, $waveformCanvas, $waveTime, $recordBtn;
let ctx = null;
let onTextComplete = () => {};

function getVoiceHelpers() {
  return window.__VOICE_MODE_HELPERS__ || {};
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
  return !!text && text.replace(/[^\w\u4e00-\u9fa5]/g, '').length > 0;
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

function beginVisualSession() {
  isConversationActive = true;
  isPaused = false;
  startTime = Date.now();
  $recordBtn.classList.add('recording');
  $waveformBar.classList.add('active');
  drawWaveform();
  updateTimer();
}

function clearVisualSession() {
  cancelAnimationFrame(animFrameId);
  $recordBtn.classList.remove('recording');
  $waveformBar.classList.remove('active');
  bindInputInterim('');
}

async function setupAudioMonitoring(stream) {
  streamGlobal = stream;
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
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
  isPaused = true;
  $waveformBar.classList.remove('active');
  $recordBtn.classList.remove('recording');

  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }

  if (usingDoubaoRecognition && doubaoSession) {
    doubaoSession.stop().catch(() => {});
    doubaoSession = null;
  }
}

export function resumeListening() {
  if (!isConversationActive) return;
  isPaused = false;

  $waveformBar.classList.add('active');
  $recordBtn.classList.add('recording');

  if (recognition) {
    try { recognition.start(); } catch (e) {}
  }
}

async function toggleConversation() {
  if (isConversationActive) {
    stopConversation();
  } else {
    await startConversation();
  }
}

async function startBrowserConversation() {
  usingDoubaoRecognition = false;
  const SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRec) {
    alert('您的浏览器不支持原生语音识别，请使用 Chrome 或 Edge。');
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  await setupAudioMonitoring(stream);
  beginVisualSession();

  recognition = new SRec();
  recognition.lang = getVoiceLanguage();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    if (isPaused) return;

    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = e.resultIndex; i < e.results.length; ++i) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }

    if (interimTranscript) bindInputInterim(interimTranscript);

    if (finalTranscript) {
      bindInputInterim('');
      pauseListening();
      onTextComplete(finalTranscript.trim());
    }
  };

  recognition.onend = () => {
    if (isConversationActive && !isPaused) {
      try { recognition.start(); } catch (e) {}
    }
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') {
      console.error('Speech recognition error:', e.error);
    }
  };

  recognition.start();
}

async function startDoubaoConversation() {
  usingDoubaoRecognition = true;
  const config = getVoiceConfig();
  doubaoSession = await startDoubaoStreamingRecognition(config, {
    onInterim(text) {
      if (isPaused) return;
      bindInputInterim(text);
    },
    onFinal(fullText) {
      if (isPaused) return;
      const cleaned = getTranscriptText(fullText);
      if (!isMeaningfulTranscript(cleaned)) return;
      bindInputInterim('');
      pauseListening();
      onTextComplete(cleaned);
    },
    onError(error) {
      console.error('Doubao streaming ASR error:', error);
    },
  });

  await setupAudioMonitoring(doubaoSession.stream);
  beginVisualSession();
}

async function startConversation() {
  try {
    if (shouldUseBrowserRecognition()) {
      await startBrowserConversation();
      return;
    }
    await startDoubaoConversation();
  } catch (err) {
    console.error('麦克风权限被拒绝或启动失败:', err);
    alert(`语音启动失败：${err.message}`);
    stopConversation();
  }
}

export function stopConversation() {
  isConversationActive = false;
  isPaused = false;
  usingDoubaoRecognition = false;

  if (recognition) {
    try { recognition.stop(); } catch (e) {}
    recognition = null;
  }

  if (doubaoSession) {
    doubaoSession.stop().catch(() => {});
    doubaoSession = null;
  }

  if (streamGlobal) {
    streamGlobal.getTracks().forEach(t => t.stop());
    streamGlobal = null;
  }

  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  analyser = null;
  clearVisualSession();
}

function drawWaveform() {
  if (!isConversationActive || !analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);

    const w = $waveformCanvas.width;
    const h = $waveformCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const barWidth = (w / bufferLength) * 2;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const vOriginal = dataArray[i];
      const v = vOriginal / 255;
      const barH = v * h * 0.85;

      const hue = 270 + (i / bufferLength) * 90;
      if (isPaused) {
        ctx.fillStyle = `rgba(150, 150, 150, ${0.4 + v * 0.4})`;
      } else {
        ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${0.4 + v * 0.6})`;
      }
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
