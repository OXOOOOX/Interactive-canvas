/**
 * layout.js — 分层布局算法 (Sugiyama-style Layered Layout)
 *
 * 核心思路：
 * 1. 分层：根据拓扑关系将块分配到不同层级
 * 2. 排序：每层内排序，最小化连线交叉
 * 3. 定位：计算 (x, y) 坐标，避免块重叠和连线穿块
 */

const BLOCK_W = 200;
const BLOCK_H = 72;
const MIN_H_GAP = 60;     // 最小水平间距
const MIN_V_GAP = 60;     // 最小垂直间距
const GAP_PER_CONNECTION = 15;  // 每多一个连接增加的间距
const MAX_H_GAP = 150;    // 最大水平间距
const MAX_V_GAP = 200;    // 最大垂直间距
const V_GAP_HEIGHT_RATIO = 0.5;  // 垂直间距与块高度的比例
const LAYOUT_BREATHING = 1.25;   // 全局宽度呼吸余量（1.0 = 紧凑; 1.25 = 有25%额外空间）

// ====== Two-Pass Layout 网格填充参数 ======
const GRID_H_GAP = 40;           // 叶子网格内水平间距
const GRID_V_GAP = 30;           // 叶子网格内垂直间距
const GRID_MAX_COLS = 3;         // 网格每行最大列数
const GRID_PARENT_OFFSET = 40;   // 网格与父节点底部的垂直偏移
const LEAF_CLUSTER_MIN = 3;      // 叶子聚类最小数量阈值

/**
 * 获取块的实际宽度
 */
function getBlockWidth(block) {
  return block.width || BLOCK_W;
}

/**
 * 获取块的实际高度
 */
function getBlockHeight(block) {
  return block.height || BLOCK_H;
}

/**
 * 计算智能水平间距
 * 根据块的连接数量动态调整
 */
function getSmartHGap(block, connections) {
  // 计算这个块的出度（作为父节点的次数）
  const outDegree = connections.filter(c => c.fromId === block.id).length;
  const gap = MIN_H_GAP + outDegree * GAP_PER_CONNECTION;
  return Math.min(gap, MAX_H_GAP);
}

/**
 * 计算智能垂直间距
 * 根据块的高度和连接复杂度动态调整
 */
function getSmartVGap(block, connections, nextLayerBlocks = []) {
  // 计算这个块的入度（作为子节点的次数）
  const inDegree = connections.filter(c => c.toId === block.id).length;
  const blockHeight = getBlockHeight(block);

  // 基础间距与块高度成正比（块越高，间距越大）
  const heightBasedGap = blockHeight * V_GAP_HEIGHT_RATIO;

  // 连接复杂度增加的间距
  const connectionGap = (inDegree - 1) * GAP_PER_CONNECTION * 2;

  const gap = MIN_V_GAP + heightBasedGap + connectionGap;
  return Math.min(Math.max(gap, MIN_V_GAP), MAX_V_GAP);
}

/**
 * 计算块的对齐位置
 * 让有多个父节点的块尽量在其父节点的平均位置下方，使连线更垂直
 */
function calculateTargetX(blockId, parentMap, blockMap) {
  const parents = parentMap[blockId] || [];
  if (parents.length === 0) return null;

  let sumX = 0;
  for (const pId of parents) {
    const parent = blockMap[pId];
    if (parent) {
      const pWidth = getBlockWidth(parent);
      sumX += parent.x + pWidth / 2;
    }
  }
  return sumX / parents.length;
}

/**
 * 计算每个块的层级（距离根节点的最短距离）
 */
