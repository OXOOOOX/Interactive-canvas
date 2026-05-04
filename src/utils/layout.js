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
const ROUTING_RAIL_TO_CHILD_GAP = 96;
const ROUTING_PARENT_TO_RAIL_MIN_GAP = 36;
const ROUTING_RAIL_TO_CHILD_MIN_GAP = 18;
const TALL_LEAF_HEIGHT_THRESHOLD = 500;
const TALL_LEAF_OFFSET = 60;
const LEAF_DIMENSION_SIMILARITY_THRESHOLD = 1.2;
const PORTRAIT_RATIO_THRESHOLD = 5;
const PORTRAIT_TARGET_RATIO = 1.5;
const PORTRAIT_WIDTH_CHANGE_MIN = 24;

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

function getSourceJunctionY(parentBottom, minChildY) {
  const availableGap = minChildY - parentBottom;
  if (availableGap <= ROUTING_RAIL_TO_CHILD_MIN_GAP * 2) {
    return parentBottom + Math.max(8, availableGap / 2);
  }

  const proportionalY = parentBottom + (minChildY - parentBottom) * 0.35;
  const childAnchoredY = minChildY - ROUTING_RAIL_TO_CHILD_GAP;
  const preferredY = Math.max(parentBottom + ROUTING_PARENT_TO_RAIL_MIN_GAP, proportionalY, childAnchoredY);
  return Math.min(preferredY, minChildY - ROUTING_RAIL_TO_CHILD_MIN_GAP);
}

function getSourceJunctionMoveRatio(parentBottom, minChildY) {
  if (minChildY - parentBottom <= ROUTING_RAIL_TO_CHILD_MIN_GAP * 2) return 0.5;
  const proportionalY = parentBottom + (minChildY - parentBottom) * 0.35;
  const childAnchoredY = minChildY - ROUTING_RAIL_TO_CHILD_GAP;
  if (childAnchoredY >= proportionalY && childAnchoredY >= parentBottom + ROUTING_PARENT_TO_RAIL_MIN_GAP) return 1;
  if (proportionalY >= parentBottom + ROUTING_PARENT_TO_RAIL_MIN_GAP) return 0.35;
  return 0;
}

function isPositionLocked(block) {
  return Boolean(block?.locked || block?.positionLocked);
}

function normalizeExtremePortraitBlocks(blocks) {
  const originallyTallIds = new Set();
  let changed = false;

  for (const block of blocks) {
    if (!block || block.isVirtual || isPositionLocked(block)) continue;
    const width = getBlockWidth(block);
    const height = getBlockHeight(block);
    if (height > TALL_LEAF_HEIGHT_THRESHOLD) originallyTallIds.add(block.id);
    if (width <= 0 || height <= 0) continue;
    if (height / width <= PORTRAIT_RATIO_THRESHOLD) continue;

    const area = width * height;
    const targetWidth = Math.max(BLOCK_W, Math.round(Math.sqrt(area / PORTRAIT_TARGET_RATIO)));
    if (targetWidth <= width + PORTRAIT_WIDTH_CHANGE_MIN) continue;

    const targetHeight = Math.max(BLOCK_H, Math.round(area / targetWidth));
    if (Math.abs(targetHeight - height) < 1) continue;

    block.width = targetWidth;
    block.height = targetHeight;
    changed = true;
  }

  return { originallyTallIds, changed };
}

function findDuplicateBlockIds(blocks) {
  const seen = new Set();
  const duplicates = new Set();
  for (const block of blocks) {
    if (seen.has(block.id)) duplicates.add(block.id);
    else seen.add(block.id);
  }
  return [...duplicates];
}

function hasDuplicateBlockIds(blocks) {
  return findDuplicateBlockIds(blocks).length > 0;
}

function getClusterAnchorX(cluster, blockMap) {
  const parent = blockMap[cluster.parentId];
  if (!parent) return null;
  const parentCenter = parent.x + getBlockWidth(parent) / 2;
  if (isClusterCentered(cluster)) return parentCenter;
  const distance = Math.max(260, Math.min(520, cluster.leafIds.length * 70));
  return parentCenter + getClusterOuterDir(cluster) * distance;
}

function enforceClusterOuterSide(cluster, blockMap) {
  if (!cluster?.bbox) return;
  const anchorX = getClusterAnchorX(cluster, blockMap);
  if (anchorX === null) return;

  const clusterCenter = (cluster.bbox.minX + cluster.bbox.maxX) / 2;
  if (getClusterOuterDir(cluster) < 0 && clusterCenter > anchorX) {
    moveCluster(cluster, anchorX - clusterCenter, 0, blockMap);
  } else if (getClusterOuterDir(cluster) > 0 && clusterCenter < anchorX) {
    moveCluster(cluster, anchorX - clusterCenter, 0, blockMap);
  }
}

function preserveClusterOuterSide(cluster, blockMap, prevCenterX) {
  if (prevCenterX === null || prevCenterX === undefined || !cluster?.bbox) return;
  const clusterCenter = (cluster.bbox.minX + cluster.bbox.maxX) / 2;

  if (getClusterOuterDir(cluster) < 0 && clusterCenter > prevCenterX) {
    moveCluster(cluster, prevCenterX - clusterCenter, 0, blockMap);
  } else if (getClusterOuterDir(cluster) > 0 && clusterCenter < prevCenterX) {
    moveCluster(cluster, prevCenterX - clusterCenter, 0, blockMap);
  }
}

function refreshClusterOuterConstraint(cluster, blockMap) {
  updateClusterBoundingBox(cluster, blockMap);
  enforceClusterOuterSide(cluster, blockMap);
  updateClusterBoundingBox(cluster, blockMap);
}

function getClusterCenterX(cluster) {
  if (!cluster?.bbox) return null;
  return (cluster.bbox.minX + cluster.bbox.maxX) / 2;
}

function moveClusterVertically(cluster, dy, blockMap) {
  moveCluster(cluster, 0, dy, blockMap);
}

function pushClusterFurtherOut(cluster, dx, blockMap) {
  const outwardDx = getClusterOuterDir(cluster) < 0 ? Math.min(dx, 0) : Math.max(dx, 0);
  moveCluster(cluster, outwardDx, 0, blockMap);
}

function getOuterPreservingShift(cluster, block, padding) {
  const bounds = cluster.bbox;
  const blockBounds = {
    minX: block.x,
    minY: block.y,
    maxX: block.x + getBlockWidth(block),
    maxY: block.y + getBlockHeight(block),
  };
  if (!bounds || !overlapsBox(getClusterBoundsWithPadding(cluster, padding), blockBounds)) {
    return { dx: 0, dy: 0 };
  }

  const horizontalDx = getClusterOuterDir(cluster) < 0
    ? blockBounds.minX - padding - bounds.maxX
    : blockBounds.maxX + padding - bounds.minX;
  const verticalDy = blockBounds.maxY + padding - bounds.minY;
  return { dx: horizontalDx, dy: verticalDy };
}

function getClusterCenterDistanceFromParent(cluster, blockMap) {
  const parent = blockMap[cluster.parentId];
  if (!parent || !cluster?.bbox) return 0;
  const parentCenter = parent.x + getBlockWidth(parent) / 2;
  const clusterCenter = (cluster.bbox.minX + cluster.bbox.maxX) / 2;
  return clusterCenter - parentCenter;
}

function chooseClusterShift(cluster, block, padding) {
  const shift = getOuterPreservingShift(cluster, block, padding);
  if (!shift.dx && !shift.dy) return shift;
  if (isClusterCentered(cluster)) return { dx: 0, dy: shift.dy };
  const horizontalClear = Math.abs(shift.dx) + padding;
  const verticalClear = Math.abs(shift.dy);
  if (horizontalClear <= verticalClear + 80) return { dx: shift.dx, dy: 0 };
  return { dx: 0, dy: shift.dy };
}

function getClusterPairSeparation(a, b, padding) {
  if (!a.bbox || !b.bbox) return { dx: 0, dy: 0 };
  if (!hasOverlapWithCluster(a, b, padding)) return { dx: 0, dy: 0 };
  const dy = getClusterVerticalSeparation(a, b, padding);
  return { dx: 0, dy };
}

function keepClusterOutsideParent(cluster, blockMap) {
  refreshClusterOuterConstraint(cluster, blockMap);
}

function keepClustersOutsideParents(clusters, blockMap) {
  for (const cluster of Object.values(clusters)) {
    keepClusterOutsideParent(cluster, blockMap);
  }
}

function isClusterCentered(cluster) {
  return cluster?.placementMode === 'center';
}

function getClusterHorizontalDirection(cluster) {
  if (isClusterCentered(cluster)) return 0;
  return getClusterOuterDir(cluster) < 0 ? -1 : 1;
}

function getOutwardTargetX(cluster, block, padding) {
  const blockBounds = {
    minX: block.x,
    maxX: block.x + getBlockWidth(block),
  };
  if (getClusterOuterDir(cluster) < 0) {
    return blockBounds.minX - padding - (cluster.bbox.maxX - cluster.bbox.minX);
  }
  return blockBounds.maxX + padding;
}

