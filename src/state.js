/**
 * state.js — 画布状态管理 + 历史栈 + 撤销重做
 */

const STORAGE_KEY = 'canvas-studio-config-v2';
const CANVAS_STORAGE_KEY = 'canvas-studio-canvas-v1';
const CANVAS_LIST_KEY = 'canvas-studio-list-v1';
const CURRENT_CANVAS_ID_KEY = 'canvas-studio-current-id-v1';
const MAX_HISTORY = 40;

/** 调用 LLM 推荐组名 */
export async function suggestGroupName(blockIds, config = null) {
  try {
    const blocks = appState.canvas.blocks.filter(b => blockIds.includes(b.id));
    const content = blocks.map(b => `${b.label}: ${b.content || ''}`).join('\n');

    // 如果没有传入 config，从 localStorage 读取
    if (!config) {
      config = loadConfig();
    }

    console.log('[AI 组名] 完整配置:', config);

    const endpoint = config?.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm;
    const apiKey = config?.llmApiKey || '';
    const model = config?.llmModel || 'qwen-plus';

    console.log('[AI 组名] 使用配置:', { endpoint, model, apiKey: apiKey ? `${apiKey.slice(0, 8)}...` : '空' });

    if (!apiKey) {
      console.error('[AI 组名] API Key 为空，请在设置中配置');
      return null;
    }

    const prompt = `请根据以下内容，为这个组推荐一个简短的名称（不超过 10 个字，不要解释，不要标点符号）：
${content}`;

    console.log('[AI 组名] 请求内容:', prompt);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50
      })
    });

    console.log('[AI 组名] 响应状态:', response.status);

    const data = await response.json();
    console.log('[AI 组名] 响应数据:', JSON.stringify(data).slice(0, 500));

    if (data.error) {
      console.error('[AI 组名] API 错误:', data.error.message);
      return null;
    }

    const name = data?.choices?.[0]?.message?.content?.trim() || null;
    console.log('[AI 组名] 推荐名称:', name);
    return name;
  } catch (e) {
    console.error('AI 推荐组名失败:', e);
    return null;
  }
}

/** 全局应用状态 */
export const appState = {
  /** 画布数据 */
  canvas: {
    title: '未命名白板',
    blocks: [],       // { id, type, label, content, x, y, groupId?, color? }
    connections: [],   // { id, fromId, toId }
    groups: [],        // { id, blockIds: [], color: string }
  },

  /** 对话历史（传给 LLM） */
  conversation: [],

  /** 选中的节点 id（兼容旧代码） */
  selectedBlockId: null,

  /** 多选的节点 id 数组 */
  selectedBlockIds: [],

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
  if (!text) return null;

  const config = JSON.parse(text);
  if (config && typeof config === 'object' && config.apiKey) {
    if (!config.llmApiKey) config.llmApiKey = config.apiKey;
    if (!config.doubaoApiKey && config.sttProvider === 'doubao') {
      config.doubaoApiKey = config.apiKey;
    }
    delete config.apiKey;
  }
  return config;
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
      // 确保 groups 字段存在（兼容旧数据）
      if (!canvas.groups) {
        canvas.groups = [];
      }
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
    const canvas = JSON.parse(data);
    // 确保 groups 字段存在（兼容旧数据）
    if (!canvas.groups) {
      canvas.groups = [];
    }
    return canvas;
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
    // 确保 groups 字段存在
    if (!canvas.groups) {
      canvas.groups = [];
    }
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
    sttModel: 'sensevoice-v1',
    fileSttModel: 'sensevoice-v1',
    ttsModel: 'qwen-tts',
    realtimeVoiceModel: '',
  },
  doubao: {
    llm: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    stt: 'https://openspeech.bytedance.com/api/v1/vc/ata/submit',
    tts: 'https://openspeech.bytedance.com/api/v1/tts',
    sttModel: 'doubao-asr-streaming-2.0',
    fileSttModel: 'doubao-asr-file-2.0',
    ttsModel: 'doubao-tts-2.0',
    realtimeVoiceModel: 'doubao-realtime-voice',
  },
};
// ═══════════════════════════════════════
//  Group Management
// ═══════════════════════════════════════

/** 可用的组颜色 */
export const GROUP_COLORS = [
  { name: '黄色', value: '#FFD600' },
  { name: '蓝色', value: '#2979FF' },
  { name: '绿色', value: '#00E676' },
  { name: '粉红', value: '#FF4081' },
  { name: '紫色', value: '#D500F9' },
  { name: '橙色', value: '#FF9100' },
];