function assignLayers(blocks, connections) {
  const blockMap = {};
  const childrenMap = {};
  const inDegree = {};
  const layer = {};

  for (const b of blocks) {
    blockMap[b.id] = b;
    childrenMap[b.id] = [];
    inDegree[b.id] = 0;
  }

  for (const conn of connections) {
    childrenMap[conn.fromId].push(conn.toId);
    inDegree[conn.toId]++;
  }

  // Kahn 算法进行拓扑排序和分层
  const queue = [];
  for (const b of blocks) {
    if (inDegree[b.id] === 0) {
      layer[b.id] = 0;
      queue.push(b.id);
    }
  }

  // 如果没有根节点（有环），所有节点从 layer 0 开始
  if (queue.length === 0) {
    for (const b of blocks) {
      layer[b.id] = 0;
      queue.push(b.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const childId of childrenMap[current]) {
      // 子的层级 = max(子的当前层级，父的层级 + 1)
      layer[childId] = Math.max(layer[childId] || 0, layer[current] + 1);
      inDegree[childId]--;
      if (inDegree[childId] === 0) {
        queue.push(childId);
      }
    }
  }

  return { layer, childrenMap, inDegree };
}

/**
 * 插入跨层虚拟节点，给两层间以上的连线在中间层占位
 */
function insertVirtualNodes(blocks, connections, layerMap) {
  const newBlocks = [...blocks];
  const newConnections = [];
  let virtualNodeCounter = 0;

  for (const conn of connections) {
    const fromLayer = layerMap[conn.fromId];
    const toLayer = layerMap[conn.toId];

    if (toLayer !== undefined && fromLayer !== undefined && toLayer - fromLayer > 1) {
      let currentId = conn.fromId;
      for (let l = fromLayer + 1; l < toLayer; l++) {
        const vId = `vnode_${conn.id}_${l}_${virtualNodeCounter++}`;
        const vBlock = { id: vId, width: 10, height: 10, isVirtual: true, text: '' };
        newBlocks.push(vBlock);
        layerMap[vId] = l;
        newConnections.push({
          id: `vconn_${currentId}_${vId}`,
          fromId: currentId,
          toId: vId,
          isVirtual: true,
          originalConnId: conn.id
        });
        currentId = vId;
      }
      newConnections.push({
        id: `vconn_${currentId}_${conn.toId}`,
        fromId: currentId,
        toId: conn.toId,
        isVirtual: true,
        originalConnId: conn.id
      });
    } else {
      newConnections.push(conn);
    }
  }

  return { activeBlocks: newBlocks, activeConnections: newConnections };
}

/**
 * 移除虚拟节点，供定位结束后打扫战场之用
 */
function removeVirtualNodes(blocks, originalConnections) {
  const finalBlocks = blocks.filter(b => !b.isVirtual);
  return { finalBlocks, finalConnections: originalConnections };
}

/**
 * 双向多轮迭代 Barycenter 重心分层排序算法
 */
function countTotalCrossings(orderedLayers, connections) {
  let crossings = 0;
  const layers = Object.keys(orderedLayers).map(Number).sort((a, b) => a - b);

  for (let i = 0; i < layers.length - 1; i++) {
    const layer1 = orderedLayers[layers[i]];
    const layer2 = orderedLayers[layers[i + 1]];

    const edges = connections.filter(c => layer1.includes(c.fromId) && layer2.includes(c.toId));

    for (let e1 = 0; e1 < edges.length; e1++) {
      for (let e2 = e1 + 1; e2 < edges.length; e2++) {
        const u1 = layer1.indexOf(edges[e1].fromId);
        const v1 = layer2.indexOf(edges[e1].toId);
        const u2 = layer1.indexOf(edges[e2].fromId);
        const v2 = layer2.indexOf(edges[e2].toId);

        if ((u1 < u2 && v1 > v2) || (u1 > u2 && v1 < v2)) {
          crossings++;
        }
      }
    }
  }
  return crossings;
}

function barycentricSort(blocks, connections, layerMap) {
  const layers = {};
  for (const b of blocks) {
    const l = layerMap[b.id];
    if (!layers[l]) layers[l] = [];
    layers[l].push(b.id);
  }

  const parentMap = {};
  const childrenMap = {};
  blocks.forEach(b => { parentMap[b.id] = []; childrenMap[b.id] = []; });
  connections.forEach(c => {
    parentMap[c.toId].push(c.fromId);
    childrenMap[c.fromId].push(c.toId);
  });

  const layerNumbers = Object.keys(layers).map(Number).sort((a, b) => a - b);

  const subtreeSizes = {};
  const calcSubtree = (id, visited = new Set()) => {
    if (subtreeSizes[id] !== undefined) return subtreeSizes[id];
    if (visited.has(id)) return 1;
    visited.add(id);
    let size = 1;
    for (const childId of childrenMap[id]) {
      size += calcSubtree(childId, visited);
    }
    visited.delete(id);
    subtreeSizes[id] = size;
    return size;
  };
  blocks.forEach(b => calcSubtree(b.id));

  for (const l of layerNumbers) {
    if (layers[l]) {
      layers[l].sort((a, b) => subtreeSizes[b] - subtreeSizes[a]);
      const newLayer = [];
      let left = true;
      for (const id of layers[l]) {
        if (left) newLayer.push(id);
        else newLayer.unshift(id);
        left = !left;
      }
      layers[l] = newLayer;
    }
  }

  let bestLayers = JSON.parse(JSON.stringify(layers));
  let minCrossings = countTotalCrossings(bestLayers, connections);
  if (minCrossings === 0) return bestLayers;

  const MAX_ITERATIONS = 6;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const currentLayers = JSON.parse(JSON.stringify(bestLayers));

    for (let i = 1; i < layerNumbers.length; i++) {
      const l = layerNumbers[i];
      const prevLayer = currentLayers[layerNumbers[i - 1]] || [];
      const positions = {};

      for (const id of currentLayers[l]) {
        const parents = parentMap[id];
        let sum = 0, count = 0;
        for (const p of parents) {
          const idx = prevLayer.indexOf(p);
          if (idx !== -1) { sum += idx; count++; }
        }
        positions[id] = count > 0 ? sum / count : (prevLayer.length > 0 ? (prevLayer.length - 1) / 2 : 0);
      }
      currentLayers[l].sort((a, b) => positions[a] - positions[b]);
    }

    let downCrossings = countTotalCrossings(currentLayers, connections);
    if (downCrossings < minCrossings) {
      minCrossings = downCrossings;
      bestLayers = JSON.parse(JSON.stringify(currentLayers));
    }

    for (let i = layerNumbers.length - 2; i >= 0; i--) {
      const l = layerNumbers[i];
      const nextLayer = currentLayers[layerNumbers[i + 1]] || [];
      const positions = {};

      for (const id of currentLayers[l]) {
        const children = childrenMap[id];
        let sum = 0, count = 0;
        for (const c of children) {
          const idx = nextLayer.indexOf(c);
          if (idx !== -1) { sum += idx; count++; }
        }
        positions[id] = count > 0 ? sum / count : (nextLayer.length > 0 ? (nextLayer.length - 1) / 2 : 0);
      }
      currentLayers[l].sort((a, b) => positions[a] - positions[b]);
    }

    let upCrossings = countTotalCrossings(currentLayers, connections);
    if (upCrossings < minCrossings) {
      minCrossings = upCrossings;
      bestLayers = JSON.parse(JSON.stringify(currentLayers));
    } else if (upCrossings === downCrossings && upCrossings >= minCrossings) {
      break;
    }
  }

  return bestLayers;
}


