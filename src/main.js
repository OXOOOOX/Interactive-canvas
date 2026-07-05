/**
 * main.js 鈥?搴旂敤鍏ュ彛锛屽垵濮嬪寲 + 鍏ㄥ眬浜嬩欢缁戝畾
 */

import './style.css';

import {
  appState, pushHistory, undo, redo, initHistory,
  saveConfig, loadConfig as loadSavedConfig, saveCanvas, loadCanvas,
  getCanvasList, saveCanvasList, createCanvas, deleteCanvas, loadCanvasById,
  saveCurrentCanvas, switchCanvas, getCurrentCanvasId, renameCanvas,
  loadGlobalMemory, saveGlobalMemory,
  ENDPOINT_PRESETS,
  createGroup, deleteGroup, getGroupBlocks, isBlockInGroup, getBlockGroup, getBlockGroups, renameGroup, suggestGroupName,
} from './state.js';
import { initCanvas, renderBlocks, zoomIn, zoomOut, fitToView, hideNodeToolbar, syncBlockSizes } from './canvas.js';
import { initChat, sendText, syncCanvasMemoryDraft, syncChatSessionUI } from './chat.js';
import { initWaveform, resumeListening, isConversationActive, isListeningActive } from './waveform.js';
import { autoLayout, findFreePosition, getBoundingBox } from './utils/layout.js';
import { transcribe } from './services/stt.js';
import { speak, canUseDoubaoTts, getDoubaoTtsFallbackReason } from './services/tts.js';
import { testDoubaoAsrConnection } from './services/doubao-asr.js';
import { buildOAuthUrl, exchangeOAuthCode } from './services/oauth.js';
import { callOrganizeLlm, callRefineLlm, callNamingLlm } from './services/llm.js';
import { parseAiResponse, executeOperations, dedupeConnections, repairCanvasTextFormatting, repairMarkdownFormatting, assertCanvasIntegrity } from './utils/parser.js';
import { createCopyAttachment, createMappedAttachment, getAttachmentFile, listAttachments, supportsMappedFiles, updateAttachmentBlob } from './services/file-store.js';
import { PDFDocument } from 'pdf-lib';

// 鈹€鈹€ DOM References 鈹€鈹€
const $ = (id) => document.getElementById(id);

const dom = {
  // Top bar
  boardTitle: $('boardTitle'),
  canvasListBtn: $('canvasListBtn'),
  newCanvasBtn: $('newCanvasBtn'),
  undoBtn: $('undoBtn'),
  redoBtn: $('redoBtn'),
  downloadJson: $('downloadJson'),
  importJson: $('importJson'),
  resetDemo: $('resetDemo'),
  settingsBtn: $('settingsBtn'),

  // Canvas list menu
  canvasListMenu: $('canvasListMenu'),
  canvasListItems: $('canvasListItems'),
  canvasListEmpty: $('canvasListEmpty'),
  newCanvasFromListBtn: $('newCanvasFromListBtn'),

  // Canvas controls
  autoLayoutBtn: $('autoLayoutBtn'),
  aiOrganizeBtn: $('aiOrganizeBtn'),
  layoutLockBtn: $('layoutLockBtn'),
  fileUploadBtn: $('fileUploadBtn'),
  zoomIn: $('zoomIn'),
  zoomOut: $('zoomOut'),
  fitBtn: $('fitBtn'),

  // Node actions
  addChild: $('addChild'),
  addSibling: $('addSibling'),
  pinNode: $('pinNode'),
  refineNode: $('refineNode'),
  deleteNode: $('deleteNode'),
  splitNode: $('splitNode'),
  mergeNode: $('mergeNode'),
  expandNode: $('expandNode'),
  deriveNode: $('deriveNode'),
  translateNode: $('translateNode'),
  refineConfirmBox: $('refineConfirmBox'),
  refineYes: $('refineYes'),
  refineNo: $('refineNo'),
  nodeToolbar: $('nodeToolbar'),

  // Chat panel
  chatPanel: $('chatPanel'),
  chatResizeHandle: $('chatResizeHandle'),
  chatToggleBtn: $('chatToggleBtn'),
  chatExpandBtn: $('chatExpandBtn'),
  searchMode: $('searchMode'),
  preferBuiltinSearch: $('preferBuiltinSearch'),
  tongyiSearchControl: $('tongyiSearchControl'),

  // Settings modal
  settingsOverlay: $('settingsOverlay'),
  closeSettings: $('closeSettings'),
  llmProvider: $('llmProvider'),
  sttProvider: $('sttProvider'),
  ttsProvider: $('ttsProvider'),
  llmEndpoint: $('llmEndpoint'),
  sttEndpoint: $('sttEndpoint'),
  ttsEndpoint: $('ttsEndpoint'),
  llmApiKey: $('llmApiKey'),
  doubaoApiKey: $('doubaoApiKey'),
  searchProvider: $('searchProvider'),
  searchApiKey: $('searchApiKey'),
  testDoubaoAsrBtn: $('testDoubaoAsrBtn'),
  proxyUrl: $('proxyUrl'),
  saveConfig: $('saveConfig'),
  loadConfig: $('loadConfig'),
  llmModel: $('llmModel'),
  llmKeyNotice: $('llmKeyNotice'),
  modelDropdown: $('modelDropdown'),
  fetchModelsBtn: $('fetchModelsBtn'),
  useFreeTrialBtn: $('useFreeTrialBtn'),
  openLlmKeyPageBtn: $('openLlmKeyPageBtn'),
  openSearchKeyPageBtn: $('openSearchKeyPageBtn'),
  globalMemoryBtn: $('globalMemoryBtn'),
  globalMemoryOverlay: $('globalMemoryOverlay'),
  closeGlobalMemory: $('closeGlobalMemory'),
  globalMemoryText: $('globalMemoryText'),
  clearGlobalMemory: $('clearGlobalMemory'),
  saveGlobalMemory: $('saveGlobalMemory'),
  globalMemoryConfirmOverlay: $('globalMemoryConfirmOverlay'),
  globalMemorySuggestionText: $('globalMemorySuggestionText'),
  rejectGlobalMemory: $('rejectGlobalMemory'),
  acceptGlobalMemory: $('acceptGlobalMemory'),

  // OAuth
  oauthProvider: $('oauthProvider'),
  oauthClientId: $('oauthClientId'),
  oauthAuthUrl: $('oauthAuthUrl'),
  oauthTokenUrl: $('oauthTokenUrl'),
  oauthScope: $('oauthScope'),
  oauthRedirect: $('oauthRedirect'),
  oauthCode: $('oauthCode'),
  oauthStart: $('oauthStart'),
  oauthExchange: $('oauthExchange'),

  // Voice
  recordBtn: $('recordBtn'),
  speakBtn: $('speakBtn'),
  voiceMode: $('voiceMode'),
  sttEnabled: $('sttEnabled'),
  ttsEnabled: $('ttsEnabled'),
  voiceLanguage: $('voiceLanguage'),
  asrModel: $('asrModel'),
  asrResourceId: $('asrResourceId'),
  asrEndpoint: $('asrEndpoint'),
  sttModel: $('sttModel'),
  fileSttModel: $('fileSttModel'),
  doubaoResourceId: $('doubaoResourceId'),
  ttsModel: $('ttsModel'),
  ttsVoice: $('ttsVoice'),
  realtimeVoiceModel: $('realtimeVoiceModel'),
  audioUploadBtn: $('audioUploadBtn'),
  audioFileInput: $('audioFileInput'),
  voiceToast: $('voiceToast'),
};

// 鈹€鈹€ Config Helper 鈹€鈹€
let llmApiKeys = {};
let lastLlmProvider = 'tongyi';
let modelOptions = [];
let apiKeyMissingPromptShown = false;

function getConfig() {
  return {
    voiceConfigVersion: 2,
    llmProvider: dom.llmProvider.value,
    sttProvider: dom.sttProvider.value,
    ttsProvider: dom.ttsProvider.value,
    voiceMode: dom.voiceMode.value,
    sttEnabled: dom.sttEnabled?.value !== 'false',
    ttsEnabled: dom.ttsEnabled?.value !== 'false',
    voiceLanguage: dom.voiceLanguage.value,
    asrModel: dom.asrModel?.value || dom.sttModel.value,
    asrResourceId: dom.asrResourceId?.value || dom.doubaoResourceId.value,
    asrEndpoint: dom.asrEndpoint?.value || dom.sttEndpoint.value,
    llmEndpoint: dom.llmEndpoint.value,
    llmModel: dom.llmModel.value,
    sttEndpoint: dom.sttEndpoint.value,
    sttModel: dom.sttModel.value,
    fileSttModel: dom.fileSttModel.value,
    doubaoResourceId: dom.doubaoResourceId.value,
    ttsEndpoint: dom.ttsEndpoint.value,
    ttsModel: dom.ttsModel.value,
    ttsVoice: dom.ttsVoice.value,
    realtimeVoiceModel: dom.realtimeVoiceModel.value,
    llmApiKey: dom.llmApiKey.value,
    llmApiKeys: getStoredLlmApiKeys(),
    doubaoApiKey: dom.doubaoApiKey.value,
    searchProvider: dom.searchProvider?.value || 'tavily',
    searchApiKey: dom.searchApiKey?.value || '',
    proxyUrl: dom.proxyUrl?.value || '',
    searchMode: getSearchModeValue(),
    preferBuiltinSearch: Boolean(dom.preferBuiltinSearch?.checked),
    oauthProvider: dom.oauthProvider.value,
    oauthClientId: dom.oauthClientId.value,
    oauthAuthUrl: dom.oauthAuthUrl.value,
    oauthTokenUrl: dom.oauthTokenUrl.value,
    oauthScope: dom.oauthScope.value,
    oauthRedirect: dom.oauthRedirect.value,
  };
}

function applyConfigDefaults(config = {}) {
  const needsVoiceMigration = !config.voiceConfigVersion || Number(config.voiceConfigVersion) < 2;
  const merged = {
    voiceMode: 'doubao-pipeline',
    sttProvider: 'doubao',
    ttsProvider: 'doubao',
    sttEnabled: true,
    ttsEnabled: true,
    voiceLanguage: 'zh-CN',
    asrEndpoint: ENDPOINT_PRESETS.doubao?.stt || '',
    asrModel: ENDPOINT_PRESETS.doubao?.sttModel || '',
    asrResourceId: 'volc.seedasr.sauc.duration',
    sttModel: ENDPOINT_PRESETS.doubao?.sttModel || '',
    fileSttModel: ENDPOINT_PRESETS.doubao?.fileSttModel || '',
    doubaoResourceId: 'volc.seedasr.sauc.duration',
    ttsEndpoint: ENDPOINT_PRESETS.doubao?.tts || '',
    ttsModel: ENDPOINT_PRESETS.doubao?.ttsModel || 'seed-tts-2.0',
    realtimeVoiceModel: ENDPOINT_PRESETS.doubao?.realtimeVoiceModel || '',
    searchMode: 'auto',
    preferBuiltinSearch: false,
    searchProvider: 'tavily',
    ...config,
    voiceConfigVersion: 2,
  };

  if (needsVoiceMigration && merged.doubaoApiKey) {
    merged.ttsEnabled = true;
    merged.ttsProvider = 'doubao';
    if (merged.voiceMode === 'browser') {
      merged.voiceMode = 'doubao-pipeline';
    }
    if (!merged.ttsEndpoint) {
      merged.ttsEndpoint = ENDPOINT_PRESETS.doubao?.tts || '';
    }
    if (!merged.ttsModel || merged.ttsModel === 'doubao-tts-2.0') {
      merged.ttsModel = ENDPOINT_PRESETS.doubao?.ttsModel || 'seed-tts-2.0';
    }
  }

  return merged;
}

function normalizeLlmApiKeys(value) {
  if (!value || typeof value !== 'object') return {};

  return Object.fromEntries(Object.entries(value).map(([provider, key]) => {
    if (typeof key === 'string') return [provider, key];
    if (key && typeof key === 'object' && typeof key.slot1 === 'string') return [provider, key.slot1];
    return [provider, ''];
  }));
}

function getStoredLlmApiKeys() {
  return JSON.parse(JSON.stringify(llmApiKeys));
}

function rememberCurrentLlmKey(provider = dom.llmProvider?.value) {
  if (!provider || !dom.llmApiKey) return;

  llmApiKeys[provider] = dom.llmApiKey.value;
}

function loadLlmProviderKey(provider = dom.llmProvider?.value) {
  if (!dom.llmApiKey || !provider) return;

  dom.llmApiKey.value = llmApiKeys[provider] || '';
  lastLlmProvider = provider;
}

function applyLlmKeyConfig(config = {}) {
  llmApiKeys = normalizeLlmApiKeys(config.llmApiKeys);

  const provider = config.llmProvider || dom.llmProvider?.value || 'tongyi';

  if (config.llmApiKey && !llmApiKeys[provider]) {
    llmApiKeys[provider] = config.llmApiKey;
  }

  loadLlmProviderKey(provider);
}

function handleLlmProviderChange() {
  rememberCurrentLlmKey(lastLlmProvider);
  applyProviderPreset(false);
  loadLlmProviderKey(dom.llmProvider.value);
  updateTongyiSearchVisibility();
  apiKeyMissingPromptShown = false;
}

function getSearchModeValue() {
  return dom.searchMode?.dataset?.value || dom.searchMode?.value || 'auto';
}

function setSearchModeValue(value = 'auto') {
  if (!dom.searchMode) return;
  const normalized = value === 'off' ? 'off' : 'auto';
  dom.searchMode.dataset.value = normalized;
  dom.searchMode.textContent = normalized === 'off' ? '关' : '开';
  dom.searchMode.classList.toggle('active', normalized !== 'off');
  dom.searchMode.setAttribute('aria-pressed', normalized !== 'off' ? 'true' : 'false');
}

function toggleSearchMode() {
  setSearchModeValue(getSearchModeValue() === 'off' ? 'auto' : 'off');
}

