/**
 * main.js — 应用入口，初始化 + 全局事件绑定
 */

import './style.css';

import {
  appState, pushHistory, undo, redo, initHistory,
  saveConfig, loadConfig as loadSavedConfig, saveCanvas, loadCanvas,
  getCanvasList, saveCanvasList, createCanvas, deleteCanvas, loadCanvasById,
  saveCurrentCanvas, switchCanvas, getCurrentCanvasId, renameCanvas,
  ENDPOINT_PRESETS,
  createGroup, deleteGroup, getGroupBlocks, isBlockInGroup, getBlockGroup, getBlockGroups, renameGroup, suggestGroupName,
} from './state.js';
import { initCanvas, renderBlocks, zoomIn, zoomOut, fitToView, hideNodeToolbar, syncBlockSizes } from './canvas.js';
import { initChat, sendText } from './chat.js';
import { initWaveform, resumeListening, isConversationActive, isListeningActive } from './waveform.js';
import { autoLayout, findFreePosition, getBoundingBox } from './utils/layout.js';
import { transcribe } from './services/stt.js';
import { speak, canUseDoubaoTts, getDoubaoTtsFallbackReason } from './services/tts.js';
import { testDoubaoAsrConnection } from './services/doubao-asr.js';
import { buildOAuthUrl, exchangeOAuthCode } from './services/oauth.js';
import { callOrganizeLlm, callRefineLlm, callNamingLlm } from './services/llm.js';
import { parseAiResponse, executeOperations, dedupeConnections } from './utils/parser.js';

// ── DOM References ──
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
  chatToggleBtn: $('chatToggleBtn'),
  chatExpandBtn: $('chatExpandBtn'),

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
  testDoubaoAsrBtn: $('testDoubaoAsrBtn'),
  appId: $('appId'),
  accessToken: $('accessToken'),
  secretKey: $('secretKey'),
  proxyUrl: $('proxyUrl'),
  saveConfig: $('saveConfig'),
  loadConfig: $('loadConfig'),
  llmModel: $('llmModel'),
  fetchModelsBtn: $('fetchModelsBtn'),

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
  speakBtn: $('speakBtn'),
  voiceMode: $('voiceMode'),
  voiceLanguage: $('voiceLanguage'),
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

// ── Config Helper ──
function getConfig() {
  return {
    llmProvider: dom.llmProvider.value,
    sttProvider: dom.sttProvider.value,
    ttsProvider: dom.ttsProvider.value,
    voiceMode: dom.voiceMode.value,
    voiceLanguage: dom.voiceLanguage.value,
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
    doubaoApiKey: dom.doubaoApiKey.value,
    appId: dom.appId.value,
    accessToken: dom.accessToken.value,
    secretKey: dom.secretKey.value,
    proxyUrl: dom.proxyUrl?.value || '',
    oauthProvider: dom.oauthProvider.value,
    oauthClientId: dom.oauthClientId.value,
    oauthAuthUrl: dom.oauthAuthUrl.value,
    oauthTokenUrl: dom.oauthTokenUrl.value,
    oauthScope: dom.oauthScope.value,
    oauthRedirect: dom.oauthRedirect.value,
  };
}

function applyConfigDefaults(config = {}) {
  return {
    voiceMode: 'doubao-pipeline',
    voiceLanguage: 'zh-CN',
    sttModel: ENDPOINT_PRESETS.doubao?.sttModel || '',
    fileSttModel: ENDPOINT_PRESETS.doubao?.fileSttModel || '',
    doubaoResourceId: 'volc.seedasr.sauc.duration',
    ttsModel: ENDPOINT_PRESETS.doubao?.ttsModel || '',
    realtimeVoiceModel: ENDPOINT_PRESETS.doubao?.realtimeVoiceModel || '',
    ...config,
  };
}

function hasDoubaoAsrCredentials(config = getConfig()) {
  return !!(
    config.doubaoApiKey ||
    (config.appId && config.accessToken) ||
    (config.appId && config.secretKey)
  );
}

function hasDoubaoTtsCredentials(config = getConfig()) {
  return canUseDoubaoTts(config);
}

function isDoubaoVoiceMode(config = getConfig()) {
  return config.voiceMode === 'doubao-pipeline' || config.voiceMode === 'doubao-realtime';
}

function getVoiceRouting(config = getConfig()) {
  if (config.voiceMode === 'browser') {
    return {
      inputMode: 'browser',
      outputMode: 'browser',
      fallbackReason: '',
    };
  }

  if (!isDoubaoVoiceMode(config)) {
    return {
      inputMode: 'browser',
      outputMode: config.ttsProvider || 'browser',
      fallbackReason: '',
    };
  }

  const hasAsr = hasDoubaoAsrCredentials(config) && !!config.sttEndpoint;
  const hasTts = hasDoubaoTtsCredentials(config);

  return {
    inputMode: hasAsr ? 'doubao' : 'browser',
    outputMode: hasTts ? 'doubao' : 'browser',
    fallbackReason: !hasTts && hasAsr
      ? getDoubaoTtsFallbackReason(config)
      : '',
  };
}

function syncVoiceModeFallback() {
  const config = getConfig();
  if (!isDoubaoVoiceMode(config)) return;
  if (!hasDoubaoAsrCredentials(config) || !config.sttEndpoint) {
    dom.voiceMode.value = 'browser';
    dom.ttsProvider.value = 'browser';
  }
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
  showVoiceToast('正在听你说话…', 'default', 1800);
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
  showVoiceToast(message || '语音启动失败', 'browser', 2800);
}

function shouldShowRouteToast(config = getConfig()) {
  const { routeKey } = getVoiceRouteSummary(config);
  return routeKey !== lastVoiceRouteKey;
}

