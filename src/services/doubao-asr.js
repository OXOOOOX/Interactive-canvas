/**
 * doubao-asr.js 鈥?璞嗗寘 SAUC 娴佸紡 ASR WebSocket 瀹㈡埛绔?
 */

const WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const DEFAULT_PROXY_ROUTE = '/api/doubao-asr';
const DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration';
const ALT_RESOURCE_ID = 'volc.seedasr.sauc'; // 鍙︿竴绉嶅父瑙佽祫婧?ID
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

function canUseServerDoubaoProxy() {
  return !import.meta.env.DEV;
}

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
  // 浼樺厛浣跨敤閰嶇疆涓寚瀹氱殑 resource ID
  if (config.asrResourceId || config.doubaoResourceId) {
    return config.asrResourceId || config.doubaoResourceId;
  }

  const model = config.asrModel || config.sttModel || '';
  if (!model || model === 'bigmodel' || model === 'doubao-asr-streaming-2.0') {
    return DEFAULT_RESOURCE_ID;
  }
  return model;
}

function getDirectWsUrl(config) {
  const endpoint = config.asrEndpoint || config.sttEndpoint || WS_URL;
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

  if (canUseServerDoubaoProxy()) {
    url.searchParams.set('mode', 'server');
    return url.toString();
  }

  throw new Error('鏈厤缃眴鍖?API Key');
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

  if (canUseServerDoubaoProxy()) {
    return {
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': connectId,
    };
  }

  throw new Error('鏈厤缃眴鍖?API Key');
}

