/**
 * canvas.js — 画布渲染 + 拖拽 + 缩放平移 + 内联编辑 + 颜色 + 右键菜单
 */

import { appState, pushHistory } from './state.js';
import { getBoundingBox } from './utils/layout.js';
import { renderMarkdown } from './utils/parser.js';

const BLOCK_DEFAULT_W = 200;
const BLOCK_MIN_W = 120;
const BLOCK_MIN_H = 60;
const DRAG_THRESHOLD = 5;
const SNAP_GRID = 20;

/** 预设节点颜色 */
const NODE_COLORS = [
  { name: '默认',   value: null },
  { name: '黄色',   value: '#FFD600' },
  { name: '蓝色',   value: '#2979FF' },
  { name: '绿色',   value: '#00E676' },
  { name: '粉红',   value: '#FF4081' },
  { name: '紫色',   value: '#D500F9' },
  { name: '橙色',   value: '#FF9100' },
];

/** DOM 引用 */
let $view, $transform, $blockCanvas, $linkLayer, $zoomLabel, $nodeToolbar, $ctxMenu;

/** 回调 */
let onCanvasChange = () => {};
let onDeleteNode = () => {};
let onAddChild = () => {};
let onAddSibling = () => {};
let onCreateBlock = () => {};

/** 初始化画布 */
export function initCanvas(callbacks) {
  $view = document.getElementById('mindmapView');
  $transform = document.getElementById('canvasTransform');
  $blockCanvas = document.getElementById('blockCanvas');
  $linkLayer = document.getElementById('linkLayer');
  $zoomLabel = document.getElementById('zoomLabel');
  $nodeToolbar = document.getElementById('nodeToolbar');

  onCanvasChange = callbacks.onChange || (() => {});
  onDeleteNode = callbacks.onDelete || (() => {});
  onAddChild = callbacks.onAddChild || (() => {});
  onAddSibling = callbacks.onAddSibling || (() => {});
  onCreateBlock = callbacks.onCreateBlock || (() => {});

  createContextMenu();
  setupPanZoom();
  setupCanvasClick();
  setupKeyboard();
  createMinimap();
  renderEmptyState();
}

// ═══════════════════════════════════════
//  CONTEXT MENU
// ═══════════════════════════════════════

function createContextMenu() {
  $ctxMenu = document.createElement('div');
  $ctxMenu.className = 'ctx-menu';
  $ctxMenu.innerHTML = `
    <button class="ctx-item" data-action="edit">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 1.5l2.5 2.5L5 11.5H2.5V9L10 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      编辑标签
    </button>
    <button class="ctx-item" data-action="editContent">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M2 7h6M2 10h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      编辑内容
    </button>
    <div class="ctx-divider"></div>
    <button class="ctx-item" data-action="addChild">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      添加子块
    </button>
    <button class="ctx-item" data-action="addSibling">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M7 4v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      添加同级
    </button>
    <div class="ctx-divider"></div>
    <div class="ctx-color-section">
      <span class="ctx-color-label">颜色</span>
      <div class="ctx-color-row">
        ${NODE_COLORS.map(c =>
          `<button class="ctx-color-dot" data-color="${c.value || ''}" title="${c.name}" style="background:${c.value || 'rgba(255,255,255,0.1)'}; ${!c.value ? 'border: 1px dashed rgba(255,255,255,0.2)' : ''}"></button>`
        ).join('')}
      </div>
    </div>
    <div class="ctx-divider"></div>
    <button class="ctx-item ctx-danger" data-action="delete">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5h4V4M11 4l-.8 7.5a1 1 0 01-1 .9H4.8a1 1 0 01-1-.9L3 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      删除
    </button>
  `;
  $ctxMenu.style.display = 'none';
  document.body.appendChild($ctxMenu);

  // Ctx menu actions
  $ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    const colorDot = e.target.closest('[data-color]');

    if (colorDot) {
      const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
      if (block) {
        const colorVal = colorDot.dataset.color || null;
        block.color = colorVal;
        pushHistory();
        renderBlocks();
        onCanvasChange();
      }
      hideCtxMenu();
      return;
    }

    if (!item) return;
    const action = item.dataset.action;
    const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
    hideCtxMenu();

    switch (action) {
      case 'edit':
        if (block) startInlineEdit(block, 'label');
        break;
      case 'editContent':
        if (block) startInlineEdit(block, 'content');
        break;
      case 'addChild': onAddChild(); break;
      case 'addSibling': onAddSibling(); break;
      case 'delete': onDeleteNode(); break;
    }
  });

  // Close on click outside
  document.addEventListener('pointerdown', (e) => {
    if (!$ctxMenu.contains(e.target)) hideCtxMenu();
  });
}

