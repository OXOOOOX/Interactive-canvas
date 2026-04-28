/**
 * parser.js — AI 增量操作解析 + 执行
 *
 * AI 返回格式：
 * {
 *   "reply": "一段文字回复",
 *   "operations": [
 *     { "op": "add", "block": { id, type, label, content }, "parentId": "xxx" },
 *     { "op": "update", "targetId": "xxx", "changes": { label?, content? } },
 *     { "op": "remove", "targetId": "xxx" },
 *   ]
 * }
 */

import { traverse, findNodeById, ensureNodeFields } from './traverse.js';

/**
 * 从 AI 原始文本中提取 JSON
 * 兼容 markdown 代码块包裹、多余前后文等
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * 提取 AI 回复文本（兼容各供应商）
 */
export function extractAssistantText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (typeof payload.text === 'string') return payload.text;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  }
  return JSON.stringify(payload);
}

/**
 * 将普通文本中的 `**` 转为加粗并安全渲染
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // 加粗
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  return html;
}

/**
 * 组装轻量级白板大纲（供聊天 AI 感知上下文用，省 token）
 */
export function buildCanvasOutline(canvas) {
  if (!canvas.blocks || canvas.blocks.length === 0) return '白板空空如也';
  
  const rootIds = canvas.blocks
    .filter(b => !canvas.connections.some(c => c.toId === b.id))
    .map(b => b.id);
  const blockMap = {};
  canvas.blocks.forEach(b => blockMap[b.id] = b);
  const childMap = {};
  canvas.connections.forEach(c => {
    if (!childMap[c.fromId]) childMap[c.fromId] = [];
    childMap[c.fromId].push(c.toId);
  });

  let out = `【当前图表大纲】\n`;
  const traversed = new Set();
  function walk(id, level) {
    if (traversed.has(id)) return;
    traversed.add(id);
    const b = blockMap[id];
    if (!b) return;
    const indent = '  '.repeat(level);
    out += `${indent}- [${b.label}] ${b.locked ? '(已被图钉锁定)' : ''}\n`;
    (childMap[id] || []).forEach(cid => walk(cid, level + 1));
  }
  rootIds.forEach(id => walk(id, 0));
  return out.trim();
}

/**
 * 解析 AI 返回，提取 reply 和 operations
 *
 * 同时兼容两种格式：
 * 1. 新增量格式: { reply, operations }
 * 2. 旧全量格式: { title, nodes, notes }（向后兼容）
 */
export function parseAiResponse(rawText) {
  const text = extractAssistantText(rawText);
  const json = extractJson(text);

  if (!json) {
    return { reply: text, operations: [], raw: text };
  }

  // 新增量格式
  if (json.reply !== undefined || Array.isArray(json.operations)) {
    const ops = (json.operations || []).map(normalizeOp).filter(Boolean);
    return { reply: json.reply || '', operations: ops, raw: text };
  }

  // 旧全量格式 → 转化为 operations
  if (json.title && Array.isArray(json.nodes)) {
    const ops = convertFullMapToOps(json);
    return {
      reply: `已生成导图「${json.title}」`,
      operations: ops,
      raw: text,
    };
  }

  return { reply: text, operations: [], raw: text };
}

/** 标准化单个操作 */
function normalizeOp(op) {
  if (!op || !op.op) return null;
  switch (op.op) {
    case 'add':
      if (!op.block) return null;
      op.block = ensureNodeFields({
        id: op.block.id || crypto.randomUUID(),
        type: op.block.type || 'text',
        label: op.block.label || '新节点',
        content: op.block.content || '',
        children: [],
      });
      return op;
    case 'update':
      if (!op.targetId || !op.changes) return null;
      return op;
    case 'remove':
      if (!op.targetId) return null;
      return op;
    case 'move':
      return op;
    case 'addConnection':
      if (!op.fromId || !op.toId) return null;
      return op;
    case 'removeConnection':
      if (!op.fromId || !op.toId) return null;
      return op;
    default:
      return null;
  }
}