async function buildInitPayload(config) {
  const payload = {
    user: { uid: 'dreamcatcher-user' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: SAMPLE_RATE,
      bits: 16,
      channel: 1,
    },
    request: {
      // model_name 鍥哄畾涓?bigmodel锛?.0 鏄€氳繃 Resource ID 鍖哄垎鐨?
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
    throw new Error(`璞嗗寘 ASR 杩斿洖閿欒: ${code}`);
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

function appendTranscriptDelta(current, incoming) {
  const base = (current || '').trim();
  const next = (incoming || '').trim();
  if (!next) return base;
  if (!base) return next;
  if (base.endsWith(next)) return base;

  const maxOverlap = Math.min(base.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === next.slice(0, size)) {
      return `${base}${next.slice(size)}`;
    }
  }

  const separator = /[a-zA-Z0-9]$/.test(base) && /^[a-zA-Z0-9]/.test(next) ? ' ' : '';
  return `${base}${separator}${next}`;
}

function getUtteranceStart(item, index) {
  const value = Number(item?.start_time ?? item?.startTime ?? item?.start ?? index);
  return Number.isFinite(value) ? value : index;
}

export function normalizeDoubaoTranscriptUpdate(data, context = {}) {
  if (!data || typeof data !== 'object') return null;

  const result = data.result && typeof data.result === 'object' ? data.result : {};
  const hasResultSnapshot = typeof result.text === 'string';
  const hasRootSnapshot = typeof data.text === 'string';
  const snapshotText = hasResultSnapshot
    ? result.text
    : hasRootSnapshot
      ? data.text
      : '';
  const baseUpdate = {
    sessionId: context.sessionId ?? null,
    sequence: Number(context.sequence || 0),
  };

  if (hasResultSnapshot || hasRootSnapshot) {
    return {
      ...baseUpdate,
      text: snapshotText.trim(),
      updateMode: 'replace',
      final: Boolean(context.isLastPackage || result.definite || result.final || data.definite || data.final),
    };
  }

  const explicitDelta = typeof result.delta === 'string'
    ? result.delta
    : typeof data.delta === 'string'
      ? data.delta
      : typeof result.text_delta === 'string'
        ? result.text_delta
        : typeof data.text_delta === 'string'
          ? data.text_delta
          : '';
  if (explicitDelta.trim()) {
    return {
      ...baseUpdate,
      text: explicitDelta.trim(),
      updateMode: 'append',
      final: Boolean(context.isLastPackage || result.final || data.final),
    };
  }

  const utterances = Array.isArray(result.utterances)
    ? result.utterances
    : Array.isArray(data.utterances)
      ? data.utterances
      : [];
  const ordered = utterances
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => typeof (item?.text || item?.transcript) === 'string')
    .sort((a, b) => getUtteranceStart(a.item, a.index) - getUtteranceStart(b.item, b.index));
  const utteranceText = ordered.map(({ item }) => item.text || item.transcript).join('').trim();
  if (!utteranceText) return null;

  return {
    ...baseUpdate,
    text: utteranceText,
    updateMode: 'replace',
    final: Boolean(context.isLastPackage || ordered.every(({ item }) => item.definite || item.final)),
  };
}

export function applyDoubaoTranscriptUpdate(current, update) {
  if (!update || typeof update.text !== 'string') return (current || '').trim();
  if (update.updateMode === 'append') return appendTranscriptDelta(current, update.text);
  return update.text.trim();
}

export async function testDoubaoAsrConnection(config, options = {}) {
  const { useProxy = true } = options;

  return new Promise((resolve, reject) => {
    let wsUrl;
    let wsOptions = {};

    if (useProxy) {
      wsUrl = getConnectionUrl(config);
    } else {
      // 鐩磋繛妯″紡锛氱洿鎺ヨ繛鎺ヨ眴鍖呭畼鏂?WebSocket
      wsUrl = getDirectWsUrl(config);
      const resourceId = getResourceId(config);
      const connectId = crypto.randomUUID();

      // 鐩磋繛闇€瑕佹坊鍔犺璇佸ご
      if (config.doubaoApiKey) {
        wsOptions.headers = {
          'X-Api-Key': config.doubaoApiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': connectId,
        };
      }
    }

    console.log('[doubao-asr test] Connecting to:', wsUrl);
    console.log('[doubao-asr test] Options:', JSON.stringify(wsOptions, null, 2));
    console.log('[doubao-asr test] Config:', {
      sttModel: config.asrModel || config.sttModel,
      resourceId: getResourceId(config),
      hasApiKey: !!config.doubaoApiKey,
    });

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`连接超时（15 秒）- ${useProxy ? '代理模式' : '直连模式'}`));
    }, 15000);

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
        const messageData = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        console.log('[doubao-asr test] Received message:', messageData.byteLength, 'bytes');
        const parsed = await parseServerMessage(messageData);
        console.log('[doubao-asr test] Parsed response:', JSON.stringify(parsed.data, null, 2).slice(0, 500));
        if (parsed.data?.error) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`鏈嶅姟绔敊璇細${parsed.data.error.message || JSON.stringify(parsed.data.error)}`));
        } else if (parsed.data?.result || parsed.data?.utterances) {
          clearTimeout(timeout);
          ws.close();
          resolve({ status: 'ok', message: `豆包 ASR 连通成功（${useProxy ? '代理' : '直连'}）`, data: parsed.data });
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

export async function startDoubaoStreamingRecognition(config, callbacks = {}, options = {}) {
  const stream = options.stream || await navigator.mediaDevices.getUserMedia({ audio: true });
  const closeStreamOnStop = options.closeStreamOnStop !== false;
  const preAudioBytes = options.preAudioBytes instanceof Uint8Array ? options.preAudioBytes : new Uint8Array(0);
  const audioContext = new AudioContext();

  // 纭繚 AudioContext 澶勪簬杩愯鐘舵€?
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
  let transcriptSequence = 0;
  const sampleChunks = [];
  const bytesPerChunk = (SAMPLE_RATE * 2 * SEGMENT_DURATION_MS) / 1000;

  const queueAudioChunk = (sequence, bytes, isLast = false) => {
    sending = sending.then(async () => {
      const audioPayload = await buildAudioPayload(sequence, bytes, isLast);
      ws.send(audioPayload);
    }).catch((error) => {
      console.error('[doubao-asr] Audio send error:', error);
      callbacks.onError?.(error);
    });
    return sending;
  };

  const queueAudioBytes = (bytes) => {
    let buffered = bytes;
    while (buffered.length >= bytesPerChunk) {
      const current = buffered.slice(0, bytesPerChunk);
      buffered = buffered.slice(bytesPerChunk);
      const currentSeq = seq;
      seq += 1;
      queueAudioChunk(currentSeq, current, false);
    }
    return buffered;
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;

    processor.disconnect();
    source.disconnect();
    if (closeStreamOnStop) {
      stream.getTracks().forEach(track => track.stop());
    }
    await audioContext.close();

    const remaining = sampleChunks.length ? concatChunks(sampleChunks.splice(0)) : new Uint8Array(0);
    await sending.catch((error) => callbacks.onError?.(error));
    if (ws.readyState === WebSocket.OPEN) {
      await queueAudioChunk(seq, remaining, true);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
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
      try {
        ws.send(await buildInitPayload(config));
        if (preAudioBytes.length) {
          const trailing = queueAudioBytes(preAudioBytes);
          sampleChunks.length = 0;
          if (trailing.length > 0) sampleChunks.push(trailing);
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    ws.onerror = () => {
      console.error('[doubao-asr] WebSocket error');
      reject(new Error('璞嗗寘 ASR WebSocket 杩炴帴澶辫触'));
    };
  });

  ws.onmessage = async (event) => {
    try {
      const parsed = await parseServerMessage(event.data);
      const update = normalizeDoubaoTranscriptUpdate(parsed.data, {
        sessionId: options.sessionId,
        sequence: ++transcriptSequence,
        isLastPackage: parsed.isLastPackage,
      });
      if (update) {
        finalText = applyDoubaoTranscriptUpdate(finalText, update);
        if (callbacks.onTranscript) {
          callbacks.onTranscript({ ...update, fullText: finalText });
        } else if (update.final) {
          callbacks.onFinal?.(finalText, update.text);
        } else {
          callbacks.onInterim?.(finalText);
        }
      }
      if (parsed.isLastPackage) {
        callbacks.onComplete?.(finalText.trim(), { sessionId: options.sessionId, sequence: transcriptSequence });
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
    callbacks.onClose?.(finalText.trim(), { sessionId: options.sessionId, sequence: transcriptSequence });
  };

  processor.onaudioprocess = (event) => {
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
      queueAudioChunk(currentSeq, current, false);
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