/** 创建组 */
export function createGroup(blockIds, color, name = null) {
  const groupId = crypto.randomUUID();
  const group = {
    id: groupId,
    blockIds: [...blockIds],
    color,
    name: name || `组 ${String.fromCharCode(65 + appState.canvas.groups.length)}`,  // 默认名称
    folded: false  // 折叠状态
  };
  appState.canvas.groups.push(group);

  // 为块绑定 groupIds（支持多组）
  blockIds.forEach(id => {
    const block = appState.canvas.blocks.find(b => b.id === id);
    if (block) {
      if (!block.groupIds) block.groupIds = [];
      if (!block.groupIds.includes(groupId)) {
        block.groupIds.push(groupId);
      }
    }
  });

  return group;
}

/** 重命名组 */
export function renameGroup(groupId, newName) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (group) {
    group.name = newName;
    return true;
  }
  return false;
}

/** 切换组的折叠状态 */
export function toggleGroupFold(groupId, folded = null) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (group) {
    if (folded !== null) {
      group.folded = folded;
    } else {
      group.folded = !group.folded;
    }
    return group.folded;
  }
  return false;
}

/** 设置组的折叠状态 */
export function setGroupFolded(groupId, folded) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (group) {
    group.folded = folded;
  }
}

/** 添加块到组 */
export function addBlocksToGroup(blockIds, groupId) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return false;

  blockIds.forEach(id => {
    const block = appState.canvas.blocks.find(b => b.id === id);
    if (block) {
      if (!block.groupIds) block.groupIds = [];
      if (!block.groupIds.includes(groupId)) {
        block.groupIds.push(groupId);
      }
      if (!group.blockIds.includes(id)) {
        group.blockIds.push(id);
      }
    }
  });
  return true;
}

/** 从组移除块（不解散组） */
export function removeBlocksFromGroup(blockIds, groupId) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return false;

  blockIds.forEach(id => {
    const block = appState.canvas.blocks.find(b => b.id === id);
    if (block && block.groupIds) {
      block.groupIds = block.groupIds.filter(gid => gid !== groupId);
      if (block.groupIds.length === 0) {
        delete block.groupIds;
      }
    }
    group.blockIds = group.blockIds.filter(bid => bid !== id);
  });
  return true;
}

/** 删除组 */
export function deleteGroup(groupId) {
  const idx = appState.canvas.groups.findIndex(g => g.id === groupId);
  if (idx !== -1) {
    // 解除块的 groupIds 绑定
    const group = appState.canvas.groups[idx];
    group.blockIds.forEach(id => {
      const block = appState.canvas.blocks.find(b => b.id === id);
      if (block && block.groupIds) {
        block.groupIds = block.groupIds.filter(gid => gid !== groupId);
        if (block.groupIds.length === 0) {
          delete block.groupIds;
        }
      }
    });
    appState.canvas.groups.splice(idx, 1);
  }
}

/** 获取组内所有块 */
export function getGroupBlocks(groupId) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return [];
  return appState.canvas.blocks.filter(b => group.blockIds.includes(b.id));
}

/** 检查块是否在组内 */
export function isBlockInGroup(blockId) {
  return appState.canvas.groups.some(g => g.blockIds.includes(blockId));
}

/** 获取块的组颜色（返回第一个组的颜色） */
export function getGroupColor(blockId) {
  const block = appState.canvas.blocks.find(b => b.id === blockId);
  if (!block || !block.groupIds || block.groupIds.length === 0) return null;
  const groupId = block.groupIds[0];
  const group = appState.canvas.groups.find(g => g.id === groupId);
  return group ? group.color : null;
}

/** 获取块所属的组（返回第一个） */
export function getBlockGroup(blockId) {
  const block = appState.canvas.blocks.find(b => b.id === blockId);
  if (!block || !block.groupIds || block.groupIds.length === 0) return null;
  const groupId = block.groupIds[0];
  return appState.canvas.groups.find(g => g.id === groupId);
}

/** 获取块所属的所有组 */
export function getBlockGroups(blockId) {
  const block = appState.canvas.blocks.find(b => b.id === blockId);
  if (!block || !block.groupIds || block.groupIds.length === 0) return [];
  return appState.canvas.groups.filter(g => block.groupIds.includes(g.id));
}