/** 把旧全量 JSON 转化为全量 add 操作 */
function convertFullMapToOps(map) {
  const ops = [];
  function walk(nodes, parentId) {
    for (const n of nodes) {
      const block = ensureNodeFields({
        id: n.id || crypto.randomUUID(),
        type: 'text',
        label: n.label || '未命名',
        content: n.content || '',
        x: n.x,
        y: n.y,
        children: [],
      });
      ops.push({ op: 'add', block, parentId: parentId || null });
      if (Array.isArray(n.children) && n.children.length) {
        walk(n.children, block.id);
      }
    }
  }
  // 添加根节点
  const rootId = crypto.randomUUID();
  ops.push({
    op: 'add',
    block: ensureNodeFields({ id: rootId, type: 'text', label: map.title, content: '', children: [] }),
    parentId: null,
  });
  walk(map.nodes, rootId);
  return ops;
}

/** 清理重复连接线，保留每组 fromId -> toId 的第一条 */
export function dedupeConnections(canvas) {
  if (!canvas?.connections) return false;
  const seen = new Set();
  const originalLength = canvas.connections.length;

  canvas.connections = canvas.connections.filter(conn => {
    const key = `${conn.fromId}->${conn.toId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return canvas.connections.length !== originalLength;
}

/**
 * 在画布状态上执行一组 operations
 * @param {Object} canvas - { blocks[], connections[] }
 * @param {Array} operations
 * @returns {{ addedIds: string[], updatedIds: string[], removedIds: string[] }}
 */
export function executeOperations(canvas, operations) {
  const result = { addedIds: [], updatedIds: [], removedIds: [] };

  const findBlock = (id) => canvas.blocks.find(b => b.id === id);
  const isLocked = (id) => Boolean(findBlock(id)?.locked);
  const isPositionLocked = (id) => {
    const block = findBlock(id);
    return Boolean(block?.locked || block?.positionLocked);
  };
  const sanitizeChanges = (changes) => {
    const { x, y, width, height, locked, positionLocked, ...safeChanges } = changes;
    return safeChanges;
  };
  const hasConnection = (fromId, toId) => canvas.connections.some(
    c => c.fromId === fromId && c.toId === toId
  );

  const addConnectionIfMissing = (fromId, toId) => {
    if (!fromId || !toId || isLocked(fromId) || isLocked(toId) || hasConnection(fromId, toId)) return;
    canvas.connections.push({
      id: crypto.randomUUID(),
      fromId,
      toId,
    });
  };

  for (const op of operations) {
    switch (op.op) {
      case 'add': {
        if (op.parentId && isLocked(op.parentId)) break;

        canvas.blocks.push(op.block);
        result.addedIds.push(op.block.id);

        if (op.parentId) {
          const parentExists = canvas.blocks.some(b => b.id === op.parentId);
          if (parentExists) {
            addConnectionIfMissing(op.parentId, op.block.id);
          }
        }
        break;
      }
      case 'update': {
        const block = canvas.blocks.find(b => b.id === op.targetId);
        if (block && op.changes) {
          if (block.locked) break; // 防护盾：锁定的节点拒改
          Object.assign(block, sanitizeChanges(op.changes));
          result.updatedIds.push(op.targetId);
        }
        break;
      }
      case 'remove': {
        const block = canvas.blocks.find(b => b.id === op.targetId);
        if (block && block.locked) break; // 防护盾：锁定的节点拒删
        
        const idx = canvas.blocks.findIndex(b => b.id === op.targetId);
        if (idx !== -1) {
          canvas.blocks.splice(idx, 1);
          // 删除相关连接线
          canvas.connections = canvas.connections.filter(
            c => c.fromId !== op.targetId && c.toId !== op.targetId
          );
          result.removedIds.push(op.targetId);
        }
        break;
      }
      case 'move': {
        const block = findBlock(op.targetId);
        if (block && !isPositionLocked(op.targetId)) {
          if (typeof op.x === 'number') block.x = op.x;
          if (typeof op.y === 'number') block.y = op.y;
          result.updatedIds.push(op.targetId);
        }
        break;
      }
      case 'addConnection': {
        if (op.fromId && op.toId) {
          addConnectionIfMissing(op.fromId, op.toId);
        }
        break;
      }
      case 'removeConnection': {
        canvas.connections = canvas.connections.filter(c => {
          if (c.fromId !== op.fromId || c.toId !== op.toId) return true;
          return isLocked(c.fromId) || isLocked(c.toId);
        });
        break;
      }
    }
  }

  return result;
}