function updateTongyiSearchVisibility() {
  if (!dom.tongyiSearchControl) return;
  const visible = dom.llmProvider?.value === 'tongyi';
  dom.tongyiSearchControl.classList.toggle('visible', visible);
  dom.tongyiSearchControl.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

const LLM_KEY_URLS = {
  tongyi: 'https://bailian.console.aliyun.com/?apiKey=1',
  doubao: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  deepseekV4Pro: 'https://platform.deepseek.com/api_keys',
  deepseekV4Flash: 'https://platform.deepseek.com/api_keys',
  custom: 'https://platform.openai.com/api-keys',
};

const SEARCH_KEY_URLS = {
  tavily: 'https://app.tavily.com/home',
  serper: 'https://serper.dev/',
  bing: 'https://portal.azure.com/#create/Microsoft.BingSearch',
};

function openExternalKeyPage(url) {
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openCurrentLlmKeyPage() {
  openExternalKeyPage(LLM_KEY_URLS[dom.llmProvider?.value] || LLM_KEY_URLS.custom);
}

function openCurrentSearchKeyPage() {
  openExternalKeyPage(SEARCH_KEY_URLS[dom.searchProvider?.value] || SEARCH_KEY_URLS.tavily);
}

function saveCurrentConfig() {
  rememberCurrentLlmKey();
  saveConfig(getConfig());
}

function useFreeTrialLlm() {
  if (!dom.llmApiKey) return;
  if (dom.llmApiKey.value.trim()) {
    if (dom.llmKeyNotice) {
      dom.llmKeyNotice.textContent = '当前已填写 LLM API Key，系统会优先使用你的 Key，不消耗服务器免费试用额度。';
      dom.llmKeyNotice.hidden = false;
    }
    return;
  }
  apiKeyMissingPromptShown = false;
  if (dom.llmKeyNotice) {
    dom.llmKeyNotice.textContent = '已切换为服务器免费试用。额度用完后，可以回来填写自己的 LLM API Key。';
    dom.llmKeyNotice.hidden = false;
  }
  saveConfig(getConfig());
  dom.settingsOverlay.classList.remove('open');
  dom.settingsOverlay.setAttribute('aria-hidden', 'true');
}

function hasDoubaoAsrCredentials(config = getConfig()) {
  return !!config.doubaoApiKey || !import.meta.env.DEV;
}

function hasDoubaoTtsCredentials(config = getConfig()) {
  return canUseDoubaoTts(config);
}

function isSttEnabled(config = getConfig()) {
  return config.sttEnabled !== false;
}

function isTtsEnabled(config = getConfig()) {
  return config.ttsEnabled !== false;
}

function isDoubaoVoiceMode(config = getConfig()) {
  return config.voiceMode === 'doubao-pipeline' || config.voiceMode === 'doubao-realtime';
}

function getVoiceRouting(config = getConfig()) {
  if (!isSttEnabled(config) && !isTtsEnabled(config)) {
    return {
      inputMode: 'off',
      outputMode: 'off',
      fallbackReason: '',
    };
  }

  const hasDoubaoAsrCreds = hasDoubaoAsrCredentials(config);
  const hasAsr = hasDoubaoAsrCreds && !!config.asrEndpoint;
  const hasTts = hasDoubaoTtsCredentials(config);
  const fallbackReasons = [];
  const wantsDoubaoAsr = isDoubaoVoiceMode(config);
  const wantsDoubaoTts = config.ttsProvider === 'doubao';
  const outputMode = (() => {
    if (!isTtsEnabled(config)) return 'off';
    if (wantsDoubaoTts) return hasTts ? 'doubao' : 'browser';
    return config.ttsProvider || 'browser';
  })();

  if (isSttEnabled(config) && wantsDoubaoAsr && !hasAsr) {
    fallbackReasons.push(hasDoubaoAsrCreds ? '未配置豆包 ASR endpoint，暂用浏览器识别' : '未配置豆包识别凭证，暂用浏览器识别');
  }

  if (isTtsEnabled(config) && wantsDoubaoTts && !hasTts) {
    fallbackReasons.push(getDoubaoTtsFallbackReason(config));
  }

  return {
    inputMode: isSttEnabled(config) ? (wantsDoubaoAsr && hasAsr ? 'doubao' : 'browser') : 'off',
    outputMode,
    fallbackReason: fallbackReasons.filter(Boolean).join('；'),
  };
}

function syncVoiceModeFallback() {
  syncVoiceFallbackNotice({ force: true });
}

let lastVoiceFallbackReason = '';
let lastVoiceRouteKey = '';
let voiceToastTimer = null;

function clearVoiceToast() {
  if (voiceToastTimer) {
    clearTimeout(voiceToastTimer);
    voiceToastTimer = null;
  }
  if (!dom.voiceToast) return;
  dom.voiceToast.classList.remove('visible');
}

function showVoiceToast(message, variant = 'default', duration = 2400) {
  if (!dom.voiceToast || !message) return;
  dom.voiceToast.textContent = message;
  dom.voiceToast.classList.remove('is-browser', 'is-success');
  if (variant === 'browser') dom.voiceToast.classList.add('is-browser');
  if (variant === 'success') dom.voiceToast.classList.add('is-success');
  dom.voiceToast.classList.add('visible');

  if (voiceToastTimer) {
    clearTimeout(voiceToastTimer);
  }

  voiceToastTimer = setTimeout(() => {
    dom.voiceToast.classList.remove('visible');
    voiceToastTimer = null;
  }, duration);
}

function getVoiceRouteSummary(config = getConfig()) {
  const routing = getVoiceRouting(config);
  const inputLabel = routing.inputMode === 'doubao' ? '豆包识别' : '浏览器识别';
  const outputLabel = routing.outputMode === 'doubao' ? '豆包朗读' : '浏览器朗读';
  return {
    routing,
    routeKey: `${routing.inputMode}|${routing.outputMode}|${routing.fallbackReason}`,
    message: `语音已连接：输入 ${inputLabel}，输出 ${outputLabel}`,
    variant: routing.outputMode === 'browser' || routing.inputMode === 'browser' ? 'browser' : 'default',
  };
}

function notifyVoiceFallback(reason) {
  if (!reason || reason === lastVoiceFallbackReason) return;
  lastVoiceFallbackReason = reason;
  console.warn(reason);
  showVoiceToast(reason, 'browser', 3200);
}

function resolveSpeechPlaybackConfig(config = getConfig()) {
  if (!isTtsEnabled(config)) {
    return {
      ...config,
      ttsProvider: 'off',
    };
  }

  const routing = getVoiceRouting(config);
  if (routing.outputMode === 'doubao') {
    return {
      ...config,
      ttsProvider: 'doubao',
    };
  }
  return {
    ...config,
    ttsProvider: 'browser',
  };
}

function syncVoiceFallbackNotice({ force = false } = {}) {
  const { routing, routeKey, message, variant } = getVoiceRouteSummary();
  if (force || routeKey !== lastVoiceRouteKey) {
    lastVoiceRouteKey = routeKey;
    showVoiceToast(message, variant, 2600);
  }
  if (!routing.fallbackReason) {
    lastVoiceFallbackReason = '';
    return;
  }
  notifyVoiceFallback(routing.fallbackReason);
}

function announceAssistantSpeechStart(outputMode = getVoiceRouting().outputMode) {
  const message = outputMode === 'doubao' ? '助手正在用豆包朗读' : '助手正在用浏览器朗读';
  const variant = outputMode === 'doubao' ? 'success' : 'browser';
  showVoiceToast(message, variant, 2000);
}

function announceAssistantSpeechDone(outputMode = getVoiceRouting().outputMode) {
  const message = outputMode === 'doubao' ? '豆包朗读完成，继续听你说' : '朗读完成，继续听你说';
  const variant = outputMode === 'doubao' ? 'success' : 'browser';
  showVoiceToast(message, variant, 2200);
}

function announceVoiceCaptured() {
  showVoiceToast('已识别到语音，正在发送', 'success', 1800);
}

function announceVoiceStopFallback() {
  showVoiceToast('检测到停顿，已自动结束本轮录音', 'success', 2200);
}

function announceVoiceWaiting() {
  showVoiceToast('正在听你说话...', 'default', 1800);
}

function announceVoiceStopped() {
  showVoiceToast('已停止连续语音', 'browser', 1600);
}

function announceVoiceStarted(inputMode = getVoiceRouting().inputMode) {
  const message = inputMode === 'doubao' ? '已开始连续语音（豆包识别）' : '已开始连续语音（浏览器识别）';
  const variant = inputMode === 'doubao' ? 'default' : 'browser';
  showVoiceToast(message, variant, 2200);
}

function announceVoiceStartFailed(message) {
  showVoiceToast(message || '璇煶鍚姩澶辫触', 'browser', 2800);
}

function shouldShowRouteToast(config = getConfig()) {
  const { routeKey } = getVoiceRouteSummary(config);
  return routeKey !== lastVoiceRouteKey;
}

function commitVoiceRouteToast(config = getConfig(), force = false) {
  syncVoiceFallbackNotice({ force: force || shouldShowRouteToast(config) });
}

function updateVoiceStatusBadges(config = getConfig()) {
  updateVoiceControlAvailability(config);
  commitVoiceRouteToast(config, true);
}

function updateVoiceControlAvailability(config = getConfig()) {
  const sttEnabled = isSttEnabled(config);
  const ttsEnabled = isTtsEnabled(config);

  if (dom.recordBtn) {
    dom.recordBtn.disabled = !sttEnabled;
    dom.recordBtn.title = sttEnabled ? '连续语音' : '语音转写已关闭';
    dom.recordBtn.setAttribute('aria-label', dom.recordBtn.title);
  }

  if (dom.audioUploadBtn) {
    dom.audioUploadBtn.disabled = !sttEnabled;
    dom.audioUploadBtn.title = sttEnabled ? '上传音频转写' : '语音转写已关闭';
    dom.audioUploadBtn.setAttribute('aria-label', dom.audioUploadBtn.title);
  }

  if (dom.speakBtn) {
    dom.speakBtn.disabled = !ttsEnabled;
    dom.speakBtn.title = ttsEnabled ? '朗读上一条回复' : '语音播报已关闭';
    dom.speakBtn.setAttribute('aria-label', dom.speakBtn.title);
  }
}

function setProviderFieldsVisible(fieldName, visible) {
  document.querySelectorAll(`[data-provider-field="${fieldName}"]`).forEach((el) => {
    el.classList.toggle('is-hidden', !visible);
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  });
}

function syncVoiceProviderFieldVisibility(config = getConfig()) {
  setProviderFieldsVisible('asr-doubao', config.voiceMode !== 'browser');
  setProviderFieldsVisible('stt-service', config.sttProvider !== 'browser');
  setProviderFieldsVisible('tts-service', config.ttsProvider !== 'browser');
}

window.__VOICE_TOAST__ = showVoiceToast;
window.__VOICE_UI__ = {
  show: showVoiceToast,
  clear: clearVoiceToast,
  syncRoute: (force = false) => syncVoiceFallbackNotice({ force }),
  announceVoiceStarted: (inputMode) => announceVoiceStarted(inputMode ?? getVoiceRouting(getConfig()).inputMode),
  announceVoiceStopped,
  announceVoiceWaiting,
  announceVoiceCaptured,
  announceVoiceAutoStopped: announceVoiceStopFallback,
  announceVoiceStartFailed,
  announceAssistantSpeechStart: (outputMode) => announceAssistantSpeechStart(outputMode ?? getVoiceRouting(getConfig()).outputMode),
  announceAssistantSpeechDone: (outputMode) => announceAssistantSpeechDone(outputMode ?? getVoiceRouting(getConfig()).outputMode),
  getRouteSummary: () => getVoiceRouteSummary(getConfig()),
  fallbackNotice: notifyVoiceFallback,
  toast: dom.voiceToast,
};

window.__VOICE_UI__.assistant = {
  start: (outputMode) => announceAssistantSpeechStart(outputMode ?? getVoiceRouting(getConfig()).outputMode),
  done: (outputMode) => announceAssistantSpeechDone(outputMode ?? getVoiceRouting(getConfig()).outputMode),
};

window.__VOICE_UI__.conversation = {
  started: (inputMode) => announceVoiceStarted(inputMode ?? getVoiceRouting(getConfig()).inputMode),
  stopped: announceVoiceStopped,
  waiting: announceVoiceWaiting,
  captured: announceVoiceCaptured,
  autoStopped: announceVoiceStopFallback,
};

window.__VOICE_UI__.routeStatus = {
  sync: (force = false) => syncVoiceFallbackNotice({ force }),
  summary: () => getVoiceRouteSummary(getConfig()),
};

window.__VOICE_UI__.routeKey = () => lastVoiceRouteKey;
window.__VOICE_UI__.fallbackReason = () => lastVoiceFallbackReason;
window.__VOICE_UI__.routeSummary = () => getVoiceRouteSummary(getConfig());
window.__VOICE_UI__.routeToastNow = () => syncVoiceFallbackNotice({ force: true });
window.__VOICE_UI__.routeToastMaybe = () => syncVoiceFallbackNotice({ force: false });
window.__VOICE_UI__.showRoute = (force = false) => syncVoiceFallbackNotice({ force });
window.__VOICE_UI__.showFallback = notifyVoiceFallback;
window.__VOICE_UI__.hide = clearVoiceToast;


window.__VOICE_TRANSCRIPT_TEXT__ = getVoiceSubmitText;
window.__VOICE_TRANSCRIPT_VALID__ = isMeaningfulTranscript;

function applyLocalConfig() {
  const cfg = window.__LOCAL_CONFIG__ || {};
  const envLlmApiKey = import.meta.env?.VITE_LLM_API_KEY || import.meta.env?.VITE_DASHSCOPE_KEY;
  const envDoubaoApiKey = import.meta.env?.VITE_DOUBAO_API_KEY;
  const finalLlmApiKey = envLlmApiKey || cfg.LLM_API_KEY || cfg.DASHSCOPE_KEY;
  const finalDoubaoApiKey = envDoubaoApiKey || cfg.DOUBAO_API_KEY;

  if (finalLlmApiKey) {
    dom.llmApiKey.value = finalLlmApiKey;
    rememberCurrentLlmKey();
  } else if (!dom.llmApiKey.value && typeof finalLlmApiKey === 'string') {
    dom.llmApiKey.value = finalLlmApiKey;
    rememberCurrentLlmKey();
  }

  if (finalDoubaoApiKey) {
    dom.doubaoApiKey.value = finalDoubaoApiKey;
  } else if (!dom.doubaoApiKey.value && typeof finalDoubaoApiKey === 'string') {
    dom.doubaoApiKey.value = finalDoubaoApiKey;
  }


  if (!dom.llmEndpoint.value && cfg.DEFAULT_LLM_ENDPOINT) dom.llmEndpoint.value = cfg.DEFAULT_LLM_ENDPOINT;
  if (dom.asrEndpoint && !dom.asrEndpoint.value && cfg.DEFAULT_STT_ENDPOINT) dom.asrEndpoint.value = cfg.DEFAULT_STT_ENDPOINT;
  if (!dom.sttEndpoint.value && cfg.DEFAULT_STT_ENDPOINT) dom.sttEndpoint.value = cfg.DEFAULT_STT_ENDPOINT;
  if (!dom.ttsEndpoint.value && cfg.DEFAULT_TTS_ENDPOINT) dom.ttsEndpoint.value = cfg.DEFAULT_TTS_ENDPOINT;

  applyVoiceLocalDefaults();
  syncVoiceModeFallback();
  syncVoiceFallbackNotice({ force: true });
}

let namingInProgress = false;
export async function checkAutoNaming() {
  if (appState.canvas.blocks.length >= 5 && appState.canvas.title === '未命名白板' && !namingInProgress) {
    namingInProgress = true;
    try {
      const name = await callNamingLlm(getConfig(), appState.canvas);
      if (name) {
        appState.canvas.title = name;
        dom.boardTitle.textContent = name;
        saveCurrentCanvas();
      }
    } catch (e) {
      console.error('Naming failed', e);
    }
    namingInProgress = false;
  }
}

// 鈹€鈹€ Canvas change handler 鈹€鈹€
function onCanvasChange(options = {}) {
  if (options.relayout) {
    relayoutAfterContentChange({
      pushHistoryEntry: options.pushHistoryEntry,
      changedBlockIds: options.changedBlockIds,
    });
    return;
  }
  saveCurrentCanvas();
}

function isBlockPositionLocked(block) {
  return Boolean(block.locked || block.positionLocked);
}

function isCanvasLayoutLocked() {
  return appState.canvas.blocks.length > 0 && appState.canvas.blocks.every(isBlockPositionLocked);
}

function updateLayoutLockButton() {
  const btn = dom.layoutLockBtn;
  if (!btn) return;

  const total = appState.canvas.blocks.length;
  const lockedCount = appState.canvas.blocks.filter(isBlockPositionLocked).length;
  const locked = total > 0 && lockedCount === total;

  btn.disabled = total === 0;
  btn.classList.toggle('active', locked);
  btn.setAttribute('aria-pressed', locked ? 'true' : 'false');

  if (total === 0) {
    btn.title = '画布为空，无法锁定块位置';
  } else if (locked) {
    btn.title = '解锁块位置';
  } else if (lockedCount > 0) {
    btn.title = `锁定当前块位置（已锁定 ${lockedCount}/${total}）`;
  } else {
    btn.title = '锁定当前块位置';
  }
}

function setCanvasLayoutLocked(locked) {
  if (appState.canvas.blocks.length === 0) return;

  let changed = false;
  for (const block of appState.canvas.blocks) {
    if (Boolean(block.positionLocked) !== locked) {
      block.positionLocked = locked;
      changed = true;
    }
  }

  if (!changed) return;
  pushHistory();
  renderBlocks();
  saveCurrentCanvas();
  updateLayoutLockButton();
}

function toggleCanvasLayoutLock() {
  setCanvasLayoutLocked(!isCanvasLayoutLocked());
}

function syncCanvasAfterRender(newIds) {
  renderBlocks(newIds);
  updateLayoutLockButton();
}

function snapshotLockedBlockGeometry() {
  return appState.canvas.blocks
    .filter(isBlockPositionLocked)
    .map(block => ({
      id: block.id,
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
    }));
}

function restoreLockedBlockGeometry(snapshot) {
  for (const item of snapshot) {
    const block = appState.canvas.blocks.find(b => b.id === item.id);
    if (!block || !isBlockPositionLocked(block)) continue;
    block.x = item.x;
    block.y = item.y;
    if (item.width === undefined) delete block.width;
    else block.width = item.width;
    if (item.height === undefined) delete block.height;
    else block.height = item.height;
  }
}

function runManualAutoLayout() {
  try {
    assertCanvasIntegrity(appState.canvas);
  } catch (err) {
    alert('鑷姩甯冨眬鍓嶆鏌ュけ璐ワ細\n' + err.message);
    return;
  }

  let layoutCompleted = false;

  try {
    renderBlocks();
    syncBlockSizes({ adaptForAutoLayout: true });
    autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
    renderBlocks();
    syncBlockSizes();
    renderBlocks();
    fitToView();
    layoutCompleted = true;
  } finally {
    if (layoutCompleted) pushHistory();
    syncCanvasAfterRender();
    saveCurrentCanvas();
  }
}

function relayoutAfterContentChange({ pushHistoryEntry = false, fitView = false, changedBlockIds = [] } = {}) {
  assertCanvasIntegrity(appState.canvas);

  const lockedGeometry = snapshotLockedBlockGeometry();
  const changedIds = new Set(changedBlockIds || []);
  if (changedIds.size > 0) {
    for (const block of appState.canvas.blocks) {
      if (!changedIds.has(block.id) || isBlockPositionLocked(block)) continue;
      delete block.height;
    }
  }

  renderBlocks();
  syncBlockSizes({ adaptForAutoLayout: true });
  autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
  restoreLockedBlockGeometry(lockedGeometry);
  renderBlocks();
  syncBlockSizes();
  restoreLockedBlockGeometry(lockedGeometry);
  if (pushHistoryEntry) pushHistory();
  renderBlocks();
  if (fitView) fitToView();
  saveCurrentCanvas();
  updateLayoutLockButton();
}

// 鈹€鈹€ Reusable node actions 鈹€鈹€
function initChatPanelResize() {
  if (!dom.chatPanel || !dom.chatResizeHandle) return;

  const storageKey = 'canvas-studio-chat-width-v1';
  const minWidth = 300;
  const maxWidth = () => Math.max(minWidth, Math.min(900, window.innerWidth - 260));
  const clampWidth = width => Math.max(minWidth, Math.min(maxWidth(), Math.round(width)));
  const storedWidth = Number(localStorage.getItem(storageKey));

  if (Number.isFinite(storedWidth) && storedWidth > 0) {
    document.documentElement.style.setProperty('--chat-width', `${clampWidth(storedWidth)}px`);
  }

  dom.chatResizeHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || dom.chatPanel.classList.contains('collapsed')) return;
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = dom.chatPanel.getBoundingClientRect().width;

    dom.chatPanel.classList.add('resizing');
    document.body.classList.add('chat-resizing');
    dom.chatResizeHandle.setPointerCapture?.(e.pointerId);

    const handlePointerMove = (moveEvent) => {
      const nextWidth = clampWidth(startWidth + startX - moveEvent.clientX);
      document.documentElement.style.setProperty('--chat-width', `${nextWidth}px`);
      localStorage.setItem(storageKey, String(nextWidth));
    };

    const handlePointerUp = (upEvent) => {
      dom.chatPanel.classList.remove('resizing');
      document.body.classList.remove('chat-resizing');
      dom.chatResizeHandle.releasePointerCapture?.(upEvent.pointerId);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
  });

  window.addEventListener('resize', () => {
    const currentWidth = dom.chatPanel.getBoundingClientRect().width;
    if (currentWidth <= 0) return;
    document.documentElement.style.setProperty('--chat-width', `${clampWidth(currentWidth)}px`);
  });
}