function showCtxMenu(x, y) {
  $ctxMenu.style.display = 'block';
  $ctxMenu.style.left = `${x}px`;
  $ctxMenu.style.top = `${y}px`;

  // 确保不超出视口
  requestAnimationFrame(() => {
    const rect = $ctxMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) $ctxMenu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) $ctxMenu.style.top = `${y - rect.height}px`;
  });
}

function hideCtxMenu() {
  $ctxMenu.style.display = 'none';
}

// ═══════════════════════════════════════
//  INLINE EDITING
// ═══════════════════════════════════════

function startInlineEdit(block, field) {
  const el = $blockCanvas.querySelector(`[data-id="${block.id}"]`);
  if (!el) return;

  const targetEl = field === 'label'
    ? el.querySelector('.mm-label')
    : el.querySelector('.mm-content');

  if (targetEl) makeEditable(targetEl, block, field);
}

function makeEditable(el, block, field) {
  // If it's a placeholder content area, clear it before editing
  if (field === 'content' && el.classList.contains('mm-content-placeholder')) {
    el.textContent = '';
    el.classList.remove('mm-content-placeholder');
  } else {
    // 恢复为无格式原文本供编辑
    if (field === 'content') el.textContent = block.content || '';
    if (field === 'label') el.textContent = block.label || '';
  }

  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();

  // 选中全部文字
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finishEdit = () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    const newText = el.textContent.trim();
    if (newText !== (block[field] || '')) {
      block[field] = newText;
      // Auto-adjust: clear explicit height so block fits content
      delete block.height;
      const blockEl = el.closest('.mm-block');
      if (blockEl) blockEl.style.height = '';
      pushHistory();
      onCanvasChange();
    }
    // If content is empty, restore placeholder
    if (field === 'content' && !block.content) {
      el.textContent = '点击添加内容…';
      el.classList.add('mm-content-placeholder');
    } else if (field === 'content') {
      el.innerHTML = renderMarkdown(block.content);
    } else if (field === 'label') {
      el.textContent = block.label;
    }
    // Re-render links since node height may have changed
    renderLinks();
  };

  el.addEventListener('blur', finishEdit, { once: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') {
      el.textContent = block[field] || '';
      if (field === 'content' && !block[field]) {
        el.textContent = '点击添加内容…';
        el.classList.add('mm-content-placeholder');
      }
      el.blur();
    }
  });
}

// ═══════════════════════════════════════
//  EMPTY STATE
// ═══════════════════════════════════════

function renderEmptyState() {
  // 由 renderBlocks 在块为空时调用
}

// ═══════════════════════════════════════
//  PAN / ZOOM
// ═══════════════════════════════════════

function applyTransform() {
  const { zoom, panX, panY } = appState.viewport;
  $transform.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  updateMinimap();
}