function commitVoiceRouteToast(config = getConfig(), force = false) {
  syncVoiceFallbackNotice({ force: force || shouldShowRouteToast(config) });
}

function updateVoiceStatusBadges(config = getConfig()) {
  commitVoiceRouteToast(config, true);
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
  const envAppId = import.meta.env?.VITE_DOUBAO_APP_ID;
  const envAccessToken = import.meta.env?.VITE_DOUBAO_ACCESS_TOKEN;
  const envSecretKey = import.meta.env?.VITE_DOUBAO_SECRET_KEY;
  const finalLlmApiKey = envLlmApiKey || cfg.LLM_API_KEY || cfg.DASHSCOPE_KEY;
  const finalDoubaoApiKey = envDoubaoApiKey || cfg.DOUBAO_API_KEY;
  const finalAppId = envAppId || cfg.DOUBAO_APP_ID;
  const finalAccessToken = envAccessToken || cfg.DOUBAO_ACCESS_TOKEN;
  const finalSecretKey = envSecretKey || cfg.DOUBAO_SECRET_KEY;

  if (finalLlmApiKey) {
    dom.llmApiKey.value = finalLlmApiKey;
  } else if (!dom.llmApiKey.value && typeof finalLlmApiKey === 'string') {
    dom.llmApiKey.value = finalLlmApiKey;
  }

  if (finalDoubaoApiKey) {
    // 清空旧的 API Key，强制使用 AppID + AccessToken 认证
    dom.doubaoApiKey.value = '';
  } else if (!dom.doubaoApiKey.value && typeof finalDoubaoApiKey === 'string') {
    dom.doubaoApiKey.value = '';
  }


  if (finalAppId) {
    dom.appId.value = finalAppId;
  } else {
    dom.appId.value = '6166922297';
  }
  if (finalAccessToken) {
    dom.accessToken.value = finalAccessToken;
  } else {
    dom.accessToken.value = 'VbF4CWyH164u21wcN-ulOf-4M9A3Y0VC';
  }
  if (finalSecretKey) {
    dom.secretKey.value = finalSecretKey;
  } else {
    dom.secretKey.value = 'YCF0iqRAetOeiEmYKUBsyxxlD-XGCctF';
  }

  if (!dom.llmEndpoint.value && cfg.DEFAULT_LLM_ENDPOINT) dom.llmEndpoint.value = cfg.DEFAULT_LLM_ENDPOINT;
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

// ── Canvas change handler ──
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

function relayoutAfterContentChange({ pushHistoryEntry = false, fitView = false, changedBlockIds = [] } = {}) {
  const changedIds = new Set(changedBlockIds || []);
  if (changedIds.size > 0) {
    for (const block of appState.canvas.blocks) {
      if (!changedIds.has(block.id)) continue;
      delete block.height;
    }
  }

  renderBlocks();
  syncBlockSizes({ adaptForAutoLayout: true });
  autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
  renderBlocks();
  syncBlockSizes();
  if (pushHistoryEntry) pushHistory();
  renderBlocks();
  if (fitView) fitToView();
  saveCurrentCanvas();
}

// ── Reusable node actions ──
function handleAddChild() {
  if (!appState.selectedBlockId) return;
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
  renderBlocks([newBlock.id]);
  saveCurrentCanvas();
  checkAutoNaming();
}

function handleAddSibling() {
  if (!appState.selectedBlockId) return;
  const parentConn = appState.canvas.connections.find(c => c.toId === appState.selectedBlockId);
  const parentId = parentConn?.fromId || null;
  const selected = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!selected) return;

  const newBlock = {
    id: crypto.randomUUID(),
    type: 'text',
    label: '新同级块',
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

function handleDeleteNode() {
  // 支持多选删除
  const selectedIds = appState.selectedBlockIds.length > 0
    ? [...appState.selectedBlockIds]
    : appState.selectedBlockId
      ? [appState.selectedBlockId]
      : [];

  if (selectedIds.length === 0) return;

  // 递归收集要删除的块（包括子节点）
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

  // 删除块
  appState.canvas.blocks = appState.canvas.blocks.filter(b => !toRemove.has(b.id));

  // 删除相关连接
  appState.canvas.connections = appState.canvas.connections.filter(
    c => !toRemove.has(c.fromId) && !toRemove.has(c.toId)
  );

  // 删除组内的块引用，如果组为空则删除组
  if (appState.canvas.groups) {
    for (let i = appState.canvas.groups.length - 1; i >= 0; i--) {
      const group = appState.canvas.groups[i];
      group.blockIds = group.blockIds.filter(id => !toRemove.has(id));
      if (group.blockIds.length === 0) {
        appState.canvas.groups.splice(i, 1);
      }
    }
  }

  // 清除选中状态
  appState.selectedBlockId = null;
  appState.selectedBlockIds = [];
  pushHistory();
  renderBlocks();
  saveCurrentCanvas();
}

/** 拆分块 - 将一个块拆成几个语义上区分的块 */
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
    // 调用 LLM 进行拆分
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
      // 删除原始块
      const blockIndex = appState.canvas.blocks.findIndex(b => b.id === block.id);
      appState.canvas.blocks.splice(blockIndex, 1);

      // 创建拆分后的新块，排列在原始块附近
      const baseX = block.x;
      const baseY = block.y;
      const verticalGap = 100;

      splitResult.forEach((item, index) => {
        const newBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          label: item.label || `拆分块${index + 1}`,
          content: item.content || '',
          x: baseX,
          y: baseY + index * verticalGap,
        };
        appState.canvas.blocks.push(newBlock);

        // 如果是第一个块，继承原始块的连接
        if (index === 0) {
          // 继承所有传入连接（fromId 指向原始块的）
          appState.canvas.connections.forEach(conn => {
            if (conn.toId === block.id) {
              conn.toId = newBlock.id;
            }
          });
          // 继承所有传出连接（toId 指向原始块的）
          appState.canvas.connections.forEach(conn => {
            if (conn.fromId === block.id) {
              conn.fromId = newBlock.id;
            }
          });
        }
      });

      // 清理组引用
      if (appState.canvas.groups) {
        appState.canvas.groups.forEach(group => {
          const idx = group.blockIds.indexOf(block.id);
          if (idx !== -1) {
            group.blockIds.splice(idx, 1);
          }
        });
      }

      pushHistory();
      renderBlocks();
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

/** 合并块 - 将选中的多个块合并成一个 */
async function handleMergeNode() {
  const selectedIds = appState.selectedBlockIds;
  if (selectedIds.length < 2) {
    alert('请选中至少 2 个块才能合并');
    return;
  }

  const btn = $('mergeNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '合并中...';
  }

  try {
    const selectedBlocks = appState.canvas.blocks.filter(b => selectedIds.includes(b.id));
    const config = getConfig();

    // 调用 LLM 进行合并
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
      // 计算边界框，确定合并后块的位置
      const minX = Math.min(...selectedBlocks.map(b => b.x));
      const minY = Math.min(...selectedBlocks.map(b => b.y));

      // 创建合并后的新块
      const mergedBlock = {
        id: crypto.randomUUID(),
        type: 'text',
        label: mergeResult.label,
        content: mergeResult.content || '',
        x: minX,
        y: minY,
        width: 240, // 合并后的块稍大一些
      };
      appState.canvas.blocks.push(mergedBlock);

      // 继承所有连接的源和目标
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

      // 创建新连接
      connFromIds.forEach(toId => {
        if (!selectedIds.includes(toId)) { // 不连接到已删除的块
          appState.canvas.connections.push({
            id: crypto.randomUUID(),
            fromId: mergedBlock.id,
            toId,
          });
        }
      });
      connToIds.forEach(fromId => {
        if (!selectedIds.includes(fromId)) { // 不从已删除的块连接
          appState.canvas.connections.push({
            id: crypto.randomUUID(),
            fromId,
            toId: mergedBlock.id,
          });
        }
      });

      // 删除原始块和连接
      appState.canvas.blocks = appState.canvas.blocks.filter(b => !selectedIds.includes(b.id));
      appState.canvas.connections = appState.canvas.connections.filter(
        c => !selectedIds.includes(c.fromId) && !selectedIds.includes(c.toId)
      );

      // 清理组引用
      if (appState.canvas.groups) {
        appState.canvas.groups.forEach(group => {
          group.blockIds = group.blockIds.filter(id => !selectedIds.includes(id));
        });
      }

      // 选中新块
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
  const resolvedConfig = resolveSpeechPlaybackConfig(config);
  const routing = getVoiceRouting(config);

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
    console.error('豆包语音合成失败，回退浏览器朗读:', error);
    showVoiceToast('豆包播报失败，已回退浏览器朗读', 'browser', 2600);
    await playBrowserSpeech(reply, {
      onStart: () => announceAssistantSpeechStart('browser'),
      onDone: () => announceAssistantSpeechDone('browser'),
    });
  }
}

function isAssistantPlaybackPending() {
  return isConversationActive && !isListeningActive();
}

async function safeResumeListening() {
  if (!isConversationActive || !isAssistantPlaybackPending()) return;
  await resumeListening();
}

async function playAssistantReply(reply) {
  if (!reply) {
    await safeResumeListening();
    return;
  }

  await playReplyWithResolvedConfig(reply, getConfig());
  await safeResumeListening();
}

async function replayAssistantReply(reply) {
  if (!reply) return;
  await playReplyWithResolvedConfig(reply, getConfig());
}

window.__VOICE_MODE_HELPERS__ = {
  shouldUseBrowserRecognition: () => shouldUseBrowserVoiceMode(getConfig()),
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

function setSttProviderModels(provider, preserveExisting = false) {
  const preset = ENDPOINT_PRESETS[provider] || {};
  setPresetInputValue(dom.sttModel, preset.sttModel, preserveExisting);
  setPresetInputValue(dom.fileSttModel, preset.fileSttModel, preserveExisting);
}

function setTtsProviderModels(provider, preserveExisting = false) {
  const preset = ENDPOINT_PRESETS[provider] || {};
  setPresetInputValue(dom.ttsModel, preset.ttsModel, preserveExisting);
  setPresetInputValue(dom.realtimeVoiceModel, preset.realtimeVoiceModel, preserveExisting);
}

function setConfig(config) {
  const finalConfig = applyConfigDefaults(config);
  for (const [key, value] of Object.entries(finalConfig)) {
    if (dom[key] && typeof value === 'string') dom[key].value = value;
  }
  syncVoiceModeFallback();
}

function setAudioUploadBusy(isBusy, label = '上传音频转写') {
  if (!dom.audioUploadBtn) return;
  dom.audioUploadBtn.disabled = isBusy;
  dom.audioUploadBtn.title = label;
  dom.audioUploadBtn.setAttribute('aria-label', label);
}

async function handleAudioFileSelected(file) {
  if (!file) return;
  setAudioUploadBusy(true, '正在转写音频...');
  try {
    const text = await transcribe(file, getConfig());
    const cleaned = (text || '').trim();
    if (!cleaned) throw new Error('未识别到有效文本');

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
    console.error('音频文件转写失败:', error);
    alert(`音频转写失败：${error.message}`);
  } finally {
    if (dom.audioFileInput) dom.audioFileInput.value = '';
    setAudioUploadBusy(false, '上传音频转写');
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

  setSttProviderModels(dom.sttProvider.value, preserveExistingModels);
  setTtsProviderModels(dom.ttsProvider.value, preserveExistingModels);
  syncVoiceModeFallback();
}

function applyVoiceModePreset() {
  if (dom.voiceMode.value === 'browser') {
    dom.sttProvider.value = 'browser';
    dom.ttsProvider.value = 'browser';
    applyProviderPreset(false);
    syncVoiceFallbackNotice();
    return;
  }

  dom.sttProvider.value = 'doubao';
  dom.ttsProvider.value = hasDoubaoTtsCredentials() ? 'doubao' : 'browser';
  applyProviderPreset(false);
  syncVoiceFallbackNotice();
}

function applyVoiceLocalDefaults() {
  if (!dom.voiceMode.value) dom.voiceMode.value = 'doubao-pipeline';
  if (!dom.voiceLanguage.value) dom.voiceLanguage.value = 'zh-CN';
}

function bindAudioUpload() {
  if (!dom.audioUploadBtn || !dom.audioFileInput) return;
  dom.audioUploadBtn.addEventListener('click', () => dom.audioFileInput.click());
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

/** 扩张块 - 在当前块内增加更多内容 */
async function handleExpandNode() {
  if (!appState.selectedBlockId) return;
  const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!block) return;

  const btn = $('expandNode');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '扩张中...';
  }

  try {
    const config = getConfig();
    // 调用 LLM 进行扩张
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
- Stay on topic, don't偏离 the core theme
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
      block.label = expandResult.label || block.label;
      block.content = expandResult.content;
      relayoutAfterContentChange({ pushHistoryEntry: true, changedBlockIds: [block.id] });
    } else {
      alert('无法扩张，请尝试手动编辑');
    }
  } catch (err) {
    console.error('Expand error:', err);
    alert('扩张失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2v20M2 12h20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="5" y="5" width="14" height="14" stroke="currentColor" stroke-width="2" rx="2"/></svg>
        <span>扩张</span>
      `;
    }
  }
}

/** 派生块 - 创建更深层次的子层级块 */
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
    // 调用 LLM 生成派生子层级
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
      const startX = block.x + 260; // 在右侧生成
      const startY = block.y;
      const verticalGap = 80;

      deriveResult.forEach((item, index) => {
        const newBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          label: item.label || `派生${index + 1}`,
          content: item.content || '',
          x: startX,
          y: startY + index * verticalGap,
        };
        appState.canvas.blocks.push(newBlock);

        // 创建从父块到新块的连接
        appState.canvas.connections.push({
          id: crypto.randomUUID(),
          fromId: block.id,
          toId: newBlock.id,
        });
      });

      pushHistory();
      renderBlocks();
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

/** 翻译块 - 中英互译 */
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
    // 调用 LLM 进行翻译
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
      block.label = translateResult.label || block.label;
      block.content = translateResult.content || block.content;
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

// ── Create new block at position ──
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
  renderBlocks([newBlock.id]);
  saveCurrentCanvas();
  checkAutoNaming();
}

// ── Init ──
function init() {
  document.addEventListener('boardChanged', checkAutoNaming);
  // 1. Load saved config
  const saved = loadSavedConfig();
  if (saved) setConfig(saved);
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
        };
      }
    }
  }
  // 确保 groups 字段存在
  if (!appState.canvas.groups) {
    appState.canvas.groups = [];
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

      const reply = await sendText(text);
      if (reply && isConversationActive) {
        await playAssistantReply(reply);
      } else {
        await resumeListening();
      }
    } catch (err) {
      console.error('语音转写或响应失败:', err);
      await resumeListening();
    }
  });

  // 4. Render canvas
  renderBlocks();
  if (appState.canvas.blocks.length > 0) fitToView();

  registerLayoutDebugTools();
  applyFixtureFromQuery();

  // 5. Bind events
  bindEvents();
}

// ── Helper Functions ──
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // 小于 1 分钟
  if (diff < 60000) return '刚刚';
  // 小于 1 小时
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  // 小于 24 小时
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  // 小于 7 天
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;

  // 超过 7 天显示日期
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric'
  });
}

function bindEvents() {

  // ── Canvas List ──
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
          <button class="btn-icon btn-xs rename-canvas-btn" data-id="${canvas.id}" title="重命名">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 10l5-1 5-5-4-4-5 5-1 5z" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
          <button class="btn-icon btn-xs delete-canvas-btn" data-id="${canvas.id}" title="删除">
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

    // 忽略按钮点击（删除/重命名）
    if (e.target.closest('.rename-canvas-btn') || e.target.closest('.delete-canvas-btn')) return;

    const id = item.dataset.id;
    if (id && id !== appState.canvas.id) {
      if (switchCanvas(id)) {
        dom.boardTitle.textContent = appState.canvas.title;
        pushHistory();
        renderBlocks();
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

      // 如果删除的是当前画布，创建新的空白画布
      if (appState.canvas.id === id) {
        const newCanvas = createCanvas('未命名白板');
        appState.canvas = newCanvas;
        dom.boardTitle.textContent = newCanvas.title;
        pushHistory();
        renderBlocks();
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

        // 如果是当前画布，同步更新标题显示
        if (id === appState.canvas.id) {
          dom.boardTitle.textContent = newTitle.trim();
          appState.canvas.title = newTitle.trim();
        }
      }
    }
  }

  // 画布列表按钮
  dom.canvasListBtn.addEventListener('click', toggleCanvasList);

  // 新建画布按钮（顶部）
  dom.newCanvasBtn.addEventListener('click', () => {
    const newCanvas = createCanvas('未命名白板');
    appState.canvas = newCanvas;
    dom.boardTitle.textContent = newCanvas.title;
    pushHistory();
    renderBlocks();
    closeCanvasList();
  });

  // 新建画布按钮（列表中）
  dom.newCanvasFromListBtn.addEventListener('click', () => {
    const newCanvas = createCanvas('未命名白板');
    appState.canvas = newCanvas;
    dom.boardTitle.textContent = newCanvas.title;
    pushHistory();
    renderBlocks();
    updateCanvasListUI();
  });

  // 画布列表点击委托
  dom.canvasListItems.addEventListener('click', handleCanvasListClick);
  dom.canvasListItems.addEventListener('click', handleDeleteCanvas);
  dom.canvasListItems.addEventListener('click', handleRenameCanvas);

  // 点击外部关闭画布列表
  document.addEventListener('pointerdown', (e) => {
    if (canvasListOpen && !dom.canvasListMenu.contains(e.target) && !dom.canvasListBtn.contains(e.target)) {
      closeCanvasList();
    }
  });

  // ── Board title edit ──
  dom.boardTitle.addEventListener('click', () => {
    const newTitle = prompt('编辑白板标题', appState.canvas.title);
    if (newTitle !== null) {
      appState.canvas.title = newTitle;
      dom.boardTitle.textContent = newTitle;
      saveCurrentCanvas();
    }
  });

  // ── Undo / Redo ──
  dom.undoBtn.addEventListener('click', () => {
    if (undo()) { renderBlocks(); saveCurrentCanvas(); }
  });
  dom.redoBtn.addEventListener('click', () => {
    if (redo()) { renderBlocks(); saveCurrentCanvas(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undo()) { renderBlocks(); saveCurrentCanvas(); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      if (redo()) { renderBlocks(); saveCurrentCanvas(); }
    }
  });

  // ── Group Shortcuts ──
  document.addEventListener('keydown', (e) => {
    // Skip when editing text
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    // Ctrl+G → 创建组
    if ((e.ctrlKey || e.metaKey) && e.key === 'g' && !e.shiftKey) {
      const selectedIds = appState.selectedBlockIds;
      if (selectedIds.length >= 2) {
        e.preventDefault();
        // 确保 groups 数组存在
        if (!appState.canvas.groups) {
          appState.canvas.groups = [];
        }
        // 选择一个颜色（基于组的索引）
        const GROUP_COLORS_LOCAL = [
          { name: '黄色', value: '#FFD600' },
          { name: '蓝色', value: '#2979FF' },
          { name: '绿色', value: '#00E676' },
          { name: '粉红', value: '#FF4081' },
          { name: '紫色', value: '#D500F9' },
          { name: '橙色', value: '#FF9100' },
        ];
        const colorIndex = appState.canvas.groups.length % GROUP_COLORS_LOCAL.length;
        const color = GROUP_COLORS_LOCAL[colorIndex].value;

        // 先创建组
        const group = createGroup(selectedIds, color);

        // AI 推荐组名（异步）
        suggestGroupName(selectedIds, getConfig()).then(name => {
          if (name && name.length > 0) {
            group.name = name;
            renderBlocks();
            saveCurrentCanvas();
          }
        });

        pushHistory();
        renderBlocks();
        saveCurrentCanvas();
      }
    }

    // Ctrl+Shift+G → 解散组
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      const selectedIds = appState.selectedBlockIds;
      if (selectedIds.length > 0) {
        // 检查选中的块所属的组
        const allGroupIds = [];
        selectedIds.forEach(id => {
          const block = appState.canvas.blocks.find(b => b.id === id);
          if (block?.groupIds) {
            allGroupIds.push(...block.groupIds);
          }
        });
        const uniqueGroupIds = new Set(allGroupIds);

        // 如果所有选中的块都在同一个组内
        if (uniqueGroupIds.size === 1 && allGroupIds.length > 0) {
          e.preventDefault();
          const groupId = uniqueGroupIds.values().next().value;
          deleteGroup(groupId);
          pushHistory();
          renderBlocks();
          saveCurrentCanvas();
        }
      }
    }
  });

  // ── Canvas controls ──
  dom.zoomIn.addEventListener('click', zoomIn);
  dom.zoomOut.addEventListener('click', zoomOut);
  dom.fitBtn.addEventListener('click', fitToView);
  dom.autoLayoutBtn.addEventListener('click', () => {
    renderBlocks();
    syncBlockSizes({ adaptForAutoLayout: true });
    autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
    pushHistory();
    renderBlocks();
    syncBlockSizes();
    renderBlocks();
    fitToView();
    saveCurrentCanvas();
  });
  
  if (dom.aiOrganizeBtn) {
    dom.aiOrganizeBtn.addEventListener('click', async () => {
      if (appState.canvas.blocks.length === 0) {
        alert('白板是空的，无法整理');
        return;
      }
      
      const btn = dom.aiOrganizeBtn;
      const originalTitle = btn.title;
      const originalHTML = btn.innerHTML;
      btn.title = '正在整理...';
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="spin"><path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5M3.4 3.4l1.8 1.8M10.8 10.8l1.8 1.8M3.4 12.6l1.8-1.8M10.8 5.2l1.8-1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      btn.disabled = true;

      try {
        const config = getConfig();
        const rawText = await callOrganizeLlm(config, appState.canvas);
        const parsed = parseAiResponse(rawText);
        
        if (parsed.operations && parsed.operations.length > 0) {
          const result = executeOperations(appState.canvas, parsed.operations);
          dedupeConnections(appState.canvas);
          relayoutAfterContentChange({
            pushHistoryEntry: true,
            fitView: true,
            changedBlockIds: [...result.addedIds, ...result.updatedIds],
          });
        } else {
          alert('AI 认为目前无需整理');
        }
      } catch (err) {
        alert('整理失败: ' + err.message);
        console.error('Organize error:', err);
      } finally {
        btn.title = originalTitle;
        btn.innerHTML = originalHTML;
        btn.disabled = false;
      }
    });
  }

// ── Node actions ──
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
        renderBlocks();
        saveCurrentCanvas();
      }
    });
  }
  // 新增功能按钮
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

  // ── Refine Node Logic ──
  let tempRefineState = null;
  
  if (dom.refineNode) {
    dom.refineNode.addEventListener('click', async () => {
      const b = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
      if (!b) return;
      
      const originalLabel = b.label;
      const originalContent = b.content;
      dom.refineNode.disabled = true;
      dom.refineNode.innerHTML = '✨思考中...';
      try {
        const config = getConfig();
        const refined = await callRefineLlm(config, b, appState.canvas);
        
        b.label = refined.label || b.label;
        b.content = refined.content || b.content;
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
        dom.refineNode.innerHTML = '✨提炼';
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

  // ── Chat panel toggle ──
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

  // ── Settings modal ──
  dom.settingsBtn.addEventListener('click', () => {
    dom.settingsOverlay.classList.add('open');
    dom.settingsOverlay.setAttribute('aria-hidden', 'false');
  });
  dom.closeSettings.addEventListener('click', closeSettings);
  dom.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === dom.settingsOverlay) closeSettings();
  });

  function closeSettings() {
    dom.settingsOverlay.classList.remove('open');
    dom.settingsOverlay.setAttribute('aria-hidden', 'true');
  }

  // Provider presets
  dom.llmProvider.addEventListener('change', () => applyProviderPreset(false));
  dom.sttProvider.addEventListener('change', () => {
    applyProviderPreset(false);
    syncVoiceFallbackNotice();
  });
  dom.ttsProvider.addEventListener('change', () => {
    applyProviderPreset(false);
    syncVoiceFallbackNotice();
  });
  dom.voiceMode.addEventListener('change', applyVoiceModePreset);
  dom.doubaoApiKey.addEventListener('change', () => {
    syncVoiceModeFallback();
    applyVoiceModePreset();
  });
  dom.testDoubaoAsrBtn.addEventListener('click', async () => {
    const config = getConfig();
    const btn = dom.testDoubaoAsrBtn;
    const originalText = btn.textContent;

    const useProxy = confirm('是否使用代理模式测试？\n\n点击「确定」使用代理（/api/doubao-asr）\n点击「取消」使用直连（豆包官方 WebSocket）');

    try {
      btn.textContent = '测试中...';
      btn.disabled = true;

      const result = await testDoubaoAsrConnection(config, { useProxy });
      alert(`✅ ${result.message}\n\n返回数据：${JSON.stringify(result.data, null, 2).slice(0, 500)}`);
    } catch (err) {
      alert(`❌ 测试失败：${err.message}`);
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
  dom.appId.addEventListener('change', () => {
    syncVoiceModeFallback();
    applyVoiceModePreset();
  });
  dom.accessToken.addEventListener('change', () => {
    syncVoiceModeFallback();
    applyVoiceModePreset();
  });
  dom.secretKey.addEventListener('change', () => {
    syncVoiceModeFallback();
    applyVoiceModePreset();
  });
  dom.sttEndpoint.addEventListener('change', () => {
    syncVoiceModeFallback();
    applyVoiceModePreset();
  });
  dom.ttsEndpoint.addEventListener('change', syncVoiceFallbackNotice);
  bindAudioUpload();

  // Save / Load config
  dom.saveConfig.addEventListener('click', () => {
    saveConfig(getConfig());
  });
  dom.loadConfig.addEventListener('click', () => {
    const cfg = loadSavedConfig();
    if (cfg) {
      setConfig(cfg);
      applyProviderPreset();
    }
  });

  // ── Fetch Models ──
  if (dom.fetchModelsBtn) {
    dom.fetchModelsBtn.addEventListener('click', async () => {
      const btn = dom.fetchModelsBtn;
      const originalText = btn.textContent;
      btn.textContent = '加载中...';
      btn.disabled = true;

      try {
        const config = getConfig();
        if (!config.llmApiKey) throw new Error('请先填写 LLM API Key');
        
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
        
        const datalist = document.getElementById('modelDataList');
        if (datalist && data && data.data) {
          datalist.innerHTML = '';
          data.data.forEach(m => {
            const option = document.createElement('option');
            option.value = m.id;
            datalist.appendChild(option);
          });
          alert(`成功获取 ${data.data.length} 个模型！请在左侧输入框下拉选择`);
        } else {
          throw new Error('返回格式不包含 data 字段');
        }
      } catch (err) {
        alert('获取失败: ' + err.message);
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
  }

  // ── Import ──
  dom.importJson.addEventListener('click', () => {
    showImportMenu();
  });

  // ── Export ──
  dom.downloadJson.addEventListener('click', () => {
    showExportMenu();
  });

  // ── Demo data ──
  dom.resetDemo.addEventListener('click', loadDemoData);

  // ── OAuth ──
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

  // ── OAuth redirect URI ──
  if (dom.oauthRedirect) {
    dom.oauthRedirect.value = location.origin + location.pathname;
  }

  // ── API Key Missing Alert ──
  window.addEventListener('api:key-missing', (e) => {
    // 打开设置面板
    dom.settingsOverlay.classList.add('open');
    dom.settingsOverlay.setAttribute('aria-hidden', 'false');

    // 给设置按钮添加闪动动画
    dom.settingsBtn.classList.add('api-key-alert');

    // 给 API key 输入框添加高亮红框
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

  // ── TTS speak ──
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
  };
  dom.boardTitle.textContent = appState.canvas.title;
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
  const detailAId = crypto.randomUUID();
  const detailBId = crypto.randomUUID();

  return {
    title: '测试：尺寸同步',
    blocks: [
      { id: rootId, type: 'text', label: '尺寸同步测试', content: '用于验证缩放下不会错误缩窄块宽度', x: 420, y: 60, width: 260 },
      { id: longId, type: 'text', label: '长内容块', content: '这是一段很长的内容，用于测试在缩放和自动排布之前同步尺寸时，不会把块的宽度错误缩小，同时要让内容保持在块内正常换行显示。\n\n- 第一条很长的说明\n- 第二条也比较长\n- 第三条继续补充细节', x: 160, y: 220, width: 300 },
      { id: mediumId, type: 'text', label: '中等内容块', content: '中等长度内容，带有一些换行。\n第二行说明。\n第三行说明。', x: 520, y: 220, width: 220 },
      { id: shortId, type: 'text', label: '短块', content: '短内容', x: 820, y: 220, width: 180 },
      { id: detailAId, type: 'text', label: '附加说明 A', content: '用于观察层级布局。', x: 300, y: 420, width: 210 },
      { id: detailBId, type: 'text', label: '附加说明 B', content: '用于观察自动排布前后的宽度是否稳定。', x: 640, y: 420, width: 240 },
    ],
    connections: [
      { id: crypto.randomUUID(), fromId: rootId, toId: longId },
      { id: crypto.randomUUID(), fromId: rootId, toId: mediumId },
      { id: crypto.randomUUID(), fromId: rootId, toId: shortId },
      { id: crypto.randomUUID(), fromId: longId, toId: detailAId },
      { id: crypto.randomUUID(), fromId: mediumId, toId: detailBId },
    ],
    groups: [],
  };
}

function createLayoutDriftFixture() {
  const rootId = crypto.randomUUID();
  const strategyId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const operationsId = crypto.randomUUID();
  const signalId = crypto.randomUUID();
  const leafA1 = crypto.randomUUID();
  const leafA2 = crypto.randomUUID();
  const leafA3 = crypto.randomUUID();
  const leafA4 = crypto.randomUUID();
  const leafB1 = crypto.randomUUID();
  const leafB2 = crypto.randomUUID();
  const leafB3 = crypto.randomUUID();
  const crossId = crypto.randomUUID();

  return {
    title: '测试：布局发散',
    blocks: [
      { id: rootId, type: 'text', label: '布局发散测试', content: '重复执行自动排布后不应不断外扩。', x: 520, y: 60, width: 260 },
      { id: strategyId, type: 'text', label: '战略层', content: '包含较长内容，用于制造较高的节点。\n- 方向一\n- 方向二\n- 方向三', x: 180, y: 220, width: 260 },
      { id: productId, type: 'text', label: '产品层', content: '用于连接多个叶子节点，触发叶子网格布局。', x: 520, y: 220, width: 250 },
      { id: operationsId, type: 'text', label: '运营层', content: '作为另一侧主干，包含多叶子和跨层连接。', x: 860, y: 220, width: 250 },
      { id: signalId, type: 'text', label: '锁定观察点', content: '这个块保持锁定，用于放大挤压与绕行问题。', x: 560, y: 420, width: 240, locked: true },
      { id: leafA1, type: 'text', label: '产品叶子 1', content: '叶子内容 A1', x: 360, y: 440, width: 200 },
      { id: leafA2, type: 'text', label: '产品叶子 2', content: '叶子内容 A2，稍微长一点，确保高度差异。', x: 520, y: 500, width: 210 },
      { id: leafA3, type: 'text', label: '产品叶子 3', content: '叶子内容 A3', x: 700, y: 440, width: 190 },
      { id: leafA4, type: 'text', label: '产品叶子 4', content: '叶子内容 A4，继续增加同父叶子数量。', x: 860, y: 500, width: 220 },
      { id: leafB1, type: 'text', label: '运营叶子 1', content: '叶子内容 B1', x: 940, y: 440, width: 200 },
      { id: leafB2, type: 'text', label: '运营叶子 2', content: '叶子内容 B2', x: 1080, y: 500, width: 210 },
      { id: leafB3, type: 'text', label: '运营叶子 3', content: '叶子内容 B3，用于触发网格阈值。', x: 1220, y: 440, width: 215 },
      { id: crossId, type: 'text', label: '跨层节点', content: '与左右主干同时相关，容易触发穿块和二次外推。', x: 260, y: 620, width: 260 },
    ],
    connections: [
      { id: crypto.randomUUID(), fromId: rootId, toId: strategyId },
      { id: crypto.randomUUID(), fromId: rootId, toId: productId },
      { id: crypto.randomUUID(), fromId: rootId, toId: operationsId },
      { id: crypto.randomUUID(), fromId: strategyId, toId: crossId },
      { id: crypto.randomUUID(), fromId: productId, toId: signalId },
      { id: crypto.randomUUID(), fromId: productId, toId: leafA1 },
      { id: crypto.randomUUID(), fromId: productId, toId: leafA2 },
      { id: crypto.randomUUID(), fromId: productId, toId: leafA3 },
      { id: crypto.randomUUID(), fromId: productId, toId: leafA4 },
      { id: crypto.randomUUID(), fromId: operationsId, toId: leafB1 },
      { id: crypto.randomUUID(), fromId: operationsId, toId: leafB2 },
      { id: crypto.randomUUID(), fromId: operationsId, toId: leafB3 },
      { id: crypto.randomUUID(), fromId: strategyId, toId: leafA2 },
      { id: crypto.randomUUID(), fromId: crossId, toId: leafB2 },
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

// ── Import Menu ──
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
      <span class="import-icon">📝</span>Markdown 大纲
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

    // 验证数据结构
    if (!data.title || !Array.isArray(data.blocks) || !Array.isArray(data.connections)) {
      throw new Error('JSON 格式无效，需要 title/blocks/connections 字段');
    }

    // 导入数据
    appState.canvas = {
      title: data.title,
      blocks: data.blocks,
      connections: data.connections,
      groups: data.groups || [],
    };

    // 更新 UI
    dom.boardTitle.textContent = appState.canvas.title;
    pushHistory();
    renderBlocks();
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
    dom.boardTitle.textContent = canvasData.title;
    pushHistory();
    renderBlocks();
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
  const blockStack = []; // 用于跟踪层级关系
  let blockIndex = 0;

  // 提取标题作为画布标题
  let title = '导入的画布';
  const titleMatch = markdown.match(/^#\s+(.+)/);
  if (titleMatch) {
    title = titleMatch[1];
  }

  // 解析每一行
  for (const line of lines) {
    // 跳过空行和标题行（已经处理）
    if (!line.trim() || line.startsWith('# ')) continue;

    // 计算缩进级别（通过 - 前面的空格或 # 数量）
    const listMatch = line.match(/^(\s*)-\s*\*\*(.+?)\*\*(?:\s*—\s*(.+))?$/);
    const headerMatch = line.match(/^(#{2,})\s*(.+?)(?:\s*—\s*(.+))?$/);

    let depth = 0;
    let label = '';
    let content = '';

    if (listMatch) {
      // 列表格式：- **Label** — Content
      depth = Math.floor(listMatch[1].length / 2);
      label = listMatch[2].trim();
      content = listMatch[3]?.trim() || '';
    } else if (headerMatch) {
      // 标题格式：## Label — Content
      depth = headerMatch[1].length - 1;
      label = headerMatch[2].trim();
      content = headerMatch[3]?.trim() || '';
    } else {
      continue; // 跳过无法解析的行
    }

    // 创建新块
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

    // 创建连接（连接到父节点）
    if (blockStack.length > 1) {
      // 找到最近的父节点（深度小于当前深度的最后一个）
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

  // 使用自动布局计算位置
  // 先给一个临时的 autoLayout 调用
  // 由于 autoLayout 需要导入，我们在这里简单计算位置
  const startX = 400;
  const startY = 60;
  const levelHeight = 160;
  const siblingGap = 200;

  // 按层级分配位置
  const levelPositions = {};
  const levelCounts = {};

  for (const block of blocks) {
    // 找到块的深度
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

// ── Export Menu ──
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
      <span class="export-icon">📝</span>Markdown 大纲
    </button>
    <button class="export-item" data-format="pdf">
      <span class="export-icon">📄</span>PDF 画布
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
        `canvas-${Date.now()}.json`,
        'application/json'
      );
    } else if (format === 'markdown') {
      downloadFile(
        canvasToMarkdown(),
        `canvas-${Date.now()}.md`,
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
    alert('当前画布为空，无法导出 PDF');
    return;
  }

  syncBlockSizes();
  const bounds = getVisibleCanvasBounds();
  if (!bounds) {
    alert('当前没有可导出的画布内容');
    return;
  }

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('无法打开打印窗口，请允许浏览器弹窗后重试');
    return;
  }

  const title = getSafeFilenameTitle();
  const page = bounds.width >= bounds.height
    ? { orientation: 'landscape', width: 1122, height: 794 }
    : { orientation: 'portrait', width: 794, height: 1122 };
  const margin = 32;
  const targetWidth = page.width - margin * 2;
  const targetHeight = page.height - margin * 2;
  const scale = Math.min(1, targetWidth / bounds.width, targetHeight / bounds.height);
  const snapshotHtml = buildPdfSnapshot(bounds);

  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
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
        width: ${bounds.width}px;
        height: ${bounds.height}px;
        transform: scale(${scale});
        transform-origin: center center;
      }
      .pdf-export-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 6000px;
        height: 6000px;
        transform: translate(${-bounds.x}px, ${-bounds.y}px);
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

function getSafeFilenameTitle() {
  const title = (appState.canvas.title || 'canvas').trim() || 'canvas';
  return `${title.replace(/[\\/:*?"<>|]+/g, '-')}-${Date.now()}`;
}

function canvasToMarkdown() {
  const { blocks, connections, title } = appState.canvas;
  let md = `# ${title}\n\n`;

  // 构建树
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
    if (b.content) line += ` — ${b.content}`;
    line += '\n';
    for (const cid of (childMap[id] || [])) {
      line += walk(cid, depth + 1);
    }
    return line;
  }

  for (const root of roots) {
    md += walk(root.id, 0);
  }

  // 孤立节点
  const visited = new Set();
  function markVisited(id) { visited.add(id); (childMap[id] || []).forEach(markVisited); }
  roots.forEach(r => markVisited(r.id));
  const orphans = blocks.filter(b => !visited.has(b.id));
  if (orphans.length) {
    md += '\n## 其他\n\n';
    for (const b of orphans) {
      md += `- **${b.label}**`;
      if (b.content) md += ` — ${b.content}`;
      md += '\n';
    }
  }

  return md;
}

// ── Start ──
init();