function moveClusterOutwardFromBlock(cluster, block, padding, blockMap) {
  const targetX = getOutwardTargetX(cluster, block, padding);
  const currentLeft = cluster.bbox.minX;
  const currentRight = cluster.bbox.maxX;
  const dx = getClusterOuterDir(cluster) < 0
    ? targetX - currentLeft
    : targetX - currentLeft;
  pushClusterFurtherOut(cluster, dx, blockMap);
  updateClusterBoundingBox(cluster, blockMap);
}

function tryResolveClusterAgainstBlock(cluster, block, padding, blockMap) {
  const previousCenter = getClusterCenterX(cluster);
  const shift = chooseClusterShift(cluster, block, padding);
  if (!shift.dx && !shift.dy) return false;

  if (shift.dx) pushClusterFurtherOut(cluster, shift.dx, blockMap);
  if (shift.dy) moveClusterVertically(cluster, shift.dy, blockMap);
  preserveClusterOuterSide(cluster, blockMap, previousCenter);
  refreshClusterOuterConstraint(cluster, blockMap);
  return true;
}

function tryResolveClusterPair(a, b, padding, blockMap) {
  const shift = getClusterPairSeparation(a, b, padding);
  if (!shift.dx && !shift.dy) return false;
  if (a.bbox.minY <= b.bbox.minY) {
    moveClusterVertically(b, shift.dy, blockMap);
    refreshClusterOuterConstraint(b, blockMap);
  } else {
    moveClusterVertically(a, shift.dy, blockMap);
    refreshClusterOuterConstraint(a, blockMap);
  }
  return true;
}

function clampClusterDistance(cluster, blockMap) {
  const parent = blockMap[cluster.parentId];
  if (!parent || !cluster.bbox) return;

  const parentCenter = parent.x + getBlockWidth(parent) / 2;
  const maxDistance = Math.max(260, Math.min(520, cluster.leafIds.length * 70));
  const clusterCenter = (cluster.bbox.minX + cluster.bbox.maxX) / 2;
  const delta = clusterCenter - parentCenter;
  if (Math.abs(delta) <= maxDistance) return;

  const targetCenter = parentCenter + Math.sign(delta) * maxDistance;
  moveCluster(cluster, targetCenter - clusterCenter, 0, blockMap);
}

function updateClusterBoundingBox(cluster, blockMap) {
  const boxes = cluster.leafIds
    .map(id => blockMap[id])
    .filter(block => block && block.x !== undefined && block.y !== undefined)
    .map(block => ({
      minX: block.x,
      minY: block.y,
      maxX: block.x + getBlockWidth(block),
      maxY: block.y + getBlockHeight(block),
    }));

  if (boxes.length === 0) {
    cluster.bbox = null;
    return null;
  }

  const bbox = {
    minX: Math.min(...boxes.map(box => box.minX)),
    minY: Math.min(...boxes.map(box => box.minY)),
    maxX: Math.max(...boxes.map(box => box.maxX)),
    maxY: Math.max(...boxes.map(box => box.maxY)),
  };
  cluster.bbox = bbox;
  return bbox;
}

function moveCluster(cluster, dx, dy, blockMap) {
  if (!dx && !dy) return;
  for (const leafId of cluster.leafIds) {
    const leaf = blockMap[leafId];
    if (!leaf || isPositionLocked(leaf) || leaf.x === undefined || leaf.y === undefined) continue;
    leaf.x += dx;
    leaf.y += dy;
  }
  updateClusterBoundingBox(cluster, blockMap);
}

function getClusterOuterBounds(cluster, padding = 0) {
  if (!cluster?.bbox) return null;
  return {
    minX: cluster.bbox.minX - padding,
    minY: cluster.bbox.minY - padding,
    maxX: cluster.bbox.maxX + padding,
    maxY: cluster.bbox.maxY + padding,
  };
}

