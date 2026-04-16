/**
 * state.js — 画布状态管理 + 历史栈 + 撤销重做
 */

const STORAGE_KEY = 'canvas-studio-config-v2';
const CANVAS_STORAGE_KEY = 'canvas-studio-canvas-v1';
const MAX_HISTORY = 40;

/** 全局应用状态 */
export const appState = {
  /** 画布数据 */
  canvas: {
    title: '未命名白板',
    blocks: [],       // { id, type, label, content, x, y }
    connections: [],   // { id, fromId, toId }
  },

  /** 对话历史（传给 LLM） */
  conversation: [],

  /** 选中的节点 id */
  selectedBlockId: null,

  /** 视口状态 */
  viewport: {
    zoom: 1,
    panX: 0,
    panY: 0,
  },

  /** 最新 AI 回复文本（用于 TTS） */
  lastAssistantReply: '',
};

/** 历史栈 */
const historyStack = [];
let historyIndex = -1;

/** 深拷贝画布 */
function cloneCanvas(canvas) {
  return JSON.parse(JSON.stringify(canvas));
}

/** 推入历史快照 */
export function pushHistory() {
  // 剪掉 redo 分支
  historyStack.splice(historyIndex + 1);
  historyStack.push(cloneCanvas(appState.canvas));
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  historyIndex = historyStack.length - 1;
}

/** 撤销 */
export function undo() {
  if (historyIndex <= 0) return false;
  historyIndex--;
  appState.canvas = cloneCanvas(historyStack[historyIndex]);
  return true;
}

/** 重做 */
export function redo() {
  if (historyIndex >= historyStack.length - 1) return false;
  historyIndex++;
  appState.canvas = cloneCanvas(historyStack[historyIndex]);
  return true;
}

/** 初始化（推入第一个快照） */
export function initHistory() {
  historyStack.length = 0;
  historyIndex = -1;
  pushHistory();
}

// ── Config 持久化 ──

export function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function loadConfig() {
  const text = localStorage.getItem(STORAGE_KEY);
  return text ? JSON.parse(text) : null;
}

/** 保存画布到 localStorage */
export function saveCanvas() {
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(appState.canvas));
}

/** 从 localStorage 恢复画布 */
export function loadCanvas() {
  const text = localStorage.getItem(CANVAS_STORAGE_KEY);
  if (!text) return false;
  try {
    const canvas = JSON.parse(text);
    if (canvas && Array.isArray(canvas.blocks)) {
      appState.canvas = canvas;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** Endpoint presets */
export const ENDPOINT_PRESETS = {
  tongyi: {
    llm: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    stt: 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions',
    tts: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  },
  doubao: {
    llm: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    stt: 'https://openspeech.bytedance.com/api/v1/vc/ata/submit',
    tts: 'https://openspeech.bytedance.com/api/v1/tts',
  },
};
