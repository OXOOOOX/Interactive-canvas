/**
 * layout.js — 自动布局算法
 *
 * 根据 blocks + connections 计算所有节点的 (x, y) 坐标
 * 策略：简单树形布局（根节点居中，子节点向下展开）
 * 组内块保持相对位置，组作为整体参与布局
 */

const BLOCK_W = 200;
const BLOCK_H = 72;
const H_GAP = 60;  // 水平间距
const V_GAP = 140; // 垂直间距 (调大以防密集)

/**
 * 从 blocks + connections 推算出树结构
 */
function buildTree(blocks, connections, groups = []) {
  const childMap = {};  // parentId → [childId]
  const hasParent = new Set();

  for (const conn of connections) {
    if (!childMap[conn.fromId]) childMap[conn.fromId] = [];
    childMap[conn.fromId].push(conn.toId);
    hasParent.add(conn.toId);
  }

  // 找根节点（没有 parent 的）
  const roots = blocks.filter(b => !hasParent.has(b.id));

  return { roots, childMap };
}

/**
 * 计算子树宽度（用于居中对齐）
 */
function subtreeWidth(blockId, childMap, blockMap, groupMap = {}) {
  const children = childMap[blockId] || [];
  if (children.length === 0) return BLOCK_W;

  // 如果当前块是组的代表块，计算整个组的宽度
  const group = groupMap[blockId];
  if (group) {
    // 组的宽度 = 组内所有块的最大宽度
    let maxGroupWidth = 0;
    group.blockIds.forEach(id => {
      const b = blockMap[id];
      if (b) {
        const w = b.width || BLOCK_W;
        if (w > maxGroupWidth) maxGroupWidth = w;
      }
    });
    // 组的子树宽度考虑组内所有块的子节点
    let totalChildWidth = 0;
    const allChildIds = [];
    group.blockIds.forEach(id => {
      (childMap[id] || []).forEach(cid => {
        if (!group.blockIds.includes(cid)) {
          allChildIds.push(cid);
        }
      });
    });
    if (allChildIds.length > 0) {
      allChildIds.forEach(cid => {
        totalChildWidth += subtreeWidth(cid, childMap, blockMap, groupMap) + H_GAP;
      });
      totalChildWidth -= H_GAP;
    }
    return Math.max(maxGroupWidth, totalChildWidth);
  }

  let total = 0;
  for (const cid of children) {
    total += subtreeWidth(cid, childMap, blockMap, groupMap) + H_GAP;
  }
  return total - H_GAP; // 去掉最后一个间距
}

/**
 * 递归布局
 */
function layoutSubtree(blockId, x, y, childMap, blockMap, groupMap = {}, positionedGroups = new Set()) {
  const block = blockMap[blockId];
  if (!block) return;

  // 检查块是否在组内
  const group = groupMap[blockId];
  if (group && !positionedGroups.has(group.id)) {
    // 这是组的代表块，布局整个组
    // 组的位置就是代表块的位置
    group.blockIds.forEach(id => {
      const b = blockMap[id];
      if (b && b.id !== blockId) {
        // 其他块暂时不处理，等代表块定位后再应用相对偏移
      }
    });
    positionedGroups.add(group.id);
  }

  if (!block.locked) {
    block.x = x;
    block.y = y;
  } else {
    // 固定的节点会强制影响它的子代重新基于它对齐
    x = block.x;
    y = block.y;
  }

  const children = childMap[blockId] || [];
  if (children.length === 0) return;

  const totalW = subtreeWidth(blockId, childMap, blockMap, groupMap);
  let curX = x + BLOCK_W / 2 - totalW / 2;

  for (const cid of children) {
    const cw = subtreeWidth(cid, childMap, blockMap, groupMap);
    const cx = curX + cw / 2 - BLOCK_W / 2;
    layoutSubtree(cid, cx, y + BLOCK_H + V_GAP, childMap, blockMap, groupMap, positionedGroups);
    curX += cw + H_GAP;
  }
}

/**
 * 对全部 blocks 执行自动布局
 * 会直接修改 block.x / block.y
 */