/**
 * 将叶子节点重排到每层外侧
 * 规则：同一父节点的子节点中，无后续子节点的叶子放到远离图中心的一侧
 * - 父节点在层中心偏左 → 叶子放兄弟组最左侧（向外扩散）
 * - 父节点在层中心偏右 → 叶子放兄弟组最右侧（向外扩散）
 * - 父节点在层正中 → 叶子对半分到两侧
 */
function reorderLeavesToOuterSide(orderedLayers, connections, blocks) {
  // 构建虚拟节点集合
  const virtualIds = new Set(blocks.filter(b => b.isVirtual).map(b => b.id));

  // 构建出度和父节点映射
  const outDegree = {};
  const parentOf = {};
  for (const ids of Object.values(orderedLayers)) {
    for (const id of ids) {
      outDegree[id] = 0;
      if (!parentOf[id]) parentOf[id] = [];
    }
  }
  for (const conn of connections) {
    if (outDegree[conn.fromId] !== undefined) outDegree[conn.fromId]++;
    if (parentOf[conn.toId]) parentOf[conn.toId].push(conn.fromId);
  }

  const layerNums = Object.keys(orderedLayers).map(Number).sort((a, b) => a - b);

  for (let li = 1; li < layerNums.length; li++) {
    const l = layerNums[li];
    const prevL = layerNums[li - 1];
    const prevLayer = orderedLayers[prevL] || [];
    const layer = orderedLayers[l];

    if (!layer || layer.length <= 2) continue;

    // 上一层位置索引
    const parentPosMap = {};
    prevLayer.forEach((id, idx) => { parentPosMap[id] = idx; });
    const prevCenter = (prevLayer.length - 1) / 2;

    // 按主要父节点分组，保持层内原有相对顺序
    const visited = new Set();
    const groupKeys = [];
    const groups = {};

    for (const id of layer) {
      const pids = parentOf[id] || [];
      const key = pids.length > 0 ? pids[0] : '_orphan';
      if (!visited.has(key)) {
        visited.add(key);
        groupKeys.push(key);
        groups[key] = [];
      }
      groups[key].push(id);
    }

    const newLayer = [];
    for (const key of groupKeys) {
      const nodes = groups[key];
      if (nodes.length <= 1) {
        newLayer.push(...nodes);
        continue;
      }

      // 叶子 = 出度为0 且非虚拟节点
      const leaves = nodes.filter(id => outDegree[id] === 0 && !virtualIds.has(id));
      const cores = nodes.filter(id => outDegree[id] > 0 || virtualIds.has(id));

      if (leaves.length === 0 || cores.length === 0) {
        newLayer.push(...nodes);
        continue;
      }

      // 根据父节点在上层的序位判断外侧方向
      const parentIdx = (key !== '_orphan' && parentPosMap[key] !== undefined)
        ? parentPosMap[key]
        : prevCenter;

      if (parentIdx < prevCenter - 0.01) {
        // 父节点偏左 → 叶子放最左侧（向外扩散）
        newLayer.push(...leaves, ...cores);
      } else if (parentIdx > prevCenter + 0.01) {
        // 父节点偏右 → 叶子放最右侧（向外扩散）
        newLayer.push(...cores, ...leaves);
      } else {
        // 父节点居中 → 叶子对半分到两侧
        const half = Math.ceil(leaves.length / 2);
        newLayer.push(...leaves.slice(0, half), ...cores, ...leaves.slice(half));
      }
    }

    orderedLayers[l] = newLayer;
  }
}


/**
 * 计算块的实际位置
 * 策略：
 * 1. 同属一个（或一组）父节点的兄弟节点，形成一个 Cluster。
 * 2. Cluster 的期望中心（targetCx）为父节点的平均中心位置。
 * 3. 按照 targetCx 分布 Cluster。如果 Cluster 之间发生重叠，则合并 Cluster 并重新分配空间。
 * 4. Cluster 内部按照顺序排布节点，主线节点天然会落在 Cluster 中央，正对父节点（形成“爪状”）。
 */
