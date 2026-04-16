/**
 * stt.js — 语音转写 (STT)
 */

export async function transcribe(audioBlob, config) {
  if (!config.sttEndpoint) throw new Error('未配置 STT endpoint');

  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
  
  const provider = config.sttProvider || 'tongyi';
  if (provider === 'tongyi') {
    formData.append('model', 'sensevoice-v1');
  }

  const res = await fetch(config.proxyUrl || config.sttEndpoint, {
    method: 'POST',
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: formData,
  });

  if (!res.ok) throw new Error(`STT 请求失败: ${res.status}`);
  const data = await res.json();
  return data.text || '';
}