function setupPanZoom() {
  let isPanning = false;
  let startX, startY;

  // 鼠标滚轮缩放
  $view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.min(4, Math.max(0.2, appState.viewport.zoom * delta));

    const rect = $view.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const scale = newZoom / appState.viewport.zoom;
    appState.viewport.panX = mx - scale * (mx - appState.viewport.panX);
    appState.viewport.panY = my - scale * (my - appState.viewport.panY);
    appState.viewport.zoom = newZoom;

    applyTransform();
  }, { passive: false });

  // 中键 / 空格+左键 拖拽
  let spaceDown = false;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT' && !e.target.isContentEditable) {
      spaceDown = true;
      $view.classList.add('grabbing');
      e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      if (!isPanning) $view.classList.remove('grabbing');
    }
  });

  $view.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      isPanning = true;
      startX = e.clientX - appState.viewport.panX;
      startY = e.clientY - appState.viewport.panY;
      $view.setPointerCapture(e.pointerId);
      $view.classList.add('grabbing');
      e.preventDefault();
    }
  });

  $view.addEventListener('pointermove', (e) => {
    if (!isPanning) return;
    appState.viewport.panX = e.clientX - startX;
    appState.viewport.panY = e.clientY - startY;
    applyTransform();
  });

  $view.addEventListener('pointerup', () => {
    if (isPanning) {
      isPanning = false;
      if (!spaceDown) $view.classList.remove('grabbing');
    }
  });
}

// ═══════════════════════════════════════
//  KEYBOARD
// ═══════════════════════════════════════

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Skip when editing text
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    // Delete / Backspace → 删除选中节点
    if ((e.key === 'Delete' || e.key === 'Backspace') && appState.selectedBlockId) {
      e.preventDefault();
      onDeleteNode();
      return;
    }

    // Tab → 添加子块
    if (e.key === 'Tab' && appState.selectedBlockId) {
      e.preventDefault();
      onAddChild();
      return;
    }

    // Enter → 添加同级块
    if (e.key === 'Enter' && appState.selectedBlockId) {
      e.preventDefault();
      onAddSibling();
      return;
    }

    // F2 → 编辑选中节点标签
    if (e.key === 'F2' && appState.selectedBlockId) {
      e.preventDefault();
      const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
      if (block) startInlineEdit(block, 'label');
      return;
    }

    // Escape → 取消选中
    if (e.key === 'Escape' && appState.selectedBlockId) {
      appState.selectedBlockId = null;
      $blockCanvas.querySelectorAll('.mm-block.selected').forEach(b => b.classList.remove('selected'));
      hideNodeToolbar();
      hideCtxMenu();
      return;
    }

    // Arrow keys → 导航节点
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && appState.selectedBlockId) {
      e.preventDefault();
      navigateNodes(e.key);
      return;
    }
  });
}

/** 根据方向键导航到最近的节点 */
function navigateNodes(key) {
  const current = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
  if (!current) return;

  let best = null;
  let bestDist = Infinity;
  const cx = current.x + (current.width || BLOCK_DEFAULT_W) / 2;
  const cy = current.y;

  for (const b of appState.canvas.blocks) {
    if (b.id === current.id) continue;
    const bx = b.x + (b.width || BLOCK_DEFAULT_W) / 2;
    const by = b.y;
    const dx = bx - cx;
    const dy = by - cy;

    let valid = false;
    switch (key) {
      case 'ArrowUp':    valid = dy < -20; break;
      case 'ArrowDown':  valid = dy > 20; break;
      case 'ArrowLeft':  valid = dx < -20; break;
      case 'ArrowRight': valid = dx > 20; break;
    }
    if (!valid) continue;

    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }

  if (best) {
    appState.selectedBlockId = best.id;
    $blockCanvas.querySelectorAll('.mm-block.selected').forEach(b => b.classList.remove('selected'));
    const el = $blockCanvas.querySelector(`[data-id="${best.id}"]`);
    if (el) el.classList.add('selected');
    showNodeToolbar(best);
  }
}

function setupCanvasClick() {
  // 单击空白 → 取消选中
  $view.addEventListener('pointerdown', (e) => {
    if (e.target === $view || e.target === $transform || e.target === $blockCanvas) {
      appState.selectedBlockId = null;
      $blockCanvas.querySelectorAll('.mm-block.selected').forEach(b => b.classList.remove('selected'));
      hideNodeToolbar();
      hideCtxMenu();
    }
  });

  // 双击空白 → 创建新块
  $view.addEventListener('dblclick', (e) => {
    if (e.target !== $view && e.target !== $transform && e.target !== $blockCanvas) return;
    const zoom = appState.viewport.zoom;
    const rect = $view.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left - appState.viewport.panX) / zoom;
    const canvasY = (e.clientY - rect.top - appState.viewport.panY) / zoom;
    // Snap to grid
    const x = Math.round(canvasX / SNAP_GRID) * SNAP_GRID;
    const y = Math.round(canvasY / SNAP_GRID) * SNAP_GRID;
    onCreateBlock(x, y);
  });
}