function positionBlocks(blocks, connections, orderedLayers, layerMap) {
  const blockMap = {};
  for (const b of blocks) {
    blockMap[b.id] = b;
  }

  const layerNumbers = Object.keys(orderedLayers).map(Number).sort((a, b) => a - b);
  let currentY = 80;

  // 构建父子映射
  const parentMap = {};
  blocks.forEach(b => { parentMap[b.id] = []; });
  connections.forEach(c => {
    if (parentMap[c.toId]) parentMap[c.toId].push(c.fromId);
  });

  // 获取期望居中位置
  function getTargetInfo(id) {
    const parents = parentMap[id] || [];
    let sumCx = 0; let counted = 0;
    for (const p of parents) {
      if (blockMap[p] && blockMap[p].x !== undefined) {
        sumCx += blockMap[p].x + getBlockWidth(blockMap[p]) / 2;
        counted++;
      }
    }
    return {
      targetCx: counted > 0 ? sumCx / counted : null,
      parentIds: new Set(parents)
    };
  }

  for (const l of layerNumbers) {
    const blockIds = orderedLayers[l];
    const realBlockIds = blockIds.filter(id => blockMap[id]);

    let maxHeight = 0;
    let maxVGap = MIN_V_GAP;
    for (const id of realBlockIds) {
      const block = blockMap[id];
      const bh = getBlockHeight(block);
      const vGap = getSmartVGap(block, connections);
      if (bh > maxHeight) maxHeight = bh;
      if (vGap > maxVGap) maxVGap = vGap;
    }

    if (realBlockIds.length === 0) {
      currentY += maxHeight + maxVGap;
      continue;
    }

    // 1. 初始化每个节点为独立的 Cluster
    let clusters = realBlockIds.map(id => {
      const w = getBlockWidth(blockMap[id]);
      const info = getTargetInfo(id);
      return {
        nodes: [id],
        width: w,
        targetCx: info.targetCx,
        parentIds: info.parentIds
      };
    });

    // 2. 对于没有父节点（targetCx 为 null）的根层分配大致距离
    const defaultGap = 300;
    let noTargetCount = clusters.filter(c => c.targetCx === null).length;
    let curX = - ((noTargetCount - 1) * defaultGap) / 2;
    clusters.forEach(c => {
      if (c.targetCx === null) {
        c.targetCx = curX;
        curX += defaultGap;
      }
    });

    // 3. 处理 Cluster 间的重叠，如有重叠则合并
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < clusters.length - 1; i++) {
        const c1 = clusters[i];
        const c2 = clusters[i + 1];

        const right1 = c1.targetCx - c1.width / 2 + c1.width;
        const left2 = c2.targetCx - c2.width / 2;

        const lastNodeId = c1.nodes[c1.nodes.length - 1];
        const firstNodeId = c2.nodes[0];
        let gap = Math.max(getSmartHGap(blockMap[lastNodeId], connections), getSmartHGap(blockMap[firstNodeId], connections));

        let sharedParent = false;
        c1.parentIds.forEach(p => { if (c2.parentIds.has(p)) sharedParent = true; });
        if (!sharedParent || (c1.parentIds.size === 0 && c2.parentIds.size === 0)) {
          gap += 100; // 跨分支时增加额外呼吸余量
        }

        if (right1 + gap > left2) {
          const totalWidth = c1.width + gap + c2.width;
          // 重心偏移混合
          const newTargetCx = (c1.targetCx * c1.width + c2.targetCx * c2.width) / (c1.width + c2.width);

          const mergedParents = new Set([...c1.parentIds, ...c2.parentIds]);

          clusters.splice(i, 2, {
            nodes: [...c1.nodes, ...c2.nodes],
            width: totalWidth,
            targetCx: newTargetCx,
            parentIds: mergedParents
          });
          merged = true;
          break;
        }
      }
    }

    // 4. 定位并分配各个节点实际 X 坐标
    for (const c of clusters) {
      let startX = c.targetCx - c.width / 2;
      for (let i = 0; i < c.nodes.length; i++) {
        const id = c.nodes[i];
        const block = blockMap[id];
        if (!block.locked) {
          block.x = startX;
          block.y = currentY;
        }
        startX += getBlockWidth(block);
        if (i < c.nodes.length - 1) {
          const nextId = c.nodes[i + 1];
          let gap = Math.max(getSmartHGap(block, connections), getSmartHGap(blockMap[nextId], connections));
          let sharedParent = false;
          const myParents = parentMap[id] || [];
          const nextParents = parentMap[nextId] || [];
          myParents.forEach(p => { if (nextParents.includes(p)) sharedParent = true; });
          if (!sharedParent || (myParents.length === 0 && nextParents.length === 0)) {
            gap += 100;
          }
          startX += gap;
        }
      }
    }

    currentY += maxHeight + maxVGap;
  }

  // 最终：确保所有节点 x >= 100
  let minX = Infinity;
  for (const b of blocks) {
    if (b.x !== undefined && b.x < minX) minX = b.x;
  }
  if (minX < 100) {
    const offset = 100 - minX;
    for (const b of blocks) {
      if (!b.locked && b.x !== undefined) {
        b.x += offset;
      }
    }
  }
}


/**
 * 检测并修复连线穿块问题（增强版）
 * 策略：
 * 1. 对每条连线，计算实际渲染路径（含贝塞尔曲线弯曲范围）
 * 2. 检测该路径是否穿过其他块（含外扩 padding）
 * 3. 优先水平推开被穿越的块，推不动则垂直下移目标块
 * 4. 迭代多轮以处理级联碰撞
 */