function handleAddChild() {
  if (!appState.selectedBlockId) return;
  const parent = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!parent || parent.locked) return;
  const pos = findFreePosition(appState.canvas.blocks, appState.selectedBlockId, appState.canvas.connections);
  const newBlock = {
    id: crypto.randomUUID(),
    type: 'text',
    label: '新子块',
    content: '',
    x: pos.x,
    y: pos.y,
  };
  appState.canvas.blocks.push(newBlock);
  appState.canvas.connections.push({
    id: crypto.randomUUID(),
    fromId: appState.selectedBlockId,
    toId: newBlock.id,
  });
  appState.selectedBlockId = newBlock.id;
  pushHistory();
  syncCanvasAfterRender([newBlock.id]);
  saveCurrentCanvas();
  checkAutoNaming();
}

function handleAddSibling() {
  if (!appState.selectedBlockId) return;
  const parentConn = appState.canvas.connections.find(c => c.toId === appState.selectedBlockId);
  const parentId = parentConn?.fromId || null;
  const selected = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  const parent = parentId ? appState.canvas.blocks.find(b => b.id === parentId) : null;
  if (!selected || selected.locked || parent?.locked) return;

  const newBlock = {
    id: crypto.randomUUID(),
    type: 'text',
    label: '鏂板悓绾у潡',
    content: '',
    x: selected.x + 260,
    y: selected.y,
  };
  appState.canvas.blocks.push(newBlock);
  if (parentId) {
    appState.canvas.connections.push({
      id: crypto.randomUUID(),
      fromId: parentId,
      toId: newBlock.id,
    });
  }
  appState.selectedBlockId = newBlock.id;
  renderBlocks();
  syncBlockSizes({ adaptForAutoLayout: true });
  autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
  pushHistory();
  renderBlocks();
  syncBlockSizes();
  renderBlocks();
  saveCurrentCanvas();
  checkAutoNaming();
}

function getNewFileBlockPosition() {
  const view = document.getElementById('mindmapView');
  if (!view) {
    return { x: 120, y: 120 };
  }
  const rect = view.getBoundingClientRect();
  return {
    x: Math.round((rect.width / 2 - appState.viewport.panX) / appState.viewport.zoom - 170),
    y: Math.round((rect.height / 2 - appState.viewport.panY) / appState.viewport.zoom - 120),
  };
}

function createFileBlockFromAttachment(meta) {
  const pos = getNewFileBlockPosition();
  const isPdf = meta.type === 'application/pdf' || /\.pdf$/i.test(meta.name || '');
  const isImage = (meta.type || '').startsWith('image/');
  const block = {
    id: crypto.randomUUID(),
    type: 'file',
    label: meta.name || '文件附件',
    content: '',
    x: pos.x,
    y: pos.y,
    width: isPdf || isImage ? 360 : 260,
    file: {
      attachmentId: meta.id,
      name: meta.name,
      type: meta.type,
      size: meta.size,
      mode: meta.mode,
      status: meta.status || 'ready',
      pathLabel: meta.pathLabel || meta.name,
      pages: isPdf ? [1] : [1],
      annotations: {},
    },
  };
  appState.canvas.blocks.push(block);
  appState.selectedBlockId = block.id;
  appState.selectedBlockIds = [block.id];
  pushHistory();
  syncCanvasAfterRender([block.id]);
  saveCurrentCanvas();
}