// ═══════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════

function getBlockWidth(block) {
  return block.width || BLOCK_DEFAULT_W;
}

function renderLinks() {
  const blockMap = {};
  for (const b of appState.canvas.blocks) blockMap[b.id] = b;

  const validConnIds = new Set();

  for (const conn of appState.canvas.connections) {
    const from = blockMap[conn.fromId];
    const to = blockMap[conn.toId];
    if (!from || !to) continue;

    validConnIds.add(conn.id);

    const fromW = getBlockWidth(from);
    const toW = getBlockWidth(to);
    const x1 = from.x + fromW / 2;
    // Use actual rendered height if available, fallback to min height
    const fromEl = $blockCanvas.querySelector(`[data-id="${from.id}"]`);
    const fromH = fromEl ? fromEl.offsetHeight : BLOCK_MIN_H;
    const y1 = from.y + fromH;
    const x2 = to.x + toW / 2;
    const y2 = to.y;
    const midY = (y1 + y2) / 2;

    const pathD = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

    let path = $linkLayer.querySelector(`path[data-conn-id="${conn.id}"]`);
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('data-conn-id', conn.id);
      path.setAttribute('stroke-width', '3');
      path.setAttribute('fill', 'none');
      $linkLayer.appendChild(path);
    }

    path.setAttribute('d', pathD);

    // 连线颜色跟随父节点颜色
    if (from.color) {
      path.setAttribute('stroke', from.color);
      path.setAttribute('opacity', '1');
    } else {
      path.setAttribute('stroke', '#000');
      path.setAttribute('opacity', '1');
    }
  }

  // Remove stale paths that belong to connections
  const allConnPaths = $linkLayer.querySelectorAll('path[data-conn-id]');
  allConnPaths.forEach(p => {
    if (!validConnIds.has(p.getAttribute('data-conn-id'))) {
      p.remove();
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 渲染所有块 */
export function renderBlocks(newIds = []) {
  if (!appState.selectedBlockId) hideNodeToolbar();
  $blockCanvas.innerHTML = '';

  // 空画布引导
  if (appState.canvas.blocks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'canvas-empty-state';
    empty.innerHTML = `
      <div class="empty-icon">🎨</div>
      <p class="empty-title">白板是空的</p>
      <p class="empty-hint">双击画布创建新块，或在右侧对话框开始聊天<br/>点击「演示」按钮加载示例数据</p>
    `;
    $blockCanvas.appendChild(empty);
    applyTransform();
    updateMinimap();
    return;
  }

  for (const block of appState.canvas.blocks) {
    const el = document.createElement('article');
    el.className = 'mm-block';
    el.dataset.id = block.id;

    // 根节点
    const isRoot = !appState.canvas.connections.some(c => c.toId === block.id);
    if (isRoot) el.classList.add('root-node');

    if (block.id === appState.selectedBlockId) el.classList.add('selected');

    // 入场动画
    if (newIds.includes(block.id)) {
      el.classList.add('entering');
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    }

    // 节点颜色
    if (block.color) {
      el.style.backgroundColor = block.color;
      el.style.borderColor = '#000';
      el.style.color = '#000';
      el.style.setProperty('--node-accent', block.color);
      el.style.boxShadow = '4px 4px 0px #000';
    }

    el.style.left = `${block.x}px`;
    el.style.top = `${block.y}px`;

    // 自定义尺寸
    const blockW = block.width || BLOCK_DEFAULT_W;
    el.style.width = `${blockW}px`;
    if (block.height) {
      el.style.height = `${block.height}px`;
    }

    // 颜色条
    const colorBar = block.color
      ? `<div class="mm-color-bar" style="background:${block.color}"></div>`
      : '';

    const lockIcon = block.locked
      ? `<div class="mm-lock-icon" title="已锁定">🔒</div>`
      : '';

    el.innerHTML = `
      ${colorBar}
      ${lockIcon}
      <div class="mm-label">${escapeHtml(block.label)}</div>
      <div class="mm-content ${block.content ? '' : 'mm-content-placeholder'}">${block.content ? renderMarkdown(block.content) : '点击添加内容…'}</div>
      <div class="mm-resize-handle mm-resize-r" data-resize="r"></div>
      <div class="mm-resize-handle mm-resize-b" data-resize="b"></div>
      <div class="mm-resize-handle mm-resize-br" data-resize="br"></div>
      <div class="mm-link-handle" title="连线到其他块"></div>
    `;

    // 选中（不重建 DOM，仅切换 CSS 类，保留 dblclick）
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 如果点击的是 resize handle，不处理选中
      if (e.target.closest('.mm-resize-handle')) return;
      // 取消其他节点的选中状态
      $blockCanvas.querySelectorAll('.mm-block.selected').forEach(b => b.classList.remove('selected'));
      appState.selectedBlockId = block.id;
      el.classList.add('selected');
      showNodeToolbar(block);
      e.stopPropagation();
    });

    // 双击 → 内联编辑（点击 label 编辑标题，点击 content 编辑内容）
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const target = e.target.closest('.mm-content');
      if (target) {
        startInlineEdit(block, 'content');
      } else {
        startInlineEdit(block, 'label');
      }
    });

    // 右键菜单
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      $blockCanvas.querySelectorAll('.mm-block.selected').forEach(b => b.classList.remove('selected'));
      appState.selectedBlockId = block.id;
      el.classList.add('selected');
      showCtxMenu(e.clientX, e.clientY);
    });

    // 拖拽
    setupDrag(el, block);
    // 调整大小
    setupResize(el, block);
    // 连线
    setupLinkHandle(el, block);

    $blockCanvas.appendChild(el);
  }

  renderLinks();
  applyTransform();
  updateMinimap();
}

