/**
 * state.js — 画布状态管理 + 历史栈 + 撤销重做
 */

const STORAGE_KEY = 'canvas-studio-config-v2';
const CANVAS_STORAGE_KEY = 'canvas-studio-canvas-v1';
const CANVAS_LIST_KEY = 'canvas-studio-list-v1';
const CURRENT_CANVAS_ID_KEY = 'canvas-studio-current-id-v1';
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

// ── 画布列表管理 ──

/** 获取画布列表 */
export function getCanvasList() {
  const list = localStorage.getItem(CANVAS_LIST_KEY);
  if (!list) return [];
  try {
    return JSON.parse(list);
  } catch {
    return [];
  }
}

/** 保存画布列表 */
export function saveCanvasList(list) {
  localStorage.setItem(CANVAS_LIST_KEY, JSON.stringify(list));
}

/** 创建新画布 */
export function createCanvas(title = '未命名白板') {
  const id = crypto.randomUUID();
  const now = Date.now();
  const canvas = {
    id,
    title,
    blocks: [],
    connections: [],
    createdAt: now,
    updatedAt: now,
  };

  // 存储完整数据
  localStorage.setItem(`canvas-data-${id}`, JSON.stringify(canvas));

  // 更新列表
  const list = getCanvasList();
  list.unshift({ id, title, createdAt: now, updatedAt: now, blockCount: 0 });
  saveCanvasList(list);

  // 设置当前画布 ID
  localStorage.setItem(CURRENT_CANVAS_ID_KEY, id);

  return canvas;
}

/** 删除画布 */
export function deleteCanvas(id) {
  localStorage.removeItem(`canvas-data-${id}`);
  const list = getCanvasList().filter(c => c.id !== id);
  saveCanvasList(list);

  // 如果删除的是当前画布，清除当前 ID
  const currentId = localStorage.getItem(CURRENT_CANVAS_ID_KEY);
  if (currentId === id) {
    localStorage.removeItem(CURRENT_CANVAS_ID_KEY);
  }
}

/** 加载指定画布 */
export function loadCanvasById(id) {
  const data = localStorage.getItem(`canvas-data-${id}`);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** 保存当前画布（多画布版本） */
export function saveCurrentCanvas() {
  if (!appState.canvas.id) {
    // 旧版本单画布，兼容处理
    saveCanvas();
    return;
  }

  // 更新完整数据
  localStorage.setItem(`canvas-data-${appState.canvas.id}`, JSON.stringify(appState.canvas));

  // 更新列表中的元数据
  const list = getCanvasList();
  const idx = list.findIndex(c => c.id === appState.canvas.id);
  if (idx !== -1) {
    list[idx] = {
      ...list[idx],
      title: appState.canvas.title,
      updatedAt: Date.now(),
      blockCount: appState.canvas.blocks.length,
    };
    saveCanvasList(list);
  }
}

/** 切换画布 */
export function switchCanvas(id) {
  const canvas = loadCanvasById(id);
  if (canvas) {
    appState.canvas = canvas;
    localStorage.setItem(CURRENT_CANVAS_ID_KEY, id);
    return true;
  }
  return false;
}

/** 获取当前画布 ID */
export function getCurrentCanvasId() {
  return localStorage.getItem(CURRENT_CANVAS_ID_KEY);
}

/** 重命名画布 */
export function renameCanvas(id, title) {
  const list = getCanvasList();
  const idx = list.findIndex(c => c.id === id);
  if (idx !== -1) {
    list[idx].title = title;
    list[idx].updatedAt = Date.now();
    saveCanvasList(list);

    // 如果当前画布，同步更新
    if (appState.canvas.id === id) {
      appState.canvas.title = title;
    }

    // 更新完整数据
    const canvas = loadCanvasById(id);
    if (canvas) {
      canvas.title = title;
      canvas.updatedAt = Date.now();
      localStorage.setItem(`canvas-data-${id}`, JSON.stringify(canvas));
    }
  }
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