function chooseCopyAttachment() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,image/*,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.txt,.md,.csv';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const meta = await createCopyAttachment(file);
      createFileBlockFromAttachment(meta);
    } catch (err) {
      alert('上传失败：' + err.message);
    }
  }, { once: true });
  input.click();
}

async function chooseMappedAttachment() {
  try {
    const meta = await createMappedAttachment();
    createFileBlockFromAttachment(meta);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    alert('映射失败：浏览器当前不允许读取该文件。你可以改用保存副本，或在浏览器授权后重试。');
  }
}

function getAttachmentStatusText(item) {
  if (item.status === 'permission-blocked') return '需授权';
  if (item.status === 'broken-copy') return '映射断开，已转副本';
  if (item.mode === 'mapped') return '映射，含副本';
  return '副本';
}

function formatAttachmentSize(size) {
  const n = Number(size) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return n > 0 ? `${n} B` : '鏈煡澶у皬';
}

function isPdfAttachment(item) {
  return item.type === 'application/pdf' || /\.pdf$/i.test(item.name || '');
}

function parsePdfPagesText(text) {
  return [...new Set(String(text || '')
    .split(/[,锛孿s]+/)
    .map(part => Number(part.trim()))
    .filter(page => Number.isInteger(page) && page > 0))];
}

function getUsedPdfPages(attachmentId) {
  const pages = new Set();
  const blockPageOverrides = new Map();

  document.querySelectorAll('.mm-block-file').forEach(el => {
    const blockId = el.dataset.id;
    const preview = el.querySelector('.file-preview');
    if (!blockId || preview?.dataset.attachmentId !== attachmentId) return;

    const inputPages = parsePdfPagesText(el.querySelector('.file-page-input')?.value);
    if (inputPages.length > 0) {
      blockPageOverrides.set(blockId, inputPages);
      inputPages.forEach(page => pages.add(page));
    }
  });

  for (const block of appState.canvas.blocks) {
    if (block.type !== 'file' || block.file?.attachmentId !== attachmentId) continue;
    const blockPages = blockPageOverrides.get(block.id) || (Array.isArray(block.file.pages) ? block.file.pages : [1]);
    if (blockPageOverrides.has(block.id)) {
      block.file.pages = [...blockPages];
    }
    blockPages.forEach(page => {
      const n = Number(page);
      if (Number.isInteger(n) && n > 0) pages.add(n);
    });
  }
  return [...pages].sort((a, b) => a - b);
}

function remapPdfBlocks(attachmentId, pageMap, pageCount) {
  for (const block of appState.canvas.blocks) {
    if (block.type !== 'file' || block.file?.attachmentId !== attachmentId) continue;
    const pages = Array.isArray(block.file.pages) ? block.file.pages : [1];
    block.file.pages = [...new Set(pages
      .map(page => pageMap.get(Number(page)))
      .filter(page => Number.isInteger(page) && page > 0))];
    if (block.file.pages.length === 0) block.file.pages = [1];

    const nextAnnotations = {};
    Object.entries(block.file.annotations || {}).forEach(([page, rects]) => {
      const nextPage = pageMap.get(Number(page));
      if (!nextPage || !Array.isArray(rects)) return;
      const key = String(nextPage);
      nextAnnotations[key] = [...(nextAnnotations[key] || []), ...rects];
    });
    block.file.annotations = nextAnnotations;
    block.file.pageCount = pageCount;
    block.file.activePageIndex = 0;
    block.file.mode = 'copy';
    block.file.status = 'ready';
    block.file.pathLabel = block.file.name;
  }
}

async function compactPdfAttachment(item) {
  const usedPages = getUsedPdfPages(item.id);
  if (usedPages.length === 0) {
    alert('当前画布中没有使用这个 PDF 的页面');
    return;
  }

  const result = await getAttachmentFile(item.id);
  if (!result.file) {
    alert('鏃犳硶璇诲彇 PDF 鏂囦欢锛岃鍏堥噸鏂颁笂浼犳垨閫夋嫨鍓湰');
    return;
  }

  const sourcePdf = await PDFDocument.load(await result.file.arrayBuffer());
  const totalPages = sourcePdf.getPageCount();
  const safePages = [...new Set(usedPages.map(page => Math.min(Math.max(1, page), totalPages)))].sort((a, b) => a - b);
  if (safePages.length === 0) {
    alert('娌℃湁鍙繚鐣欑殑鏈夋晥椤电爜');
    return;
  }

  const nextPdf = await PDFDocument.create();
  const copiedPages = await nextPdf.copyPages(sourcePdf, safePages.map(page => page - 1));
  copiedPages.forEach(page => nextPdf.addPage(page));
  const bytes = await nextPdf.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const pageMap = new Map(safePages.map((page, index) => [page, index + 1]));
  const suffix = safePages.length === totalPages ? '' : '-used-pages';
  const baseName = (item.name || 'document.pdf').replace(/\.pdf$/i, '');
  const nextName = `${baseName}${suffix}.pdf`;

  await updateAttachmentBlob(item.id, blob, {
    name: nextName,
    type: 'application/pdf',
    mode: 'copy',
    status: 'ready',
    pathLabel: nextName,
    pageCount: safePages.length,
  });

  remapPdfBlocks(item.id, pageMap, safePages.length);
  pushHistory();
  syncCanvasAfterRender();
  saveCurrentCanvas();
}

function renderAttachmentList(items) {
  if (!items.length) {
    return '<div class="file-list-empty">暂无附件</div>';
  }

  return items.map(item => `
    <div class="file-list-item" data-attachment-id="${item.id}">
      <div class="file-list-main">
        <div class="file-list-name" title="${escapeHtml(item.name || '')}">${escapeHtml(item.name || '未命名文件')}</div>
        <div class="file-list-path" title="${escapeHtml(item.pathLabel || item.name || '')}">${escapeHtml(item.pathLabel || item.name || '浏览器未开放完整路径')}</div>
        <div class="file-list-meta">
          <span class="file-list-status ${item.status === 'permission-blocked' ? 'needs-auth' : ''}">${getAttachmentStatusText(item)}</span>
          <span>${formatAttachmentSize(item.size)}</span>
        </div>
      </div>
      <div class="file-list-actions">
        ${isPdfAttachment(item) ? `<button class="file-list-compact" data-compact-pdf="${item.id}" type="button">鍙暀浣跨敤椤?/button>` : ''}
        <button class="file-list-use" data-use-attachment="${item.id}" type="button">鎻掑叆</button>
      </div>
    </div>
  `).join('');
}

async function showFileUploadMenu() {
  let menu = document.getElementById('fileUploadMenu');
  if (menu) {
    menu.remove();
    return;
  }

  const attachments = await listAttachments();

  menu = document.createElement('div');
  menu.id = 'fileUploadMenu';
  menu.className = 'import-menu file-upload-menu';
  menu.innerHTML = `
    <div class="file-upload-actions">
      <button class="import-item" data-mode="mapped" ${supportsMappedFiles() ? '' : 'disabled'}>
        <span class="import-icon">↗</span>
        <span class="import-text">
          <strong>映射文件</strong>
          <small>上传副本，每次刷新</small>
        </span>
      </button>
      <button class="import-item" data-mode="copy">
        <span class="import-icon">⧉</span>
        <span class="import-text">
          <strong>保存副本</strong>
          <small>不随本地文件修改</small>
        </span>
      </button>
    </div>
    <div class="file-list-panel">
      <div class="file-list-title">附件列表</div>
      ${renderAttachmentList(attachments)}
    </div>
  `;

  const rect = dom.fileUploadBtn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left}px`;
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const compactBtn = e.target.closest('[data-compact-pdf]');
    if (compactBtn) {
      const attachment = attachments.find(item => item.id === compactBtn.dataset.compactPdf);
      if (attachment) {
        compactBtn.disabled = true;
        compactBtn.textContent = '处理中...';
        compactPdfAttachment(attachment)
          .then(() => {
            menu.remove();
          })
          .catch(err => {
            compactBtn.disabled = false;
            compactBtn.textContent = '只留使用页';
            alert('处理失败：' + err.message);
          });
      }
      return;
    }

    const reuseBtn = e.target.closest('[data-use-attachment]');
    if (reuseBtn) {
      const attachment = attachments.find(item => item.id === reuseBtn.dataset.useAttachment);
      if (attachment) {
        createFileBlockFromAttachment(attachment);
        menu.remove();
      }
      return;
    }

    const item = e.target.closest('[data-mode]');
    if (!item || item.disabled) return;
    const mode = item.dataset.mode;
    menu.remove();
    if (mode === 'mapped') chooseMappedAttachment();
    else chooseCopyAttachment();
  });

  setTimeout(() => {
    document.addEventListener('pointerdown', function closer(e) {
      if (!menu.contains(e.target) && e.target !== dom.fileUploadBtn) {
        menu.remove();
        document.removeEventListener('pointerdown', closer);
      }
    });
  }, 10);
}

function handleDeleteNode() {
  // 鏀寔澶氶€夊垹闄?
  const selectedIds = appState.selectedBlockIds.length > 0
    ? [...appState.selectedBlockIds]
    : appState.selectedBlockId
      ? [appState.selectedBlockId]
      : [];

  if (selectedIds.length === 0) return;

  // 閫掑綊鏀堕泦瑕佸垹闄ょ殑鍧楋紙鍖呮嫭瀛愯妭鐐癸級
  const toRemove = new Set(selectedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const conn of appState.canvas.connections) {
      if (toRemove.has(conn.fromId) && !toRemove.has(conn.toId)) {
        toRemove.add(conn.toId);
        changed = true;
      }
    }
  }

  // 鍒犻櫎鍧?
  appState.canvas.blocks = appState.canvas.blocks.filter(b => !toRemove.has(b.id));

  // 鍒犻櫎鐩稿叧杩炴帴
  appState.canvas.connections = appState.canvas.connections.filter(
    c => !toRemove.has(c.fromId) && !toRemove.has(c.toId)
  );

  // 鍒犻櫎缁勫唴鐨勫潡寮曠敤锛屽鏋滅粍涓虹┖鍒欏垹闄ょ粍
  if (appState.canvas.groups) {
    for (let i = appState.canvas.groups.length - 1; i >= 0; i--) {
      const group = appState.canvas.groups[i];
      group.blockIds = group.blockIds.filter(id => !toRemove.has(id));
      if (group.blockIds.length === 0) {
        appState.canvas.groups.splice(i, 1);
      }
    }
  }

  // 娓呴櫎閫変腑鐘舵€?
  appState.selectedBlockId = null;
  appState.selectedBlockIds = [];
  pushHistory();
  syncCanvasAfterRender();
  saveCurrentCanvas();
}

/** 鎷嗗垎鍧?- 灏嗕竴涓潡鎷嗘垚鍑犱釜璇箟涓婂尯鍒嗙殑鍧?*/
async function handleSplitNode() {
  if (!appState.selectedBlockId) return;
  const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!block) return;

  const btn = $('splitNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '拆分中...';
  }

  try {
    const config = getConfig();
    // 璋冪敤 LLM 杩涜鎷嗗垎
    const response = await fetch(config.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel || 'qwen-plus',
        messages: [{
          role: 'user',
          content: `Split the following content into 2-4 semantically independent blocks. Requirements:
- Each block should have a label (concise title) and content (brief description)
- Use concise language, remove redundancy, keep core information
- Return ONLY a JSON array: [{"label":"Title 1","content":"Content 1"},{"label":"Title 2","content":"Content 2"}...]
- No explanations, no extra text

Original content:
Label: ${block.label}
Content: ${block.content || 'None'}`
        }],
        max_tokens: 800
      })
    });

    const data = await response.json();
    const splitResult = JSON.parse(data?.choices?.[0]?.message?.content || '[]');

    if (splitResult.length > 0) {
      // 鍒犻櫎鍘熷鍧?
      const blockIndex = appState.canvas.blocks.findIndex(b => b.id === block.id);
      appState.canvas.blocks.splice(blockIndex, 1);

      // 鍒涘缓鎷嗗垎鍚庣殑鏂板潡锛屾帓鍒楀湪鍘熷鍧楅檮杩?
      const baseX = block.x;
      const baseY = block.y;
      const verticalGap = 100;

      splitResult.forEach((item, index) => {
        const newBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          label: repairMarkdownFormatting(item.label || `拆分块 ${index + 1}`).text,
          content: repairMarkdownFormatting(item.content || '').text,
          x: baseX,
          y: baseY + index * verticalGap,
        };
        appState.canvas.blocks.push(newBlock);

        // 濡傛灉鏄涓€涓潡锛岀户鎵垮師濮嬪潡鐨勮繛鎺?
        if (index === 0) {
          // 缁ф壙鎵€鏈変紶鍏ヨ繛鎺ワ紙fromId 鎸囧悜鍘熷鍧楃殑锛?
          appState.canvas.connections.forEach(conn => {
            if (conn.toId === block.id) {
              conn.toId = newBlock.id;
            }
          });
          // 缁ф壙鎵€鏈変紶鍑鸿繛鎺ワ紙toId 鎸囧悜鍘熷鍧楃殑锛?
          appState.canvas.connections.forEach(conn => {
            if (conn.fromId === block.id) {
              conn.fromId = newBlock.id;
            }
          });
        }
      });

      // 娓呯悊缁勫紩鐢?
      if (appState.canvas.groups) {
        appState.canvas.groups.forEach(group => {
          const idx = group.blockIds.indexOf(block.id);
          if (idx !== -1) {
            group.blockIds.splice(idx, 1);
          }
        });
      }

      pushHistory();
      syncCanvasAfterRender();
      saveCurrentCanvas();
    } else {
      alert('无法拆分，请尝试手动编辑');
    }
  } catch (err) {
    console.error('Split error:', err);
    alert('拆分失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M3 12h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
        <span>拆分</span>
      `;
    }
  }
}

/** 鍚堝苟鍧?- 灏嗛€変腑鐨勫涓潡鍚堝苟鎴愪竴涓?*/
async function handleMergeNode() {
  const selectedIds = appState.selectedBlockIds;
  if (selectedIds.length < 2) {
    alert('请选中至少 2 个块才能合并');
    return;
  }

  const selectedBlocks = appState.canvas.blocks.filter(b => selectedIds.includes(b.id));

  const btn = $('mergeNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '合并中...';
  }

  try {
    const config = getConfig();

    // 璋冪敤 LLM 杩涜鍚堝苟
    const response = await fetch(config.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel || 'qwen-plus',
        messages: [{
          role: 'user',
          content: `Merge the following content into one block. Requirements:
- label: Create a concise title that captures the core theme
- content: Remove duplicates, retain all key points and important details, use concise language
- Use short sentences and structured expression, avoid verbose explanations
- Return ONLY JSON: {"label":"New Title","content":"Merged content"}
- No explanations, no extra text
- IMPORTANT: Keep the output language the same as the input content language

Content to merge:
${selectedBlocks.map(b => `[${b.label}] ${b.content || ''}`).join('\n\n')}`
        }],
        max_tokens: 1500
      })
    });

    const data = await response.json();
    const mergeResult = JSON.parse(data?.choices?.[0]?.message?.content || '{}');

    if (mergeResult.label) {
      // 璁＄畻杈圭晫妗嗭紝纭畾鍚堝苟鍚庡潡鐨勪綅缃?
      const minX = Math.min(...selectedBlocks.map(b => b.x));
      const minY = Math.min(...selectedBlocks.map(b => b.y));

      // 鍒涘缓鍚堝苟鍚庣殑鏂板潡
      const mergedBlock = {
        id: crypto.randomUUID(),
        type: 'text',
        label: repairMarkdownFormatting(mergeResult.label).text,
        content: repairMarkdownFormatting(mergeResult.content || '').text,
        x: minX,
        y: minY,
        width: 240, // 鍚堝苟鍚庣殑鍧楃◢澶т竴浜?
      };
      appState.canvas.blocks.push(mergedBlock);

      // 缁ф壙鎵€鏈夎繛鎺ョ殑婧愬拰鐩爣
      const connFromIds = new Set();
      const connToIds = new Set();
      selectedBlocks.forEach(b => {
        appState.canvas.connections.forEach(conn => {
          if (conn.fromId === b.id) {
            connFromIds.add(conn.toId);
          }
          if (conn.toId === b.id) {
            connToIds.add(conn.fromId);
          }
        });
      });

      // 鍒涘缓鏂拌繛鎺?
      connFromIds.forEach(toId => {
        if (!selectedIds.includes(toId)) { // 涓嶈繛鎺ュ埌宸插垹闄ょ殑鍧?
          appState.canvas.connections.push({
            id: crypto.randomUUID(),
            fromId: mergedBlock.id,
            toId,
          });
        }
      });
      connToIds.forEach(fromId => {
        if (!selectedIds.includes(fromId)) { // 涓嶄粠宸插垹闄ょ殑鍧楄繛鎺?
          appState.canvas.connections.push({
            id: crypto.randomUUID(),
            fromId,
            toId: mergedBlock.id,
          });
        }
      });

      // 鍒犻櫎鍘熷鍧楀拰杩炴帴
      appState.canvas.blocks = appState.canvas.blocks.filter(b => !selectedIds.includes(b.id));
      appState.canvas.connections = appState.canvas.connections.filter(
        c => !selectedIds.includes(c.fromId) && !selectedIds.includes(c.toId)
      );

      // 娓呯悊缁勫紩鐢?
      if (appState.canvas.groups) {
        appState.canvas.groups.forEach(group => {
          group.blockIds = group.blockIds.filter(id => !selectedIds.includes(id));
        });
      }

      // 閫変腑鏂板潡
      appState.selectedBlockId = mergedBlock.id;
      appState.selectedBlockIds = [];

      pushHistory();
      renderBlocks();
      saveCurrentCanvas();
    } else {
      alert('无法合并，请尝试手动编辑');
    }
  } catch (err) {
    console.error('Merge error:', err);
    alert('合并失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" stroke="currentColor" stroke-width="2"/><rect x="14" y="3" width="7" height="7" stroke="currentColor" stroke-width="2"/><rect x="8" y="14" width="7" height="7" stroke="currentColor" stroke-width="2"/></svg>
        <span>合并</span>
      `;
    }
  }
}
function shouldUseBrowserVoiceMode(config = getConfig()) {
  return getVoiceRouting(config).inputMode === 'browser';
}

function shouldUseBrowserSpeech(config = getConfig()) {
  return getVoiceRouting(config).outputMode === 'browser';
}

function buildBrowserUtterance(reply) {
  const utterance = new SpeechSynthesisUtterance(reply);
  utterance.lang = getSpeechSynthesisLanguage();
  utterance.rate = 1.4;
  return utterance;
}

function playBrowserSpeech(reply, callbacks = {}) {
  return new Promise((resolve) => {
    const utterance = buildBrowserUtterance(reply);
    utterance.onend = () => {
      callbacks.onDone?.();
      resolve();
    };
    utterance.onerror = () => {
      callbacks.onError?.();
      resolve();
    };
    speechSynthesis.cancel();
    callbacks.onStart?.();
    speechSynthesis.speak(utterance);
  });
}

async function playReplyWithResolvedConfig(reply, config = getConfig()) {
  if (!isTtsEnabled(config)) return;

  const resolvedConfig = resolveSpeechPlaybackConfig(config);
  const routing = getVoiceRouting(config);

  if (resolvedConfig.ttsProvider === 'off') return;

  if (routing.fallbackReason) {
    notifyVoiceFallback(routing.fallbackReason);
  } else {
    lastVoiceFallbackReason = '';
  }

  if (resolvedConfig.ttsProvider === 'browser') {
    await playBrowserSpeech(reply, {
      onStart: () => announceAssistantSpeechStart('browser'),
      onDone: () => announceAssistantSpeechDone('browser'),
    });
    return;
  }

  announceAssistantSpeechStart('doubao');
  try {
    await speak(reply, resolvedConfig);
    announceAssistantSpeechDone('doubao');
  } catch (error) {
    console.error('豆包语音合成失败', error);
    showVoiceToast(`豆包播报失败：${error.message || '请检查 TTS 配置'}`, 'browser', 3200);
  }
}

function isAssistantPlaybackPending() {
  return isConversationActive && !isListeningActive();
}

async function safeResumeListening() {
  if (!isConversationActive || !isAssistantPlaybackPending()) return;
  await resumeListening();
}

let earlyVoiceResumeTimer = null;

function clearEarlyVoiceResumeTimer() {
  if (!earlyVoiceResumeTimer) return;
  clearTimeout(earlyVoiceResumeTimer);
  earlyVoiceResumeTimer = null;
}

function scheduleEarlyVoiceResumeDuringModelReply() {
  clearEarlyVoiceResumeTimer();
  if (!isConversationActive || isTtsEnabled()) return;

  earlyVoiceResumeTimer = setTimeout(() => {
    earlyVoiceResumeTimer = null;
    void safeResumeListening();
  }, 1000);
}

async function playAssistantReply(reply) {
  clearEarlyVoiceResumeTimer();
  if (!reply || !isTtsEnabled()) {
    await safeResumeListening();
    return;
  }

  await playReplyWithResolvedConfig(reply, getConfig());
  await safeResumeListening();
}

async function replayAssistantReply(reply) {
  if (!reply) return;
  if (!isTtsEnabled()) {
    showVoiceToast('语音播报已关闭', 'browser', 1800);
    return;
  }
  await playReplyWithResolvedConfig(reply, getConfig());
}

window.__VOICE_MODE_HELPERS__ = {
  shouldUseBrowserRecognition: () => shouldUseBrowserVoiceMode(getConfig()),
  isRecognitionEnabled: () => isSttEnabled(getConfig()),
};

window.__GET_CONFIG__ = getConfig;
window.__PLAY_ASSISTANT_REPLY__ = playAssistantReply;
window.__GET_VOICE_LANGUAGE__ = getSpeechSynthesisLanguage;
window.__VOICE_FILE_TRANSCRIBE__ = handleAudioFileSelected;
window.__VOICE_TRANSCRIPT_TEXT__ = getVoiceSubmitText;
window.__VOICE_TRANSCRIPT_VALID__ = isMeaningfulTranscript;

function setPresetInputValue(input, value, preserveExisting = false) {
  if (!input || !value) return;
  if (!preserveExisting || !input.value) {
    input.value = value;
  }
}

function setLlmProviderModel(provider, preserveExisting = false) {
  const preset = ENDPOINT_PRESETS[provider] || {};
  setPresetInputValue(dom.llmModel, preset.llmModel, preserveExisting);
}

function setSttProviderModels(provider, preserveExisting = false) {
  const preset = ENDPOINT_PRESETS[provider] || {};
  setPresetInputValue(dom.sttModel, preset.sttModel, preserveExisting);
  setPresetInputValue(dom.fileSttModel, preset.fileSttModel, preserveExisting);
}

function setAsrProviderPreset(provider, preserveExisting = false) {
  if (!dom.asrEndpoint || !dom.asrModel || !dom.asrResourceId) return;
  if (provider === 'browser') return;
  const preset = ENDPOINT_PRESETS.doubao || {};
  setPresetInputValue(dom.asrEndpoint, preset.stt, preserveExisting);
  setPresetInputValue(dom.asrModel, preset.sttModel, preserveExisting);
  setPresetInputValue(dom.asrResourceId, 'volc.seedasr.sauc.duration', preserveExisting);
}

function setTtsProviderModels(provider, preserveExisting = false) {
  const preset = ENDPOINT_PRESETS[provider] || {};
  setPresetInputValue(dom.ttsModel, preset.ttsModel, preserveExisting);
  setPresetInputValue(dom.realtimeVoiceModel, preset.realtimeVoiceModel, preserveExisting);
}

function setConfig(config) {
  const finalConfig = applyConfigDefaults(config);
  for (const [key, value] of Object.entries(finalConfig)) {
    if (key === 'searchMode') {
      setSearchModeValue(value);
      continue;
    }
    if (key === 'preferBuiltinSearch') {
      if (dom.preferBuiltinSearch) dom.preferBuiltinSearch.checked = Boolean(value);
      continue;
    }
    if (key === 'sttEnabled' || key === 'ttsEnabled') {
      if (dom[key]) dom[key].value = value === false || value === 'false' ? 'false' : 'true';
      continue;
    }
    if (dom[key] && typeof value === 'string') dom[key].value = value;
  }
  applyLlmKeyConfig(finalConfig);
  updateTongyiSearchVisibility();
  syncVoiceModeFallback();
  updateVoiceControlAvailability(getConfig());
  syncVoiceProviderFieldVisibility(getConfig());
}