// ═══════════════════════════════════════
//  DRAG (with threshold to allow dblclick)
// ═══════════════════════════════════════

function setupDrag(el, block) {
  let dragReady = false;   // pointerdown happened, but threshold not crossed
  let dragging = false;    // actually dragging
  let offsetX, offsetY;
  let startScreenX, startScreenY;
  let pointerId = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.isContentEditable) return;
    if (block.locked) return; // 已锁定无法拖拽
    // Don't drag from resize handles
    if (e.target.closest('.mm-resize-handle')) return;

    dragReady = true;
    dragging = false;
    pointerId = e.pointerId;
    startScreenX = e.clientX;
    startScreenY = e.clientY;

    const zoom = appState.viewport.zoom;
    const rect = $view.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left - appState.viewport.panX) / zoom;
    const canvasY = (e.clientY - rect.top - appState.viewport.panY) / zoom;
    offsetX = canvasX - block.x;
    offsetY = canvasY - block.y;
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragReady && !dragging) return;

    // Check threshold before starting actual drag
    if (dragReady && !dragging) {
      const dx = e.clientX - startScreenX;
      const dy = e.clientY - startScreenY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      // Threshold crossed — start actual drag
      dragging = true;
      dragReady = false;
      el.classList.add('dragging');
      el.setPointerCapture(pointerId);
    }

    if (!dragging) return;
    const zoom = appState.viewport.zoom;
    const rect = $view.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left - appState.viewport.panX) / zoom;
    const canvasY = (e.clientY - rect.top - appState.viewport.panY) / zoom;
    // Snap to grid unless Alt is held
    if (e.altKey) {
      block.x = canvasX - offsetX;
      block.y = canvasY - offsetY;
    } else {
      block.x = Math.round((canvasX - offsetX) / SNAP_GRID) * SNAP_GRID;
      block.y = Math.round((canvasY - offsetY) / SNAP_GRID) * SNAP_GRID;
    }
    el.style.left = `${block.x}px`;
    el.style.top = `${block.y}px`;
    renderLinks();
    if (appState.selectedBlockId === block.id) hideNodeToolbar();
  });

  el.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false;
      el.classList.remove('dragging');
      pushHistory();
      onCanvasChange();
      if (appState.selectedBlockId === block.id) showNodeToolbar(block);
    }
    dragReady = false;
    pointerId = null;
  });
}

