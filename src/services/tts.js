/**
 * tts.js — 语音合成 (TTS)
 */

function getDoubaoResourceId(config) {
  return config.ttsModel || 'seed-tts-2.0';
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

function buildDoubaoHeaders(config) {
  if (!config.doubaoApiKey) throw new Error('未配置豆包 API Key');
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': config.doubaoApiKey,
    'X-Api-Resource-Id': getDoubaoResourceId(config),
    'X-Api-Connect-Id': crypto.randomUUID(),
  };
}

function buildDoubaoBody(text, config) {
  return {
    text,
    voice: config.ttsVoice || undefined,
    voice_type: config.ttsVoice || undefined,
    audio_config: {
      format: 'mp3',
    },
  };
}

export async function speak(text, config) {
  if (config.ttsProvider === 'browser') {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    speechSynthesis.speak(utterance);
    return;
  }

  if (!config.ttsEndpoint) throw new Error('未配置 TTS endpoint');

  const isDoubao = config.ttsProvider === 'doubao';
  const res = await fetch(config.proxyUrl || config.ttsEndpoint, {
    method: 'POST',
    headers: isDoubao
      ? buildDoubaoHeaders(config)
      : {
          'Content-Type': 'application/json',
          ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
        },
    body: JSON.stringify(
      isDoubao
        ? buildDoubaoBody(text, config)
        : { text, provider: config.ttsProvider || 'tongyi' }
    ),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`TTS 请求失败: ${res.status}${errorText ? ` ${errorText.slice(0, 160)}` : ''}`);
  }

  const data = await res.json();
  const audioBase64 = extractAudioBase64(data);
  if (!audioBase64) throw new Error('TTS 未返回音频数据');

  const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
  await audio.play();
}

export { buildDoubaoHeaders, buildDoubaoBody };