function overlapsBox(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function isLeafSizeCompatible(bucket, leaf) {
  if (!bucket || bucket.items.length === 0) return true;
  const width = getBlockWidth(leaf);
  const height = getBlockHeight(leaf);
  return bucket.minWidth > 0
    && bucket.minHeight > 0
    && width / bucket.minWidth <= LEAF_DIMENSION_SIMILARITY_THRESHOLD
    && bucket.maxWidth / width <= LEAF_DIMENSION_SIMILARITY_THRESHOLD
    && height / bucket.minHeight <= LEAF_DIMENSION_SIMILARITY_THRESHOLD
    && bucket.maxHeight / height <= LEAF_DIMENSION_SIMILARITY_THRESHOLD;
}

function addLeafToBucket(bucket, leafId, blockMap) {
  const leaf = blockMap[leafId];
  if (!leaf) return;
  const width = getBlockWidth(leaf);
  const height = getBlockHeight(leaf);
  bucket.items.push(leafId);
  bucket.minWidth = Math.min(bucket.minWidth, width);
  bucket.maxWidth = Math.max(bucket.maxWidth, width);
  bucket.minHeight = Math.min(bucket.minHeight, height);
  bucket.maxHeight = Math.max(bucket.maxHeight, height);
}

function createLeafBucket() {
  return {
    items: [],
    minWidth: Infinity,
    maxWidth: 0,
    minHeight: Infinity,
    maxHeight: 0,
  };
}

function buildLeafCluster(parentId, normalLeafIds, tallLeafIds, blockMap) {
  const leafIds = [...normalLeafIds, ...tallLeafIds];
  if (leafIds.length === 0) return null;

  let maxLeafW = 0;
  let maxLeafH = 0;
  let maxNormalLeafW = 0;
  let maxNormalLeafH = 0;
  for (const leafId of leafIds) {
    const leaf = blockMap[leafId];
    if (!leaf) continue;
    const width = getBlockWidth(leaf);
    const height = getBlockHeight(leaf);
    maxLeafW = Math.max(maxLeafW, width);
    maxLeafH = Math.max(maxLeafH, height);
    if (normalLeafIds.includes(leafId)) {
      maxNormalLeafW = Math.max(maxNormalLeafW, width);
      maxNormalLeafH = Math.max(maxNormalLeafH, height);
    }
  }

  const gridCols = Math.min(Math.max(normalLeafIds.length, 1), GRID_MAX_COLS);
  const gridRows = normalLeafIds.length > 0 ? Math.ceil(normalLeafIds.length / gridCols) : 0;
  const gridW = normalLeafIds.length > 0
    ? gridCols * maxNormalLeafW + (gridCols - 1) * GRID_H_GAP
    : maxLeafW;
  const gridH = normalLeafIds.length > 0
    ? gridRows * maxNormalLeafH + Math.max(gridRows - 1, 0) * GRID_V_GAP
    : 0;

  return {
    parentId,
    leafIds,
    normalLeafIds: [...normalLeafIds],
    tallLeafIds: [...tallLeafIds],
    maxLeafW,
    maxLeafH,
    maxNormalLeafW,
    maxNormalLeafH,
    gridCols,
    gridRows,
    gridW,
    gridH,
    bbox: null,
    outerDir: 1,
  };
}

function identifyLeafClusters(blocks, connections, blockMap, originallyTallIds = new Set()) {
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

  const leafGroups = {};
  for (const b of blocks) {
    if (outDegree[b.id] === 0 && parentOf[b.id].length === 1) {
      const pid = parentOf[b.id][0];
      if (!leafGroups[pid]) leafGroups[pid] = [];
      leafGroups[pid].push(b.id);
    }
  }

  const clusters = {};
  for (const [pid, leafIds] of Object.entries(leafGroups)) {
    if (leafIds.length < LEAF_CLUSTER_MIN) continue;

    const normalLeafIds = [];
    const tallLeafIds = [];
    for (const leafId of leafIds) {
      const leaf = blockMap[leafId];
      if (!leaf || isPositionLocked(leaf)) continue;
      const height = getBlockHeight(leaf);
      if (originallyTallIds.has(leafId) || height > TALL_LEAF_HEIGHT_THRESHOLD) {
        tallLeafIds.push(leafId);
      } else {
        normalLeafIds.push(leafId);
      }
    }

    const sortedNormalLeafIds = [...normalLeafIds].sort((a, b) => {
      const aw = getBlockWidth(blockMap[a]);
      const bw = getBlockWidth(blockMap[b]);
      if (aw !== bw) return aw - bw;
      return getBlockHeight(blockMap[a]) - getBlockHeight(blockMap[b]);
    });

    const buckets = [];
    for (const leafId of sortedNormalLeafIds) {
      const leaf = blockMap[leafId];
      if (!leaf) continue;
      let bucket = buckets.find(item => isLeafSizeCompatible(item, leaf));
      if (!bucket) {
        bucket = createLeafBucket();
        buckets.push(bucket);
      }
      addLeafToBucket(bucket, leafId, blockMap);
    }

    const qualifiedBuckets = buckets
      .filter(bucket => bucket.items.length >= LEAF_CLUSTER_MIN)
      .sort((a, b) => b.items.length - a.items.length);
    if (qualifiedBuckets.length === 0) {
      if (tallLeafIds.length >= LEAF_CLUSTER_MIN) {
        const cluster = buildLeafCluster(pid, [], tallLeafIds, blockMap);
        if (cluster) clusters[`${pid}::tall`] = cluster;
      }
      continue;
    }

    qualifiedBuckets.forEach((bucket, index) => {
      const clusterTallLeafIds = index === 0 ? tallLeafIds : [];
      const cluster = buildLeafCluster(pid, bucket.items, clusterTallLeafIds, blockMap);
      if (cluster) clusters[`${pid}::grid::${index}`] = cluster;
    });
  }
  return clusters;
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

  const parentMap = {};
  blocks.forEach(b => { parentMap[b.id] = []; });
  connections.forEach(c => {
    if (parentMap[c.toId]) parentMap[c.toId].push(c.fromId);
  });

  const childMap = {};
  blocks.forEach(b => { childMap[b.id] = []; });
  connections.forEach(c => {
    if (childMap[c.fromId] && blockMap[c.toId]) childMap[c.fromId].push(c.toId);
  });

  const subtreeFootprintMemo = new Map();
  function getSubtreeFootprintWidth(id, visiting = new Set()) {
    if (subtreeFootprintMemo.has(id)) return subtreeFootprintMemo.get(id);
    if (visiting.has(id)) return getBlockWidth(blockMap[id]);

    const block = blockMap[id];
    const ownWidth = getBlockWidth(block);
    visiting.add(id);
    const children = (childMap[id] || [])
      .filter(childId => blockMap[childId] && layerMap[childId] > layerMap[id]);

    if (children.length === 0) {
      visiting.delete(id);
      subtreeFootprintMemo.set(id, ownWidth);
      return ownWidth;
    }

    let width = 0;
    for (let i = 0; i < children.length; i++) {
      const child = blockMap[children[i]];
      width += getSubtreeFootprintWidth(children[i], visiting);
      if (i < children.length - 1) {
        const next = blockMap[children[i + 1]];
        width += Math.max(getSmartHGap(child, connections), getSmartHGap(next, connections));
      }
    }

    visiting.delete(id);
    const footprint = Math.max(ownWidth, Math.round(width * LAYOUT_BREATHING));
    subtreeFootprintMemo.set(id, footprint);
    return footprint;
  }

  function getTargetInfo(id) {
    const parents = parentMap[id] || [];
    let sumCx = 0; let counted = 0;
    for (const p of parents) {
      if (blockMap[p] && blockMap[p].x !== undefined) {
        sumCx += blockMap[p].x + getBlockWidth(blockMap[p]) / 2;
        counted++;
      }
    }

    let targetCx = counted > 0 ? sumCx / counted : null;
    if (parents.length === 1) {
      const parent = blockMap[parents[0]];
      if (parent && parent.x !== undefined) {
        targetCx = parent.x + getBlockWidth(parent) / 2;
      }
    }

    return {
      targetCx,
      parentIds: new Set(parents)
    };
  }

  function getParentLayerAverageCenter(parentId) {
    const parentLayer = layerMap[parentId];
    if (parentLayer === undefined) return null;

    let sum = 0;
    let count = 0;
    for (const block of blocks) {
      if (block.isVirtual || layerMap[block.id] !== parentLayer || block.x === undefined) continue;
      sum += block.x + getBlockWidth(block) / 2;
      count++;
    }

    return count > 1 ? sum / count : null;
  }

  function getOutwardLeafClusterStartX(cluster, fallbackStartX) {
    if (!cluster || cluster.parentIds.size !== 1) return fallbackStartX;
    if (!cluster.nodes.every(id => (childMap[id] || []).length === 0)) return fallbackStartX;

    const parentId = [...cluster.parentIds][0];
    const parent = blockMap[parentId];
    const parentLayerCenter = getParentLayerAverageCenter(parentId);
    if (!parent || parent.x === undefined || parentLayerCenter === null) return fallbackStartX;

    const parentWidth = getBlockWidth(parent);
    const parentCx = parent.x + parentWidth / 2;

    if (parentCx < parentLayerCenter - 1) {
      return Math.min(fallbackStartX, parent.x + parentWidth - cluster.width);
    }
    if (parentCx > parentLayerCenter + 1) {
      return Math.max(fallbackStartX, parent.x);
    }
    return fallbackStartX;
  }

  function getClusterStartX(cluster) {
    return getOutwardLeafClusterStartX(cluster, cluster.targetCx - cluster.width / 2);
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

    let clusters = realBlockIds.map(id => {
      const w = getSubtreeFootprintWidth(id);
      const info = getTargetInfo(id);
      return {
        nodes: [id],
        slotWidths: [w],
        width: w,
        targetCx: info.targetCx,
        parentIds: info.parentIds
      };
    });

    const defaultGap = 300;
    let noTargetCount = clusters.filter(c => c.targetCx === null).length;
    let curX = - ((noTargetCount - 1) * defaultGap) / 2;
    clusters.forEach(c => {
      if (c.targetCx === null) {
        c.targetCx = curX;
        curX += defaultGap;
      }
    });

    clusters.sort((a, b) => a.targetCx - b.targetCx);

    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < clusters.length - 1; i++) {
        const c1 = clusters[i];
        const c2 = clusters[i + 1];

        const right1 = getClusterStartX(c1) + c1.width;
        const left2 = getClusterStartX(c2);

        const lastNodeId = c1.nodes[c1.nodes.length - 1];
        const firstNodeId = c2.nodes[0];
        let gap = Math.max(getSmartHGap(blockMap[lastNodeId], connections), getSmartHGap(blockMap[firstNodeId], connections));

        let sharedParent = false;
        c1.parentIds.forEach(p => { if (c2.parentIds.has(p)) sharedParent = true; });
        if (!sharedParent || (c1.parentIds.size === 0 && c2.parentIds.size === 0)) {
          gap += 100;
        }

        if (right1 + gap > left2) {
          const totalWidth = c1.width + gap + c2.width;
          const newTargetCx = (c1.targetCx * c1.width + c2.targetCx * c2.width) / (c1.width + c2.width);
          const mergedParents = new Set([...c1.parentIds, ...c2.parentIds]);

          clusters.splice(i, 2, {
            nodes: [...c1.nodes, ...c2.nodes],
            slotWidths: [...(c1.slotWidths || []), ...(c2.slotWidths || [])],
            width: totalWidth,
            targetCx: newTargetCx,
            parentIds: mergedParents
          });
          merged = true;
          break;
        }
      }
      if (merged) clusters.sort((a, b) => a.targetCx - b.targetCx);
    }

    for (const c of clusters) {
      let startX = getClusterStartX(c);
      for (let i = 0; i < c.nodes.length; i++) {
        const id = c.nodes[i];
        const block = blockMap[id];
        const blockWidth = getBlockWidth(block);
        const slotWidth = c.slotWidths?.[i] || blockWidth;
        if (!isPositionLocked(block)) {
          block.x = startX + Math.max(0, (slotWidth - blockWidth) / 2);
          block.y = currentY;
        }
        startX += slotWidth;
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

    const chainProtection = buildCenteredChainProtection(realBlockIds.map(id => blockMap[id]).filter(Boolean), connections);
    resolveHorizontalOverlaps(
      realBlockIds.map(id => blockMap[id]).filter(Boolean),
      connections,
      parentMap,
      { protectedIds: chainProtection.protectedIds }
    );
    currentY += maxHeight + maxVGap;
  }

  let minX = Infinity;
  for (const b of blocks) {
    if (b.x !== undefined && b.x < minX) minX = b.x;
  }
  if (minX < 100) {
    const offset = 100 - minX;
    for (const b of blocks) {
      if (!isPositionLocked(b) && b.x !== undefined) {
        b.x += offset;
      }
    }
  }
}

function resolveHorizontalOverlaps(blocks, connections, parentMap = {}, options = {}) {
  const movableBlocks = blocks.filter(b => !b.isVirtual && b.x !== undefined && b.y !== undefined);
  if (movableBlocks.length <= 1) return;

  const protectedIds = options.protectedIds || new Set();

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    const sorted = [...movableBlocks].sort((a, b) => a.x - b.x || a.y - b.y);

    for (let i = 0; i < sorted.length; i++) {
      const left = sorted[i];
      const leftBottom = left.y + getBlockHeight(left);
      const leftRight = left.x + getBlockWidth(left);

      for (let j = i + 1; j < sorted.length; j++) {
        const right = sorted[j];
        const rightBottom = right.y + getBlockHeight(right);
        const overlapY = left.y < rightBottom && leftBottom > right.y;
        if (!overlapY) continue;

        const leftParents = parentMap[left.id] || [];
        const rightParents = parentMap[right.id] || [];
        const sharedParent = leftParents.some(parentId => rightParents.includes(parentId));
        let gap = Math.max(getSmartHGap(left, connections), getSmartHGap(right, connections));
        if (!sharedParent || (leftParents.length === 0 && rightParents.length === 0)) {
          gap += 100;
        }

        const minRightX = leftRight + gap;
        const rightProtected = protectedIds.has(right.id);
        const leftProtected = protectedIds.has(left.id);
        if (right.x < minRightX && !isPositionLocked(right)) {
          if (rightProtected && !leftProtected) continue;
          right.x = minRightX;
          moved = true;
        }
      }
    }

    if (!moved) break;
  }
}