// ═══════════════════════════════════════
//  RESIZE
// ═══════════════════════════════════════

function setupResize(el, block) {
  const handles = el.querySelectorAll('.mm-resize-handle');

  handles.forEach(handle => {
    let resizing = false;
    let startW, startH, startScreenX, startScreenY;
    const direction = handle.dataset.resize; // 'r', 'b', or 'br'

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      resizing = true;
      handle.setPointerCapture(e.pointerId);

      startW = block.width || el.offsetWidth;
      startH = block.height || el.offsetHeight;
      startScreenX = e.clientX;
      startScreenY = e.clientY;

      el.classList.add('resizing');
    });

    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const zoom = appState.viewport.zoom;
      const dx = (e.clientX - startScreenX) / zoom;
      const dy = (e.clientY - startScreenY) / zoom;

      if (direction === 'r' || direction === 'br') {
        block.width = Math.max(BLOCK_MIN_W, startW + dx);
        el.style.width = `${block.width}px`;
      }
      if (direction === 'b' || direction === 'br') {
        block.height = Math.max(BLOCK_MIN_H, startH + dy);
        el.style.height = `${block.height}px`;
      }

      renderLinks();
      if (appState.selectedBlockId === block.id) showNodeToolbar(block);
    });

    handle.addEventListener('pointerup', () => {
      if (resizing) {
        resizing = false;
        el.classList.remove('resizing');
        pushHistory();
        onCanvasChange();
      }
    });
  });
}

// ═══════════════════════════════════════
//  INTERACTIVE CONNECTIONS
// ═══════════════════════════════════════

function setupLinkHandle(el, block) {
  const handle = el.querySelector('.mm-link-handle');
  if (!handle) return;

  let linking = false;
  let tempPath = null;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    linking = true;
    handle.setPointerCapture(e.pointerId);

    // Create temporary path
    tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (block.color) {
      tempPath.setAttribute('stroke', block.color);
    } else {
      tempPath.setAttribute('stroke', '#000');
    }
    tempPath.setAttribute('stroke-width', '2');
    tempPath.setAttribute('stroke-dasharray', '5 5');
    tempPath.setAttribute('fill', 'none');
    tempPath.setAttribute('class', 'temp-link');
    $linkLayer.appendChild(tempPath);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!linking || !tempPath) return;
    const zoom = appState.viewport.zoom;
    const rect = $view.getBoundingClientRect();
    
    const startX = block.x + getBlockWidth(block) / 2;
    const startY = block.y + el.offsetHeight;
    
    const endX = (e.clientX - rect.left - appState.viewport.panX) / zoom;
    const endY = (e.clientY - rect.top - appState.viewport.panY) / zoom;
    
    const midY = (startY + endY) / 2;
    tempPath.setAttribute('d', `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`);
  });

  handle.addEventListener('pointerup', (e) => {
    if (!linking) return;
    linking = false;
    if (tempPath) {
      tempPath.remove();
      tempPath = null;
    }
    
    // Check what was dropped ON
    handle.style.pointerEvents = 'none';
    el.style.pointerEvents = 'none';
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    handle.style.pointerEvents = 'auto';
    el.style.pointerEvents = 'auto';
    
    const targetBlockEl = targetEl ? targetEl.closest('.mm-block') : null;
    
    if (targetBlockEl) {
      const targetId = targetBlockEl.dataset.id;
      if (targetId && targetId !== block.id) {
        // Validation: No duplicates, No cycles
        const exists = appState.canvas.connections.some(c => c.fromId === block.id && c.toId === targetId);
        const causesCycle = hasPath(targetId, block.id, appState.canvas.connections);
        
        if (!exists && !causesCycle) {
          appState.canvas.connections.push({
            id: crypto.randomUUID(),
            fromId: block.id,
            toId: targetId
          });
          pushHistory();
          renderLinks();
          updateMinimap();
          onCanvasChange();
        }
      }
    }
  });
}