export function autoLayout(blocks, connections, groups = []) {
  if (blocks.length === 0) return;

  const blockMap = {};
  for (const b of blocks) blockMap[b.id] = b;

  // 构建组映射：块 ID → 组对象
  const groupMap = {};
  if (groups && groups.length > 0) {
    groups.forEach(group => {
      // 每个组的第一个块作为代表块
      const representativeId = group.blockIds[0];
      groupMap[representativeId] = group;
    });
  }

  // 保存组内块的相对位置（相对于组代表块）
  const groupInternalOffsets = {};
  if (groups && groups.length > 0) {
    groups.forEach(group => {
      const representative = blockMap[group.blockIds[0]];
      if (representative) {
        const repCx = representative.x + (representative.width || BLOCK_W) / 2;
        const repCy = representative.y;

        groupInternalOffsets[group.id] = group.blockIds.map(id => {
          const b = blockMap[id];
          if (!b) return { id, offsetX: 0, offsetY: 0 };
          const bCx = b.x + (b.width || BLOCK_W) / 2;
          const bCy = b.y;
          return {
            id,
            offsetX: bCx - repCx,  // 块中心相对于代表块中心的偏移
            offsetY: bCy - repCy,   // 块顶部相对于代表块顶部的偏移
          };
        });
      }
    });
  }

  const { roots, childMap } = buildTree(blocks, connections, groups);
  const positionedGroups = new Set();

  // 布局每棵树
  let startX = 100;
  const startY = 100;

  for (const root of roots) {
    const tw = subtreeWidth(root.id, childMap, blockMap, groupMap);
    const rx = startX + tw / 2 - BLOCK_W / 2;
    layoutSubtree(root.id, rx, startY, childMap, blockMap, groupMap, positionedGroups);
    startX += tw + H_GAP * 2;
  }

  // 处理没有连接的孤立节点
  const positioned = new Set();
  for (const root of roots) {
    positioned.add(root.id);
    const walk = (id) => {
      (childMap[id] || []).forEach(cid => {
        positioned.add(cid);
        walk(cid);
      });
    };
    walk(root.id);
  }

  let orphanX = startX + 100;
  for (const b of blocks) {
    if (!positioned.has(b.id)) {
      if (!b.locked) {
        b.x = orphanX;
        b.y = startY;
      }
      orphanX += BLOCK_W + H_GAP;
    }
  }

  // 应用组内相对位置
  if (groups && groups.length > 0) {
    groups.forEach(group => {
      const offsets = groupInternalOffsets[group.id];
      if (offsets && offsets.length > 0) {
        // 找到代表块的新位置
        const representativeId = group.blockIds[0];
        const representative = blockMap[representativeId];
        if (representative) {
          const repCx = representative.x + (representative.width || BLOCK_W) / 2;
          const repCy = representative.y;

          // 应用偏移到组内所有块
          offsets.forEach(offset => {
            const b = blockMap[offset.id];
            if (b && b.id !== representativeId && !b.locked) {
              b.x = repCx + offset.offsetX - (b.width || BLOCK_W) / 2;
              b.y = repCy + offset.offsetY;
            }
          });
        }
      }
    });
  }
}

/**
 * 为新增节点找到一个不重叠的位置
 */
export function findFreePosition(blocks, parentId, connections) {
  // 找父节点
  const parent = blocks.find(b => b.id === parentId);
  if (!parent) {
    // 无父节点 → 放在右下角空白区
    const maxX = Math.max(100, ...blocks.map(b => b.x));
    const maxY = Math.max(100, ...blocks.map(b => b.y));
    return { x: maxX + BLOCK_W + H_GAP, y: 100 };
  }

  // 找已有兄弟节点
  const siblingIds = connections
    .filter(c => c.fromId === parentId)
    .map(c => c.toId);
  const siblings = blocks.filter(b => siblingIds.includes(b.id));

  if (siblings.length === 0) {
    // 第一个子节点 → 正下方
    return { x: parent.x, y: parent.y + BLOCK_H + V_GAP };
  }

  // 放在最右边兄弟的右侧
  const rightmost = siblings.reduce((a, b) => (a.x > b.x ? a : b));
  return { x: rightmost.x + BLOCK_W + H_GAP, y: rightmost.y };
}

/**
 * 计算画布内容的边界框（用于 fit-to-view）
 */
export function getBoundingBox(blocks, getBlockWidth) {
  if (blocks.length === 0) return { x: 0, y: 0, width: 800, height: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    const bw = getBlockWidth ? getBlockWidth(b) : (b.width || BLOCK_W);
    const bh = b.height || BLOCK_H;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + bw);
    maxY = Math.max(maxY, b.y + bh);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