function buildParentMap(blocks, connections) {
  const parentMap = {};
  blocks.forEach(block => { parentMap[block.id] = []; });
  connections.forEach(conn => {
    if (parentMap[conn.toId]) parentMap[conn.toId].push(conn.fromId);
  });
  return parentMap;
}

function buildChildMap(blocks, connections) {
  const childMap = {};
  blocks.forEach(block => { childMap[block.id] = []; });
  connections.forEach(conn => {
    if (childMap[conn.fromId]) childMap[conn.fromId].push(conn.toId);
  });
  return childMap;
}

function buildCenteredChainProtection(blocks, connections, blockedIds = new Set()) {
  const blockMap = {};
  for (const block of blocks) {
    if (block.isVirtual) continue;
    blockMap[block.id] = block;
  }

  const parentMap = buildParentMap(blocks, connections);
  const childMap = buildChildMap(blocks, connections);
  const protectedIds = new Set();
  const CENTER_TOLERANCE = 12;

  for (const block of blocks) {
    if (!block || block.isVirtual || isPositionLocked(block) || blockedIds.has(block.id)) continue;
    if (block.x === undefined || block.y === undefined) continue;

    const parents = parentMap[block.id] || [];
    const children = childMap[block.id] || [];
    if (parents.length !== 1 || children.length > 1) continue;

    const parent = blockMap[parents[0]];
    if (!parent || isPositionLocked(parent) || blockedIds.has(parent.id)) continue;

    const targetX = parent.x + getBlockWidth(parent) / 2 - getBlockWidth(block) / 2;
    if (Math.abs(block.x - targetX) <= CENTER_TOLERANCE) {
      protectedIds.add(block.id);
    }
  }

  return { protectedIds, parentMap, childMap, blockMap };
}

function buildLayerBands(blocks, tolerance = 60) {
  const bands = [];
  const sorted = [...blocks].filter(b => !b.isVirtual && b.y !== undefined).sort((a, b) => a.y - b.y);
  for (const block of sorted) {
    const topY = block.y;
    let band = bands.find(item => Math.abs(item.topY - topY) <= tolerance);
    if (!band) {
      band = { topY, blocks: [] };
      bands.push(band);
    }
    band.blocks.push(block);
    band.topY = (band.topY * (band.blocks.length - 1) + topY) / band.blocks.length;
  }
  return bands;
}

function resolveLayerBandOverlaps(blocks, connections, options = {}) {
  const parentMap = buildParentMap(blocks, connections);
  const protectedIds = options.protectedIds || buildCenteredChainProtection(blocks, connections, options.blockedIds || new Set()).protectedIds;
  for (const band of buildLayerBands(blocks)) {
    resolveHorizontalOverlaps(band.blocks, connections, parentMap, { protectedIds });
  }
}

function resolveResidualSkeletonOverlaps(blocks, connections) {
  const movableBlocks = blocks.filter(block => !block.isVirtual && block.x !== undefined && block.y !== undefined);
  if (movableBlocks.length <= 1) return;

  const parentMap = buildParentMap(blocks, connections);
  const childMap = buildChildMap(blocks, connections);

  function isDirectChainPair(upper, lower) {
    if (!upper || !lower) return false;
    if ((childMap[upper.id] || []).length === 1 && childMap[upper.id][0] === lower.id) return true;
    if ((parentMap[upper.id] || []).length === 1 && parentMap[upper.id][0] === lower.id) return true;
    return false;
  }

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    const sorted = [...movableBlocks].sort((a, b) => a.y - b.y || a.x - b.x);

    for (let i = 0; i < sorted.length; i++) {
      const upper = sorted[i];
      const upperRight = upper.x + getBlockWidth(upper);
      const upperBottom = upper.y + getBlockHeight(upper);

      for (let j = i + 1; j < sorted.length; j++) {
        const lower = sorted[j];
        const lowerRight = lower.x + getBlockWidth(lower);
        const lowerBottom = lower.y + getBlockHeight(lower);
        const overlaps = upper.x < lowerRight && upperRight > lower.x && upper.y < lowerBottom && upperBottom > lower.y;
        if (!overlaps) continue;

        if (isDirectChainPair(upper, lower)) {
          const gapY = Math.max(MIN_V_GAP, Math.round(Math.max(getSmartVGap(upper, connections), getSmartVGap(lower, connections)) * 0.35));
          const nextY = upperBottom + gapY;
          if (!isPositionLocked(lower) && lower.y < nextY) {
            lower.y = nextY;
            moved = true;
          }
          continue;
        }

        if (Math.abs(upper.y - lower.y) <= 60) {
          const gap = Math.max(getSmartHGap(upper, connections), getSmartHGap(lower, connections));
          const nextX = upperRight + gap;
          if (!isPositionLocked(lower) && lower.x < nextX) {
            lower.x = nextX;
            moved = true;
          }
        } else {
          const gapY = Math.max(MIN_V_GAP, Math.round(Math.max(getSmartVGap(upper, connections), getSmartVGap(lower, connections)) * 0.35));
          const nextY = upperBottom + gapY;
          if (!isPositionLocked(lower) && lower.y < nextY) {
            lower.y = nextY;
            moved = true;
          }
        }
      }
    }

    if (!moved) break;
  }
}

function blockIntersectsBounds(block, bounds, padding = 0) {
  return overlapsBox(
    {
      minX: block.x,
      minY: block.y,
      maxX: block.x + getBlockWidth(block),
      maxY: block.y + getBlockHeight(block),
    },
    {
      minX: bounds.minX - padding,
      minY: bounds.minY - padding,
      maxX: bounds.maxX + padding,
      maxY: bounds.maxY + padding,
    }
  );
}

function isBoundsOccupied(bounds, blocks, ignoreIds = new Set(), padding = 0) {
  return blocks.some(block => {
    if (ignoreIds.has(block.id) || block.isVirtual || block.x === undefined || block.y === undefined) return false;
    return blockIntersectsBounds(block, bounds, padding);
  });
}

function getPlacedLeafBounds(cluster, blockMap) {
  updateClusterBoundingBox(cluster, blockMap);
  return cluster.bbox;
}

function moveClusterToFreeSlot(cluster, occupiedBlocks, blockMap, baseDx = 0, baseDy = 0, padding = 25) {
  updateClusterBoundingBox(cluster, blockMap);
  if (!cluster.bbox) return;
  if (baseDx || baseDy) moveCluster(cluster, baseDx, baseDy, blockMap);

  const ignoreIds = new Set(cluster.leafIds);
  for (let attempt = 0; attempt < 8; attempt++) {
    const bounds = getPlacedLeafBounds(cluster, blockMap);
    if (!bounds || !isBoundsOccupied(bounds, occupiedBlocks, ignoreIds, padding)) return;

    const dx = cluster.outerDir < 0 ? -(bounds.maxX - bounds.minX + GRID_H_GAP) : (bounds.maxX - bounds.minX + GRID_H_GAP);
    moveCluster(cluster, dx, attempt > 2 ? GRID_V_GAP : 0, blockMap);
  }
}

function resolveIntraClusterLeafOverlaps(cluster, blockMap) {
  const blocks = cluster.leafIds.map(id => blockMap[id]).filter(Boolean);
  resolveHorizontalOverlaps(blocks, [], {});
}

function getSkeletonBlocksForPlacement(blocks, strippedIds) {
  return blocks.filter(b => !strippedIds.has(b.id) && !b.isVirtual && b.x !== undefined && b.y !== undefined);
}

function getClusterShiftForBlock(cluster, block, outerDir, padding) {
  return chooseClusterShift(cluster, block, padding);
}

function getClusterVerticalSeparation(a, b, padding) {
  if (!a.bbox || !b.bbox) return 0;
  if (a.bbox.minY <= b.bbox.minY) return a.bbox.maxY + padding - b.bbox.minY;
  return b.bbox.maxY + padding - a.bbox.minY;
}

function resolveAllOverlaps(blocks, connections, clusters = null, blockMap = null) {
  const strippedIds = clusters ? getClusterLeafIdsSet(clusters) : new Set();
  const skeletonBlocks = blocks.filter(block => !strippedIds.has(block.id));
  const chainProtection = buildCenteredChainProtection(skeletonBlocks, connections, strippedIds);
  resolveLayerBandOverlaps(skeletonBlocks, connections, {
    protectedIds: chainProtection.protectedIds,
    blockedIds: strippedIds,
  });
  resolveResidualSkeletonOverlaps(skeletonBlocks, connections);

  if (clusters && blockMap) {
    const clusterList = Object.values(clusters);
    const placedSkeleton = getSkeletonBlocksForPlacement(blocks, strippedIds);

    for (const cluster of clusterList) {
      refreshClusterConstraint(cluster, blockMap);
      resolveClusterAgainstSkeleton(cluster, placedSkeleton, blockMap, 25);
      refreshClusterConstraint(cluster, blockMap);
    }

    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i < clusterList.length; i++) {
        for (let j = i + 1; j < clusterList.length; j++) {
          moved = resolveClusterPair(clusterList[i], clusterList[j], blockMap, 25) || moved;
        }
      }
      if (!moved) break;
    }
  }
}