/** Check if there is a path from startId to targetId in existing connections */
function hasPath(startId, targetId, connections) {
  if (startId === targetId) return true;
  for (const conn of connections) {
    if (conn.fromId === startId) {
      if (hasPath(conn.toId, targetId, connections)) {
        return true;
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════
//  NODE TOOLBAR
// ═══════════════════════════════════════

function showNodeToolbar(block) {
  const zoom = appState.viewport.zoom;
  const el = $blockCanvas.querySelector(`[data-id="${block.id}"]`);
  const blockH = el ? el.offsetHeight : BLOCK_MIN_H;
  const blockW = getBlockWidth(block);

  // Calculate node position in viewport
  const nodeRight = (block.x + blockW) * zoom + appState.viewport.panX;
  const nodeBottom = (block.y + blockH) * zoom + appState.viewport.panY;
  const nodeTop = block.y * zoom + appState.viewport.panY;

  // Get toolbar dimensions
  const toolbarRect = $nodeToolbar.getBoundingClientRect();
  const toolbarH = toolbarRect.height || 150;
  const toolbarW = toolbarRect.width || 100;

  // Get viewport bounds
  const viewRect = $view.getBoundingClientRect();
  const topbarOffset = 52;

  // Position toolbar to the right of the node
  let px = nodeRight + 8;
  let py = nodeTop + topbarOffset;

  // Prevent right edge overflow
  if (px + toolbarW > viewRect.right) {
    px = nodeRight - toolbarW - 8;
  }

  // Prevent bottom edge overflow
  if (py + toolbarH > viewRect.bottom) {
    py = Math.max(topbarOffset, nodeBottom - toolbarH);
  }

  // Prevent top edge overflow
  if (py < topbarOffset) {
    py = topbarOffset;
  }

  $nodeToolbar.style.left = `${px}px`;
  $nodeToolbar.style.top = `${py}px`;
  $nodeToolbar.classList.add('visible');
  $nodeToolbar.setAttribute('aria-hidden', 'false');
}

export function hideNodeToolbar() {
  $nodeToolbar.classList.remove('visible');
  $nodeToolbar.setAttribute('aria-hidden', 'true');
}

// ═══════════════════════════════════════
//  ZOOM
// ═══════════════════════════════════════

export function zoomIn() {
  appState.viewport.zoom = Math.min(4, appState.viewport.zoom * 1.15);
  applyTransform();
}

export function zoomOut() {
  appState.viewport.zoom = Math.max(0.2, appState.viewport.zoom * 0.85);
  applyTransform();
}

export function fitToView() {
  const box = getBoundingBox(appState.canvas.blocks, getBlockWidth);
  const viewRect = $view.getBoundingClientRect();
  const pad = 80;

  const scaleX = (viewRect.width - pad * 2) / (box.width || 800);
  const scaleY = (viewRect.height - pad * 2) / (box.height || 600);
  const zoom = Math.max(0.2, Math.min(2, Math.min(scaleX, scaleY)));

  appState.viewport.zoom = zoom;
  appState.viewport.panX = pad - box.x * zoom + (viewRect.width - pad * 2 - box.width * zoom) / 2;
  appState.viewport.panY = pad - box.y * zoom + (viewRect.height - pad * 2 - box.height * zoom) / 2;

  applyTransform();
}

// ═══════════════════════════════════════
//  MINIMAP
// ═══════════════════════════════════════

let $minimap, $minimapCanvas, minimapCtx;

function createMinimap() {
  $minimap = document.createElement('div');
  $minimap.className = 'canvas-minimap';
  $minimap.innerHTML = `
    <canvas class="minimap-canvas" width="180" height="120"></canvas>
    <div class="minimap-viewport"></div>
  `;
  document.querySelector('.canvas-area').appendChild($minimap);
  $minimapCanvas = $minimap.querySelector('.minimap-canvas');
  minimapCtx = $minimapCanvas.getContext('2d');

  // Click on minimap to navigate
  $minimap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const rect = $minimapCanvas.getBoundingClientRect();
    navigateMinimap(e.clientX - rect.left, e.clientY - rect.top);
  });
  $minimap.addEventListener('pointermove', (e) => {
    if (e.buttons !== 1) return;
    const rect = $minimapCanvas.getBoundingClientRect();
    navigateMinimap(e.clientX - rect.left, e.clientY - rect.top);
  });
}

function navigateMinimap(mx, my) {
  const blocks = appState.canvas.blocks;
  if (blocks.length === 0) return;

  const box = getBoundingBox(blocks, getBlockWidth);
  const pad = 20;
  const scale = Math.min(
    (180 - pad * 2) / (box.width || 1),
    (120 - pad * 2) / (box.height || 1)
  );

  const viewRect = $view.getBoundingClientRect();
  const targetCanvasX = box.x + (mx - pad) / scale;
  const targetCanvasY = box.y + (my - pad) / scale;

  appState.viewport.panX = viewRect.width / 2 - targetCanvasX * appState.viewport.zoom;
  appState.viewport.panY = viewRect.height / 2 - targetCanvasY * appState.viewport.zoom;
  applyTransform();
  updateMinimap();
}

function updateMinimap() {
  if (!minimapCtx) return;
  const blocks = appState.canvas.blocks;
  const w = 180, h = 120;

  minimapCtx.clearRect(0, 0, w, h);

  if (blocks.length === 0) return;

  const box = getBoundingBox(blocks, getBlockWidth);
  const pad = 20;
  const scale = Math.min(
    (w - pad * 2) / (box.width || 1),
    (h - pad * 2) / (box.height || 1)
  );

  // Draw connections
  minimapCtx.strokeStyle = '#000';
  minimapCtx.lineWidth = 2;
  minimapCtx.lineWidth = 1;
  const blockMap = {};
  for (const b of blocks) blockMap[b.id] = b;
  for (const conn of appState.canvas.connections) {
    const from = blockMap[conn.fromId];
    const to = blockMap[conn.toId];
    if (!from || !to) continue;
    const x1 = pad + (from.x + (from.width || BLOCK_DEFAULT_W) / 2 - box.x) * scale;
    const y1 = pad + (from.y + 36 - box.y) * scale;
    const x2 = pad + (to.x + (to.width || BLOCK_DEFAULT_W) / 2 - box.x) * scale;
    const y2 = pad + (to.y - box.y) * scale;
    minimapCtx.beginPath();
    minimapCtx.moveTo(x1, y1);
    minimapCtx.lineTo(x2, y2);
    minimapCtx.stroke();
  }

  // Draw blocks
  for (const b of blocks) {
    const bw = (b.width || BLOCK_DEFAULT_W) * scale;
    const bh = 36 * scale;
    const bx = pad + (b.x - box.x) * scale;
    const by = pad + (b.y - box.y) * scale;

    if (b.id === appState.selectedBlockId) {
      minimapCtx.fillStyle = '#FFD600';
    } else if (b.color) {
      minimapCtx.fillStyle = b.color;
    } else {
      minimapCtx.fillStyle = '#ffffff';
    }
    minimapCtx.fillRect(bx, by, Math.max(bw, 3), Math.max(bh, 2));
  }

  // Draw viewport rectangle
  const viewRect = $view.getBoundingClientRect();
  const zoom = appState.viewport.zoom;
  const vx = pad + ((-appState.viewport.panX / zoom) - box.x) * scale;
  const vy = pad + ((-appState.viewport.panY / zoom) - box.y) * scale;
  const vw = (viewRect.width / zoom) * scale;
  const vh = (viewRect.height / zoom) * scale;

  minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  minimapCtx.lineWidth = 1.5;
  minimapCtx.strokeRect(vx, vy, vw, vh);
}
