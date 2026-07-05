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

export function validateCanvasIntegrity(canvas = {}) {
  const blocks = Array.isArray(canvas.blocks) ? canvas.blocks : [];
  const connections = Array.isArray(canvas.connections) ? canvas.connections : [];
  const groups = Array.isArray(canvas.groups) ? canvas.groups : [];
  const blockIds = new Map();
  const duplicateBlockIds = new Set();
  const missingBlockIds = [];
  const invalidConnections = [];
  const invalidGroupRefs = [];

  blocks.forEach((block, index) => {
    const id = typeof block?.id === 'string' ? block.id.trim() : '';
    if (!id) {
      missingBlockIds.push(`#${index + 1}`);
      return;
    }
    if (blockIds.has(id)) duplicateBlockIds.add(id);
    blockIds.set(id, true);
  });

  connections.forEach((connection, index) => {
    const fromId = typeof connection?.fromId === 'string' ? connection.fromId.trim() : '';
    const toId = typeof connection?.toId === 'string' ? connection.toId.trim() : '';
    if (!fromId || !toId || !blockIds.has(fromId) || !blockIds.has(toId)) {
      invalidConnections.push(`#${index + 1}: ${fromId || '(empty)'} -> ${toId || '(empty)'}`);
    }
  });

  groups.forEach((group, groupIndex) => {
    if (!Array.isArray(group?.blockIds)) return;
    group.blockIds.forEach((blockId) => {
      if (!blockIds.has(blockId)) {
        invalidGroupRefs.push(`#${groupIndex + 1}: ${blockId}`);
      }
    });
  });

  const errors = [];
  if (missingBlockIds.length) {
    errors.push(`存在缺少 id 的 blocks：${missingBlockIds.slice(0, 8).join(', ')}`);
  }
  if (duplicateBlockIds.size) {
    errors.push(`存在重复 block id：${Array.from(duplicateBlockIds).slice(0, 8).join(', ')}`);
  }
  if (invalidConnections.length) {
    errors.push(`存在指向不存在节点的 connections：${invalidConnections.slice(0, 8).join(', ')}`);
  }
  if (invalidGroupRefs.length) {
    errors.push(`存在指向不存在节点的 groups.blockIds：${invalidGroupRefs.slice(0, 8).join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    duplicateBlockIds: Array.from(duplicateBlockIds),
    missingBlockIds,
    invalidConnections,
    invalidGroupRefs,
  };
}

export function assertCanvasIntegrity(canvas) {
  const result = validateCanvasIntegrity(canvas);
  if (!result.valid) {
    throw new Error(result.errors.join('\n'));
  }
  return result;
}

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
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
      if (typeof op.block.label === 'string') {
        op.block.label = repairMarkdownFormatting(op.block.label).text;
      }
      if (typeof op.block.content === 'string') {
        op.block.content = repairMarkdownFormatting(op.block.content).text;
      }
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
      if (typeof op.changes.label === 'string') {
        op.changes.label = repairMarkdownFormatting(op.changes.label).text;
      }
      if (typeof op.changes.content === 'string') {
        op.changes.content = repairMarkdownFormatting(op.changes.content).text;
      }
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
    const { id, x, y, width, height, locked, positionLocked, ...safeChanges } = changes;
    return safeChanges;
  };
  const hasConnection = (fromId, toId) => canvas.connections.some(
    c => c.fromId === fromId && c.toId === toId
  );

  const addConnectionIfMissing = (fromId, toId) => {
    if (!fromId || !toId || !findBlock(fromId) || !findBlock(toId)) return;
    if (isLocked(fromId) || isLocked(toId) || hasConnection(fromId, toId)) return;
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
        if (!op.block?.id || findBlock(op.block.id)) break;

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
          if (Array.isArray(canvas.groups)) {
            canvas.groups.forEach(group => {
              if (Array.isArray(group.blockIds)) {
                group.blockIds = group.blockIds.filter(id => id !== op.targetId);
              }
            });
          }
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

function renderInlineMarkdown(text) {
  return escapeHtml(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

function splitTableRow(line) {
  const trimmed = line.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const normalized = body.endsWith('|') ? body.slice(0, -1) : body;
  const cells = [];
  let current = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '|' && normalized[index - 1] !== '\\') {
      cells.push(current.replace(/\\\|/g, '|').trim());
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current.replace(/\\\|/g, '|').trim());
  return cells;
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  if (cells.length < 2) return false;
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function isTableHeader(line, dividerLine) {
  return line?.includes('|') && dividerLine?.includes('|') && isTableDivider(dividerLine);
}

function escapeMarkdownTableCell(cell) {
  return String(cell ?? '').replace(/(?<!\\)\|/g, '\\|').trim();
}

function buildTableDivider(columnCount) {
  return `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
}

function buildTableRow(cells) {
  return `| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`;
}

function getTableCandidateRange(lines, startIndex) {
  let endIndex = startIndex;
  while (endIndex < lines.length && lines[endIndex].trim() && lines[endIndex].includes('|')) {
    endIndex += 1;
  }
  return { startIndex, endIndex };
}

function repairTableCandidate(lines) {
  const nonDividerLines = lines.filter(line => !isTableDivider(line));
  if (nonDividerLines.length < 2) {
    return { lines, changed: false, issues: [] };
  }

  const rows = nonDividerLines.map(splitTableRow);
  const columnCount = rows[0].length;
  const issues = [];

  if (columnCount < 2) {
    return { lines, changed: false, issues: [] };
  }

  const hasMismatchedRows = rows.some(cells => cells.length !== columnCount);
  if (hasMismatchedRows) {
    issues.push({
      type: 'table_column_mismatch',
      message: 'Markdown table rows have different column counts; this may require semantic repair.',
    });
    return { lines, changed: false, issues };
  }

  const repaired = [
    buildTableRow(rows[0]),
    buildTableDivider(columnCount),
    ...rows.slice(1).map(buildTableRow),
  ];

  return {
    lines: repaired,
    changed: repaired.join('\n') !== lines.join('\n'),
    issues,
  };
}

export function inspectMarkdownFormatting(text) {
  const issues = [];
  const source = String(text ?? '');
  if (/\\[nNrRt]/.test(source) || /\/[nN]/.test(source)) {
    issues.push({
      type: 'escaped_newline_literal',
      message: 'Text contains visible newline escape markers.',
      fixable: true,
    });
  }

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('|') || isTableDivider(lines[index])) continue;
    const { endIndex } = getTableCandidateRange(lines, index);
    const candidate = lines.slice(index, endIndex);
    const result = repairTableCandidate(candidate);
    result.issues.forEach(issue => issues.push({ ...issue, fixable: false }));
    index = endIndex - 1;
  }

  return {
    issues,
    needsModelRepair: issues.some(issue => !issue.fixable),
  };
}