function getClusterShiftForCluster(a, b, padding) {
  if (!a.bbox || !b.bbox) return { dx: 0, dy: 0 };
  if (!hasOverlapWithCluster(a, b, padding)) return { dx: 0, dy: 0 };
  const dy = getClusterVerticalSeparation(a, b, padding);
  return { dx: 0, dy };
}

function getSkeletonBoundsBlocks(blocks, strippedIds) {
  return getSkeletonBlocksForPlacement(blocks, strippedIds);
}

function resolveClusterAgainstSkeleton(cluster, skeletonBlocks, blockMap, padding) {
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const skeletonBlock of skeletonBlocks) {
      moved = tryResolveClusterAgainstBlock(cluster, skeletonBlock, padding, blockMap) || moved;
    }
    if (!moved) break;
  }
}

function resolveClusterPair(a, b, blockMap, padding) {
  return tryResolveClusterPair(a, b, padding, blockMap);
}

function validateLayoutInput(blocks) {
  const duplicateIds = findDuplicateBlockIds(blocks);
  if (duplicateIds.length === 0) return true;

  console.warn('[autoLayout] Skip layout because duplicate block ids were found:', duplicateIds);
  return false;
}

function hasOverlapWithCluster(cluster, otherCluster, padding = 0) {
  const a = getClusterBoundsWithPadding(cluster, padding);
  const b = getClusterBoundsWithPadding(otherCluster, padding);
  return a && b ? overlapsBox(a, b) : false;
}

function getClusterBoundsWithPadding(cluster, padding = 0) {
  return getClusterOuterBounds(cluster, padding);
}

function refreshAllClusterBounds(clusters, blockMap) {
  for (const cluster of Object.values(clusters)) {
    updateClusterBoundingBox(cluster, blockMap);
  }
}

function refreshClusterConstraint(cluster, blockMap) {
  refreshClusterOuterConstraint(cluster, blockMap);
}

function translateCluster(cluster, dx, dy, blockMap) {
  moveCluster(cluster, dx, dy, blockMap);
}

function getSkeletonBlocks(blocks, strippedIds) {
  return blocks.filter(b => !strippedIds.has(b.id));
}

function getSkeletonConnections(connections, strippedIds) {
  return connections.filter(c => !strippedIds.has(c.toId) && !strippedIds.has(c.fromId));
}

function getClusterLeafIdsSet(clusters) {
  return getStrippedLeafIds(clusters);
}

function setClusterGridRows(cluster, rows) {
  cluster.gridRows = rows;
}

function setClusterGridCols(cluster, cols) {
  cluster.gridCols = cols;
}

function setClusterGridSize(cluster, width, height) {
  cluster.gridW = width;
  cluster.gridH = height;
}

function setClusterOuterDir(cluster, dir) {
  cluster.outerDir = dir;
}

function setClusterPlacementMode(cluster, mode) {
  cluster.placementMode = mode;
}

function getClusterOuterDir(cluster) {
  return cluster.outerDir || 1;
}

function getClusterParentId(cluster) {
  return cluster.parentId;
}

function getClusterMaxLeafWidth(cluster) {
  return cluster.maxLeafW || 0;
}

function getClusterMaxLeafHeight(cluster) {
  return cluster.maxLeafH || 0;
}

function getClusterMaxNormalLeafWidth(cluster) {
  return cluster.maxNormalLeafW || 0;
}

function getClusterMaxNormalLeafHeight(cluster) {
  return cluster.maxNormalLeafH || 0;
}

function getClusterNormalLeafIds(cluster) {
  return cluster.normalLeafIds;
}

function getClusterTallLeafIds(cluster) {
  return cluster.tallLeafIds;
}

function getClusterBBox(cluster) {
  return cluster.bbox;
}

function hasClusters(clusters) {
  return Object.keys(clusters).length > 0;
}

function getClusterCount(clusters) {
  return Object.keys(clusters).length;
}

function getLeafCount(clusters) {
  let count = 0;
  for (const cluster of Object.values(clusters)) count += cluster.leafIds.length;
  return count;
}

function getClusterEntries(clusters) {
  return Object.entries(clusters);
}

function getStrippedLeafIds(clusters) {
  const strippedLeafIds = new Set();
  for (const cluster of Object.values(clusters)) {
    cluster.leafIds.forEach(id => strippedLeafIds.add(id));
  }
  return strippedLeafIds;
}

