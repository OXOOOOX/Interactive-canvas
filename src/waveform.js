/**
 * waveform.js — 原生浏览器 Web Speech API + 动态波浪支持
 */

let analyser = null;
let animFrameId = null;
let startTime = 0;

let audioCtx = null;
let streamGlobal = null;

// Speech Recognition
let recognition = null;

// VAD / 状态
export let isConversationActive = false;
let isPaused = false; // 用于在 AI 说话时暂停监听

let $waveformBar, $waveformCanvas, $waveTime, $recordBtn;
let ctx = null;
let onTextComplete = () => {};

export function initWaveform(completeCallback) {
  $waveformBar = document.getElementById('waveformBar');
  $waveformCanvas = document.getElementById('waveformCanvas');
  $waveTime = document.getElementById('waveTime');
  $recordBtn = document.getElementById('recordBtn');
  ctx = $waveformCanvas.getContext('2d');
  onTextComplete = completeCallback;

  $recordBtn.addEventListener('click', toggleConversation);
  
  // 预检
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    console.warn('当前浏览器不支持原生 SpeechRecognition，需要 Chrome/Edge');
  }
}

// 供外部调用，AI 开始说话时暂停监听
export function pauseListening() {
  if (isPaused) return;
  isPaused = true;
  $waveformBar.classList.remove('active');
  $recordBtn.classList.remove('recording');

  if (recognition) {
    try { recognition.stop(); } catch(e) {}
  }
}

// AI 说完文字后调用，恢复监听
export function resumeListening() {
  if (!isConversationActive) return;
  isPaused = false;
  
  $waveformBar.classList.add('active');
  $recordBtn.classList.add('recording');

  if (recognition) {
    try { recognition.start(); } catch(e) {}
  }
}

async function toggleConversation() {
  if (isConversationActive) {
    stopConversation();
  } else {
    await startConversation();
  }
}

async function startConversation() {
  const SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRec) {
    alert('您的浏览器不支持原生语音识别，请使用 Chrome 或 Edge。');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamGlobal = stream;
    
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    isConversationActive = true;
    isPaused = false;
    startTime = Date.now();
    
    $recordBtn.classList.add('recording');
    $waveformBar.classList.add('active');

    drawWaveform();
    updateTimer();

    // 启动原生识别
    recognition = new SRec();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    
    // 输入框实时回显
    const $chatInput = document.getElementById('chatInput');

    recognition.onresult = (e) => {
      if (isPaused) return; // 暂停时不处理

      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = e.resultIndex; i < e.results.length; ++i) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript;
        } else {
          interimTranscript += e.results[i][0].transcript;
        }
      }

      // 回显 interim
      if (interimTranscript) {
        if ($chatInput) $chatInput.value = interimTranscript;
      }

      if (finalTranscript) {
        if ($chatInput) $chatInput.value = ''; // 清空以备后用
        
        // 发现完整短句，暂停听筒，送去请求
        pauseListening();
        onTextComplete(finalTranscript.trim());
      }
    };

    // 如果连续说话断开了，自动重启
    recognition.onend = () => {
      // 只要没有手动 stop 或设为 pause，就自动重启，从而实现不间断监听
      if (isConversationActive && !isPaused) {
        try { recognition.start(); } catch(e) {}
      }
    };

    recognition.onerror = (e) => {
      // no-speech 不抛异常，静静等待
      if (e.error !== 'no-speech') {
        console.error('Speech recognition error:', e.error);
      }
    };

    recognition.start();

  } catch (err) {
    console.error('麦克风权限被拒绝或启动失败:', err);
  }
}

export function stopConversation() {
  isConversationActive = false;
  if (recognition) {
    try { recognition.stop(); } catch(e) {}
    recognition = null;
  }
  if (streamGlobal) {
    streamGlobal.getTracks().forEach(t => t.stop());
    streamGlobal = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  cancelAnimationFrame(animFrameId);
  $recordBtn.classList.remove('recording');
  $waveformBar.classList.remove('active');
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