function avoidBlockCrossing(blocks, connections) {
  const blockMap = {};
  for (const b of blocks) {
    blockMap[b.id] = b;
  }

  // 构建父节点多子映射，用于计算汇聚点
  const childrenMap = {};
  for (const b of blocks) childrenMap[b.id] = [];
  for (const c of connections) {
    if (childrenMap[c.fromId]) childrenMap[c.fromId].push(c.toId);
  }

  const LINE_PADDING = 30; // 连线到块的最小安全距离

  // 迭代多轮
  for (let iter = 0; iter < 3; iter++) {
    const yAdjustments = {};
    const xAdjustments = {};
    let hasCollision = false;

    for (const conn of connections) {
      const from = blockMap[conn.fromId];
      const to = blockMap[conn.toId];
      if (!from || !to) continue;
      if (from.isVirtual || to.isVirtual) continue;

      const fromWidth = getBlockWidth(from);
      const fromHeight = getBlockHeight(from);
      const toWidth = getBlockWidth(to);

      const fromCenterX = from.x + fromWidth / 2;
      const fromBottomY = from.y + fromHeight;
      const toCenterX = to.x + toWidth / 2;
      const toTopY = to.y;

      // 跳过同层或反向连线
      if (toTopY <= fromBottomY) continue;

      // 计算实际渲染曲线的水平扫掠范围
      // 贝塞尔曲线 M(fromCx, fromBottom) C(fromCx, midY, toCx, midY, toCx, toTop)
      // 曲线的水平范围在 fromCx 和 toCx 之间，还会略微超出
      const curveLeft = Math.min(fromCenterX, toCenterX) - LINE_PADDING;
      const curveRight = Math.max(fromCenterX, toCenterX) + LINE_PADDING;

      // 对曲线采样，得到更精确的扫掠范围
      const midY = (fromBottomY + toTopY) / 2;
      let sweepLeft = Math.min(fromCenterX, toCenterX);
      let sweepRight = Math.max(fromCenterX, toCenterX);
      for (let t = 0; t <= 1.0; t += 0.1) {
        const mt = 1 - t;
        // 三次贝塞尔 x: P0=fromCx, P1=fromCx, P2=toCx, P3=toCx
        const bx = mt * mt * mt * fromCenterX + 3 * mt * mt * t * fromCenterX +
                    3 * mt * t * t * toCenterX + t * t * t * toCenterX;
        sweepLeft = Math.min(sweepLeft, bx);
        sweepRight = Math.max(sweepRight, bx);
      }
      const lineLeft = sweepLeft - LINE_PADDING;
      const lineRight = sweepRight + LINE_PADDING;

      // 检查这条连线是否穿过其他块
      for (const other of blocks) {
        if (other.id === from.id || other.id === to.id) continue;
        if (other.isVirtual) continue;

        const otherWidth = getBlockWidth(other);
        const otherHeight = getBlockHeight(other);
        const otherLeft = other.x;
        const otherRight = other.x + otherWidth;
        const otherTop = other.y;
        const otherBottom = other.y + otherHeight;

        // 检测块是否在连线的垂直范围内（含 padding）
        const inVerticalRange = otherTop > (fromBottomY - 5) && otherBottom < (toTopY + 5);
        if (!inVerticalRange) continue;

        // 检测块是否与连线水平扫掠范围重叠
        const overlapH = otherLeft < lineRight && otherRight > lineLeft;
        if (!overlapH) continue;

        hasCollision = true;

        // 尝试水平移动中间的块
        // 计算最小移动距离：将块推到扫掠范围外
        const pushLeft = lineLeft - otherRight;     // 推到左侧需要的距离（负值=往左）
        const pushRight = lineRight - otherLeft;    // 推到右侧需要的距离（正值=往右）

        const distToLeft = Math.abs(pushLeft);
        const distToRight = Math.abs(pushRight);
        const moveDir = distToLeft < distToRight ? -1 : 1;
        const moveDistance = (moveDir < 0 ? distToLeft : distToRight) + MIN_H_GAP;

        const targetX = other.x + moveDir * moveDistance;

        // 检查目标位置是否可行（不与其他块重叠）
        let canMove = true;
        for (const check of blocks) {
          if (check.id === other.id) continue;
          if (check.isVirtual) continue;
          const checkLeft = check.x;
          const checkRight = check.x + getBlockWidth(check);
          const checkTop = check.y;
          const checkBottom = check.y + getBlockHeight(check);
          const newOtherLeft = targetX;
          const newOtherRight = targetX + otherWidth;

          // 同行检测（y 方向有重叠）
          if (otherTop < checkBottom && otherBottom > checkTop) {
            if (newOtherLeft < checkRight + MIN_H_GAP / 2 &&
                newOtherRight > checkLeft - MIN_H_GAP / 2) {
              canMove = false;
              break;
            }
          }
        }

        if (canMove && xAdjustments[other.id] === undefined) {
          xAdjustments[other.id] = targetX;
        } else {
          // 无法水平移动，垂直调整目标块
          if (!yAdjustments[to.id]) {
            yAdjustments[to.id] = 0;
          }
          const smartVGap = getSmartVGap(to, connections);
          yAdjustments[to.id] = Math.max(yAdjustments[to.id],
            otherBottom - toTopY + smartVGap);
        }
      }
    }

    // 应用垂直调整
    for (const [id, offset] of Object.entries(yAdjustments)) {
      const block = blockMap[id];
      if (block && !block.locked) {
        block.y += offset;
      }
    }

    // 应用水平调整
    for (const [id, targetX] of Object.entries(xAdjustments)) {
      const block = blockMap[id];
      if (block && !block.locked) {
        block.x = targetX;
      }
    }

    // 如果本轮没有碰撞，提前退出
    if (!hasCollision) break;
  }
}

/**
 * ====== Two-Pass Layout 辅助函数 ======
 */