export function repairMarkdownFormatting(text) {
  let nextText = String(text ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '  ')
    .replace(/\/n/g, '\n')
    .replace(/\/N/g, '\n');

  const issues = [];
  const lines = nextText.split(/\r?\n/);
  const repairedLines = [];
  let changed = nextText !== String(text ?? '');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes('|') || isTableDivider(line)) {
      repairedLines.push(line);
      continue;
    }

    const { endIndex } = getTableCandidateRange(lines, index);
    const candidate = lines.slice(index, endIndex);
    const result = repairTableCandidate(candidate);
    issues.push(...result.issues);
    if (result.issues.length === 0 && result.changed) changed = true;
    repairedLines.push(...(result.issues.length ? candidate : result.lines));
    index = endIndex - 1;
  }

  nextText = repairedLines.join('\n');

  return {
    text: nextText,
    changed,
    issues,
    needsModelRepair: issues.some(issue => issue.type === 'table_column_mismatch'),
  };
}

export function repairCanvasTextFormatting(canvas) {
  if (!canvas?.blocks) return { changed: false, issues: [] };
  const allIssues = [];
  let changed = false;

  for (const block of canvas.blocks) {
    for (const field of ['label', 'content']) {
      if (typeof block[field] !== 'string') continue;
      const result = repairMarkdownFormatting(block[field]);
      if (result.changed) {
        block[field] = result.text;
        changed = true;
      }
      result.issues.forEach(issue => {
        allIssues.push({ ...issue, blockId: block.id, field });
      });
    }
  }

  return { changed, issues: allIssues };
}

function renderTable(lines, startIndex) {
  const header = splitTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const columnCount = header.length;
  const normalizeCells = cells => Array.from({ length: columnCount }, (_, cellIndex) => cells[cellIndex] || '');
  const headHtml = normalizeCells(header)
    .map(cell => `<th>${renderInlineMarkdown(cell)}</th>`)
    .join('');
  const bodyHtml = rows
    .map(row => `<tr>${normalizeCells(row).map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
    .join('');

  return {
    html: `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index,
  };
}

export function renderMarkdown(text) {
  if (!text) return '';

  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(paragraph.map(line => renderInlineMarkdown(line)).join('<br>'));
    paragraph = [];
  };

  while (index < lines.length) {
    if (isTableHeader(lines[index], lines[index + 1])) {
      flushParagraph();
      const table = renderTable(lines, index);
      blocks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    if (!lines[index].trim()) {
      flushParagraph();
      blocks.push('');
      index += 1;
      continue;
    }

    paragraph.push(lines[index]);
    index += 1;
  }

  flushParagraph();

  return blocks.join('<br>');
}