function normalizeLayoutBounds(blocks, clusters = null, blockMap = null, padding = 100) {
  let minX = Infinity;
  let minY = Infinity;

  for (const block of blocks) {
    if (block.x === undefined || block.y === undefined) continue;
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

  const offsetX = padding - minX;
  const offsetY = 80 - minY;
  if (offsetX === 0 && offsetY === 0) return;

  for (const block of blocks) {
    if (!isPositionLocked(block) && block.x !== undefined && block.y !== undefined) {
      block.x += offsetX;
      block.y += offsetY;
    }
  }

  if (clusters && blockMap) {
    refreshAllClusterBounds(clusters, blockMap);
  }
}

function compactHorizontalBands(blocks, clusters = null) {
  const blockedIds = new Set();
  if (clusters) {
    for (const cluster of Object.values(clusters)) {
      cluster.leafIds.forEach(id => blockedIds.add(id));
    }
  }
  const movableBlocks = blocks.filter(
    b => !b.isVirtual && !blockedIds.has(b.id) && b.x !== undefined && b.y !== undefined
  );
  const bandTolerance = 90;
  const bands = [];

  for (const block of movableBlocks.sort((a, b) => a.y - b.y)) {
    const centerY = block.y + getBlockHeight(block) / 2;
    let band = bands.find(item => Math.abs(item.centerY - centerY) <= bandTolerance);
    if (!band) {
      band = { centerY, blocks: [] };
      bands.push(band);
    }
    band.blocks.push(block);
    band.centerY = (band.centerY * (band.blocks.length - 1) + centerY) / band.blocks.length;
  }

  for (const band of bands) {
    const sorted = [...band.blocks].sort((a, b) => a.x - b.x);
    if (sorted.length <= 1) continue;

    const originalLeft = sorted[0].x;
    const originalRight = Math.max(...sorted.map(b => b.x + getBlockWidth(b)));
    const originalWidth = originalRight - originalLeft;

    let compactWidth = 0;
    for (let i = 0; i < sorted.length; i++) {
      compactWidth += getBlockWidth(sorted[i]);
      if (i < sorted.length - 1) compactWidth += MIN_H_GAP;
    }

    if (compactWidth >= originalWidth - 40) continue;

    let currentX = originalLeft + (originalWidth - compactWidth) / 2;
    for (const block of sorted) {
      if (!isPositionLocked(block)) block.x = currentX;
      currentX += getBlockWidth(block) + MIN_H_GAP;
    }
  }
}

function stabilizeLeafClusters(clusters, blockMap) {
  for (const cluster of Object.values(clusters)) {
    refreshClusterOuterConstraint(cluster, blockMap);
  }
}

function alignLinearChains(blocks, connections, clusters = null) {
  const blockedIds = new Set();
  if (clusters) {
    for (const cluster of Object.values(clusters)) {
      cluster.leafIds.forEach(id => blockedIds.add(id));
    }
  }

  const blockMap = {};
  const parentMap = {};
  const childMap = {};
  for (const block of blocks) {
    if (block.isVirtual) continue;
    blockMap[block.id] = block;
    parentMap[block.id] = [];
    childMap[block.id] = [];
  }
  for (const conn of connections) {
    if (parentMap[conn.toId]) parentMap[conn.toId].push(conn.fromId);
    if (childMap[conn.fromId]) childMap[conn.fromId].push(conn.toId);
  }

  const occupiedBlocks = blocks.filter(block => !block.isVirtual && block.x !== undefined && block.y !== undefined);

  function canMoveToX(block, targetX, parentId) {
    const parent = blockMap[parentId];
    const candidate = {
      minX: targetX,
      minY: block.y,
      maxX: targetX + getBlockWidth(block),
      maxY: block.y + getBlockHeight(block),
    };

    if (parent) {
      const parentBox = {
        minX: parent.x,
        minY: parent.y,
        maxX: parent.x + getBlockWidth(parent),
        maxY: parent.y + getBlockHeight(parent),
      };
      if (overlapsBox(candidate, parentBox)) return false;
    }

    for (const other of occupiedBlocks) {
      if (other.id === block.id || other.id === parentId) continue;
      const otherBox = {
        minX: other.x,
        minY: other.y,
        maxX: other.x + getBlockWidth(other),
        maxY: other.y + getBlockHeight(other),
      };
      if (overlapsBox(candidate, otherBox)) return false;
    }
    return true;
  }

  function findNearestOpenX(block, targetX, parentId) {
    if (canMoveToX(block, targetX, parentId)) return targetX;

    const step = 20;
    const maxShift = 400;
    for (let offset = step; offset <= maxShift; offset += step) {
      const leftX = targetX - offset;
      if (canMoveToX(block, leftX, parentId)) return leftX;
      const rightX = targetX + offset;
      if (canMoveToX(block, rightX, parentId)) return rightX;
    }

    return null;
  }

  for (const block of blocks) {
    if (block.isVirtual || isPositionLocked(block) || blockedIds.has(block.id)) continue;

    const parents = parentMap[block.id] || [];
    const children = childMap[block.id] || [];
    if (parents.length !== 1 || children.length > 1) continue;

    const parent = blockMap[parents[0]];
    if (!parent) continue;

    const targetX = parent.x + getBlockWidth(parent) / 2 - getBlockWidth(block) / 2;
    const nextX = findNearestOpenX(block, targetX, parent.id);
    if (nextX === null) continue;
    block.x = nextX;
  }
}

function runStablePass(blocks, connections, clusters, blockMap, layerMap) {
  const beforeSpread = measureLayoutSpread(blocks);
  const snapshot = blocks.map(block => ({ id: block.id, x: block.x, y: block.y }));

  compactSkeletonLayersY(blocks, layerMap, connections);
  stabilizeLeafClusters(clusters, blockMap);
  compactHorizontalBands(blocks, clusters);
  resolveAllOverlaps(blocks, connections, clusters, blockMap);
  reserveClusterRoutingCorridors(blocks, clusters, blockMap);
  const blockedIds = clusters ? getClusterLeafIdsSet(clusters) : new Set();
  const stableBlocks = blocks.filter(block => !block.isVirtual);
  const stableChainProtection = buildCenteredChainProtection(stableBlocks, connections, blockedIds);
  resolveLayerBandOverlaps(stableBlocks, connections, {
    protectedIds: stableChainProtection.protectedIds,
    blockedIds,
  });
  alignLinearChains(blocks, connections, clusters);
  normalizeLayoutBounds(blocks, clusters, blockMap);

  const afterSpread = measureLayoutSpread(blocks);
  if (afterSpread > beforeSpread + 120) {
    const posMap = new Map(snapshot.map(item => [item.id, item]));
    for (const block of blocks) {
      const prev = posMap.get(block.id);
      if (prev && !isPositionLocked(block)) {
        block.x = prev.x;
        block.y = prev.y;
      }
    }
    stabilizeLeafClusters(clusters, blockMap);
    resolveAllOverlaps(blocks, connections, clusters, blockMap);
    reserveClusterRoutingCorridors(blocks, clusters, blockMap);
    alignLinearChains(blocks, connections, clusters);
    normalizeLayoutBounds(blocks, clusters, blockMap);
  }
}

function compactSkeletonLayersY(blocks, layerMap, connections = []) {
  const layers = new Map();
  const blockMap = new Map();
  const parentIdsByBlock = new Map();

  for (const block of blocks) {
    if (block.isVirtual) continue;
    blockMap.set(block.id, block);
    const layer = layerMap[block.id];
    if (layer === undefined) continue;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(block);
  }

  for (const conn of connections) {
    if (!parentIdsByBlock.has(conn.toId)) parentIdsByBlock.set(conn.toId, []);
    parentIdsByBlock.get(conn.toId).push(conn.fromId);
  }

  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  const processedUpperBlocks = [];

  const hasHorizontalOverlap = (upper, lower) => {
    const upperLeft = upper.x;
    const upperRight = upper.x + getBlockWidth(upper);
    const lowerLeft = lower.x;
    const lowerRight = lower.x + getBlockWidth(lower);
    return lowerLeft < upperRight && lowerRight > upperLeft;
  };

  const getCompactionGap = (upper, lower) => {
    return Math.max(
      MIN_V_GAP,
      Math.round(Math.max(getSmartVGap(upper, connections), getSmartVGap(lower, connections)) * 0.35)
    );
  };

  for (const layer of sortedLayers) {
    const layerBlocks = layers.get(layer);
    if (!layerBlocks || layerBlocks.length === 0) continue;

    if (processedUpperBlocks.length === 0) {
      const layerTop = Math.min(...layerBlocks.map(block => block.y));
      const shift = 80 - layerTop;
      if (shift !== 0) {
        for (const block of layerBlocks) {
          if (!isPositionLocked(block)) block.y += shift;
        }
      }
      processedUpperBlocks.push(...layerBlocks);
      continue;
    }

    const sortedLayerBlocks = [...layerBlocks].sort((a, b) => {
      if (a.x !== b.x) return a.x - b.x;
      return a.y - b.y;
    });

    for (const block of sortedLayerBlocks) {
      let targetTop = 80;

      const parentIds = parentIdsByBlock.get(block.id) || [];
      for (const parentId of parentIds) {
        const parent = blockMap.get(parentId);
        if (!parent || parent.isVirtual) continue;
        targetTop = Math.max(
          targetTop,
          parent.y + getBlockHeight(parent) + getCompactionGap(parent, block)
        );
      }

      for (const upper of processedUpperBlocks) {
        if (!hasHorizontalOverlap(upper, block)) continue;
        targetTop = Math.max(
          targetTop,
          upper.y + getBlockHeight(upper) + getCompactionGap(upper, block)
        );
      }

      if (!isPositionLocked(block)) {
        block.y = targetTop;
      }
    }

    processedUpperBlocks.push(...sortedLayerBlocks);
  }
}

function measureLayoutSpread(blocks) {
  const visibleBlocks = blocks.filter(b => !b.isVirtual && b.x !== undefined && b.y !== undefined);
  if (visibleBlocks.length === 0) return 0;
  const box = getBoundingBox(visibleBlocks, getBlockWidth);
  return box.width + box.height;
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
      if (block && !isPositionLocked(block)) {
        block.y += offset;
      }
    }

    // 应用水平调整
    for (const [id, targetX] of Object.entries(xAdjustments)) {
      const block = blockMap[id];
      if (block && !isPositionLocked(block)) {
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

/**
 * 将叶子聚类编排为网格矩阵，安置在父节点下方空隙中
 * - 无核心子线时：网格居中于父节点正下方
 * - 有核心子线时：网格偏移至核心子树的对侧空隙
 */
function placeLeafGrids(allBlocks, originalConnections, clusters, blockMap) {
  const childrenMap = {};
  for (const b of allBlocks) childrenMap[b.id] = [];
  for (const conn of originalConnections) {
    if (childrenMap[conn.fromId]) childrenMap[conn.fromId].push(conn.toId);
  }

  const strippedIds = getClusterLeafIdsSet(clusters);

  let graphCenterX = 0;
  let skelCount = 0;
  for (const b of allBlocks) {
    if (!strippedIds.has(b.id) && !b.isVirtual && b.x !== undefined) {
      graphCenterX += b.x + getBlockWidth(b) / 2;
      skelCount++;
    }
  }
  if (skelCount > 0) graphCenterX /= skelCount;

  const skeletonBlocks = allBlocks.filter(block => !strippedIds.has(block.id) && !block.isVirtual && block.x !== undefined);

  function shiftGridAwayFromSiblingCenters(parentId, gridCx, gridW) {
    const parent = blockMap[parentId];
    if (!parent) return gridCx;

    let left = gridCx - gridW / 2;
    let right = gridCx + gridW / 2;
    const parentCx = parent.x + getBlockWidth(parent) / 2;
    const padding = MIN_H_GAP;

    for (const other of skeletonBlocks) {
      if (other.id === parentId || other.y !== parent.y) continue;
      const otherCx = other.x + getBlockWidth(other) / 2;
      if (otherCx <= left - padding || otherCx >= right + padding) continue;

      const shiftRight = otherCx < parentCx;
      const shift = shiftRight
        ? otherCx + padding - left
        : right - otherCx + padding;
      gridCx += shiftRight ? shift : -shift;
      left = gridCx - gridW / 2;
      right = gridCx + gridW / 2;
    }

    return gridCx;
  }

  function getSiblingLayerCenterX(parent) {
    const sameLayer = skeletonBlocks.filter(block => block.id !== parent.id && Math.abs(block.y - parent.y) <= 30);
    if (sameLayer.length === 0) return null;

    const centers = [
      parent.x + getBlockWidth(parent) / 2,
      ...sameLayer.map(block => block.x + getBlockWidth(block) / 2),
    ];
    return centers.reduce((sum, center) => sum + center, 0) / centers.length;
  }

  const clustersByParent = new Map();
  for (const [, cluster] of getClusterEntries(clusters)) {
    const parentId = getClusterParentId(cluster);
    if (!clustersByParent.has(parentId)) clustersByParent.set(parentId, []);
    clustersByParent.get(parentId).push(cluster);
  }

  for (const [parentId, parentClusters] of clustersByParent.entries()) {
    const parent = blockMap[parentId];
    if (!parent || parent.x === undefined) continue;

    parentClusters.sort((a, b) => {
      const aSize = getClusterNormalLeafIds(b).length - getClusterNormalLeafIds(a).length;
      if (aSize !== 0) return aSize;
      return (b.gridH || 0) - (a.gridH || 0);
    });

    const parentW = getBlockWidth(parent);
    const parentH = getBlockHeight(parent);
    const parentCx = parent.x + parentW / 2;
    const coreChildren = (childrenMap[parentId] || []).filter(cid => !strippedIds.has(cid));
    let coreMinX = Infinity;
    let coreMaxX = -Infinity;
    for (const cid of coreChildren) {
      const cb = blockMap[cid];
      if (cb && cb.x !== undefined) {
        coreMinX = Math.min(coreMinX, cb.x);
        coreMaxX = Math.max(coreMaxX, cb.x + getBlockWidth(cb));
      }
    }

    let nextGridTop = parent.y + parentH + GRID_PARENT_OFFSET;
    for (const cluster of parentClusters) {
      const normalLeafIds = getClusterNormalLeafIds(cluster);
      const tallLeafIds = getClusterTallLeafIds(cluster);
      const maxNormalLeafW = Math.max(1, getClusterMaxNormalLeafWidth(cluster));
      const maxNormalLeafH = Math.max(1, getClusterMaxNormalLeafHeight(cluster));
      const maxLeafW = Math.max(1, getClusterMaxLeafWidth(cluster));
      const cols = normalLeafIds.length > 0 ? Math.min(normalLeafIds.length, GRID_MAX_COLS) : 1;
      const rows = normalLeafIds.length > 0 ? Math.ceil(normalLeafIds.length / cols) : 0;
      const gridW = normalLeafIds.length > 0 ? cols * maxNormalLeafW + (cols - 1) * GRID_H_GAP : maxLeafW;
      const gridH = normalLeafIds.length > 0 ? rows * maxNormalLeafH + Math.max(rows - 1, 0) * GRID_V_GAP : 0;

      setClusterGridCols(cluster, cols);
      setClusterGridRows(cluster, rows);
      setClusterGridSize(cluster, gridW, gridH);

      let gridCx;
      const outerOffset = gridW / 2 + 40;
      let outerDir = 1;
      let placementMode = 'outer';

      if (coreChildren.length === 0) {
        const siblingLayerCenterX = getSiblingLayerCenterX(parent);
        if (siblingLayerCenterX === null || Math.abs(parentCx - siblingLayerCenterX) <= 30) {
          placementMode = 'center';
          gridCx = parentCx;
        } else {
          outerDir = parentCx < siblingLayerCenterX ? -1 : 1;
          gridCx = parentCx + outerDir * outerOffset;
        }
      } else if (parentCx < graphCenterX - 30) {
        outerDir = -1;
        gridCx = parentCx - outerOffset;
        if (coreMinX !== Infinity) gridCx = Math.min(gridCx, coreMinX - gridW / 2 - 40);
      } else if (parentCx > graphCenterX + 30) {
        outerDir = 1;
        gridCx = parentCx + outerOffset;
        if (coreMaxX !== -Infinity) gridCx = Math.max(gridCx, coreMaxX + gridW / 2 + 40);
      } else {
        const coreCx = (coreMinX + coreMaxX) / 2;
        if (coreCx >= parentCx) {
          outerDir = -1;
          gridCx = coreMinX - gridW / 2 - 40;
        } else {
          outerDir = 1;
          gridCx = coreMaxX + gridW / 2 + 40;
        }
      }
      gridCx = shiftGridAwayFromSiblingCenters(parentId, gridCx, gridW);
      setClusterOuterDir(cluster, outerDir);
      setClusterPlacementMode(cluster, placementMode);

      const gridTop = nextGridTop;
      const gridLeft = gridCx - gridW / 2;
      for (let i = 0; i < normalLeafIds.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const leaf = blockMap[normalLeafIds[i]];
        if (leaf && !isPositionLocked(leaf)) {
          leaf.x = gridLeft + col * (maxNormalLeafW + GRID_H_GAP);
          leaf.y = gridTop + row * (maxNormalLeafH + GRID_V_GAP);
        }
      }

      let occupiedBottom = gridTop + gridH;
      if (tallLeafIds.length > 0) {
        if (normalLeafIds.length === 0) {
          let currentY = gridTop;
          for (const tallLeafId of tallLeafIds) {
            const leaf = blockMap[tallLeafId];
            if (!leaf || isPositionLocked(leaf)) continue;
            leaf.x = parentCx - getBlockWidth(leaf) / 2;
            leaf.y = currentY;
            currentY += getBlockHeight(leaf) + GRID_V_GAP;
          }
          occupiedBottom = Math.max(occupiedBottom, currentY - GRID_V_GAP);
        } else {
          const tallStartX = outerDir < 0
            ? gridLeft - TALL_LEAF_OFFSET
            : gridLeft + gridW + TALL_LEAF_OFFSET;
          let currentY = gridTop;
          for (const tallLeafId of tallLeafIds) {
            const leaf = blockMap[tallLeafId];
            if (!leaf || isPositionLocked(leaf)) continue;
            const leafW = getBlockWidth(leaf);
            leaf.x = outerDir < 0 ? tallStartX - leafW : tallStartX;
            leaf.y = currentY;
            currentY += getBlockHeight(leaf) + GRID_V_GAP;
          }
          occupiedBottom = Math.max(occupiedBottom, currentY - GRID_V_GAP);
        }
      }

      updateClusterBoundingBox(cluster, blockMap);
      occupiedBottom = Math.max(occupiedBottom, cluster.bbox?.maxY || occupiedBottom);
      nextGridTop = occupiedBottom + GRID_V_GAP;
    }
  }
}

/**
 * 碰撞微调：检查网格叶子与骨架节点重叠
 * 增强：整体平移聚类，保持矩阵形状不被打散
 */
function resolveGridCollisions(blocks, clusters, blockMap) {
  const strippedIds = getClusterLeafIdsSet(clusters);
  const skeletonBlocks = blocks.filter(b => !strippedIds.has(b.id) && !b.isVirtual && b.x !== undefined);
  const COLLISION_PADDING = 25;
  const MAX_ITERATIONS = 6;

  refreshAllClusterBounds(clusters, blockMap);

  const clusterList = Object.values(clusters);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = false;

    for (const cluster of clusterList) {
      refreshClusterOuterConstraint(cluster, blockMap);
      if (!getClusterBBox(cluster)) continue;

      for (const skeletonBlock of skeletonBlocks) {
        moved = tryResolveClusterAgainstBlock(cluster, skeletonBlock, COLLISION_PADDING, blockMap) || moved;
      }
    }

    for (let i = 0; i < clusterList.length; i++) {
      for (let j = i + 1; j < clusterList.length; j++) {
        moved = tryResolveClusterPair(clusterList[i], clusterList[j], COLLISION_PADDING, blockMap) || moved;
      }
    }

    if (!moved) break;
  }
}

function classifyRootComponents(blocks, connections) {
  const adjacency = new Map();
  const inDegree = new Map();
  const outDegree = new Map();

  for (const block of blocks) {
    adjacency.set(block.id, new Set());
    inDegree.set(block.id, 0);
    outDegree.set(block.id, 0);
  }

  for (const conn of connections) {
    if (!adjacency.has(conn.fromId) || !adjacency.has(conn.toId)) continue;
    adjacency.get(conn.fromId).add(conn.toId);
    adjacency.get(conn.toId).add(conn.fromId);
    outDegree.set(conn.fromId, (outDegree.get(conn.fromId) || 0) + 1);
    inDegree.set(conn.toId, (inDegree.get(conn.toId) || 0) + 1);
  }

  return blocks.map(block => ({
    id: block.id,
    isolatedRootCard: (inDegree.get(block.id) || 0) === 0 && (outDegree.get(block.id) || 0) === 0,
  }));
}

function getBoundsForBlockIds(blockIds, blockMap) {
  const items = blockIds
    .map(id => blockMap[id])
    .filter(block => block && block.x !== undefined && block.y !== undefined);

  if (items.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    };
  }

  const bbox = getBoundingBox(items);
  return {
    minX: bbox.x,
    minY: bbox.y,
    maxX: bbox.x + bbox.width,
    maxY: bbox.y + bbox.height,
    width: bbox.width,
    height: bbox.height,
  };
}

function getBoundsForBlocks(items) {
  if (items.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    };
  }

  const bbox = getBoundingBox(items);
  return {
    minX: bbox.x,
    minY: bbox.y,
    maxX: bbox.x + bbox.width,
    maxY: bbox.y + bbox.height,
    width: bbox.width,
    height: bbox.height,
  };
}