function setAudioUploadBusy(isBusy, label = '涓婁紶闊抽杞啓') {
  if (!dom.audioUploadBtn) return;
  dom.audioUploadBtn.disabled = isBusy || !isSttEnabled();
  dom.audioUploadBtn.title = label;
  dom.audioUploadBtn.setAttribute('aria-label', label);
}

async function handleAudioFileSelected(file) {
  if (!file) return;
  if (!isSttEnabled()) {
    showVoiceToast('语音转写已关闭', 'browser', 1800);
    return;
  }
  setAudioUploadBusy(true, '正在转写音频...');
  try {
    const text = await transcribe(file, getConfig());
    const cleaned = (text || '').trim();
    if (!cleaned) throw new Error('鏈瘑鍒埌鏈夋晥鏂囨湰');

    if (isConversationActive) {
      await sendText(cleaned);
      return;
    }

    const input = document.getElementById('chatInput');
    if (input) {
      input.value = cleaned;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  } catch (error) {
    console.error('闊抽鏂囦欢杞啓澶辫触:', error);
    alert(`闊抽杞啓澶辫触锛?{error.message}`);
  } finally {
    if (dom.audioFileInput) dom.audioFileInput.value = '';
    setAudioUploadBusy(false, '涓婁紶闊抽杞啓');
  }
}

function applyProviderPreset(preserveExistingModels = true) {
  const llmPreset = ENDPOINT_PRESETS[dom.llmProvider.value]?.llm || '';
  const sttPreset = ENDPOINT_PRESETS[dom.sttProvider.value]?.stt || '';
  const ttsPreset = ENDPOINT_PRESETS[dom.ttsProvider.value]?.tts || '';

  const llmCustom = dom.llmProvider.value === 'custom';
  const sttCustom = dom.sttProvider.value === 'custom';
  const ttsCustom = dom.ttsProvider.value === 'custom' || dom.ttsProvider.value === 'browser';

  dom.llmEndpoint.readOnly = !llmCustom;
  dom.sttEndpoint.readOnly = !sttCustom;
  dom.ttsEndpoint.readOnly = !ttsCustom;

  if (!llmCustom) dom.llmEndpoint.value = llmPreset;
  if (!sttCustom) dom.sttEndpoint.value = sttPreset;
  if (!ttsCustom) dom.ttsEndpoint.value = ttsPreset;

  setLlmProviderModel(dom.llmProvider.value, preserveExistingModels);
  setSttProviderModels(dom.sttProvider.value, preserveExistingModels);
  setTtsProviderModels(dom.ttsProvider.value, preserveExistingModels);
  syncVoiceModeFallback();
}

function closeModelDropdown() {
  if (!dom.modelDropdown) return;
  dom.modelDropdown.classList.remove('open');
  dom.modelDropdown.setAttribute('aria-hidden', 'true');
}

function renderModelDropdown(models = modelOptions) {
  if (!dom.modelDropdown) return;

  dom.modelDropdown.innerHTML = '';
  if (!models.length) {
    closeModelDropdown();
    return;
  }

  models.forEach((modelId) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'model-option';
    item.textContent = modelId;
    item.addEventListener('click', () => {
      dom.llmModel.value = modelId;
      closeModelDropdown();
      dom.llmModel.focus();
    });
    dom.modelDropdown.appendChild(item);
  });
}

function openModelDropdown() {
  if (!dom.modelDropdown || !modelOptions.length) return;

  renderModelDropdown();
  dom.modelDropdown.classList.add('open');
  dom.modelDropdown.setAttribute('aria-hidden', 'false');
}

function updateModelOptions(models) {
  modelOptions = [...new Set(models.filter(Boolean))];

  const datalist = document.getElementById('modelDataList');
  if (datalist) {
    datalist.innerHTML = '';
    modelOptions.forEach((modelId) => {
      const option = document.createElement('option');
      option.value = modelId;
      datalist.appendChild(option);
    });
  }

  renderModelDropdown();
  openModelDropdown();
}

function applyVoiceModePreset() {
  setAsrProviderPreset(dom.voiceMode.value, false);
  syncVoiceFallbackNotice();
}

function applyVoiceLocalDefaults() {
  if (!dom.voiceMode.value) dom.voiceMode.value = 'doubao-pipeline';
  if (!dom.voiceLanguage.value) dom.voiceLanguage.value = 'zh-CN';
  setAsrProviderPreset(dom.voiceMode.value, true);
  if (!dom.asrModel?.value && dom.sttModel?.value) dom.asrModel.value = dom.sttModel.value;
  if (!dom.asrResourceId?.value && dom.doubaoResourceId?.value) dom.asrResourceId.value = dom.doubaoResourceId.value;
  if (!dom.asrEndpoint?.value && dom.sttEndpoint?.value?.startsWith('ws')) dom.asrEndpoint.value = dom.sttEndpoint.value;
}

function bindAudioUpload() {
  if (!dom.audioUploadBtn || !dom.audioFileInput) return;
  dom.audioUploadBtn.addEventListener('click', () => {
    if (!isSttEnabled()) {
      showVoiceToast('语音转写已关闭', 'browser', 1800);
      return;
    }
    dom.audioFileInput.click();
  });
  dom.audioFileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await handleAudioFileSelected(file);
  });
}

function getSpeechSynthesisLanguage() {
  return dom.voiceLanguage.value || 'zh-CN';
}

function getVoiceSubmitText(transcribedText) {
  return (transcribedText || '').trim();
}

function isMeaningfulTranscript(text) {
  return !!text && text.replace(/[^\w\u4e00-\u9fa5]/g, '').length > 0;
}

/** 鎵╁紶鍧?- 鍦ㄥ綋鍓嶅潡鍐呭鍔犳洿澶氬唴瀹?*/
async function handleExpandNode() {
  if (!appState.selectedBlockId) return;
  const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!block) return;

  const btn = $('expandNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '扩展中...';
  }

  try {
    const config = getConfig();
    // 璋冪敤 LLM 杩涜鎵╁紶
    const response = await fetch(config.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel || 'qwen-plus',
        messages: [{
          role: 'user',
          content: `Expand the following content. Requirements:
- label: Keep or slightly refine the original title
- content: Add key points, examples, or relevant information to enrich the content
- Use concise language with short sentences, avoid verbosity
- Stay on topic, do not deviate from the core theme
- Return ONLY JSON: {"label":"Title","content":"Expanded content"}
- No explanations, no extra text
- IMPORTANT: Keep the output language the same as the input content language

Original content:
Label: ${block.label}
Content: ${block.content || 'None'}`
        }],
        max_tokens: 1200
      })
    });

    const data = await response.json();
    const expandResult = JSON.parse(data?.choices?.[0]?.message?.content || '{}');

    if (expandResult.content) {
      block.label = repairMarkdownFormatting(expandResult.label || block.label).text;
      block.content = repairMarkdownFormatting(expandResult.content).text;
      relayoutAfterContentChange({ pushHistoryEntry: true, changedBlockIds: [block.id] });
    } else {
      alert('无法扩展，请尝试手动编辑');
    }
  } catch (err) {
    console.error('Expand error:', err);
    alert('扩展失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2v20M2 12h20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="5" y="5" width="14" height="14" stroke="currentColor" stroke-width="2" rx="2"/></svg>
        <span>扩展</span>
      `;
    }
  }
}

/** 娲剧敓鍧?- 鍒涘缓鏇存繁灞傛鐨勫瓙灞傜骇鍧?*/
async function handleDeriveNode() {
  if (!appState.selectedBlockId) return;
  const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!block) return;

  const btn = $('deriveNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '派生中...';
  }

  try {
    const config = getConfig();
    // 璋冪敤 LLM 鐢熸垚娲剧敓瀛愬眰绾?
    const response = await fetch(config.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel || 'qwen-plus',
        messages: [{
          role: 'user',
          content: `Based on the following content, generate 2-4 deeper-level subtopics. Each subtopic should include a label (title) and brief content (description). Return ONLY a JSON array: [{"label":"Subtopic 1","content":"Description 1"},{"label":"Subtopic 2","content":"Description 2"}...]
- IMPORTANT: Keep the output language the same as the input content language
- No explanations, no extra text

Parent content:
Label: ${block.label}
Content: ${block.content || 'None'}`
        }],
        max_tokens: 1000
      })
    });

    const data = await response.json();
    const deriveResult = JSON.parse(data?.choices?.[0]?.message?.content || '[]');

    if (deriveResult.length > 0) {
      const startX = block.x + 260; // 鍦ㄥ彸渚х敓鎴?
      const startY = block.y;
      const verticalGap = 80;

      deriveResult.forEach((item, index) => {
        const newBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          label: repairMarkdownFormatting(item.label || `派生 ${index + 1}`).text,
          content: repairMarkdownFormatting(item.content || '').text,
          x: startX,
          y: startY + index * verticalGap,
        };
        appState.canvas.blocks.push(newBlock);

        // 鍒涘缓浠庣埗鍧楀埌鏂板潡鐨勮繛鎺?
        appState.canvas.connections.push({
          id: crypto.randomUUID(),
          fromId: block.id,
          toId: newBlock.id,
        });
      });

      pushHistory();
      syncCanvasAfterRender();
      saveCurrentCanvas();
    } else {
      alert('无法派生，请尝试手动添加子块');
    }
  } catch (err) {
    console.error('Derive error:', err);
    alert('派生失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v8m0 0l-3-3m3 3l3-3M4 21h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>派生</span>
      `;
    }
  }
}

