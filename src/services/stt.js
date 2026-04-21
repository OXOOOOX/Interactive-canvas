/**
 * stt.js — 语音转写 (STT)
 */

function getUploadFileName(audioBlob) {
  if (audioBlob?.name) return audioBlob.name;
  return 'audio.webm';
}

function buildDoubaoResourceId(config) {
  return config.fileSttModel || config.sttModel || 'speech.recognition';
}

function appendProviderFields(formData, config) {
  const provider = config.sttProvider || 'tongyi';

  if (provider === 'doubao') {
    if (config.fileSttModel) formData.append('model', config.fileSttModel);
    if (config.voiceLanguage) formData.append('language', config.voiceLanguage);
    return;
  }

  if (provider === 'tongyi') {
    formData.append('model', config.fileSttModel || config.sttModel || 'sensevoice-v1');
    if (config.voiceLanguage) formData.append('language_hints', config.voiceLanguage);
    return;
  }

  if (config.fileSttModel) {
    formData.append('model', config.fileSttModel);
  }
}

function extractTextFromResult(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.text === 'string') return data.text;
  if (typeof data.result === 'string') return data.result;
  if (typeof data.transcript === 'string') return data.transcript;
  if (typeof data.utterance === 'string') return data.utterance;
  if (typeof data.message === 'string' && !data.code) return data.message;

  if (Array.isArray(data.results)) {
    const joined = data.results
      .map(item => item?.text || item?.transcript || item?.utterance || '')
      .filter(Boolean)
      .join('\n');
    if (joined) return joined;
  }

  if (Array.isArray(data.segments)) {
    const joined = data.segments
      .map(item => item?.text || item?.transcript || '')
      .filter(Boolean)
      .join('\n');
    if (joined) return joined;
  }

  if (Array.isArray(data.utterances)) {
    const joined = data.utterances
      .map(item => item?.text || item?.transcript || '')
      .filter(Boolean)
      .join('\n');
    if (joined) return joined;
  }

  if (data.data && typeof data.data === 'object') {
    return extractTextFromResult(data.data);
  }

  if (data.result && typeof data.result === 'object') {
    return extractTextFromResult(data.result);
  }

  return '';
}

function buildDoubaoHeaders(config) {
  if (!config.doubaoApiKey) throw new Error('未配置豆包 API Key');
  return {
    'X-Api-Key': config.doubaoApiKey,
    'X-Api-Resource-Id': buildDoubaoResourceId(config),
    'X-Api-Connect-Id': crypto.randomUUID(),
  };
}

function buildDoubaoJsonBody(audioBlob, config) {
  return {
    fileName: getUploadFileName(audioBlob),
    audioBase64: '',
    model: config.fileSttModel || undefined,
    language: config.voiceLanguage || undefined,
  };
}

async function transcribeWithDoubao(audioBlob, config) {
  const endpoint = config.proxyUrl || config.sttEndpoint;
  const preferJsonProxy = !!config.proxyUrl;

  if (preferJsonProxy) {
    const body = buildDoubaoJsonBody(audioBlob, config);
    body.audioBase64 = await blobToBase64(audioBlob);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildDoubaoHeaders(config),
      },
      body: JSON.stringify(body),
    });
    return handleTranscribeResponse(res);
  }

  const formData = new FormData();
  formData.append('file', audioBlob, getUploadFileName(audioBlob));
  appendProviderFields(formData, config);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: buildDoubaoHeaders(config),
    body: formData,
  });
  return handleTranscribeResponse(res);
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function handleTranscribeResponse(res) {
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`STT 请求失败: ${res.status}${errorText ? ` ${errorText.slice(0, 160)}` : ''}`);
  }

  const data = await res.json();
  const text = extractTextFromResult(data).trim();
  if (!text) {
    throw new Error('语音服务未返回可用文本');
  }
  return text;
}

export async function transcribe(audioBlob, config) {
  if (!config.sttEndpoint) throw new Error('未配置 STT endpoint');

  if ((config.sttProvider || 'tongyi') === 'doubao') {
    return transcribeWithDoubao(audioBlob, config);
  }

  const formData = new FormData();
  formData.append('file', audioBlob, getUploadFileName(audioBlob));
  appendProviderFields(formData, config);

  const res = await fetch(config.proxyUrl || config.sttEndpoint, {
    method: 'POST',
    headers: config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {},
    body: formData,
  });

  return handleTranscribeResponse(res);
}

export { extractTextFromResult, buildDoubaoHeaders };