function translateBlocksById(blockIds, dx, dy, blockMap) {
  if (!dx && !dy) return;
  for (const blockId of blockIds) {
    const block = blockMap[blockId];
    if (!block || isPositionLocked(block) || block.x === undefined || block.y === undefined) continue;
    block.x += dx;
    block.y += dy;
  }
}

function packFloatingRootCards(floatingRootIds, allBlocks, blockMap) {
  if (floatingRootIds.length === 0) return;

  const floatingRoots = floatingRootIds
    .map(id => blockMap[id])
    .filter(block => block && block.x !== undefined && block.y !== undefined);
  if (floatingRoots.length === 0) return;

  const nonFloatingBlocks = allBlocks.filter(block => !floatingRootIds.includes(block.id));
  const primaryBounds = getBoundsForBlocks(nonFloatingBlocks.length > 0 ? nonFloatingBlocks : allBlocks);

  const FLOATING_GAP_X = 60;
  const FLOATING_GAP_Y = 30;
  const FLOATING_TOP_GAP = 80;
  const maxWidth = Math.max(primaryBounds.width, 3 * BLOCK_W + 2 * FLOATING_GAP_X);
  let currentX = primaryBounds.minX;
  let currentY = primaryBounds.maxY + FLOATING_TOP_GAP;
  let rowHeight = 0;

  for (const block of floatingRoots) {
    const width = getBlockWidth(block);
    const height = getBlockHeight(block);
    if (currentX > primaryBounds.minX && currentX + width > primaryBounds.minX + maxWidth) {
      currentX = primaryBounds.minX;
      currentY += rowHeight + FLOATING_GAP_Y;
      rowHeight = 0;
    }

    const dx = currentX - block.x;
    const dy = currentY - block.y;
    translateBlocksById([block.id], dx, dy, blockMap);
    currentX += width + FLOATING_GAP_X;
    rowHeight = Math.max(rowHeight, height);
  }
}

