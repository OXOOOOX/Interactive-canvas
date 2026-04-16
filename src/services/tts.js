/**
 * tts.js — 语音合成 (TTS)
 */

export async function speak(text, config) {
  if (config.ttsProvider === 'browser') {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    speechSynthesis.speak(utterance);
    return;
  }

  if (!config.ttsEndpoint) throw new Error('未配置 TTS endpoint');

  const res = await fetch(config.proxyUrl || config.ttsEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ text, provider: config.ttsProvider || 'tongyi' }),
  });

  if (!res.ok) throw new Error(`TTS 请求失败: ${res.status}`);
  const data = await res.json();
  if (data.audioBase64) {
    const audio = new Audio(`data:audio/mpeg;base64,${data.audioBase64}`);
    await audio.play();
  }
}