/**
 * 识别纯叶子挂载组
 * 找到所有出度为 0 的叶子节点，按单一父节点分组
 * 仅返回满足阈值（≥ LEAF_CLUSTER_MIN）的组
 */
function identifyLeafClusters(blocks, connections) {
  const outDegree = {};
  const parentOf = {};
  for (const b of blocks) {
    outDegree[b.id] = 0;
    parentOf[b.id] = [];
  }
  for (const conn of connections) {
    outDegree[conn.fromId] = (outDegree[conn.fromId] || 0) + 1;
    if (parentOf[conn.toId]) parentOf[conn.toId].push(conn.fromId);
  }

  // 按父节点分组叶子（仅单父叶子参与聚类）
  const leafGroups = {};
  for (const b of blocks) {
    if (outDegree[b.id] === 0 && parentOf[b.id].length === 1) {
      const pid = parentOf[b.id][0];
      if (!leafGroups[pid]) leafGroups[pid] = [];
      leafGroups[pid].push(b.id);
    }
  }

  // 过滤：只保留 >= 阈值的组
  const clusters = {};
  for (const [pid, leafIds] of Object.entries(leafGroups)) {
    if (leafIds.length >= LEAF_CLUSTER_MIN) {
      clusters[pid] = leafIds;
    }
  }
  return clusters;
}

/**
 * 将叶子聚类编排为网格矩阵，安置在父节点下方空隙中
 * - 无核心子线时：网格居中于父节点正下方
 * - 有核心子线时：网格偏移至核心子树的对侧空隙
 */
function placeLeafGrids(allBlocks, originalConnections, clusters, blockMap) {
  // 构建原始子节点映射
  const childrenMap = {};
  for (const b of allBlocks) childrenMap[b.id] = [];
  for (const conn of originalConnections) {
    if (childrenMap[conn.fromId]) childrenMap[conn.fromId].push(conn.toId);
  }

  const strippedIds = new Set();
  for (const leafIds of Object.values(clusters)) {
    leafIds.forEach(id => strippedIds.add(id));
  }

  // 计算骨架重心 X（用于判断外侧方向）
  let graphCenterX = 0, skelCount = 0;
  for (const b of allBlocks) {
    if (!strippedIds.has(b.id) && !b.isVirtual && b.x !== undefined) {
      graphCenterX += b.x + getBlockWidth(b) / 2;
      skelCount++;
    }
  }
  if (skelCount > 0) graphCenterX /= skelCount;

  for (const [parentId, leafIds] of Object.entries(clusters)) {
    const parent = blockMap[parentId];
    if (!parent || parent.x === undefined) continue;

    const parentW = getBlockWidth(parent);
    const parentH = getBlockHeight(parent);
    const parentCx = parent.x + parentW / 2;
    const gridTop = parent.y + parentH + GRID_PARENT_OFFSET;

    // 计算网格尺寸
    const cols = Math.min(leafIds.length, GRID_MAX_COLS);
    const maxLeafW = Math.max(...leafIds.map(id => getBlockWidth(blockMap[id])));
    const leafH = Math.max(...leafIds.map(id => getBlockHeight(blockMap[id])));
    const gridW = cols * maxLeafW + (cols - 1) * GRID_H_GAP;

    // 核心子节点边界
    const coreChildren = (childrenMap[parentId] || []).filter(cid => !strippedIds.has(cid));
    let coreMinX = Infinity, coreMaxX = -Infinity;
    for (const cid of coreChildren) {
      const cb = blockMap[cid];
      if (cb && cb.x !== undefined) {
        coreMinX = Math.min(coreMinX, cb.x);
        coreMaxX = Math.max(coreMaxX, cb.x + getBlockWidth(cb));
      }
    }

    // 网格放置方向：始终朝图的外侧
    let gridCx;
    const outerOffset = gridW / 2 + 40;

    if (parentCx < graphCenterX - 30) {
      // 父节点偏左 → 网格往更左放（外侧）
      gridCx = parentCx - outerOffset;
      if (coreMinX !== Infinity) {
        gridCx = Math.min(gridCx, coreMinX - gridW / 2 - 40);
      }
    } else if (parentCx > graphCenterX + 30) {
      // 父节点偏右 → 网格往更右放（外侧）
      gridCx = parentCx + outerOffset;
      if (coreMaxX !== -Infinity) {
        gridCx = Math.max(gridCx, coreMaxX + gridW / 2 + 40);
      }
    } else {
      // 父节点居中
      if (coreChildren.length === 0) {
        gridCx = parentCx;
      } else {
        const coreCx = (coreMinX + coreMaxX) / 2;
        if (coreCx >= parentCx) {
          gridCx = coreMinX - gridW / 2 - 40;
        } else {
          gridCx = coreMaxX + gridW / 2 + 40;
        }
      }
    }

    // 将每个叶子放置到网格中
    const gridLeft = gridCx - gridW / 2;
    for (let i = 0; i < leafIds.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const leaf = blockMap[leafIds[i]];
      if (leaf && !leaf.locked) {
        leaf.x = gridLeft + col * (maxLeafW + GRID_H_GAP);
        leaf.y = gridTop + row * (leafH + GRID_V_GAP);
      }
    }
  }
}

/**
 * 碰撞微调：检查网格叶子与骨架节点重叠
 * 增强：水平朝外侧推开 + 不同聚类组间碰撞检测
 */