function getBlockBounds(block, padding = 0) {
  return {
    minX: block.x - padding,
    minY: block.y - padding,
    maxX: block.x + getBlockWidth(block) + padding,
    maxY: block.y + getBlockHeight(block) + padding,
  };
}

function buildRoutingCorridorsForCluster(cluster, blockMap) {
  const parent = blockMap[cluster.parentId];
  if (!parent || !cluster?.bbox) return [];

  const childCenters = cluster.leafIds
    .map(id => blockMap[id])
    .filter(block => block && block.x !== undefined && block.y !== undefined)
    .map(block => block.x + getBlockWidth(block) / 2)
    .sort((a, b) => a - b);
  if (childCenters.length < 2) return [];

  const parentCx = parent.x + getBlockWidth(parent) / 2;
  const parentBottom = parent.y + getBlockHeight(parent);
  const minChildY = cluster.bbox.minY;
  if (minChildY <= parentBottom) return [];

  const junctionY = getSourceJunctionY(parentBottom, minChildY);
  const junctionMoveRatio = getSourceJunctionMoveRatio(parentBottom, minChildY);
  const leftmost = childCenters[0];
  const rightmost = childCenters[childCenters.length - 1];
  const spread = rightmost - leftmost;
  const padding = 24;
  const corridors = [
    {
      minX: parentCx - padding,
      minY: parentBottom,
      maxX: parentCx + padding,
      maxY: junctionY,
      role: 'trunk',
      centerY: (parentBottom + junctionY) / 2,
    },
  ];

  if (childCenters.length >= 4 && spread > 200) {
    corridors.push({
      minX: leftmost - padding,
      minY: junctionY - padding,
      maxX: rightmost + padding,
      maxY: junctionY + padding,
      role: 'rail',
      centerY: junctionY,
      moveRatio: junctionMoveRatio,
    });
    for (const childCx of childCenters) {
      corridors.push({
        minX: childCx - padding,
        minY: junctionY,
        maxX: childCx + padding,
        maxY: minChildY,
        role: 'drop',
        centerY: (junctionY + minChildY) / 2,
      });
    }
  }

  return corridors;
}

function getRoutingCorridorShift(cluster, blocks, blockMap) {
  const corridors = buildRoutingCorridorsForCluster(cluster, blockMap);
  if (corridors.length === 0) return 0;

  const ignoredIds = new Set([cluster.parentId, ...cluster.leafIds]);
  let neededDy = 0;
  for (const corridor of corridors) {
    for (const block of blocks) {
      if (!block || block.isVirtual || ignoredIds.has(block.id)) continue;
      if (block.x === undefined || block.y === undefined) continue;
      const bounds = getBlockBounds(block, 18);
      if (!overlapsBox(corridor, bounds)) continue;

      const movesWithCluster = corridor.role === 'drop';
      const junctionMovesPartially = corridor.role === 'rail';
      const moveRatio = movesWithCluster ? 1 : (junctionMovesPartially ? corridor.moveRatio : 0);
      if (moveRatio <= 0) continue;

      const corridorReferenceY = corridor.role === 'rail' ? corridor.centerY : corridor.minY;
      neededDy = Math.max(
        neededDy,
        Math.ceil((bounds.maxY + 12 - corridorReferenceY) / moveRatio)
      );
    }
  }

  return Math.min(Math.max(0, neededDy), 220);
}

function reserveClusterRoutingCorridors(blocks, clusters, blockMap) {
  if (!clusters || !hasClusters(clusters)) return;
  const clusterList = Object.values(clusters);

  refreshAllClusterBounds(clusters, blockMap);
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const cluster of clusterList) {
      updateClusterBoundingBox(cluster, blockMap);
      const dy = getRoutingCorridorShift(cluster, blocks, blockMap);
      if (dy <= 0) continue;
      moveClusterVertically(cluster, dy, blockMap);
      moved = true;
    }
    if (!moved) break;
  }
}

function layoutSingleComponent(blocks, connections, blockMap, originallyTallIds = new Set()) {
  const leafClusters = identifyLeafClusters(blocks, connections, blockMap, originallyTallIds);
  const strippedLeafIds = getStrippedLeafIds(leafClusters);
  const skeletonBlocks = getSkeletonBlocks(blocks, strippedLeafIds);
  const skeletonConnections = getSkeletonConnections(connections, strippedLeafIds);

  const { layer } = assignLayers(skeletonBlocks, skeletonConnections);
  const { activeBlocks, activeConnections } = insertVirtualNodes(skeletonBlocks, skeletonConnections, layer);
  const orderedLayers = barycentricSort(activeBlocks, activeConnections, layer);

  reorderLeavesToOuterSide(orderedLayers, activeConnections, activeBlocks);

  console.log('=== Barycenter 优化布局结果 ===');
  for (const [layerNum, blockIds] of Object.entries(orderedLayers)) {
    console.log(`Layer ${layerNum}: [${blockIds.length} nodes]`);
  }
  const minCrossings = countTotalCrossings(orderedLayers, activeConnections);
  console.log(`Barycenter 总计连线交叉: ${minCrossings}`);

  positionBlocks(activeBlocks, activeConnections, orderedLayers, layer);
  avoidBlockCrossing(activeBlocks, activeConnections);

  if (hasClusters(leafClusters)) {
    console.log(`=== Pass 2: 安置 ${getLeafCount(leafClusters)} 个叶子到网格 ===`);
    placeLeafGrids(blocks, connections, leafClusters, blockMap);
    resolveGridCollisions(blocks, leafClusters, blockMap);
    reserveClusterRoutingCorridors(blocks, leafClusters, blockMap);
  }

  runStablePass(blocks, connections, leafClusters, blockMap, layer);
  return { leafClusters, layer, activeBlocks };
}

function collectAllLeafClusters(states) {
  return Object.assign({}, ...states.map(state => state.leafClusters));
}

/**
 * 主函数：执行完整的分层布局（Two-Pass: 骨架优先 + 叶子网格填充）
 */
export function autoLayout(blocks, connections, groups = []) {
  if (blocks.length === 0) return;
  if (!validateLayoutInput(blocks)) return;

  const { originallyTallIds } = normalizeExtremePortraitBlocks(blocks);

  const blockMap = {};
  for (const b of blocks) blockMap[b.id] = b;

  console.log(`=== Two-Pass Layout ===`);

  const componentTags = classifyRootComponents(blocks, connections);
  const floatingRootIds = componentTags.filter(item => item.isolatedRootCard).map(item => item.id);
  const mainBlocks = blocks.filter(block => !floatingRootIds.includes(block.id));
  const mainBlockIds = new Set(mainBlocks.map(block => block.id));
  const mainConnections = connections.filter(conn => mainBlockIds.has(conn.fromId) && mainBlockIds.has(conn.toId));

  const layoutStates = [];
  if (mainBlocks.length > 0) {
    const mainBlockMap = {};
    for (const block of mainBlocks) mainBlockMap[block.id] = block;
    layoutStates.push(layoutSingleComponent(mainBlocks, mainConnections, mainBlockMap, originallyTallIds));
  }

  const allLeafClusters = collectAllLeafClusters(layoutStates);

  if (floatingRootIds.length > 0) {
    packFloatingRootCards(floatingRootIds, blocks.filter(block => !floatingRootIds.includes(block.id)), blockMap);
    refreshAllClusterBounds(allLeafClusters, blockMap);
  }

  resolveAllOverlaps(blocks, connections, allLeafClusters, blockMap);
  alignLinearChains(blocks, connections, allLeafClusters);
  normalizeLayoutBounds(blocks, allLeafClusters, blockMap);

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
          if (b && offset && b.id !== group.blockIds[0] && !isPositionLocked(b)) {
            const bWidth = getBlockWidth(b);
            b.x = repCx + offset.offsetX - bWidth / 2;
            b.y = repCy + offset.offsetY;
          }
        });
      }
    });
  }
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
