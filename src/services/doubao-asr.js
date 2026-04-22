/**
 * doubao-asr.js — 豆包 SAUC 流式 ASR WebSocket 客户端
 */

const WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const DEFAULT_PROXY_ROUTE = '/api/doubao-asr';
const DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration';
const ALT_RESOURCE_ID = 'volc.seedasr.sauc'; // 另一种常见资源 ID
const SAMPLE_RATE = 16000;
const SEGMENT_DURATION_MS = 200;

const MESSAGE_TYPE = {
  CLIENT_FULL_REQUEST: 0x1,
  CLIENT_AUDIO_ONLY_REQUEST: 0x2,
};

const MESSAGE_FLAGS = {
  POS_SEQUENCE: 0x1,
  NEG_WITH_SEQUENCE: 0x3,
};

const SERIALIZATION_JSON = 0x1;
const COMPRESSION_GZIP = 0x1;

function createHeader(messageType, flags, serialization = SERIALIZATION_JSON, compression = COMPRESSION_GZIP) {
  return new Uint8Array([
    (0x1 << 4) | 0x1,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

function appendInt32(target, value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, value, false);
  target.push(new Uint8Array(view.buffer));
}

function appendUint32(target, value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value, false);
  target.push(new Uint8Array(view.buffer));
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function gzipBytes(uint8Array) {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(uint8Array);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function ungzipBytes(uint8Array) {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(uint8Array);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function decodeJson(uint8Array) {
  return JSON.parse(new TextDecoder().decode(uint8Array));
}

function pcmFloatTo16BitPCM(float32Array) {
  const buffer = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(buffer.buffer);
}

function downsampleBuffer(float32Array, inputRate, outputRate) {
  if (outputRate >= inputRate) return float32Array;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(float32Array.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Array.length; i += 1) {
      accum += float32Array[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function getResourceId(config) {
  // 优先使用配置中指定的 resource ID
  if (config.doubaoResourceId) {
    return config.doubaoResourceId;
  }

  const model = config.sttModel || '';
  if (!model || model === 'bigmodel' || model === 'doubao-asr-streaming-2.0') {
    return DEFAULT_RESOURCE_ID;
  }
  return model;
}

function getDirectWsUrl(config) {
  const endpoint = config.sttEndpoint || WS_URL;
  if (endpoint.startsWith('http://')) return endpoint.replace('http://', 'ws://');
  if (endpoint.startsWith('https://')) return endpoint.replace('https://', 'wss://');
  return endpoint;
}

function getProxyBaseUrl(config) {
  const base = config.doubaoAsrProxyUrl || `${window.location.origin.replace(/^http/, 'ws')}${DEFAULT_PROXY_ROUTE}`;
  if (base.startsWith('http://')) return base.replace('http://', 'ws://');
  if (base.startsWith('https://')) return base.replace('https://', 'wss://');
  return base;
}

function buildProxyQuery(config) {
  const url = new URL(getProxyBaseUrl(config));
  url.searchParams.set('target', getDirectWsUrl(config));
  url.searchParams.set('resourceId', getResourceId(config));
  url.searchParams.set('connectId', crypto.randomUUID());

  if (config.doubaoApiKey) {
    url.searchParams.set('mode', 'apiKey');
    url.searchParams.set('apiKey', config.doubaoApiKey);
    return url.toString();
  }

  if (config.appId && (config.accessToken || config.secretKey)) {
    url.searchParams.set('mode', 'legacy');
    url.searchParams.set('appId', config.appId);
    if (config.accessToken) url.searchParams.set('accessToken', config.accessToken);
    if (config.secretKey) url.searchParams.set('secretKey', config.secretKey);
    return url.toString();
  }

  throw new Error('未配置豆包流式识别凭证');
}

function getConnectionUrl(config) {
  return buildProxyQuery(config);
}

export function getDoubaoProxyRoute() {
  return DEFAULT_PROXY_ROUTE;
}

export function getDoubaoProxyTarget(config) {
  return getDirectWsUrl(config);
}

export function getDoubaoProxyHeaders(config, connectId = crypto.randomUUID()) {
  const resourceId = getResourceId(config);
  if (config.doubaoApiKey) {
    return {
      'X-Api-Key': config.doubaoApiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': connectId,
    };
  }

  if (config.appId && config.accessToken) {
    return {
      'X-Api-App-Key': config.appId,
      'X-Api-Access-Key': config.accessToken,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': crypto.randomUUID(),
    };
  }

  if (config.appId && config.secretKey) {
    return {
      'X-Api-App-Key': config.appId,
      'X-Api-Secret-Key': config.secretKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': crypto.randomUUID(),
    };
  }

  throw new Error('未配置豆包流式识别凭证');
}

async function buildInitPayload(config) {
  const payload = {
    user: { uid: 'dreamcatcher-user' },
    audio: {
      format: 'raw',
      codec: 'raw',
      rate: SAMPLE_RATE,
      bits: 16,
      channel: 1,
    },
    request: {
      // model_name 固定为 bigmodel，2.0 是通过 Resource ID 区分的
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: false,
      end_window_size: 800,
      force_to_speech_time: 500,
    },
  };

  const compressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const chunks = [createHeader(MESSAGE_TYPE.CLIENT_FULL_REQUEST, MESSAGE_FLAGS.POS_SEQUENCE)];
  appendInt32(chunks, 1);
  appendUint32(chunks, compressed.length);
  chunks.push(compressed);
  return concatChunks(chunks);
}

async function buildAudioPayload(seq, audioBytes, isLast = false) {
  const compressed = await gzipBytes(audioBytes);
  const actualSeq = isLast ? -seq : seq;
  const flags = isLast ? MESSAGE_FLAGS.NEG_WITH_SEQUENCE : MESSAGE_FLAGS.POS_SEQUENCE;
  const chunks = [createHeader(MESSAGE_TYPE.CLIENT_AUDIO_ONLY_REQUEST, flags)];
  appendInt32(chunks, actualSeq);
  appendUint32(chunks, compressed.length);
  chunks.push(compressed);
  return concatChunks(chunks);
}

async function parseServerMessage(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const headerSize = (bytes[0] & 0x0f) * 4;
  const messageType = bytes[1] >> 4;
  const flags = bytes[1] & 0x0f;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 0x0f;

  let offset = headerSize;
  let isLastPackage = false;

  if (flags & 0x01) {
    offset += 4;
  }
  if (flags & 0x02) {
    isLastPackage = true;
  }

  if (messageType === 0x9) {
    offset += 4;
  } else if (messageType === 0xf) {
    const code = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, false);
    throw new Error(`豆包 ASR 返回错误: ${code}`);
  }

  let payload = bytes.slice(offset);
  if (compression === COMPRESSION_GZIP && payload.length > 0) {
    payload = await ungzipBytes(payload);
  }

  const data = serialization === SERIALIZATION_JSON && payload.length > 0
    ? decodeJson(payload)
    : null;

  return { isLastPackage, data };
}

function extractTranscript(data) {
  if (!data || typeof data !== 'object') return { interim: '', final: '' };

  const utterances = Array.isArray(data.result?.utterances)
    ? data.result.utterances
    : Array.isArray(data.utterances)
      ? data.utterances
      : [];

  let interim = '';
  let final = '';

  if (typeof data.result?.text === 'string') final = data.result.text;
  if (typeof data.text === 'string' && !final) final = data.text;

  for (const item of utterances) {
    const text = item?.text || item?.transcript || '';
    if (!text) continue;
    if (item.definite || item.final) {
      final += text;
    } else {
      interim += text;
    }
  }

  return { interim, final };
}

export async function testDoubaoAsrConnection(config, options = {}) {
  const { useProxy = true } = options;

  return new Promise((resolve, reject) => {
    let wsUrl;
    let wsOptions = {};

    if (useProxy) {
      wsUrl = getConnectionUrl(config);
    } else {
      // 直连模式：直接连接豆包官方 WebSocket
      wsUrl = getDirectWsUrl(config);
      const resourceId = getResourceId(config);
      const connectId = crypto.randomUUID();

      // 直连需要添加认证头
      if (config.doubaoApiKey) {
        wsOptions.headers = {
          'X-Api-Key': config.doubaoApiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': connectId,
        };
      } else if (config.appId && (config.accessToken || config.secretKey)) {
        wsOptions.headers = {
          'X-Api-App-Key': config.appId,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': connectId,
          ...(config.accessToken ? { 'X-Api-Access-Key': config.accessToken } : {}),
          ...(config.secretKey ? { 'X-Api-Secret-Key': config.secretKey } : {}),
        };
      }
    }

    console.log('[doubao-asr test] Connecting to:', wsUrl);
    console.log('[doubao-asr test] Options:', JSON.stringify(wsOptions, null, 2));
    console.log('[doubao-asr test] Config:', {
      sttModel: config.sttModel,
      resourceId: getResourceId(config),
      hasApiKey: !!config.doubaoApiKey,
      hasAppId: !!config.appId,
    });

    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`连接超时（5 秒）- ${useProxy ? '代理模式' : '直连模式'}`));
    }, 5000);

    ws.onopen = async () => {
      console.log('[doubao-asr test] WebSocket connected');
      try {
        const initPayload = await buildInitPayload(config);
        console.log('[doubao-asr test] Init payload size:', initPayload.length, 'bytes');
        ws.send(initPayload);
        console.log('[doubao-asr test] Init payload sent');
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        console.error('[doubao-asr test] Build init payload error:', err);
        reject(err);
      }
    };

    ws.onmessage = async (event) => {
      try {
        console.log('[doubao-asr test] Received message:', event.data.byteLength, 'bytes');
        const parsed = await parseServerMessage(event.data);
        console.log('[doubao-asr test] Parsed response:', JSON.stringify(parsed.data, null, 2).slice(0, 500));
        clearTimeout(timeout);
        ws.close();
        if (parsed.data?.error) {
          reject(new Error(`服务端错误：${parsed.data.error.message || JSON.stringify(parsed.data.error)}`));
        } else if (parsed.data?.result || parsed.data?.utterances) {
          resolve({ status: 'ok', message: `豆包 ASR 连通成功（${useProxy ? '代理' : '直连'}）`, data: parsed.data });
        } else {
          resolve({ status: 'ok', message: `WebSocket 连通但返回格式异常（${useProxy ? '代理' : '直连'}）`, data: parsed.data });
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        console.error('[doubao-asr test] Parse message error:', err);
        reject(err);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      console.error('[doubao-asr test] WebSocket error event:', err);
      reject(new Error(`WebSocket 连接失败，检查网络或凭证（${useProxy ? '代理' : '直连'}）`));
    };

    ws.onclose = (event) => {
      console.log('[doubao-asr test] WebSocket closed:', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    };
  });
}

export async function startDoubaoStreamingRecognition(config, callbacks = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new AudioContext();

  // 确保 AudioContext 处于运行状态
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const ws = new WebSocket(getConnectionUrl(config));

  let seq = 2;
  let stopped = false;
  let sending = Promise.resolve();
  let finalText = '';
  const sampleChunks = [];
  const bytesPerChunk = (SAMPLE_RATE * 2 * SEGMENT_DURATION_MS) / 1000;

  source.connect(processor);
  processor.connect(audioContext.destination);

  console.log('[doubao-asr] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);

  const stop = async () => {
    console.log('[doubao-asr] stop() called, stopped=', stopped, 'ws.readyState=', ws.readyState);
    if (stopped) {
      console.log('[doubao-asr] stop() already stopped, ignoring');
      return;
    }
    stopped = true;

    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach(track => track.stop());
    await audioContext.close();
    console.log('[doubao-asr] Audio context closed');

    const remaining = sampleChunks.length ? concatChunks(sampleChunks.splice(0)) : new Uint8Array(0);
    await sending.catch((error) => callbacks.onError?.(error));
    if (ws.readyState === WebSocket.OPEN) {
      const payload = await buildAudioPayload(seq, remaining, true);
      ws.send(payload);
      console.log('[doubao-asr] Final audio payload sent');
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          console.log('[doubao-asr] Closing WebSocket');
          ws.close();
        }
      }, 1200);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  const ready = new Promise((resolve, reject) => {
    ws.binaryType = 'arraybuffer';
    ws.onopen = async () => {
      console.log('[doubao-asr] WebSocket opened');
      try {
        ws.send(await buildInitPayload(config));
        console.log('[doubao-asr] Init payload sent');
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    ws.onerror = () => {
      console.error('[doubao-asr] WebSocket error');
      reject(new Error('豆包 ASR WebSocket 连接失败'));
    };
  });

  ws.onmessage = async (event) => {
    console.log('[doubao-asr] ws.onmessage raw data size:', event.data.byteLength);
    try {
      const parsed = await parseServerMessage(event.data);
      console.log('[doubao-asr] ws.onmessage parsed:', JSON.stringify(parsed.data, null, 2).slice(0, 300));
      const { interim, final } = extractTranscript(parsed.data);
      console.log('[doubao-asr] ws.onmessage:', { interim, final, isLastPackage: parsed.isLastPackage });
      if (interim) callbacks.onInterim?.(interim);
      if (final) {
        finalText += final;
        callbacks.onFinal?.(finalText.trim(), final.trim());
      }
      if (parsed.isLastPackage) {
        callbacks.onComplete?.(finalText.trim());
      }
    } catch (error) {
      console.error('[doubao-asr] ws.onmessage parse error:', error);
      callbacks.onError?.(error);
    }
  };

  ws.onerror = (error) => {
    console.error('[doubao-asr] WebSocket error event:', error);
  };

  ws.onclose = () => {
    console.log('[doubao-asr] WebSocket closed, finalText=', finalText);
    callbacks.onClose?.(finalText.trim());
  };

  processor.onaudioprocess = (event) => {
    console.log('[doubao-asr] onaudioprocess triggered, stopped=', stopped, 'ws.readyState=', ws.readyState);
    if (stopped || ws.readyState !== WebSocket.OPEN) return;

    const downsampled = downsampleBuffer(event.inputBuffer.getChannelData(0), audioContext.sampleRate, SAMPLE_RATE);
    sampleChunks.push(pcmFloatTo16BitPCM(downsampled));

    let buffered = concatChunks(sampleChunks);
    while (buffered.length >= bytesPerChunk) {
      const current = buffered.slice(0, bytesPerChunk);
      buffered = buffered.slice(bytesPerChunk);
      sampleChunks.length = 0;
      if (buffered.length > 0) sampleChunks.push(buffered);

      const currentSeq = seq;
      seq += 1;
      sending = sending.then(async () => {
        const audioPayload = await buildAudioPayload(currentSeq, current, false);
        ws.send(audioPayload);
        console.log('[doubao-asr] Audio sent, seq:', currentSeq, 'size:', audioPayload.length, 'bytes');
      }).catch((error) => {
        console.error('[doubao-asr] Audio send error:', error);
        callbacks.onError?.(error);
      });
    }
  };

  await ready;

  return {
    stream,
    audioContext,
    processor,
    stop,
  };
}