function resolveGridCollisions(blocks, clusters, blockMap) {
  const strippedIds = new Set();
  for (const leafIds of Object.values(clusters)) {
    leafIds.forEach(id => strippedIds.add(id));
  }

  const skeletonBlocks = blocks.filter(b => !strippedIds.has(b.id) && !b.isVirtual && b.x !== undefined);
  const COLLISION_PADDING = 25;

  // 骨架重心
  let graphCenterX = 0, skelCount = 0;
  for (const sb of skeletonBlocks) {
    graphCenterX += sb.x + getBlockWidth(sb) / 2;
    skelCount++;
  }
  if (skelCount > 0) graphCenterX /= skelCount;

  // 逐聚类检查与骨架的碰撞
  for (const [parentId, leafIds] of Object.entries(clusters)) {
    const parent = blockMap[parentId];
    if (!parent || parent.x === undefined) continue;
    const parentCx = parent.x + getBlockWidth(parent) / 2;
    const outerDir = parentCx < graphCenterX ? -1 : 1;

    for (const leafId of leafIds) {
      const gb = blockMap[leafId];
      if (!gb || gb.locked || gb.x === undefined) continue;
      const gbW = getBlockWidth(gb);
      const gbH = getBlockHeight(gb);

      for (const sb of skeletonBlocks) {
        const sbW = getBlockWidth(sb);
        const sbH = getBlockHeight(sb);
        const overlapX = gb.x < sb.x + sbW + COLLISION_PADDING && gb.x + gbW + COLLISION_PADDING > sb.x;
        const overlapY = gb.y < sb.y + sbH + COLLISION_PADDING && gb.y + gbH + COLLISION_PADDING > sb.y;

        if (overlapX && overlapY) {
          // 按外侧方向水平位移（而非只是下移）
          if (outerDir < 0) {
            gb.x = sb.x - gbW - COLLISION_PADDING;
          } else {
            gb.x = sb.x + sbW + COLLISION_PADDING;
          }
        }
      }
    }
  }

  // 不同聚类组间碰撞
  const clusterKeys = Object.keys(clusters);
  for (let i = 0; i < clusterKeys.length; i++) {
    for (let j = i + 1; j < clusterKeys.length; j++) {
      for (const id1 of clusters[clusterKeys[i]]) {
        const b1 = blockMap[id1];
        if (!b1 || b1.x === undefined) continue;
        for (const id2 of clusters[clusterKeys[j]]) {
          const b2 = blockMap[id2];
          if (!b2 || b2.x === undefined) continue;
          const w1 = getBlockWidth(b1), h1 = getBlockHeight(b1);
          const w2 = getBlockWidth(b2), h2 = getBlockHeight(b2);
          const overlapX = b1.x < b2.x + w2 + COLLISION_PADDING && b1.x + w1 + COLLISION_PADDING > b2.x;
          const overlapY = b1.y < b2.y + h2 + COLLISION_PADDING && b1.y + h1 + COLLISION_PADDING > b2.y;
          if (overlapX && overlapY) {
            if (b1.y > b2.y) {
              b1.y = b2.y + h2 + COLLISION_PADDING;
            } else {
              b2.y = b1.y + h1 + COLLISION_PADDING;
            }
          }
        }
      }
    }
  }
}

/**
 * 主函数：执行完整的分层布局（Two-Pass: 骨架优先 + 叶子网格填充）
 */
