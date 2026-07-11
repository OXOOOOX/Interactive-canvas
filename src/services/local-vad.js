import { MicVAD } from '@ricky0123/vad-web';

const SAMPLE_RATE = 16000;
const PRE_ROLL_MS = 700;
const MAX_PRE_ROLL_SAMPLES = Math.round((SAMPLE_RATE * PRE_ROLL_MS) / 1000);
const STARTUP_IGNORE_MS = 1200;
const MIN_TRIGGER_PROBABILITY = 0.78;

const VAD_ASSET_BASE = '/vad/';

function pcmFloatTo16BitPCM(float32Array) {
  const buffer = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(buffer.buffer);
}

function concatFloatFrames(frames) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    merged.set(frame, offset);
    offset += frame.length;
  }
  return merged;
}

function trimPreRollFrames(frames) {
  let total = frames.reduce((sum, frame) => sum + frame.length, 0);
  while (frames.length > 1 && total > MAX_PRE_ROLL_SAMPLES) {
    const removed = frames.shift();
    total -= removed.length;
  }
}

export async function createLocalVadGate(callbacks = {}) {
  const preRollFrames = [];
  let stream = null;
  let vad = null;
  let started = false;
  let startedAt = 0;
  let latestSpeechProbability = 0;

  const stopTracks = () => {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const getStream = async () => {
    if (stream && stream.active) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });
    return stream;
  };

  await getStream();
  await callbacks.onStreamReady?.(stream);

  try {
    vad = await MicVAD.new({
    model: 'legacy',
    startOnLoad: false,
    baseAssetPath: VAD_ASSET_BASE,
    onnxWASMBasePath: VAD_ASSET_BASE,
    ortConfig: (ort) => {
      ort.env.logLevel = 'warning';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    },
    getStream,
    pauseStream: async () => {},
    resumeStream: getStream,
    positiveSpeechThreshold: 0.7,
    negativeSpeechThreshold: 0.5,
    minSpeechMs: 450,
    redemptionMs: 1500,
    preSpeechPadMs: PRE_ROLL_MS,
    submitUserSpeechOnPause: false,
    onFrameProcessed: (probabilities, frame) => {
      latestSpeechProbability = Number(probabilities?.isSpeech ?? 0);
      preRollFrames.push(new Float32Array(frame));
      trimPreRollFrames(preRollFrames);
      callbacks.onFrameProcessed?.({
        isSpeech: latestSpeechProbability,
        isStartupIgnored: Date.now() - startedAt < STARTUP_IGNORE_MS,
      });
    },
    onSpeechStart: () => callbacks.onSpeechMaybeStart?.(),
    onSpeechRealStart: () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < STARTUP_IGNORE_MS) {
        callbacks.onIgnoredSpeechStart?.({ reason: 'startup', elapsed, isSpeech: latestSpeechProbability });
        return;
      }
      if (latestSpeechProbability < MIN_TRIGGER_PROBABILITY) {
        callbacks.onIgnoredSpeechStart?.({ reason: 'probability', elapsed, isSpeech: latestSpeechProbability });
        return;
      }
      callbacks.onSpeechStart?.({ elapsed, isSpeech: latestSpeechProbability });
    },
    onSpeechEnd: (audio) => callbacks.onSpeechEnd?.(audio),
    onVADMisfire: () => callbacks.onVADMisfire?.(),
    });
  } catch (error) {
    stopTracks();
    throw error;
  }

  return {
    get stream() {
      return stream;
    },
    async start() {
      if (started) return;
      await getStream();
      startedAt = Date.now();
      await vad.start();
      started = true;
    },
    getPreRollPcm() {
      return pcmFloatTo16BitPCM(concatFloatFrames(preRollFrames));
    },
    resetPreRoll() {
      preRollFrames.length = 0;
    },
    async stop() {
      if (!vad) {
        stopTracks();
        return;
      }
      try {
        await vad.destroy();
      } catch (error) {
        console.warn('[local-vad] destroy failed:', error);
      }
      vad = null;
      started = false;
      preRollFrames.length = 0;
      stopTracks();
    },
  };
}
