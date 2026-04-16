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
} from './state.js';
import { initCanvas, renderBlocks, zoomIn, zoomOut, fitToView, hideNodeToolbar } from './canvas.js';
import { initChat, sendText } from './chat.js';
import { initWaveform, resumeListening, isConversationActive } from './waveform.js';
import { autoLayout, findFreePosition } from './utils/layout.js';
import { transcribe } from './services/stt.js';
import { speak } from './services/tts.js';
import { buildOAuthUrl, exchangeOAuthCode } from './services/oauth.js';
import { callOrganizeLlm, callRefineLlm, callNamingLlm } from './services/llm.js';
import { parseAiResponse, executeOperations } from './utils/parser.js';

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
  apiKey: $('apiKey'),
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
};

// ── Config Helper ──
function getConfig() {
  return {
    llmProvider: dom.llmProvider.value,
    sttProvider: dom.sttProvider.value,
    ttsProvider: dom.ttsProvider.value,
    llmEndpoint: dom.llmEndpoint.value,
    llmModel: dom.llmModel.value,
    sttEndpoint: dom.sttEndpoint.value,
    ttsEndpoint: dom.ttsEndpoint.value,
    apiKey: dom.apiKey.value,
    proxyUrl: dom.proxyUrl?.value || '',
    oauthProvider: dom.oauthProvider.value,
    oauthClientId: dom.oauthClientId.value,
    oauthAuthUrl: dom.oauthAuthUrl.value,
    oauthTokenUrl: dom.oauthTokenUrl.value,
    oauthScope: dom.oauthScope.value,
    oauthRedirect: dom.oauthRedirect.value,
  };
}

function setConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (dom[key] && typeof value === 'string') dom[key].value = value;
  }
}

function applyProviderPreset() {
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
}

function applyLocalConfig() {
  const cfg = window.__LOCAL_CONFIG__ || {};
  const envKey = import.meta.env?.VITE_DASHSCOPE_KEY;
  const finalKey = envKey || cfg.DASHSCOPE_KEY;
  
  if (finalKey) {
    dom.apiKey.value = finalKey;
  } else if (!dom.apiKey.value && typeof finalKey === 'string') {
    dom.apiKey.value = finalKey;
  }
  if (!dom.llmEndpoint.value && cfg.DEFAULT_LLM_ENDPOINT) dom.llmEndpoint.value = cfg.DEFAULT_LLM_ENDPOINT;
  if (!dom.sttEndpoint.value && cfg.DEFAULT_STT_ENDPOINT) dom.sttEndpoint.value = cfg.DEFAULT_STT_ENDPOINT;
  if (!dom.ttsEndpoint.value && cfg.DEFAULT_TTS_ENDPOINT) dom.ttsEndpoint.value = cfg.DEFAULT_TTS_ENDPOINT;
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
function onCanvasChange() {
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
  pushHistory();
  renderBlocks([newBlock.id]);
  saveCurrentCanvas();
  checkAutoNaming();
}

function handleDeleteNode() {
  if (!appState.selectedBlockId) return;
  const idx = appState.canvas.blocks.findIndex(b => b.id === appState.selectedBlockId);
  if (idx === -1) return;
  // Also remove children recursively
  const toRemove = new Set([appState.selectedBlockId]);
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
  appState.canvas.blocks = appState.canvas.blocks.filter(b => !toRemove.has(b.id));
  appState.canvas.connections = appState.canvas.connections.filter(
    c => !toRemove.has(c.fromId) && !toRemove.has(c.toId)
  );
  appState.selectedBlockId = null;
  pushHistory();
  renderBlocks();
  saveCurrentCanvas();
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
  applyProviderPreset();
  applyLocalConfig();

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
        };
      }
    }
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
      const text = transcribedText;
      // 过滤纯标点符号/噪音
      if (text && text.replace(/[^\w\u4e00-\u9fa5]/g, '').length > 0) {
        const reply = await sendText(text);
        if (reply && isConversationActive) {
          // AI 响应后使用原生引擎低延迟朗读
          const utterance = new SpeechSynthesisUtterance(reply);
          utterance.lang = 'zh-CN';
          utterance.rate = 1.4; // 加快语速，让语感更干练
          utterance.onend = () => resumeListening();
          utterance.onerror = () => resumeListening();
          // 如果之前有没念完的，强制切断
          speechSynthesis.cancel();
          speechSynthesis.speak(utterance);
        } else {
          resumeListening();
        }
      } else {
        // 无效语音，继续听
        resumeListening();
      }
    } catch (err) {
      console.error('语音转写或响应失败:', err);
      resumeListening(); // 即使报错也尝试继续听
    }
  });

  // 4. Render canvas
  renderBlocks();
  if (appState.canvas.blocks.length > 0) fitToView();

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

  // ── Canvas controls ──
  dom.zoomIn.addEventListener('click', zoomIn);
  dom.zoomOut.addEventListener('click', zoomOut);
  dom.fitBtn.addEventListener('click', fitToView);
  dom.autoLayoutBtn.addEventListener('click', () => {
    autoLayout(appState.canvas.blocks, appState.canvas.connections);
    pushHistory();
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
          executeOperations(appState.canvas, parsed.operations);
          autoLayout(appState.canvas.blocks, appState.canvas.connections);
          pushHistory();
          renderBlocks();
          fitToView();
          saveCurrentCanvas();
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
  dom.deleteNode.addEventListener('click', handleDeleteNode);
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
        renderBlocks(); // temporary preview WYSIWYG
        
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
        renderBlocks();
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
  dom.llmProvider.addEventListener('change', applyProviderPreset);
  dom.sttProvider.addEventListener('change', applyProviderPreset);
  dom.ttsProvider.addEventListener('change', applyProviderPreset);

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
        if (!config.apiKey) throw new Error('请先填写 API Key');
        
        let url = config.llmEndpoint || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        if (url.endsWith('/chat/completions')) url = url.replace('/chat/completions', '');
        if (!url.endsWith('/models')) url = url.replace(/\/$/, '') + '/models';

        const res = await fetch(config.proxyUrl || url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`
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
    dom.apiKey.classList.add('api-key-highlight');

    // 聚焦 API key 输入框
    setTimeout(() => {
      dom.apiKey.focus();
      dom.apiKey.select();
    }, 300);

    // 动画结束后移除类
    setTimeout(() => {
      dom.settingsBtn.classList.remove('api-key-alert');
      dom.apiKey.classList.remove('api-key-highlight');
    }, 3000);
  });

  // ── TTS speak ──
  if (dom.speakBtn) {
    dom.speakBtn.addEventListener('click', async () => {
      if (!appState.lastAssistantReply) return;
      try {
        await speak(appState.lastAssistantReply, getConfig());
      } catch (err) {
        console.error('TTS error:', err);
      }
    });
  }
}

function loadDemoData() {
  const rootId = crypto.randomUUID();
  const prodId = crypto.randomUUID();
  const mktId = crypto.randomUUID();
  const mvpId = crypto.randomUUID();
  const roadId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const compId = crypto.randomUUID();

  appState.canvas = {
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
  };

  dom.boardTitle.textContent = '创业计划';
  initHistory();
  renderBlocks(appState.canvas.blocks.map(b => b.id));
  setTimeout(fitToView, 500);
  saveCurrentCanvas();
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