export function autoLayout(blocks, connections, groups = []) {
  if (blocks.length === 0) return;

  const originalConnections = connections;
  const blockMap = {};
  for (const b of blocks) blockMap[b.id] = b;

  // ====== Two-Pass Layout: Pass 1 — 剥离叶子，布局骨架 ======

  // 1. 识别叶子聚类（≥3 个纯叶子挂载在同一父节点下）
  const leafClusters = identifyLeafClusters(blocks, connections);
  const strippedLeafIds = new Set();
  for (const leafIds of Object.values(leafClusters)) {
    leafIds.forEach(id => strippedLeafIds.add(id));
  }

  console.log(`=== Two-Pass Layout ===`);
  console.log(`剥离叶子聚类: ${Object.keys(leafClusters).length} 组, 共 ${strippedLeafIds.size} 个叶子`);

  // 2. 生成骨架（剥离叶子后的块和连线）
  const skeletonBlocks = blocks.filter(b => !strippedLeafIds.has(b.id));
  const skeletonConnections = connections.filter(
    c => !strippedLeafIds.has(c.toId) && !strippedLeafIds.has(c.fromId)
  );

  // 3. 分层（仅骨架）
  const { layer } = assignLayers(skeletonBlocks, skeletonConnections);

  // 4. 插入虚拟节点以撑开跨层连线空间
  const { activeBlocks, activeConnections } = insertVirtualNodes(skeletonBlocks, skeletonConnections, layer);

  // 5. Barycenter 迭代排序（层内排序）
  const orderedLayers = barycentricSort(activeBlocks, activeConnections, layer);

  // 5.5 叶子外移：将无后续子节点的叶子排到各层外侧
  reorderLeavesToOuterSide(orderedLayers, activeConnections, activeBlocks);

  // 调试输出
  console.log('=== Barycenter 优化布局结果 ===');
  for (const [layerNum, blockIds] of Object.entries(orderedLayers)) {
    console.log(`Layer ${layerNum}: [${blockIds.length} nodes]`);
  }
  const minCrossings = countTotalCrossings(orderedLayers, activeConnections);
  console.log(`Barycenter 总计连线交叉: ${minCrossings}`);

  // 6. 定位骨架
  positionBlocks(activeBlocks, activeConnections, orderedLayers, layer);

  // 7. 避免穿块
  avoidBlockCrossing(activeBlocks, activeConnections);

  // ====== Two-Pass Layout: Pass 2 — 叶子网格填充 ======
  if (strippedLeafIds.size > 0) {
    console.log(`=== Pass 2: 安置 ${strippedLeafIds.size} 个叶子到网格 ===`);
    placeLeafGrids(blocks, originalConnections, leafClusters, blockMap);
    resolveGridCollisions(blocks, leafClusters, blockMap);
  }

  // 8. 处理组的相对位置
  const groupMap = {};
  if (groups && groups.length > 0) {
    groups.forEach(group => {
      const representativeId = group.blockIds[0];
      groupMap[representativeId] = group;
    });

    groups.forEach(group => {
      const representative = blockMap[group.blockIds[0]];
      if (representative) {
        const repWidth = getBlockWidth(representative);
        const repCx = representative.x + repWidth / 2;
        const repCy = representative.y;

        const baseOffsets = {};
        group.blockIds.forEach(id => {
          const b = blockMap[id];
          if (b) {
            const bWidth = getBlockWidth(b);
            baseOffsets[id] = {
              offsetX: b.x + bWidth / 2 - repCx,
              offsetY: b.y - repCy
            };
          }
        });

        group.blockIds.forEach(id => {
          const b = blockMap[id];
          const offset = baseOffsets[id];
          if (b && offset && b.id !== group.blockIds[0] && !b.locked) {
            const bWidth = getBlockWidth(b);
            b.x = repCx + offset.offsetX - bWidth / 2;
            b.y = repCy + offset.offsetY;
          }
        });
      }
    });
  }

  // 9. 脱掉马甲，清理虚拟节点
  removeVirtualNodes(activeBlocks, originalConnections);
}


/**
 * 为新增节点找到一个不重叠的位置
 */
export function findFreePosition(blocks, parentId, connections) {
  const parent = blocks.find(b => b.id === parentId);
  if (!parent) {
    const maxX = Math.max(100, ...blocks.map(b => b.x));
    const maxY = Math.max(100, ...blocks.map(b => b.y));
    const parentW = parent ? getBlockWidth(parent) : BLOCK_W;
    return { x: maxX + parentW + MIN_H_GAP, y: 100 };
  }

  const parentHeight = getBlockHeight(parent);
  const siblingIds = connections
    .filter(c => c.fromId === parentId)
    .map(c => c.toId);
  const siblings = blocks.filter(b => siblingIds.includes(b.id));

  if (siblings.length === 0) {
    const vGap = getSmartVGap(parent, connections);
    return { x: parent.x, y: parent.y + parentHeight + vGap };
  }

  const rightmost = siblings.reduce((a, b) => (a.x > b.x ? a : b));
  const rightmostWidth = getBlockWidth(rightmost);
  const hGap = getSmartHGap(rightmost, connections);
  return { x: rightmost.x + rightmostWidth + hGap, y: rightmost.y };
}

/**
 * 计算边界框
 */
export function getBoundingBox(blocks, customGetWidth) {
  if (blocks.length === 0) return { x: 0, y: 0, width: 800, height: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    const bw = customGetWidth ? customGetWidth(b) : getBlockWidth(b);
    const bh = b.height || BLOCK_H;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + bw);
    maxY = Math.max(maxY, b.y + bh);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 导出画布数据结构（用于调试和分析）
 * 在浏览器控制台运行：copyWindow.exportCanvasData()
 */
export function exportCanvasData(blocks, connections, groups) {
  const blockMap = {};
  for (const b of blocks) {
    blockMap[b.id] = b;
  }

  // 计算每个块的层级
  const { layer } = assignLayers(blocks, connections);

  // 计算每个块的入度和出度
  const inDegree = {};
  const outDegree = {};
  for (const b of blocks) {
    inDegree[b.id] = 0;
    outDegree[b.id] = 0;
  }
  for (const conn of connections) {
    inDegree[conn.toId] = (inDegree[conn.toId] || 0) + 1;
    outDegree[conn.fromId] = (outDegree[conn.fromId] || 0) + 1;
  }

  const data = {
    summary: {
      totalBlocks: blocks.length,
      totalConnections: connections.length,
      totalGroups: groups.length,
      maxLayer: Math.max(...Object.values(layer)),
    },
    blocks: blocks.map(b => ({
      id: b.id,
      text: b.text?.substring(0, 50) || '',
      layer: layer[b.id],
      inDegree: inDegree[b.id],
      outDegree: outDegree[b.id],
      width: b.width || BLOCK_W,
      height: b.height || BLOCK_H,
      x: b.x,
      y: b.y,
    })),
    connections: connections.map(c => ({
      id: c.id,
      fromId: c.fromId,
      toId: c.toId,
    })),
    // 按层级分组
    layers: {},
  };

  // 按层级组织块
  for (const [blockId, layerNum] of Object.entries(layer)) {
    if (!data.layers[layerNum]) {
      data.layers[layerNum] = [];
    }
    data.layers[layerNum].push(blockId);
  }

  return data;
}
