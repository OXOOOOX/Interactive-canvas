/**
 * tts.js — 语音合成 (TTS)
 */

function getDoubaoResourceId(config) {
  const model = config.ttsModel || 'seed-tts-2.0';
  return model === 'doubao-tts-2.0' ? 'seed-tts-2.0' : model;
}

function getDoubaoSpeaker(config) {
  return config.ttsVoice || 'zh_female_gaolengyujie_uranus_bigtts';
}

function getDoubaoEndpoint(config) {
  const endpoint = config.ttsEndpoint || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
  return endpoint.includes('/api/v1/tts')
    ? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
    : endpoint;
}

function getRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `dreamcatcher-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function canUseServerDoubaoProxy() {
  return !import.meta.env.DEV;
}

function validateDoubaoTtsConfig(config) {
  if (config.doubaoApiKey || canUseServerDoubaoProxy()) return;
  throw new Error('未配置豆包 TTS 所需的 doubaoApiKey');
}

function playBrowserTts(text, config) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = config.voiceLanguage || 'zh-CN';
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
}

function playAudioElement(audio) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.onended = null;
      audio.onerror = null;
    };

    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('TTS 音频播放失败'));
    };

    audio.play().catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

export function canUseDoubaoTts(config) {
  return !!((config?.doubaoApiKey || canUseServerDoubaoProxy()) && getDoubaoEndpoint(config));
}

export function getDoubaoTtsFallbackReason(config) {
  if (canUseDoubaoTts(config)) return '';
  return '未配置豆包 TTS 所需的 doubaoApiKey';
}

function extractAudioBase64(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.audioBase64 === 'string') return data.audioBase64;
  if (typeof data.audio === 'string') return data.audio;
  if (typeof data.data === 'string') return data.data;
  if (typeof data.result?.audio === 'string') return data.result.audio;
  if (typeof data.result?.audio_base64 === 'string') return data.result.audio_base64;
  if (typeof data.data?.audio === 'string') return data.data.audio;
  if (typeof data.data?.audioBase64 === 'string') return data.data.audioBase64;
  return '';
}

function collectAudioBase64(objects) {
  return objects
    .map((item) => extractAudioBase64(item))
    .filter(Boolean)
    .join('');
}

function parseJsonObjects(text) {
  const objects = [];
  const source = String(text || '').trim();
  if (!source) return objects;

  try {
    objects.push(JSON.parse(source));
    return objects;
  } catch (error) {
    // Some TTS providers return text/plain, SSE lines, or multiple JSON frames.
  }

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    try {
      objects.push(JSON.parse(payload));
    } catch (error) {
      // Ignore non-JSON progress lines.
    }
  }
  if (objects.length) return objects;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(source.slice(start, i + 1)));
        } catch (error) {
          // Continue scanning for later complete JSON objects.
        }
        start = -1;
      }
    }
  }

  return objects;
}

async function parseTtsResponse(res) {
  const raw = await res.text();
  const objects = parseJsonObjects(raw);
  const audioBase64 = collectAudioBase64(objects);
  if (audioBase64) return { audioBase64, chunks: objects.length };
  return objects[0] || { raw };
}

function buildDoubaoHeaders(config) {
  validateDoubaoTtsConfig(config);
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': config.doubaoApiKey,
    'X-Api-Resource-Id': getDoubaoResourceId(config),
    'X-Api-Request-Id': getRequestId(),
  };
}

function buildDoubaoBody(text, config) {
  return {
    user: { uid: 'dreamcatcher-user' },
    req_params: {
      text,
      speaker: getDoubaoSpeaker(config),
      audio_params: {
        format: 'mp3',
        sample_rate: 24000,
      },
    },
  };
}

function buildDoubaoProxyBody(text, config, endpoint) {
  return {
    endpoint,
    apiKey: config.doubaoApiKey,
    resourceId: getDoubaoResourceId(config),
    requestId: getRequestId(),
    payload: buildDoubaoBody(text, config),
  };
}

export async function speak(text, config) {
  if (config.ttsProvider === 'browser') {
    await playBrowserTts(text, config);
    return;
  }

  const isDoubao = config.ttsProvider === 'doubao';
  const endpoint = isDoubao ? getDoubaoEndpoint(config) : config.ttsEndpoint;
  if (!endpoint) throw new Error('未配置 TTS endpoint');

  if (isDoubao) {
    validateDoubaoTtsConfig(config);
  }

  const controller = new AbortController();
  const timeoutMs = isDoubao ? 12000 : 20000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const requestUrl = isDoubao ? '/api/doubao-tts' : (config.proxyUrl || endpoint);
  let res;
  try {
    res = await fetch(requestUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(!isDoubao && config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify(
        isDoubao
          ? buildDoubaoProxyBody(text, config, endpoint)
          : { text, provider: config.ttsProvider || 'tongyi' }
      ),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`TTS 请求超时: ${timeoutMs / 1000} 秒`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`TTS 请求失败: ${res.status}${errorText ? ` ${errorText.slice(0, 160)}` : ''}`);
  }

  const data = await parseTtsResponse(res);
  const audioBase64 = extractAudioBase64(data);
  if (!audioBase64) throw new Error('TTS 未返回音频数据');

  const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
  await playAudioElement(audio);
}

export { buildDoubaoHeaders, buildDoubaoBody };
export { validateDoubaoTtsConfig };
export { playBrowserTts };