/** 缈昏瘧鍧?- 涓嫳浜掕瘧 */
async function handleTranslateNode() {
  if (!appState.selectedBlockId) return;
  const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!block) return;

  const btn = $('translateNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '翻译中...';
  }

  try {
    const config = getConfig();
    // 璋冪敤 LLM 杩涜缈昏瘧
    const response = await fetch(config.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel || 'qwen-plus',
        messages: [{
          role: 'user',
          content: `Translate the following content between Chinese and English. Requirements:
- If the content is mainly in Chinese, translate to English
- If the content is mainly in English, translate to Chinese
- If only individual words are in the other language, keep the original and add translation in brackets
- Translate both label and content
- Keep formatting clean and concise
- Return ONLY JSON: {"label":"Translated Label","content":"Translated Content"}
- No explanations, no extra text

Original content:
Label: ${block.label}
Content: ${block.content || 'None'}`
        }],
        max_tokens: 1000
      })
    });

    const data = await response.json();
    const translateResult = JSON.parse(data?.choices?.[0]?.message?.content || '{}');

    if (translateResult.label || translateResult.content) {
      block.label = repairMarkdownFormatting(translateResult.label || block.label).text;
      block.content = repairMarkdownFormatting(translateResult.content || block.content).text;
      relayoutAfterContentChange({ pushHistoryEntry: true, changedBlockIds: [block.id] });
    } else {
      alert('无法翻译，请尝试手动编辑');
    }
  } catch (err) {
    console.error('Translate error:', err);
    alert('翻译失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 5h16M4 12h16M4 19h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>翻译</span>
      `;
    }
  }
}

// 鈹€鈹€ Create new block at position 鈹€鈹€
function handleCreateBlock(x, y) {
  const newBlock = {
    id: crypto.randomUUID(),
    type: 'text',
    label: '新块',
    content: '',
    x,
    y,
  };
  appState.canvas.blocks.push(newBlock);
  appState.selectedBlockId = newBlock.id;
  pushHistory();
  syncCanvasAfterRender([newBlock.id]);
  saveCurrentCanvas();
  checkAutoNaming();
}

// 鈹€鈹€ Init 鈹€鈹€
function init() {
  document.addEventListener('boardChanged', checkAutoNaming);
  // 1. Load saved config
  const saved = loadSavedConfig();
  if (saved) {
    setConfig(saved);
    if (!saved.voiceConfigVersion || Number(saved.voiceConfigVersion) < 2) {
      saveCurrentConfig();
    }
  }
  applyProviderPreset(true);
  applyLocalConfig();
  applyVoiceModePreset();
  updateVoiceStatusBadges();

  // 2. Load canvas - try multi-canvas system first, fallback to single canvas
  const currentId = getCurrentCanvasId();
  if (currentId) {
    const canvas = loadCanvasById(currentId);
    if (canvas) {
      appState.canvas = canvas;
    } else {
      // ID exists but canvas not found, create new
      const newCanvas = createCanvas('未命名白板');
      appState.canvas = newCanvas;
    }
  } else {
    // Try old single canvas system
    if (!loadCanvas()) {
      // Check if there are any canvases in the list
      const list = getCanvasList();
      if (list.length > 0) {
        // Use the first (most recent) canvas
        switchCanvas(list[0].id);
      } else {
        // Default empty canvas
        appState.canvas = {
          title: '未命名白板',
          blocks: [],
          connections: [],
          groups: [],
          memory: '',
          sessions: [],
          activeSessionId: '',
        };
      }
    }
  }
  // 纭繚 groups 瀛楁瀛樺湪
  if (!appState.canvas.groups) {
    appState.canvas.groups = [];
  }
  if (typeof appState.canvas.memory !== 'string') {
    appState.canvas.memory = '';
  }
  dom.boardTitle.textContent = appState.canvas.title;

  // 3. Init modules
  initHistory();
  initCanvas({
    onChange: onCanvasChange,
    onDelete: handleDeleteNode,
    onAddChild: handleAddChild,
    onAddSibling: handleAddSibling,
    onCreateBlock: handleCreateBlock,
  });
  initChat(getConfig);
  initWaveform(async (transcribedText) => {
    try {
      const text = getVoiceSubmitText(transcribedText);
      if (!isMeaningfulTranscript(text)) {
        resumeListening();
        return;
      }

      let voiceBriefPlayed = false;
      const response = await sendText(text, {
        voiceOutputEnabled: isTtsEnabled(getConfig()),
        returnVoicePayload: true,
        onVoiceBrief: (voiceBrief) => {
          if (voiceBriefPlayed || !voiceBrief || !isConversationActive) return;
          voiceBriefPlayed = true;
          void (async () => {
            await resumeListening();
            await playAssistantReply(voiceBrief);
          })();
        },
      });
      const reply = typeof response === 'string' ? response : response?.reply;
      const voiceText = typeof response === 'string' ? response : response?.voiceText;
      if (reply && isConversationActive) {
        await resumeListening();
        if (!voiceBriefPlayed && voiceText) {
          await playAssistantReply(voiceText);
        }
      } else {
        clearEarlyVoiceResumeTimer();
        await resumeListening();
      }
    } catch (err) {
      clearEarlyVoiceResumeTimer();
      console.error('璇煶杞啓鎴栧搷搴斿け璐?', err);
      await resumeListening();
    }
  });

  // 4. Render canvas
  syncCanvasAfterRender();
  if (appState.canvas.blocks.length > 0) fitToView();

  registerLayoutDebugTools();
  applyFixtureFromQuery();

  // 5. Bind events
  bindEvents();
}

// 鈹€鈹€ Helper Functions 鈹€鈹€
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // 灏忎簬 1 鍒嗛挓
  if (diff < 60000) return '刚刚';
  // 灏忎簬 1 灏忔椂
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  // 灏忎簬 24 灏忔椂
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  // 灏忎簬 7 澶?
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;

  // 瓒呰繃 7 澶╂樉绀烘棩鏈?
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric'
  });
}

function bindEvents() {

  // 鈹€鈹€ Canvas List 鈹€鈹€
  let canvasListOpen = false;

  function updateCanvasListUI() {
    const list = getCanvasList();
    const currentId = appState.canvas.id || getCurrentCanvasId();

    if (list.length === 0) {
      dom.canvasListItems.innerHTML = '';
      dom.canvasListEmpty.style.display = 'block';
      return;
    }

    dom.canvasListEmpty.style.display = 'none';
    dom.canvasListItems.innerHTML = list.map(canvas => `
      <div class="canvas-list-item ${canvas.id === currentId ? 'active' : ''}" data-id="${canvas.id}">
        <div class="canvas-list-item-info">
          <span class="canvas-list-item-title">${escapeHtml(canvas.title)}</span>
          <span class="canvas-list-item-meta">${formatDate(canvas.updatedAt)}</span>
        </div>
        <div class="canvas-list-item-actions">
          <button class="btn-icon btn-xs rename-canvas-btn" data-id="${canvas.id}" title="閲嶅懡鍚?>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 10l5-1 5-5-4-4-5 5-1 5z" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
          <button class="btn-icon btn-xs delete-canvas-btn" data-id="${canvas.id}" title="鍒犻櫎">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M3 3v7h6V3M4 1h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  }

  function toggleCanvasList() {
    canvasListOpen = !canvasListOpen;
    dom.canvasListMenu.setAttribute('aria-hidden', !canvasListOpen);
    dom.canvasListMenu.classList.toggle('open', canvasListOpen);
    if (canvasListOpen) {
      updateCanvasListUI();
    }
  }

  function closeCanvasList() {
    canvasListOpen = false;
    dom.canvasListMenu.setAttribute('aria-hidden', 'true');
    dom.canvasListMenu.classList.remove('open');
  }

  function handleCanvasListClick(e) {
    const item = e.target.closest('.canvas-list-item');
    if (!item) return;

    // 蹇界暐鎸夐挳鐐瑰嚮锛堝垹闄?閲嶅懡鍚嶏級
    if (e.target.closest('.rename-canvas-btn') || e.target.closest('.delete-canvas-btn')) return;

    const id = item.dataset.id;
    if (id && id !== appState.canvas.id) {
      if (switchCanvas(id)) {
        dom.boardTitle.textContent = appState.canvas.title;
        syncCanvasMemoryDraft();
        syncChatSessionUI();
        pushHistory();
        syncCanvasAfterRender();
        updateCanvasListUI();
        closeCanvasList();
      }
    }
  }

  function handleDeleteCanvas(e) {
    const btn = e.target.closest('.delete-canvas-btn');
    if (!btn) return;
    const id = btn.dataset.id;

    if (confirm('确定要删除这个画布吗？此操作无法撤销。')) {
      deleteCanvas(id);
      updateCanvasListUI();

      // 濡傛灉鍒犻櫎鐨勬槸褰撳墠鐢诲竷锛屽垱寤烘柊鐨勭┖鐧界敾甯?
      if (appState.canvas.id === id) {
        const newCanvas = createCanvas('未命名白板');
        appState.canvas = newCanvas;
        dom.boardTitle.textContent = newCanvas.title;
        syncCanvasMemoryDraft();
        syncChatSessionUI();
        pushHistory();
        syncCanvasAfterRender();
      }
    }
  }

  function handleRenameCanvas(e) {
    const btn = e.target.closest('.rename-canvas-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const canvas = getCanvasList().find(c => c.id === id);

    if (canvas) {
      const newTitle = prompt('重命名画布', canvas.title);
      if (newTitle !== null && newTitle.trim()) {
        renameCanvas(id, newTitle.trim());
        updateCanvasListUI();

        // 濡傛灉鏄綋鍓嶇敾甯冿紝鍚屾鏇存柊鏍囬鏄剧ず
        if (id === appState.canvas.id) {
          dom.boardTitle.textContent = newTitle.trim();
          appState.canvas.title = newTitle.trim();
        }
      }
    }
  }

  // 鐢诲竷鍒楄〃鎸夐挳
  dom.canvasListBtn.addEventListener('click', toggleCanvasList);

  // 鏂板缓鐢诲竷鎸夐挳锛堥《閮級
  dom.newCanvasBtn.addEventListener('click', () => {
    const newCanvas = createCanvas('未命名白板');
    appState.canvas = newCanvas;
    dom.boardTitle.textContent = newCanvas.title;
    syncCanvasMemoryDraft();
    syncChatSessionUI();
    pushHistory();
    syncCanvasAfterRender();
    closeCanvasList();
  });

  // 鏂板缓鐢诲竷鎸夐挳锛堝垪琛ㄤ腑锛?
  dom.newCanvasFromListBtn.addEventListener('click', () => {
    const newCanvas = createCanvas('未命名白板');
    appState.canvas = newCanvas;
    dom.boardTitle.textContent = newCanvas.title;
    syncCanvasMemoryDraft();
    syncChatSessionUI();
    pushHistory();
    syncCanvasAfterRender();
    updateCanvasListUI();
  });

  // 鐢诲竷鍒楄〃鐐瑰嚮濮旀墭
  dom.canvasListItems.addEventListener('click', handleCanvasListClick);
  dom.canvasListItems.addEventListener('click', handleDeleteCanvas);
  dom.canvasListItems.addEventListener('click', handleRenameCanvas);

  // 鐐瑰嚮澶栭儴鍏抽棴鐢诲竷鍒楄〃
  document.addEventListener('pointerdown', (e) => {
    if (canvasListOpen && !dom.canvasListMenu.contains(e.target) && !dom.canvasListBtn.contains(e.target)) {
      closeCanvasList();
    }
  });

  // 鈹€鈹€ Board title edit 鈹€鈹€
  dom.boardTitle.addEventListener('click', () => {
    const newTitle = prompt('缂栬緫鐧芥澘鏍囬', appState.canvas.title);
    if (newTitle !== null) {
      appState.canvas.title = newTitle;
      dom.boardTitle.textContent = newTitle;
      saveCurrentCanvas();
    }
  });

  // 鈹€鈹€ Undo / Redo 鈹€鈹€
  dom.undoBtn.addEventListener('click', () => {
    if (undo()) { syncCanvasMemoryDraft(); syncChatSessionUI(); syncCanvasAfterRender(); saveCurrentCanvas(); }
  });
  dom.redoBtn.addEventListener('click', () => {
    if (redo()) { syncCanvasMemoryDraft(); syncChatSessionUI(); syncCanvasAfterRender(); saveCurrentCanvas(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undo()) { syncCanvasMemoryDraft(); syncChatSessionUI(); syncCanvasAfterRender(); saveCurrentCanvas(); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      if (redo()) { syncCanvasMemoryDraft(); syncChatSessionUI(); syncCanvasAfterRender(); saveCurrentCanvas(); }
    }
  });

  // 鈹€鈹€ Group Shortcuts 鈹€鈹€
  document.addEventListener('keydown', (e) => {
    // Skip when editing text
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    // Ctrl+G 鈫?鍒涘缓缁?
    if ((e.ctrlKey || e.metaKey) && e.key === 'g' && !e.shiftKey) {
      const selectedIds = appState.selectedBlockIds;
      if (selectedIds.length >= 2) {
        e.preventDefault();
        // 纭繚 groups 鏁扮粍瀛樺湪
        if (!appState.canvas.groups) {
          appState.canvas.groups = [];
        }
        // 閫夋嫨涓€涓鑹诧紙鍩轰簬缁勭殑绱㈠紩锛?
        const GROUP_COLORS_LOCAL = [
          { name: '榛勮壊', value: '#FFD600' },
          { name: '钃濊壊', value: '#2979FF' },
          { name: '缁胯壊', value: '#00E676' },
          { name: '绮夌孩', value: '#FF4081' },
          { name: '绱壊', value: '#D500F9' },
          { name: '姗欒壊', value: '#FF9100' },
        ];
        const colorIndex = appState.canvas.groups.length % GROUP_COLORS_LOCAL.length;
        const color = GROUP_COLORS_LOCAL[colorIndex].value;

        // 鍏堝垱寤虹粍
        const group = createGroup(selectedIds, color);

        // AI 鎺ㄨ崘缁勫悕锛堝紓姝ワ級
        suggestGroupName(selectedIds, getConfig()).then(name => {
          if (name && name.length > 0) {
            group.name = name;
            syncCanvasAfterRender();
            saveCurrentCanvas();
          }
        });

        pushHistory();
        syncCanvasAfterRender();
        saveCurrentCanvas();
      }
    }

    // Ctrl+Shift+G 鈫?瑙ｆ暎缁?
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      const selectedIds = appState.selectedBlockIds;
      if (selectedIds.length > 0) {
        // 妫€鏌ラ€変腑鐨勫潡鎵€灞炵殑缁?
        const allGroupIds = [];
        selectedIds.forEach(id => {
          const block = appState.canvas.blocks.find(b => b.id === id);
          if (block?.groupIds) {
            allGroupIds.push(...block.groupIds);
          }
        });
        const uniqueGroupIds = new Set(allGroupIds);

        // 濡傛灉鎵€鏈夐€変腑鐨勫潡閮藉湪鍚屼竴涓粍鍐?
        if (uniqueGroupIds.size === 1 && allGroupIds.length > 0) {
          e.preventDefault();
          const groupId = uniqueGroupIds.values().next().value;
          deleteGroup(groupId);
          pushHistory();
          syncCanvasAfterRender();
          saveCurrentCanvas();
        }
      }
    }
  });

  // 鈹€鈹€ Canvas controls 鈹€鈹€
  dom.zoomIn.addEventListener('click', zoomIn);
  dom.zoomOut.addEventListener('click', zoomOut);
  dom.fitBtn.addEventListener('click', fitToView);
  if (dom.layoutLockBtn) {
    dom.layoutLockBtn.addEventListener('click', toggleCanvasLayoutLock);
  }
  if (dom.fileUploadBtn) {
    dom.fileUploadBtn.addEventListener('click', showFileUploadMenu);
  }
  dom.autoLayoutBtn.addEventListener('click', () => {
    runManualAutoLayout();
  });
  
  if (dom.aiOrganizeBtn) {
    dom.aiOrganizeBtn.addEventListener('click', async () => {
      if (appState.canvas.blocks.length === 0) {
        alert('鐧芥澘鏄┖鐨勶紝鏃犳硶鏁寸悊');
        return;
      }
      
      const btn = dom.aiOrganizeBtn;
      const originalTitle = btn.title;
      const originalHTML = btn.innerHTML;
      btn.title = '姝ｅ湪鏁寸悊...';
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="spin"><path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5M3.4 3.4l1.8 1.8M10.8 10.8l1.8 1.8M3.4 12.6l1.8-1.8M10.8 5.2l1.8-1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      btn.disabled = true;

      try {
        const config = getConfig();
        const rawText = await callOrganizeLlm(config, appState.canvas);
        const parsed = parseAiResponse(rawText);
        
        if (parsed.operations && parsed.operations.length > 0) {
          const result = executeOperations(appState.canvas, parsed.operations);
          repairCanvasTextFormatting(appState.canvas);
          dedupeConnections(appState.canvas);
          relayoutAfterContentChange({
            pushHistoryEntry: true,
            fitView: true,
            changedBlockIds: [...result.addedIds, ...result.updatedIds],
          });
        } else {
          alert('AI 璁や负鐩墠鏃犻渶鏁寸悊');
        }
      } catch (err) {
        alert('鏁寸悊澶辫触: ' + err.message);
        console.error('Organize error:', err);
      } finally {
        btn.title = originalTitle;
        btn.innerHTML = originalHTML;
        btn.disabled = false;
      }
    });
  }

// 鈹€鈹€ Node actions 鈹€鈹€
  dom.addChild.addEventListener('click', handleAddChild);
  dom.addSibling.addEventListener('click', handleAddSibling);
  if (dom.deleteNode) {
    dom.deleteNode.addEventListener('click', handleDeleteNode);
  }
  if (dom.pinNode) {
    dom.pinNode.addEventListener('click', () => {
      const b = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
      if (b) {
        b.locked = !b.locked;
        pushHistory();
        syncCanvasAfterRender();
        saveCurrentCanvas();
      }
    });
  }
  // 鏂板鍔熻兘鎸夐挳
  if (dom.splitNode) {
    dom.splitNode.addEventListener('click', handleSplitNode);
  } else {
    console.warn('splitNode button not found in DOM');
  }
  if (dom.mergeNode) {
    dom.mergeNode.addEventListener('click', handleMergeNode);
  } else {
    console.warn('mergeNode button not found in DOM');
  }
  if (dom.expandNode) {
    dom.expandNode.addEventListener('click', handleExpandNode);
  } else {
    console.warn('expandNode button not found in DOM');
  }
  if (dom.deriveNode) {
    dom.deriveNode.addEventListener('click', handleDeriveNode);
  } else {
    console.warn('deriveNode button not found in DOM');
  }
  if (dom.translateNode) {
    dom.translateNode.addEventListener('click', handleTranslateNode);
  } else {
    console.warn('translateNode button not found in DOM');
  }

  // 鈹€鈹€ Refine Node Logic 鈹€鈹€
  let tempRefineState = null;
  
  if (dom.refineNode) {
    dom.refineNode.addEventListener('click', async () => {
      const b = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
      if (!b) return;

      const originalLabel = b.label;
      const originalContent = b.content;
      dom.refineNode.disabled = true;
      dom.refineNode.innerHTML = '精炼中...';
      try {
        const config = getConfig();
        const refined = await callRefineLlm(config, b, appState.canvas);
        
        b.label = repairMarkdownFormatting(refined.label || b.label).text;
        b.content = repairMarkdownFormatting(refined.content || b.content).text;
        relayoutAfterContentChange({ changedBlockIds: [b.id] });
        
        tempRefineState = { b, originalLabel, originalContent };
        
        // Show confirm box over the node toolbar
        const toolbarRect = dom.nodeToolbar.getBoundingClientRect();
        dom.refineConfirmBox.style.left = `${toolbarRect.left}px`;
        dom.refineConfirmBox.style.top = `${toolbarRect.bottom + 10}px`;
        dom.refineConfirmBox.setAttribute('aria-hidden', 'false');
      } catch (err) {
        alert('提炼失败: ' + err.message);
      } finally {
        dom.refineNode.disabled = false;
        dom.refineNode.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6-4.8-6 4.8 2.4-7.2-6-4.8h7.6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
          <span>精炼</span>
        `;
      }
    });
  }

  if (dom.refineYes) {
    dom.refineYes.addEventListener('click', () => {
      dom.refineConfirmBox.setAttribute('aria-hidden', 'true');
      tempRefineState = null;
      pushHistory();
      saveCurrentCanvas();
    });
  }
  
  if (dom.refineNo) {
    dom.refineNo.addEventListener('click', () => {
      dom.refineConfirmBox.setAttribute('aria-hidden', 'true');
      if (tempRefineState) {
        tempRefineState.b.label = tempRefineState.originalLabel;
        tempRefineState.b.content = tempRefineState.originalContent;
        relayoutAfterContentChange({ changedBlockIds: [tempRefineState.b.id] });
        tempRefineState = null;
      }
    });
  }

  // 鈹€鈹€ Chat panel toggle 鈹€鈹€
  initChatPanelResize();

  dom.chatToggleBtn.addEventListener('click', () => {
    dom.chatPanel.classList.add('collapsed');
    dom.chatExpandBtn.classList.add('visible');
    dom.chatExpandBtn.setAttribute('aria-hidden', 'false');
  });
  dom.chatExpandBtn.addEventListener('click', () => {
    dom.chatPanel.classList.remove('collapsed');
    dom.chatExpandBtn.classList.remove('visible');
    dom.chatExpandBtn.setAttribute('aria-hidden', 'true');
  });

  // 鈹€鈹€ Settings modal 鈹€鈹€
  dom.settingsBtn.addEventListener('click', () => {
    syncVoiceProviderFieldVisibility();
    dom.settingsOverlay.classList.add('open');
    dom.settingsOverlay.setAttribute('aria-hidden', 'false');
  });
  dom.closeSettings.addEventListener('click', closeSettings);
  dom.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === dom.settingsOverlay) closeSettings();
  });

  function closeSettings() {
    saveCurrentConfig();
    dom.settingsOverlay.classList.remove('open');
    dom.settingsOverlay.setAttribute('aria-hidden', 'true');
  }

  function openGlobalMemoryModal() {
    if (!dom.globalMemoryOverlay || !dom.globalMemoryText) return;
    dom.globalMemoryText.value = loadGlobalMemory();
    dom.globalMemoryOverlay.classList.add('open');
    dom.globalMemoryOverlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => dom.globalMemoryText?.focus(), 0);
  }

  function closeGlobalMemoryModal() {
    dom.globalMemoryOverlay?.classList.remove('open');
    dom.globalMemoryOverlay?.setAttribute('aria-hidden', 'true');
  }

  function closeGlobalMemoryConfirm() {
    dom.globalMemoryConfirmOverlay?.classList.remove('open');
    dom.globalMemoryConfirmOverlay?.setAttribute('aria-hidden', 'true');
  }

  dom.globalMemoryBtn?.addEventListener('click', openGlobalMemoryModal);
  dom.closeGlobalMemory?.addEventListener('click', closeGlobalMemoryModal);
  dom.globalMemoryOverlay?.addEventListener('click', (e) => {
    if (e.target === dom.globalMemoryOverlay) closeGlobalMemoryModal();
  });
  dom.saveGlobalMemory?.addEventListener('click', () => {
    saveGlobalMemory(dom.globalMemoryText?.value || '');
    closeGlobalMemoryModal();
  });
  dom.clearGlobalMemory?.addEventListener('click', () => {
    if (!confirm('确定清空全局记忆吗？')) return;
    saveGlobalMemory('');
    if (dom.globalMemoryText) dom.globalMemoryText.value = '';
  });
  dom.rejectGlobalMemory?.addEventListener('click', closeGlobalMemoryConfirm);
  dom.acceptGlobalMemory?.addEventListener('click', () => {
    saveGlobalMemory(dom.globalMemorySuggestionText?.value || '');
    closeGlobalMemoryConfirm();
  });
  window.addEventListener('global-memory:suggest', (e) => {
    const suggestedMemory = e.detail?.suggestedMemory || '';
    if (!suggestedMemory || !dom.globalMemoryConfirmOverlay || !dom.globalMemorySuggestionText) return;
    dom.globalMemorySuggestionText.value = suggestedMemory;
    dom.globalMemoryConfirmOverlay.classList.add('open');
    dom.globalMemoryConfirmOverlay.setAttribute('aria-hidden', 'false');
  });

  // Provider presets
  dom.llmProvider.addEventListener('change', handleLlmProviderChange);
  dom.openLlmKeyPageBtn?.addEventListener('click', openCurrentLlmKeyPage);
  dom.openSearchKeyPageBtn?.addEventListener('click', openCurrentSearchKeyPage);
  dom.useFreeTrialBtn?.addEventListener('click', useFreeTrialLlm);
  dom.searchMode?.addEventListener('click', toggleSearchMode);
  dom.llmApiKey.addEventListener('input', () => {
    rememberCurrentLlmKey();
    if (dom.llmApiKey.value.trim()) apiKeyMissingPromptShown = false;
    if (dom.llmApiKey.value.trim() && dom.llmKeyNotice) dom.llmKeyNotice.hidden = true;
  });
  dom.sttProvider.addEventListener('change', () => {
    applyProviderPreset(false);
    syncVoiceFallbackNotice();
    syncVoiceProviderFieldVisibility();
  });
  dom.ttsProvider.addEventListener('change', () => {
    applyProviderPreset(false);
    syncVoiceFallbackNotice();
    syncVoiceProviderFieldVisibility();
  });
  dom.sttEnabled?.addEventListener('change', () => {
    syncVoiceModeFallback();
    updateVoiceStatusBadges();
  });
  dom.ttsEnabled?.addEventListener('change', () => {
    syncVoiceFallbackNotice({ force: true });
    updateVoiceControlAvailability();
  });
  dom.voiceMode.addEventListener('change', () => {
    applyVoiceModePreset();
    syncVoiceProviderFieldVisibility();
  });
  dom.doubaoApiKey.addEventListener('change', () => {
    syncVoiceModeFallback();
  });
  dom.testDoubaoAsrBtn.addEventListener('click', async () => {
    const config = getConfig();
    const btn = dom.testDoubaoAsrBtn;
    const originalText = btn.textContent;

    const useProxy = true;

    try {
      btn.textContent = '测试中...';
      btn.disabled = true;

      const result = await testDoubaoAsrConnection(config, { useProxy });
      alert(`测试成功：${result.message}\n\n返回数据：${JSON.stringify(result.data, null, 2).slice(0, 500)}`);
    } catch (err) {
      alert(`测试失败：${err.message}`);
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
  dom.sttEndpoint.addEventListener('change', () => {
    syncVoiceFallbackNotice({ force: true });
  });
  dom.asrEndpoint?.addEventListener('change', () => syncVoiceFallbackNotice({ force: true }));
  dom.asrResourceId?.addEventListener('change', () => syncVoiceFallbackNotice({ force: true }));
  dom.asrModel?.addEventListener('change', () => syncVoiceFallbackNotice({ force: true }));
  dom.ttsEndpoint.addEventListener('change', syncVoiceFallbackNotice);
  bindAudioUpload();

  // Save / Load config
  dom.saveConfig.addEventListener('click', () => {
    saveCurrentConfig();
  });
  dom.loadConfig.addEventListener('click', () => {
    const cfg = loadSavedConfig();
    if (cfg) {
      setConfig(cfg);
      applyProviderPreset();
      loadLlmProviderKey(dom.llmProvider.value);
    }
  });

  // 鈹€鈹€ Fetch Models 鈹€鈹€
  if (dom.fetchModelsBtn) {
    dom.fetchModelsBtn.addEventListener('click', async () => {
      const btn = dom.fetchModelsBtn;
      const originalText = btn.textContent;
      btn.textContent = '鍔犺浇涓?..';
      btn.disabled = true;

      try {
        const config = getConfig();
        if (!config.llmApiKey) throw new Error('璇峰厛濉啓 LLM API Key');
        
        let url = config.llmEndpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        if (url.endsWith('/chat/completions')) url = url.replace('/chat/completions', '');
        if (!url.endsWith('/models')) url = url.replace(/\/$/, '') + '/models';

        const res = await fetch(config.proxyUrl || url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${config.llmApiKey}`
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        
        if (data && Array.isArray(data.data)) {
          updateModelOptions(data.data.map(m => m.id));
          alert(`鎴愬姛鑾峰彇 ${data.data.length} 涓ā鍨嬶紒璇峰湪宸︿晶杈撳叆妗嗕笅鎷夐€夋嫨`);
        } else {
          throw new Error('杩斿洖鏍煎紡涓嶅寘鍚?data 瀛楁');
        }
      } catch (err) {
        alert('鑾峰彇澶辫触: ' + err.message);
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
  }

  // 鈹€鈹€ Import 鈹€鈹€
  if (dom.llmModel) {
    dom.llmModel.addEventListener('focus', openModelDropdown);
    dom.llmModel.addEventListener('click', openModelDropdown);
    dom.llmModel.addEventListener('input', () => {
      const query = dom.llmModel.value.trim().toLowerCase();
      const filtered = query
        ? modelOptions.filter(modelId => modelId.toLowerCase().includes(query))
        : modelOptions;
      renderModelDropdown(filtered);
      if (filtered.length) openModelDropdown();
    });
  }
  document.addEventListener('click', (event) => {
    if (!dom.modelDropdown?.contains(event.target) && event.target !== dom.llmModel && event.target !== dom.fetchModelsBtn) {
      closeModelDropdown();
    }
  });

  dom.importJson.addEventListener('click', () => {
    showImportMenu();
  });

  // 鈹€鈹€ Export 鈹€鈹€
  dom.downloadJson.addEventListener('click', () => {
    showExportMenu();
  });

  // 鈹€鈹€ Demo data 鈹€鈹€
  dom.resetDemo.addEventListener('click', loadDemoData);

  // 鈹€鈹€ OAuth 鈹€鈹€
  if (dom.oauthStart) {
    dom.oauthStart.addEventListener('click', () => {
      try {
        const url = buildOAuthUrl(getConfig());
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (err) {
        console.error('OAuth error:', err);
      }
    });
  }
  if (dom.oauthExchange) {
    dom.oauthExchange.addEventListener('click', async () => {
      try {
        await exchangeOAuthCode(dom.oauthCode.value.trim(), getConfig());
      } catch (err) {
        console.error('OAuth exchange error:', err);
      }
    });
  }

  // 鈹€鈹€ OAuth redirect URI 鈹€鈹€
  if (dom.oauthRedirect) {
    dom.oauthRedirect.value = location.origin + location.pathname;
  }

  // 鈹€鈹€ API Key Missing Alert 鈹€鈹€
  window.addEventListener('api:key-missing', (e) => {
    if (apiKeyMissingPromptShown) return;
    apiKeyMissingPromptShown = true;
    const detail = e.detail || {};
    const rawMessage = String(detail.message || '');
    const isQuota = detail.status === 429 || rawMessage.toLowerCase().includes('quota');
    const noticeText = isQuota
      ? '免费试用额度已用完。你可以填写自己的 LLM API Key 继续使用，或者稍后再试。'
      : '当前没有可用的模型 Key。可以先使用服务器免费试用；如果服务端未配置或你想长期使用，请填写自己的 LLM API Key。';

    // 鎵撳紑璁剧疆闈㈡澘
    dom.settingsOverlay.classList.add('open');
    dom.settingsOverlay.setAttribute('aria-hidden', 'false');
    if (dom.llmKeyNotice) {
      dom.llmKeyNotice.textContent = noticeText;
      dom.llmKeyNotice.hidden = false;
    }

    // 缁欒缃寜閽坊鍔犻棯鍔ㄥ姩鐢?
    dom.settingsBtn.classList.add('api-key-alert');

    // 缁?API key 杈撳叆妗嗘坊鍔犻珮浜孩妗?
    dom.llmApiKey.classList.add('api-key-highlight');

    setTimeout(() => {
      dom.llmApiKey.focus();
      dom.llmApiKey.select();
    }, 300);

    setTimeout(() => {
      dom.settingsBtn.classList.remove('api-key-alert');
      dom.llmApiKey.classList.remove('api-key-highlight');
    }, 3000);
  });

  // 鈹€鈹€ TTS speak 鈹€鈹€
  if (dom.speakBtn) {
    dom.speakBtn.addEventListener('click', async () => {
      if (!appState.lastAssistantReply) return;
      try {
        await replayAssistantReply(appState.lastAssistantReply);
      } catch (err) {
        console.error('TTS error:', err);
      }
    });
  }
}

function applyCanvasFixture(canvas, fitDelay = 500) {
  appState.canvas = {
    ...canvas,
    groups: canvas.groups || [],
    memory: canvas.memory || '',
    sessions: canvas.sessions || [],
    activeSessionId: canvas.activeSessionId || '',
  };
  dom.boardTitle.textContent = appState.canvas.title;
  syncCanvasMemoryDraft();
  syncChatSessionUI();
  initHistory();
  renderBlocks(appState.canvas.blocks.map(b => b.id));
  setTimeout(fitToView, fitDelay);
  saveCurrentCanvas();
}

function createDefaultDemoCanvas() {
  const rootId = crypto.randomUUID();
  const prodId = crypto.randomUUID();
  const mktId = crypto.randomUUID();
  const mvpId = crypto.randomUUID();
  const roadId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const compId = crypto.randomUUID();

  return {
    title: '创业计划',
    blocks: [
      { id: rootId, type: 'text', label: '创业计划', content: '核心主题', x: 400, y: 60 },
      { id: prodId, type: 'text', label: '产品', content: '产品规划方向', x: 180, y: 220 },
      { id: mktId, type: 'text', label: '市场', content: '市场分析策略', x: 580, y: 220 },
      { id: mvpId, type: 'text', label: 'MVP', content: '最小可行产品', x: 60, y: 380 },
      { id: roadId, type: 'text', label: '迭代路线', content: '版本规划', x: 280, y: 380 },
      { id: userId, type: 'text', label: '用户画像', content: '目标用户分析', x: 480, y: 380 },
      { id: compId, type: 'text', label: '竞品分析', content: '竞争对手调研', x: 700, y: 380 },
    ],
    connections: [
      { id: crypto.randomUUID(), fromId: rootId, toId: prodId },
      { id: crypto.randomUUID(), fromId: rootId, toId: mktId },
      { id: crypto.randomUUID(), fromId: prodId, toId: mvpId },
      { id: crypto.randomUUID(), fromId: prodId, toId: roadId },
      { id: crypto.randomUUID(), fromId: mktId, toId: userId },
      { id: crypto.randomUUID(), fromId: mktId, toId: compId },
    ],
    groups: [],
  };
}

function createSyncSizeFixture() {
  const rootId = crypto.randomUUID();
  const longId = crypto.randomUUID();
  const mediumId = crypto.randomUUID();
  const shortId = crypto.randomUUID();
  return {
    title: '测试：尺寸同步',
    blocks: [
      { id: rootId, type: 'text', label: '尺寸同步测试', content: '用于验证缩放和自动布局不会错误缩窄块宽度', x: 420, y: 60, width: 260 },
      { id: longId, type: 'text', label: '长内容块', content: '这是一段很长的内容，用于测试换行和宽度保持。\n\n- 第一条说明\n- 第二条说明\n- 第三条说明', x: 160, y: 220, width: 300 },
      { id: mediumId, type: 'text', label: '中等内容块', content: '中等长度内容。\n第二行说明。\n第三行说明。', x: 520, y: 220, width: 220 },
      { id: shortId, type: 'text', label: '短块', content: '短内容', x: 820, y: 220, width: 180 },
    ],
    connections: [
      { id: crypto.randomUUID(), fromId: rootId, toId: longId },
      { id: crypto.randomUUID(), fromId: rootId, toId: mediumId },
      { id: crypto.randomUUID(), fromId: rootId, toId: shortId },
    ],
    groups: [],
  };
}

function createLayoutDriftFixture() {
  const rootId = crypto.randomUUID();
  const leftId = crypto.randomUUID();
  const centerId = crypto.randomUUID();
  const rightId = crypto.randomUUID();
  const leafA = crypto.randomUUID();
  const leafB = crypto.randomUUID();
  return {
    title: '测试：布局发散',
    blocks: [
      { id: rootId, type: 'text', label: '布局发散测试', content: '重复执行自动布局后不应不断外扩。', x: 520, y: 60, width: 260 },
      { id: leftId, type: 'text', label: '战略层', content: '包含较长内容，用于制造较高节点。\n- 方向一\n- 方向二\n- 方向三', x: 180, y: 220, width: 260 },
      { id: centerId, type: 'text', label: '产品层', content: '连接多个叶子节点，触发布局计算。', x: 520, y: 220, width: 250 },
      { id: rightId, type: 'text', label: '运营层', content: '另一侧主干节点。', x: 860, y: 220, width: 250 },
      { id: leafA, type: 'text', label: '叶子 A', content: '叶子内容 A', x: 420, y: 420, width: 200 },
      { id: leafB, type: 'text', label: '叶子 B', content: '叶子内容 B', x: 700, y: 420, width: 200 },
    ],
    connections: [
      { id: crypto.randomUUID(), fromId: rootId, toId: leftId },
      { id: crypto.randomUUID(), fromId: rootId, toId: centerId },
      { id: crypto.randomUUID(), fromId: rootId, toId: rightId },
      { id: crypto.randomUUID(), fromId: centerId, toId: leafA },
      { id: crypto.randomUUID(), fromId: centerId, toId: leafB },
    ],
    groups: [],
  };
}

function loadTestFixture(name) {
  if (name === 'size-sync') {
    applyCanvasFixture(createSyncSizeFixture());
    return true;
  }
  if (name === 'layout-drift') {
    applyCanvasFixture(createLayoutDriftFixture());
    return true;
  }
  return false;
}

function runAutoLayoutBenchmark(iterations = 5) {
  const rounds = Math.max(1, Number(iterations) || 1);
  const results = [];

  for (let i = 0; i < rounds; i++) {
    renderBlocks();
    syncBlockSizes({ adaptForAutoLayout: true });
    autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
    renderBlocks();
    syncBlockSizes();
    renderBlocks();
    const box = getBoundingBox(appState.canvas.blocks, b => b.width || 200);
    results.push({
      iteration: i + 1,
      minX: Math.round(box.x),
      minY: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }

  console.table(results);
  fitToView();
  saveCurrentCanvas();
  return results;
}

function loadDemoData() {
  applyCanvasFixture(createDefaultDemoCanvas());
}

function applyFixtureFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get('fixture');
  const autorun = Number(params.get('autorun') || 0);

  if (fixture) {
    const loaded = loadTestFixture(fixture);
    if (loaded && autorun > 0) {
      setTimeout(() => runAutoLayoutBenchmark(autorun), 700);
    }
  }
}

function registerLayoutDebugTools() {
  window.loadTestFixture = (name) => {
    const loaded = loadTestFixture(name);
    if (!loaded) {
      console.warn(`Unknown fixture: ${name}`);
    }
    return loaded;
  };
  window.runAutoLayoutBenchmark = runAutoLayoutBenchmark;
}

// 鈹€鈹€ Import Menu 鈹€鈹€
function showImportMenu() {
  // Create dropdown if not exists
  let menu = document.getElementById('importMenu');
  if (menu) { menu.remove(); return; }

  menu = document.createElement('div');
  menu.id = 'importMenu';
  menu.className = 'import-menu';
  menu.innerHTML = `
    <button class="import-item" data-format="json">
      <span class="import-icon">{ }</span>JSON 文件
    </button>
    <button class="import-item" data-format="markdown">
      <span class="import-icon">#</span>Markdown 大纲
    </button>
  `;

  // Position below the import button
  const btn = dom.importJson;
  const rect = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-format]');
    if (!item) return;
    const format = item.dataset.format;
    menu.remove();
    openFilePicker(format);
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('pointerdown', function closer(e) {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('pointerdown', closer);
      }
    });
  }, 10);
}

function openFilePicker(format) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = format === 'json' ? '.json,application/json' : '.md,.markdown,text/markdown';
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target.result;
      if (format === 'json') {
        handleImportJson(content);
      } else {
        handleImportMarkdown(content);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function handleImportJson(content) {
  try {
    const data = JSON.parse(content);
    if (!data.title || !Array.isArray(data.blocks) || !Array.isArray(data.connections)) {
      throw new Error('JSON 格式无效，需要 title/blocks/connections 字段');
    }
    assertCanvasIntegrity(data);

    // 瀵煎叆鏁版嵁
    appState.canvas = {
      title: data.title,
      blocks: data.blocks,
      connections: data.connections,
      groups: data.groups || [],
      memory: data.memory || '',
      sessions: data.sessions || [],
      activeSessionId: data.activeSessionId || '',
    };
    repairCanvasTextFormatting(appState.canvas);

    // 鏇存柊 UI
    dom.boardTitle.textContent = appState.canvas.title;
    syncCanvasMemoryDraft();
    syncChatSessionUI();
    pushHistory();
    syncCanvasAfterRender();
    fitToView();
    saveCurrentCanvas();
  } catch (err) {
    alert('导入失败：' + err.message);
  }
}

function handleImportMarkdown(content) {
  try {
    const canvasData = parseMarkdownToCanvas(content);

    appState.canvas = canvasData;
    appState.canvas.memory = '';
    appState.canvas.sessions = [];
    appState.canvas.activeSessionId = '';
    dom.boardTitle.textContent = canvasData.title;
    syncCanvasMemoryDraft();
    syncChatSessionUI();
    pushHistory();
    syncCanvasAfterRender();
    fitToView();
    saveCurrentCanvas();
  } catch (err) {
    alert('导入失败：' + err.message);
  }
}

function parseMarkdownToCanvas(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  const connections = [];
  const blockStack = []; // 鐢ㄤ簬璺熻釜灞傜骇鍏崇郴
  let blockIndex = 0;

  // 鎻愬彇鏍囬浣滀负鐢诲竷鏍囬
  let title = '导入的画布';
  const titleMatch = markdown.match(/^#\s+(.+)/);
  if (titleMatch) {
    title = titleMatch[1];
  }

  // 瑙ｆ瀽姣忎竴琛?
  for (const line of lines) {
    // 璺宠繃绌鸿鍜屾爣棰樿锛堝凡缁忓鐞嗭級
    if (!line.trim() || line.startsWith('# ')) continue;

    // 璁＄畻缂╄繘绾у埆锛堥€氳繃 - 鍓嶉潰鐨勭┖鏍兼垨 # 鏁伴噺锛?
    const listMatch = line.match(/^(\s*)-\s*\*\*(.+?)\*\*(?:\s*鈥擻s*(.+))?$/);
    const headerMatch = line.match(/^(#{2,})\s*(.+?)(?:\s*鈥擻s*(.+))?$/);

    let depth = 0;
    let label = '';
    let content = '';

    if (listMatch) {
      // 鍒楄〃鏍煎紡锛? **Label** 鈥?Content
      depth = Math.floor(listMatch[1].length / 2);
      label = listMatch[2].trim();
      content = listMatch[3]?.trim() || '';
    } else if (headerMatch) {
      // 鏍囬鏍煎紡锛?# Label 鈥?Content
      depth = headerMatch[1].length - 1;
      label = headerMatch[2].trim();
      content = headerMatch[3]?.trim() || '';
    } else {
      continue; // 璺宠繃鏃犳硶瑙ｆ瀽鐨勮
    }

    // 鍒涘缓鏂板潡
    const blockId = crypto.randomUUID();
    const block = {
      id: blockId,
      type: 'text',
      label,
      content,
      x: 0,
      y: 0,
    };
    blocks.push(block);
    blockStack.push({ id: blockId, depth });

    // 鍒涘缓杩炴帴锛堣繛鎺ュ埌鐖惰妭鐐癸級
    if (blockStack.length > 1) {
      // 鎵惧埌鏈€杩戠殑鐖惰妭鐐癸紙娣卞害灏忎簬褰撳墠娣卞害鐨勬渶鍚庝竴涓級
      for (let i = blockStack.length - 2; i >= 0; i--) {
        if (blockStack[i].depth < depth) {
          connections.push({
            id: crypto.randomUUID(),
            fromId: blockStack[i].id,
            toId: blockId,
          });
          break;
        }
      }
    }

    blockIndex++;
  }

  // 浣跨敤鑷姩甯冨眬璁＄畻浣嶇疆
  // 鍏堢粰涓€涓复鏃剁殑 autoLayout 璋冪敤
  // 鐢变簬 autoLayout 闇€瑕佸鍏ワ紝鎴戜滑鍦ㄨ繖閲岀畝鍗曡绠椾綅缃?
  const startX = 400;
  const startY = 60;
  const levelHeight = 160;
  const siblingGap = 200;

  // 鎸夊眰绾у垎閰嶄綅缃?
  const levelPositions = {};
  const levelCounts = {};

  for (const block of blocks) {
    // 鎵惧埌鍧楃殑娣卞害
    const stackEntry = blockStack.find(s => s.id === block.id);
    const depth = stackEntry ? stackEntry.depth : 0;

    if (!levelCounts[depth]) levelCounts[depth] = 0;
    if (!levelPositions[depth]) levelPositions[depth] = [];

    const x = startX + levelCounts[depth] * siblingGap;
    const y = startY + depth * levelHeight;

    block.x = x;
    block.y = y;

    levelPositions[depth].push(x);
    levelCounts[depth]++;
  }

  return {
    title,
    blocks,
    connections,
    groups: [],
  };
}

// 鈹€鈹€ Export Menu 鈹€鈹€
function showExportMenu() {
  // Create dropdown if not exists
  let menu = document.getElementById('exportMenu');
  if (menu) { menu.remove(); return; }

  menu = document.createElement('div');
  menu.id = 'exportMenu';
  menu.className = 'export-menu';
  menu.innerHTML = `
    <button class="export-item" data-format="json">
      <span class="export-icon">{ }</span>JSON 文件
    </button>
    <button class="export-item" data-format="markdown">
      <span class="export-icon">#</span>Markdown 大纲
    </button>
    <button class="export-item" data-format="pdf">
      <span class="export-icon">PDF</span>PDF 画布
    </button>
  `;

  // Position below the export button
  const btn = dom.downloadJson;
  const rect = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-format]');
    if (!item) return;
    const format = item.dataset.format;
    menu.remove();

    if (format === 'json') {
      downloadFile(
        JSON.stringify(appState.canvas, null, 2),
        `${getSafeExportFilenameBase()}.json`,
        'application/json'
      );
    } else if (format === 'markdown') {
      downloadFile(
        canvasToMarkdown(),
        `${getSafeExportFilenameBase()}.md`,
        'text/markdown'
      );
    } else if (format === 'pdf') {
      exportCanvasToPdf();
    }
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('pointerdown', function closer(e) {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('pointerdown', closer);
      }
    });
  }, 10);
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCanvasToPdf() {
  if (appState.canvas.blocks.length === 0) {
    alert('褰撳墠鐢诲竷涓虹┖锛屾棤娉曞鍑?PDF');
    return;
  }

  syncBlockSizes();
  const bounds = getVisibleCanvasBounds();
  if (!bounds) {
    alert('褰撳墠娌℃湁鍙鍑虹殑鐢诲竷鍐呭');
    return;
  }

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('鏃犳硶鎵撳紑鎵撳嵃绐楀彛锛岃鍏佽娴忚鍣ㄥ脊绐楀悗閲嶈瘯');
    return;
  }

  const filenameBase = getSafeExportFilenameBase();
  const page = bounds.width >= bounds.height
    ? { orientation: 'landscape', width: 1122, height: 794 }
    : { orientation: 'portrait', width: 794, height: 1122 };
  const margin = 32;
  const targetWidth = page.width - margin * 2;
  const targetHeight = page.height - margin * 2;
  const scale = Math.min(targetWidth / bounds.width, targetHeight / bounds.height);
  const scaledWidth = bounds.width * scale;
  const scaledHeight = bounds.height * scale;
  const snapshotHtml = buildPdfSnapshot(bounds);

  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(filenameBase)}</title>
    ${getExportStylesHtml()}
    <style>
      @page { size: A4 ${page.orientation}; margin: 0; }
      html, body {
        margin: 0;
        width: 100%;
        min-height: 100%;
        background: #fff;
        overflow: hidden;
      }
      body {
        display: grid;
        place-items: center;
      }
      .pdf-page {
        width: ${page.width}px;
        height: ${page.height}px;
        display: grid;
        place-items: center;
        background: #fff;
        overflow: hidden;
      }
      .pdf-viewport {
        width: ${targetWidth}px;
        height: ${targetHeight}px;
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .pdf-export-root {
        position: relative;
        width: ${scaledWidth}px;
        height: ${scaledHeight}px;
        overflow: visible;
      }
      .pdf-export-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: ${bounds.width}px;
        height: ${bounds.height}px;
        transform: scale(${scale}) translate(${-bounds.x}px, ${-bounds.y}px);
        transform-origin: 0 0;
      }
      @media print {
        body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        .pdf-page { break-after: avoid; }
      }
    </style>
  </head>
  <body>
    <main class="pdf-page">
      <div class="pdf-viewport">
        ${snapshotHtml}
      </div>
    </main>
  </body>
</html>`);
  printWindow.document.close();
  printWindow.document.title = filenameBase;

  const triggerPrint = async () => {
    try {
      await printWindow.document.fonts?.ready;
    } catch (_) {}
    printWindow.focus();
    printWindow.print();
  };

  if (printWindow.document.readyState === 'complete') {
    setTimeout(triggerPrint, 300);
  } else {
    printWindow.addEventListener('load', () => setTimeout(triggerPrint, 300), { once: true });
  }
}

function getVisibleCanvasBounds() {
  const blocks = Array.from(document.querySelectorAll('#blockCanvas .mm-block'));
  if (blocks.length === 0) return null;

  const padding = 80;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const block of blocks) {
    const x = parseFloat(block.style.left) || 0;
    const y = parseFloat(block.style.top) || 0;
    const width = block.offsetWidth || parseFloat(block.style.width) || 200;
    const height = block.offsetHeight || parseFloat(block.style.height) || 80;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function buildPdfSnapshot(bounds) {
  const linkLayer = document.getElementById('linkLayer')?.cloneNode(true);
  const blockCanvas = document.getElementById('blockCanvas')?.cloneNode(true);
  const root = document.createElement('div');
  const canvas = document.createElement('div');

  root.className = 'pdf-export-root';
  root.style.width = `${bounds.width}px`;
  root.style.height = `${bounds.height}px`;
  canvas.className = 'pdf-export-canvas';

  if (linkLayer) canvas.appendChild(linkLayer);
  if (blockCanvas) canvas.appendChild(blockCanvas);
  root.appendChild(canvas);
  sanitizePdfClone(root);

  return root.outerHTML;
}

function sanitizePdfClone(root) {
  root.querySelectorAll('.selected, .selected-multi, .dragging, .resizing, .entering').forEach(el => {
    el.classList.remove('selected', 'selected-multi', 'dragging', 'resizing', 'entering');
  });
  root.querySelectorAll('.mm-resize-handle, .mm-link-handle, .link-scissors-btn').forEach(el => el.remove());
  root.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  root.querySelectorAll('[tabindex]').forEach(el => el.removeAttribute('tabindex'));
}

function getExportStylesHtml() {
  return Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map(node => {
      if (node.tagName === 'LINK') {
        const href = new URL(node.getAttribute('href'), document.baseURI).href;
        return `<link rel="stylesheet" href="${escapeHtml(href)}">`;
      }
      return `<style>${node.textContent}</style>`;
    })
    .join('\n');
}

function getSafeExportFilenameBase() {
  const title = (appState.canvas.title || 'canvas').trim() || 'canvas';
  return `${title.replace(/[\\/:*?"<>|]+/g, '-')}-${Date.now()}`;
}

function canvasToMarkdown() {
  const { blocks, connections, title } = appState.canvas;
  let md = `# ${title}\n\n`;

  // 鏋勫缓鏍?
  const childMap = {};
  const hasParent = new Set();
  for (const c of connections) {
    if (!childMap[c.fromId]) childMap[c.fromId] = [];
    childMap[c.fromId].push(c.toId);
    hasParent.add(c.toId);
  }
  const roots = blocks.filter(b => !hasParent.has(b.id));
  const blockMap = {};
  for (const b of blocks) blockMap[b.id] = b;

  function walk(id, depth) {
    const b = blockMap[id];
    if (!b) return '';
    const indent = '  '.repeat(depth);
    let line = `${indent}- **${b.label}**`;
    if (b.content) line += ` 鈥?${b.content}`;
    line += '\n';
    for (const cid of (childMap[id] || [])) {
      line += walk(cid, depth + 1);
    }
    return line;
  }

  for (const root of roots) {
    md += walk(root.id, 0);
  }

  // 瀛ょ珛鑺傜偣
  const visited = new Set();
  function markVisited(id) { visited.add(id); (childMap[id] || []).forEach(markVisited); }
  roots.forEach(r => markVisited(r.id));
  const orphans = blocks.filter(b => !visited.has(b.id));
  if (orphans.length) {
    md += '\n## 鍏朵粬\n\n';
    for (const b of orphans) {
      md += `- **${b.label}**`;
      if (b.content) md += ` 鈥?${b.content}`;
      md += '\n';
    }
  }

  return md;
}

// 鈹€鈹€ Start 鈹€鈹€
init();
