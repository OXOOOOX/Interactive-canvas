/**
 * canvas.js — 画布渲染 + 拖拽 + 缩放平移 + 内联编辑 + 颜色 + 右键菜单
 */

import { appState, pushHistory, createGroup, deleteGroup, getGroupBlocks, getBlockGroup, getBlockGroups, renameGroup, suggestGroupName, saveCurrentCanvas, toggleGroupFold, addBlocksToGroup, removeBlocksFromGroup, loadConfig } from './state.js';
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
let $view, $transform, $blockCanvas, $linkLayer, $zoomLabel, $nodeToolbar, $ctxMenu, $linkScissorsModeBtn, $scissorsLayer;

/** 回调 */
let onCanvasChange = () => {};
let onDeleteNode = () => {};
let onAddChild = () => {};
let onAddSibling = () => {};
let onCreateBlock = () => {};

/** 剪刀模式状态 */
let scissorsMode = false;

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
  createScissorsModeButton();
  createScissorsLayer();
  renderEmptyState();

  // 初始化剪刀按钮位置
  setScissorsBtnPosition();
}

/** 创建剪刀按钮层 */
function createScissorsLayer() {
  const scissorsLayer = document.createElement('div');
  scissorsLayer.id = 'scissorsLayer';
  scissorsLayer.className = 'scissors-layer';
  scissorsLayer.style.pointerEvents = 'none';  // 层本身不响应事件
  // 剪刀层需要和 canvasTransform 一样的尺寸和变换
  scissorsLayer.style.position = 'absolute';
  scissorsLayer.style.top = '0';
  scissorsLayer.style.left = '0';
  scissorsLayer.style.width = '6000px';
  scissorsLayer.style.height = '6000px';
  scissorsLayer.style.transformOrigin = '0 0';
  $transform.appendChild(scissorsLayer);
  $scissorsLayer = scissorsLayer;  // 保存引用
}

/** 创建剪刀模式按钮 */
function createScissorsModeButton() {
  $linkScissorsModeBtn = document.createElement('button');
  $linkScissorsModeBtn.className = 'link-scissors-mode-btn';
  $linkScissorsModeBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="6" cy="6" r="3"/>
      <circle cx="6" cy="18" r="3"/>
      <line x1="20" y1="4" x2="8.12" y2="15.88"/>
      <line x1="14.47" y1="14.48" x2="20" y2="20"/>
      <line x1="8.12" y1="8.12" x2="12" y2="12"/>
    </svg>
  `;
  $linkScissorsModeBtn.title = '开启剪刀模式（点击连线删除）';
  $linkScissorsModeBtn.addEventListener('click', toggleScissorsMode);
  $view.appendChild($linkScissorsModeBtn);
}

/** 更新多选 UI 样式 */
function updateMultiSelectUI() {
  $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
    b.classList.remove('selected');
    b.classList.remove('selected-multi');
  });

  appState.selectedBlockIds.forEach(id => {
    const el = $blockCanvas.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.classList.add('selected-multi');
      // 如果只有一个选中，同时添加 selected 类
      if (appState.selectedBlockIds.length === 1) {
        el.classList.add('selected');
      }
    }
  });
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
    <!-- 组操作 -->
    <button class="ctx-item group-action" data-action="create-group" style="display:none;">
      🔗 创建组
    </button>
    <!-- 加入组子菜单 -->
    <div class="ctx-item group-action ctx-submenu-trigger" data-submenu="add-to-group" style="display:none;">
      📁 加入组
      <div class="ctx-submenu">
        <!-- 动态生成 -->
      </div>
    </div>
    <!-- 退出组子菜单 -->
    <div class="ctx-item group-action ctx-submenu-trigger" data-submenu="remove-from-group" style="display:none;">
      🚪 退出组
      <div class="ctx-submenu">
        <!-- 动态生成 -->
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

  // 清除之前的鼠标悬停监听器（如果有）
  const oldClone = $ctxMenu.cloneNode(true);
  $ctxMenu.parentNode?.replaceChild($ctxMenu, $ctxMenu);

  // Ctx menu actions
  $ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    const colorDot = e.target.closest('[data-color]');

    if (colorDot) {
      const colorVal = colorDot.dataset.color || null;
      // 支持多选时同时修改多个块的颜色
      if (appState.selectedBlockIds.length > 0) {
        appState.selectedBlockIds.forEach(id => {
          const block = appState.canvas.blocks.find(b => b.id === id);
          if (block) {
            block.color = colorVal;
          }
        });
      } else {
        const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
        if (block) {
          block.color = colorVal;
        }
      }
      pushHistory();
      renderBlocks();
      onCanvasChange();
      hideCtxMenu();
      return;
    }

    if (!item) return;
    const action = item.dataset.action;

    if (action === 'create-group') {
      hideCtxMenu();
      handleCreateGroupFromMenu();
      return;
    }

    // 加入组
    if (action === 'add-to-group-single') {
      const groupId = item.dataset.groupId;
      hideCtxMenu();
      if (groupId) {
        addBlocksToGroup(appState.selectedBlockIds, groupId);
        pushHistory();
        renderBlocks();
        onCanvasChange();
      }
      return;
    }

    // 退出组
    if (action === 'remove-from-group-single') {
      const groupId = item.dataset.groupId;
      hideCtxMenu();
      if (groupId) {
        removeBlocksFromGroup(appState.selectedBlockIds, groupId);
        pushHistory();
        renderBlocks();
        onCanvasChange();
      }
      return;
    }

    hideCtxMenu();

    const block = appState.canvas.blocks.find(b => b.id === appState.selectedBlockId);
    switch (action) {
      case 'edit':
        if (block) startInlineEdit(block, 'label');
        break;
      case 'editContent':
        if (block) startInlineEdit(block, 'content');
        break;
      case 'addChild': onAddChild(); break;
      case 'addSibling': onAddSibling(); break;
      case 'delete':
        // 支持多选删除
        if (appState.selectedBlockIds.length > 0) {
          onDeleteNode();
        } else if (block) {
          onDeleteNode();
        }
        break;
    }
  });

  // Close on click outside
  document.addEventListener('pointerdown', (e) => {
    if (!$ctxMenu.contains(e.target)) hideCtxMenu();
  });
}

function showCtxMenu(x, y, clickedBlock) {
  const selectedCount = appState.selectedBlockIds.length;
  const selectedBlocks = appState.canvas.blocks.filter(b =>
    appState.selectedBlockIds.includes(b.id)
  );

  // 收集所有选中的块所属的组 ID
  const allGroupIds = [];
  selectedBlocks.forEach(b => {
    if (b.groupIds) {
      allGroupIds.push(...b.groupIds);
    }
  });
  const uniqueGroupIds = new Set(allGroupIds);

  // 更新菜单项显示
  const createGroupBtn = $ctxMenu.querySelector('[data-action="create-group"]');

  if (createGroupBtn) {
    createGroupBtn.style.display = selectedCount >= 2 ? 'block' : 'none';
    createGroupBtn.textContent = selectedCount >= 2 ? `🔗 创建组 (${selectedCount}个块)` : '🔗 创建组';
  }

  // 加入组子菜单和退出组子菜单
  const addToGroupSubmenu = $ctxMenu.querySelector('[data-submenu="add-to-group"]');
  const removeFromGroupSubmenu = $ctxMenu.querySelector('[data-submenu="remove-from-group"]');

  // 有选中的块且存在组 → 显示加入组子菜单
  const hasGroups = appState.canvas.groups && appState.canvas.groups.length > 0;
  if (addToGroupSubmenu) {
    addToGroupSubmenu.style.display = (selectedCount > 0 && hasGroups) ? 'block' : 'none';
    if (selectedCount > 0 && hasGroups) {
      const submenuContent = addToGroupSubmenu.querySelector('.ctx-submenu');
      if (submenuContent) {
        submenuContent.innerHTML = appState.canvas.groups.map(group => {
          const isAlreadyInGroup = selectedBlocks.every(b => b.groupIds && b.groupIds.includes(group.id));
          const disabled = isAlreadyInGroup ? ' disabled' : '';
          const suffix = isAlreadyInGroup ? ' (已在组内)' : '';
          return `<button class="ctx-item submenu-item" data-action="add-to-group-single" data-group-id="${group.id}"${disabled}>
            ${group.name || '组'}${suffix}
          </button>`;
        }).join('');
      }
    }
  }

  // 退出组子菜单：显示选中的块已经加入的组（交集）
  if (removeFromGroupSubmenu) {
    if (selectedCount > 0 && hasGroups) {
      // 找出所有选中块共同的组（交集）
      const commonGroupIds = new Set(selectedBlocks[0]?.groupIds || []);
      for (let i = 1; i < selectedBlocks.length; i++) {
        const blockGroupIds = new Set(selectedBlocks[i].groupIds || []);
        for (const id of commonGroupIds) {
          if (!blockGroupIds.has(id)) {
            commonGroupIds.delete(id);
          }
        }
      }

      // 只有当存在共同组时才显示退出组子菜单
      const hasCommonGroups = commonGroupIds.size > 0;
      removeFromGroupSubmenu.style.display = hasCommonGroups ? 'block' : 'none';

      if (hasCommonGroups) {
        const submenuContent = removeFromGroupSubmenu.querySelector('.ctx-submenu');
        if (submenuContent) {
          submenuContent.innerHTML = appState.canvas.groups
            .filter(group => commonGroupIds.has(group.id))
            .map(group => `
              <button class="ctx-item submenu-item" data-action="remove-from-group-single" data-group-id="${group.id}">
                ${group.name || '组'}
              </button>
            `).join('');
        }
      }
    } else {
      removeFromGroupSubmenu.style.display = 'none';
    }
  }

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

async function handleCreateGroupFromMenu() {
  const selectedIds = appState.selectedBlockIds;
  console.log('[Group] Creating group with selected ids:', selectedIds);

  if (selectedIds.length < 2) {
    console.warn('[Group] Not enough blocks selected:', selectedIds.length);
    alert('请至少选中 2 个块才能创建组');
    return;
  }

  // 确保 groups 数组存在
  if (!appState.canvas.groups) {
    appState.canvas.groups = [];
  }

  // 选择一个颜色（基于组的索引）
  const GROUP_COLORS_LOCAL = [
    { name: '黄色', value: '#FFD600' },
    { name: '蓝色', value: '#2979FF' },
    { name: '绿色', value: '#00E676' },
    { name: '粉红', value: '#FF4081' },
    { name: '紫色', value: '#D500F9' },
    { name: '橙色', value: '#FF9100' },
  ];
  const colorIndex = appState.canvas.groups.length % GROUP_COLORS_LOCAL.length;
  const color = GROUP_COLORS_LOCAL[colorIndex].value;

  // 先创建组（默认名称）
  const group = createGroup(selectedIds, color);
  console.log('[Group] Created group with default name:', group.name);

  // AI 推荐组名（异步，不阻塞创建）
  // 优先从 localStorage 读取配置，如果没有则尝试从 UI 表单读取
  let config = loadConfig();
  if (!config) {
    const apiKeyInput = document.getElementById('apiKey');
    if (apiKeyInput && apiKeyInput.value) {
      config = { apiKey: apiKeyInput.value };
    }
  }
  suggestGroupName(selectedIds, config).then(name => {
    if (name && name.length > 0) {
      console.log('[Group] AI recommended name:', name);
      group.name = name;
      updateGroupSelector();
      saveCurrentCanvas();
    }
  });

  pushHistory();
  renderBlocks();
  onCanvasChange();

  console.log('[Group] Group created successfully');
}

/**
 * 高亮显示指定组的所有成员块
 * @param {string} groupId - 组 ID
 * @param {boolean} highlight - 是否高亮
 * @param {string} borderColor - 边框颜色（可选，默认使用组的颜色）
 */
function highlightGroupMembers(groupId, highlight, borderColor = null) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return;

  // 如果没有指定颜色，使用组的颜色
  const color = borderColor || group.color;

  group.blockIds.forEach(blockId => {
    const el = $blockCanvas.querySelector(`[data-id="${blockId}"]`);
    if (el) {
      if (highlight) {
        el.classList.add('group-highlight');
        if (color) {
          el.style.setProperty('--highlight-color', color);
        }
      } else {
        el.classList.remove('group-highlight');
        el.style.removeProperty('--highlight-color');
      }
    }
  });
}

function hideCtxMenu() {
  // 清除所有高亮
  $blockCanvas.querySelectorAll('.group-highlight').forEach(el => {
    el.classList.remove('group-highlight');
    el.style.removeProperty('--highlight-color');
  });
  $ctxMenu.style.display = 'none';
}

// ═══════════════════════════════════════
//  CONNECTION LINE DELETE (Ctrl + Click)
// ═══════════════════════════════════════

let isCtrlPressed = false;
let $linkDeleteHint = null;

function handleLinkMouseEnter(e) {
  if (isCtrlPressed) {
    e.target.classList.add('ctrl-hover');
    showLinkDeleteHint(e);
  }
}

function handleLinkMouseLeave(e) {
  e.target.classList.remove('ctrl-hover');
  hideLinkDeleteHint();
}

function handleLinkClick(e) {
  if (!isCtrlPressed) return;

  const connId = e.target.getAttribute('data-conn-id');
  if (connId) {
    const connIndex = appState.canvas.connections.findIndex(c => c.id === connId);
    if (connIndex !== -1) {
      appState.canvas.connections.splice(connIndex, 1);
      pushHistory();
      renderLinks();
      updateMinimap();
      onCanvasChange();
      hideLinkDeleteHint();
    }
  }
}

function showLinkDeleteHint(e) {
  if (!$linkDeleteHint) {
    $linkDeleteHint = document.createElement('div');
    $linkDeleteHint.className = 'link-delete-hint';
    $linkDeleteHint.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12"/>
        <circle cx="12" cy="12" r="9"/>
      </svg>
      <span>点击删除连线</span>
    `;
    document.body.appendChild($linkDeleteHint);
  }
  $linkDeleteHint.style.left = `${e.clientX + 15}px`;
  $linkDeleteHint.style.top = `${e.clientY + 15}px`;
  $linkDeleteHint.classList.add('visible');
}

function hideLinkDeleteHint() {
  if ($linkDeleteHint) {
    $linkDeleteHint.classList.remove('visible');
  }
}

// 全局键盘事件监听
document.addEventListener('keydown', (e) => {
  if (e.key === 'Control' || e.key === 'Meta') {
    isCtrlPressed = true;
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || e.key === 'Meta') {
    isCtrlPressed = false;
    hideLinkDeleteHint();
    // 移除所有连线的 hover 状态
    $linkLayer.querySelectorAll('path.ctrl-hover').forEach(p => {
      p.classList.remove('ctrl-hover');
    });
  }
});

/** 删除指定 ID 的连接 */
function deleteConnection(connId) {
  const connIndex = appState.canvas.connections.findIndex(c => c.id === connId);
  if (connIndex !== -1) {
    appState.canvas.connections.splice(connIndex, 1);
    pushHistory();
    renderLinks();
    updateMinimap();
    onCanvasChange();
  }
}

/** 切换剪刀模式 */
function toggleScissorsMode() {
  scissorsMode = !scissorsMode;
  console.log('[剪刀模式] 状态:', scissorsMode ? '开启' : '关闭');
  renderLinks();
  // 更新按钮状态
  if ($linkScissorsModeBtn) {
    $linkScissorsModeBtn.classList.toggle('active', scissorsMode);
    $linkScissorsModeBtn.setAttribute('title', scissorsMode ? '关闭剪刀模式' : '开启剪刀模式（点击连线删除）');
  }
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

    // Delete / Backspace → 删除选中节点（支持多选）
    if ((e.key === 'Delete' || e.key === 'Backspace') && (appState.selectedBlockId || appState.selectedBlockIds.length > 0)) {
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
    if (e.key === 'Escape' && (appState.selectedBlockId || appState.selectedBlockIds.length > 0)) {
      e.preventDefault();
      appState.selectedBlockId = null;
      appState.selectedBlockIds = [];
      $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
        b.classList.remove('selected');
        b.classList.remove('selected-multi');
      });
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

  // 方向键导航时清除多选状态
  appState.selectedBlockIds = [];

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
    appState.selectedBlockIds = [best.id];
    $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
      b.classList.remove('selected');
      b.classList.remove('selected-multi');
    });
    const el = $blockCanvas.querySelector(`[data-id="${best.id}"]`);
    if (el) {
      el.classList.add('selected');
      el.classList.add('selected-multi');
    }
    showNodeToolbar(best);
  }
}

function setupCanvasClick() {
  // 单击空白 → 取消选中
  $view.addEventListener('pointerdown', (e) => {
    if (e.target === $view || e.target === $transform || e.target === $blockCanvas) {
      appState.selectedBlockId = null;
      appState.selectedBlockIds = [];
      $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
        b.classList.remove('selected');
        b.classList.remove('selected-multi');
      });
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
  // 清除旧的连线和剪刀按钮
  $linkLayer.innerHTML = '';
  $scissorsLayer?.querySelectorAll('.link-scissors-btn').forEach(btn => btn.remove());

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
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    const pathD = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

    let path = $linkLayer.querySelector(`path[data-conn-id="${conn.id}"]`);
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('data-conn-id', conn.id);
      path.setAttribute('stroke-width', '3');
      path.setAttribute('fill', 'none');
      path.style.pointerEvents = 'stroke';  // 只响应描边区域的点击
      path.style.cursor = 'default';
      $linkLayer.appendChild(path);

      // 为连线添加鼠标事件监听器（用于 Ctrl+ 点击删除）
      path.addEventListener('mouseenter', handleLinkMouseEnter);
      path.addEventListener('mouseleave', handleLinkMouseLeave);
      path.addEventListener('click', handleLinkClick);
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

    // 为每条连线添加剪刀按钮（触屏模式）
    let scissorsBtn = $scissorsLayer.querySelector(`.link-scissors-btn[data-conn-id="${conn.id}"]`);
    if (!scissorsBtn) {
      scissorsBtn = document.createElement('div');
      scissorsBtn.className = 'link-scissors-btn';
      scissorsBtn.setAttribute('data-conn-id', conn.id);
      scissorsBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="6" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <line x1="20" y1="4" x2="8.12" y2="15.88"/>
          <line x1="14.47" y1="14.48" x2="20" y2="20"/>
          <line x1="8.12" y1="8.12" x2="12" y2="12"/>
        </svg>
      `;
      scissorsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[剪刀按钮] 点击删除连线:', conn.id);
        deleteConnection(conn.id);
      });
      $scissorsLayer.appendChild(scissorsBtn);
      console.log('[剪刀按钮] 创建新按钮，连线 ID:', conn.id);
    }

    // 更新剪刀按钮位置（连线中点）
    // 注意：不需要手动乘以 zoom 或加上 panX/Y，因为 scissorsLayer 是 $transform 的子元素
    // transform 会自动应用这些变换
    const btnLeft = midX - 14;  // 14 是按钮宽度的一半 (28/2)
    const btnTop = midY - 14;   // 14 是按钮高度的一半 (28/2)

    if (scissorsMode) {
      scissorsBtn.classList.add('visible');
      scissorsBtn.style.left = `${btnLeft}px`;
      scissorsBtn.style.top = `${btnTop}px`;
    } else {
      scissorsBtn.classList.remove('visible');
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 渲染所有块 */
export function renderBlocks(newIds = []) {
  if (!appState.selectedBlockId && appState.selectedBlockIds.length === 0) hideNodeToolbar();
  $blockCanvas.innerHTML = '';
  $linkLayer.innerHTML = '';  // 清空连接线层

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
    updateGroupSelector();
    return;
  }

  // 收集所有折叠组内的块 ID（除了代表块）
  const foldedBlockIds = new Set();
  if (appState.canvas.groups && appState.canvas.groups.length > 0) {
    appState.canvas.groups.forEach(group => {
      if (group.folded && group.blockIds.length > 1) {
        // 折叠组：隐藏除第一个块外的所有块
        group.blockIds.slice(1).forEach(id => foldedBlockIds.add(id));
      }
    });
  }

  for (const block of appState.canvas.blocks) {
    // 跳过折叠组内被隐藏的块
    if (foldedBlockIds.has(block.id)) {
      continue;
    }

    const el = document.createElement('article');
    el.className = 'mm-block';
    el.dataset.id = block.id;

    // 根节点
    const isRoot = !appState.canvas.connections.some(c => c.toId === block.id);
    if (isRoot) el.classList.add('root-node');

    // 选中状态：单选或多选
    if (block.id === appState.selectedBlockId) {
      el.classList.add('selected');
    }
    if (appState.selectedBlockIds.includes(block.id)) {
      el.classList.add('selected-multi');
    }

    // 组标识 - 左上角颜色圆点
    if (block.groupId) {
      const group = getBlockGroup(block.id);
      if (group) {
        el.dataset.groupId = block.groupId;
        // 组内块添加特殊类
        el.classList.add('mm-block-in-group');
      }
    }

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

    // 组标识圆点（支持多组，显示多个圆点）
    const groupIndicators = block.groupIds && block.groupIds.length > 0
      ? block.groupIds.map(groupId => {
          const group = appState.canvas.groups.find(g => g.id === groupId);
          const color = group ? group.color : '#FFD600';
          const groupName = group ? `组 (${group.color})` : '组';
          // 如果是折叠组的代表块，添加折叠指示器
          const isFolded = group && group.folded && group.blockIds.length > 1;
          const foldedIcon = isFolded ? `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5h6M5 2v6" stroke="#000" stroke-width="1.5"/></svg>` : '';
          return `<div class="mm-group-indicator ${isFolded ? 'folded' : ''}" style="background:${color}" title="${isFolded ? '已折叠（点击展开）' : groupName}">${foldedIcon}</div>`;
        }).join('')
      : '';

    // 折叠指示器（显示块数量）
    let foldedBadge = '';
    if (block.groupIds && block.groupIds.length > 0) {
      block.groupIds.forEach(groupId => {
        const group = appState.canvas.groups.find(g => g.id === groupId);
        if (group && group.folded && group.blockIds.length > 1) {
          foldedBadge = `<div class="mm-folded-badge">+${group.blockIds.length - 1}块</div>`;
        }
      });
    }

    el.innerHTML = `
      ${colorBar}
      ${lockIcon}
      ${groupIndicators}
      ${foldedBadge}
      <div class="mm-label">${escapeHtml(block.label)}</div>
      <div class="mm-content ${block.content ? '' : 'mm-content-placeholder'}">${block.content ? renderMarkdown(block.content) : '点击添加内容…'}</div>
      <div class="mm-resize-handle mm-resize-r" data-resize="r"></div>
      <div class="mm-resize-handle mm-resize-b" data-resize="b"></div>
      <div class="mm-resize-handle mm-resize-br" data-resize="br"></div>
      <div class="mm-link-handle" title="连线到其他块"></div>
    `;

    // 为折叠指示器添加点击展开事件
    el.querySelectorAll('.mm-group-indicator.folded').forEach(indicator => {
      indicator.addEventListener('click', (e) => {
        e.stopPropagation();
        // 找到对应的组 ID 并展开
        block.groupIds.forEach(groupId => {
          const group = appState.canvas.groups.find(g => g.id === groupId);
          if (group && group.folded) {
            toggleGroupFold(groupId, false);
          }
        });
        renderBlocks();
        saveCurrentCanvas();
      });
    });

    // 选中（不重建 DOM，仅切换 CSS 类，保留 dblclick）
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 如果点击的是 resize handle，不处理选中
      if (e.target.closest('.mm-resize-handle')) return;

      const isMultiSelect = e.shiftKey || e.ctrlKey;

      if (!isMultiSelect) {
        // 单击：取消其他选中，只选中当前
        $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
          b.classList.remove('selected');
          b.classList.remove('selected-multi');
        });
        appState.selectedBlockIds = [block.id];
        appState.selectedBlockId = block.id;
        el.classList.add('selected');
        el.classList.add('selected-multi');
        showNodeToolbar(block);
      } else {
        // Shift/Ctrl+ 点击：累加/取消选中
        const idx = appState.selectedBlockIds.indexOf(block.id);
        if (idx > -1) {
          // 取消选中
          appState.selectedBlockIds = appState.selectedBlockIds.filter(id => id !== block.id);
          el.classList.remove('selected');
          el.classList.remove('selected-multi');
        } else {
          // 添加选中
          appState.selectedBlockIds.push(block.id);
          appState.selectedBlockId = block.id;
          el.classList.add('selected-multi');
        }
        // 更新所有选中块的样式
        updateMultiSelectUI();
        // 显示-toolbar（以最后选中的块为准）
        showNodeToolbar(block);
      }
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

      const isSelected = appState.selectedBlockIds.includes(block.id);

      // 如果当前块未被选中，则选中它（但不清空其他选中）
      if (!isSelected) {
        // 取消其他选中，只选中当前
        $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
          b.classList.remove('selected');
          b.classList.remove('selected-multi');
        });
        appState.selectedBlockIds = [block.id];
        appState.selectedBlockId = block.id;
        el.classList.add('selected');
        el.classList.add('selected-multi');
      }

      showCtxMenu(e.clientX, e.clientY, block);
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
  updateGroupSelector();
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
  let initialPositions = []; // 记录组内所有块的初始位置

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

    // 如果块在组内（且只属于一个组），记录组内所有块的初始位置
    if (block.groupIds && block.groupIds.length === 1) {
      const groupId = block.groupIds[0];
      const groupBlocks = getGroupBlocks(groupId);
      initialPositions = groupBlocks.map(b => ({
        id: b.id,
        x: b.x,
        y: b.y,
        el: $blockCanvas.querySelector(`[data-id="${b.id}"]`)
      }));
    }
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
    let newX, newY;
    if (e.altKey) {
      newX = canvasX - offsetX;
      newY = canvasY - offsetY;
    } else {
      newX = Math.round((canvasX - offsetX) / SNAP_GRID) * SNAP_GRID;
      newY = Math.round((canvasY - offsetY) / SNAP_GRID) * SNAP_GRID;
    }

    block.x = newX;
    block.y = newY;
    el.style.left = `${block.x}px`;
    el.style.top = `${block.y}px`;

    // 如果块在组内（且只属于一个组），同时移动组内所有其他块
    if (block.groupIds && block.groupIds.length === 1 && initialPositions.length > 0) {
      const currentInitPos = initialPositions.find(p => p.id === block.id);
      if (currentInitPos) {
        const dx = block.x - currentInitPos.x;
        const dy = block.y - currentInitPos.y;

        initialPositions.forEach(p => {
          if (p.id !== block.id) {
            const b = appState.canvas.blocks.find(b => b.id === p.id);
            if (b) {
              b.x = p.x + dx;
              b.y = p.y + dy;
              p.el.style.left = `${b.x}px`;
              p.el.style.top = `${b.y}px`;
            }
          }
        });
      }
    }

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
    initialPositions = [];
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

/** 设置剪刀模式按钮位置（固定在组选择器右侧） */
export function setScissorsBtnPosition() {
  if (!$linkScissorsModeBtn || !$groupSelector) return;
  // 获取组选择器的实际位置
  const groupSelectorRect = $groupSelector.getBoundingClientRect();
  const viewRect = document.querySelector('.canvas-area').getBoundingClientRect();

  // 计算相对于 canvas-area 的位置
  // 组选择器右侧 + 2px 间距
  const left = groupSelectorRect.right - viewRect.left + 2;
  // 顶部对齐组选择器容器
  const top = groupSelectorRect.top - viewRect.top;
  // 高度与组选择器一致
  const height = groupSelectorRect.height;

  $linkScissorsModeBtn.style.left = `${left}px`;
  $linkScissorsModeBtn.style.top = `${top}px`;
  $linkScissorsModeBtn.style.height = `${height}px`;
  $linkScissorsModeBtn.style.right = 'auto';
  $linkScissorsModeBtn.style.bottom = 'auto';
}

// ═══════════════════════════════════════
//  MINIMAP
// ═══════════════════════════════════════

let $minimap, $minimapCanvas, minimapCtx, $groupSelector;

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

  // 创建组选择器（小地图右侧）
  $groupSelector = document.createElement('div');
  $groupSelector.className = 'group-selector';
  $groupSelector.innerHTML = `
    <div class="group-dots" id="groupDots">
      <!-- 最近 3 个组的颜色圆点 -->
    </div>
    <button class="group-list-btn" id="groupListBtn" title="组列表">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4" r="1.5" fill="currentColor"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><circle cx="7" cy="10" r="1.5" fill="currentColor"/></svg>
    </button>
    <div class="group-list-menu" id="groupListMenu" aria-hidden="true">
      <!-- 动态生成组列表 -->
    </div>
  `;
  document.querySelector('.canvas-area').appendChild($groupSelector);

  // 组列表按钮点击事件
  const groupListBtn = $groupSelector.querySelector('#groupListBtn');
  const groupListMenu = $groupSelector.querySelector('#groupListMenu');
  groupListBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = groupListMenu.getAttribute('aria-hidden') === 'true';
    if (isHidden) {
      renderGroupList();
      groupListMenu.setAttribute('aria-hidden', 'false');
      groupListMenu.style.display = 'block';
    } else {
      groupListMenu.setAttribute('aria-hidden', 'true');
      groupListMenu.style.display = 'none';
    }
  });

  // 点击空白处关闭组列表
  document.addEventListener('pointerdown', (e) => {
    if (!$groupSelector.contains(e.target)) {
      groupListMenu.setAttribute('aria-hidden', 'true');
      groupListMenu.style.display = 'none';
    }
  });

  // 点击组列表项选中整个组（排除操作按钮点击）
  groupListMenu.addEventListener('click', (e) => {
    // 如果点击的是操作按钮，不触发选中组
    if (e.target.closest('.group-rename-btn') || e.target.closest('.group-delete-btn') || e.target.closest('.group-arrange-btn')) {
      return;
    }
    const groupItem = e.target.closest('[data-group-id]');
    if (groupItem) {
      const groupId = groupItem.dataset.groupId;
      selectGroup(groupId);
      groupListMenu.setAttribute('aria-hidden', 'true');
      groupListMenu.style.display = 'none';
    }
  });

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

/**
 * 更新组选择器显示
 */
function updateGroupSelector() {
  if (!$groupSelector) return;

  const groups = appState.canvas.groups || [];
  const groupDots = $groupSelector.querySelector('#groupDots');
  const groupListMenu = $groupSelector.querySelector('#groupListMenu');

  // 获取最近 3 个组（按创建顺序，最新的在前）
  const recentGroups = groups.slice(-3).reverse();

  // 更新颜色圆点
  if (recentGroups.length === 0) {
    groupDots.innerHTML = '<span class="no-groups">暂无组</span>';
  } else {
    groupDots.innerHTML = recentGroups.map(group =>
      `<div class="group-dot" style="background:${group.color}" data-group-id="${group.id}" title="组 (${group.blockIds.length}个块)"></div>`
    ).join('');

    // 为每个圆点添加点击事件
    groupDots.querySelectorAll('.group-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupId = dot.dataset.groupId;
        selectGroup(groupId);
      });
    });
  }

  // 隐藏组列表菜单
  groupListMenu.setAttribute('aria-hidden', 'true');
  groupListMenu.style.display = 'none';

  // 更新剪刀按钮位置，使其跟随组选择器宽度变化
  setScissorsBtnPosition();
}

/**
 * 渲染组列表菜单
 */
function renderGroupList() {
  const groupListMenu = $groupSelector.querySelector('#groupListMenu');
  const groups = appState.canvas.groups || [];

  if (groups.length === 0) {
    groupListMenu.innerHTML = '<div class="group-list-empty">暂无组</div>';
    return;
  }

  groupListMenu.innerHTML = groups.map(group => `
    <div class="group-list-item" data-group-id="${group.id}">
      <div class="group-list-color" style="background:${group.color}" data-group-id="${group.id}" title="点击修改颜色"></div>
      <div class="group-list-info">
        <div class="group-list-header">
          <span class="group-list-name">${escapeHtml(group.name || '组')}</span>
          <div class="group-list-actions">
            <button class="group-arrange-btn" data-group-id="${group.id}" title="组内排列">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="4" height="4" stroke="currentColor" stroke-width="1.2"/><rect x="7" y="1" width="4" height="4" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="7" width="4" height="4" stroke="currentColor" stroke-width="1.2"/><rect x="7" y="7" width="4" height="4" stroke="currentColor" stroke-width="1.2"/></svg>
            </button>
            <button class="group-rename-btn" data-group-id="${group.id}" title="重命名">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 11h3l7-7-3-3-7 7v3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
            </button>
            <button class="group-delete-btn" data-group-id="${group.id}" title="解散组">
              <span style="font-size: 14px; font-weight: 700;">×</span>
            </button>
          </div>
        </div>
        <span class="group-list-count">${group.blockIds.length}个块</span>
      </div>
    </div>
  `).join('');

  // 计算并设置菜单宽度：根据最长组名动态计算
  // 默认宽度 = 所有组名中最长的那个 + 两侧 padding(12px) + 左侧颜色块 (14px+8px) + 最小余量
  // 最大宽度限制为约 10 个中文字 (200px)
  const items = groupListMenu.querySelectorAll('.group-list-item');
  let maxNameWidth = 0;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '500 12px system-ui';

  items.forEach(item => {
    const nameEl = item.querySelector('.group-list-name');
    const text = nameEl.textContent;
    const metrics = ctx.measureText(text);
    if (metrics.width > maxNameWidth) {
      maxNameWidth = metrics.width;
    }
  });

  // 计算所需宽度：颜色块 (14+8=22px) + 组名 + 右侧留白 (8px) + padding(12px)
  const neededWidth = 22 + maxNameWidth + 8 + 12;
  const finalWidth = Math.min(Math.max(neededWidth, 180), 200);
  groupListMenu.style.width = `${finalWidth}px`;

  // 更新剪刀按钮位置，使其跟随组选择器宽度变化
  setScissorsBtnPosition();

  // 为重命名按钮添加事件
  groupListMenu.querySelectorAll('.group-rename-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupId;
      showRenameGroupDialog(groupId);
    });
  });

  // 为组内排列按钮添加事件
  groupListMenu.querySelectorAll('.group-arrange-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupId;
      showGroupArrangeMenu(groupId, btn);
    });
  });

  // 为解散组按钮添加事件
  groupListMenu.querySelectorAll('.group-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupId;
      deleteGroup(groupId);
      pushHistory();
      renderBlocks();
      renderGroupList();
      updateGroupSelector();
      saveCurrentCanvas();
    });
  });

  // 为颜色圆圈添加点击事件（打开颜色选择器）
  groupListMenu.querySelectorAll('.group-list-color').forEach(colorDot => {
    colorDot.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupId = colorDot.dataset.groupId;
      showGroupColorPicker(groupId, colorDot);
    });
  });

  // 双击组列表项也可以重命名
  groupListMenu.querySelectorAll('.group-list-item').forEach(item => {
    item.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const groupId = item.dataset.groupId;
      if (groupId) {
        showRenameGroupDialog(groupId);
      }
    });
  });
}

/**
 * 显示组颜色选择器
 */
function showGroupColorPicker(groupId, anchorEl) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return;

  const GROUP_COLORS_LOCAL = [
    { name: '黄色', value: '#FFD600' },
    { name: '蓝色', value: '#2979FF' },
    { name: '绿色', value: '#00E676' },
    { name: '粉红', value: '#FF4081' },
    { name: '紫色', value: '#D500F9' },
    { name: '橙色', value: '#FF9100' },
    { name: '无', value: null },
  ];

  // 创建颜色选择器
  const picker = document.createElement('div');
  picker.className = 'group-color-picker';
  picker.innerHTML = `
    <div class="group-color-grid">
      ${GROUP_COLORS_LOCAL.map(c => `
        <button class="group-color-option" data-color="${c.value || ''}" style="background:${c.value || 'rgba(255,255,255,0.1)'}; ${!c.value ? 'border: 1px dashed rgba(0,0,0,0.3)' : ''}" title="${c.name}"></button>
      `).join('')}
    </div>
  `;
  document.body.appendChild(picker);

  // 定位在颜色圆圈下方
  const rect = anchorEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  // 点击颜色选项
  picker.querySelectorAll('.group-color-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const color = option.dataset.color === '' ? null : option.dataset.color;
      group.color = color;
      updateGroupSelector();
      saveCurrentCanvas();
      picker.remove();
    });
  });

  // 点击外部关闭
  picker.addEventListener('pointerdown', (e) => {
    if (e.target === picker) {
      picker.remove();
    }
  });
}

/**
 * 显示组内排列菜单
 */
function showGroupArrangeMenu(groupId, anchorEl) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return;

  // 获取组列表菜单的位置
  const groupListMenu = $groupSelector.querySelector('#groupListMenu');
  const groupListRect = groupListMenu.getBoundingClientRect();

  const arrangeMenu = document.createElement('div');
  arrangeMenu.className = 'group-arrange-menu';
  arrangeMenu.innerHTML = `
    <div class="group-arrange-header">
      <span>${escapeHtml(group.name || '组')} - 排列方式</span>
    </div>
    <button class="group-arrange-option" data-layout="horizontal">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="4" width="4" height="8" stroke="currentColor" stroke-width="1.2"/><rect x="8" y="4" width="4" height="8" stroke="currentColor" stroke-width="1.2"/><path d="M13 8h2" stroke="currentColor" stroke-width="1.2"/></svg>
      <span>横向排列</span>
    </button>
    <button class="group-arrange-option" data-layout="vertical">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="2" width="8" height="4" stroke="currentColor" stroke-width="1.2"/><rect x="4" y="8" width="8" height="4" stroke="currentColor" stroke-width="1.2"/><path d="M8 13v2" stroke="currentColor" stroke-width="1.2"/></svg>
      <span>纵向排列</span>
    </button>
    <button class="group-arrange-option" data-layout="grid">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2" width="5" height="5" stroke="currentColor" stroke-width="1.2"/><rect x="2" y="9" width="5" height="5" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="9" width="5" height="5" stroke="currentColor" stroke-width="1.2"/></svg>
      <span>网格排列</span>
    </button>
  `;
  document.body.appendChild(arrangeMenu);

  // 排列菜单出现在组列表菜单的右侧，与组列表菜单顶部对齐
  arrangeMenu.style.position = 'fixed';
  arrangeMenu.style.left = `${groupListRect.right + 8}px`;
  arrangeMenu.style.top = `${groupListRect.top}px`;

  // 点击选项后执行排列并关闭两个菜单
  arrangeMenu.querySelectorAll('.group-arrange-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const layout = option.dataset.layout;
      arrangeGroupBlocks(groupId, layout);
      arrangeMenu.remove();
      groupListMenu.setAttribute('aria-hidden', 'true');
      groupListMenu.style.display = 'none';
    });
  });

  // 点击外部关闭两个菜单
  const closeMenus = (e) => {
    if (!arrangeMenu.contains(e.target) && !groupListMenu.contains(e.target) && !$groupSelector.contains(e.target)) {
      arrangeMenu.remove();
      groupListMenu.setAttribute('aria-hidden', 'true');
      groupListMenu.style.display = 'none';
      document.removeEventListener('pointerdown', closeMenus);
    }
  };
  // 延迟一帧添加监听器，避免立即触发关闭
  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', closeMenus);
  });
}

/**
 * 组内块自动排列
 */
function arrangeGroupBlocks(groupId, layout) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return;

  const blocks = appState.canvas.blocks.filter(b => group.blockIds.includes(b.id));
  if (blocks.length === 0) return;

  const BLOCK_WIDTH = 200;
  const BLOCK_HEIGHT = 72;
  const H_GAP = 40;  // 水平间距
  const V_GAP = 40;  // 垂直间距

  // 计算组的边界框（代表块的位置作为锚点）
  const representative = blocks[0];
  const anchorX = representative.x;
  const anchorY = representative.y;

  if (layout === 'horizontal') {
    // 横向排列：所有块水平排列，以代表块为起点
    blocks.forEach((block, index) => {
      if (!block.locked) {
        block.x = anchorX + index * (BLOCK_WIDTH + H_GAP);
        block.y = anchorY;
      }
    });
  } else if (layout === 'vertical') {
    // 纵向排列：所有块垂直排列，以代表块为起点
    blocks.forEach((block, index) => {
      if (!block.locked) {
        block.x = anchorX;
        block.y = anchorY + index * (BLOCK_HEIGHT + V_GAP);
      }
    });
  } else if (layout === 'grid') {
    // 网格排列：计算行列数，然后排列
    const cols = Math.ceil(Math.sqrt(blocks.length));
    const rows = Math.ceil(blocks.length / cols);
    let index = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols && index < blocks.length; col++) {
        const block = blocks[index];
        if (!block.locked) {
          block.x = anchorX + col * (BLOCK_WIDTH + H_GAP);
          block.y = anchorY + row * (BLOCK_HEIGHT + V_GAP);
        }
        index++;
      }
    }
  }

  pushHistory();
  renderBlocks();
  saveCurrentCanvas();
}

/**
 * 显示组重命名对话框
 */
function showRenameGroupDialog(groupId) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return;

  // 隐藏组列表
  const groupListMenu = $groupSelector.querySelector('#groupListMenu');
  groupListMenu.setAttribute('aria-hidden', 'true');
  groupListMenu.style.display = 'none';

  // 创建对话框
  const dialog = document.createElement('div');
  dialog.className = 'group-rename-dialog';
  dialog.innerHTML = `
    <div class="group-rename-box">
      <div class="group-rename-header">
        <span>重命名组</span>
      </div>
      <input type="text" class="group-rename-input" value="${escapeHtml(group.name || '')}" placeholder="输入组名称" />
      <div class="group-rename-actions">
        <button class="group-rename-cancel">取消</button>
        <button class="group-rename-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const input = dialog.querySelector('.group-rename-input');
  const cancelBtn = dialog.querySelector('.group-rename-cancel');
  const saveBtn = dialog.querySelector('.group-rename-save');

  // 自动聚焦输入框
  setTimeout(() => input.focus(), 0);
  input.select();

  // 点击取消
  cancelBtn.addEventListener('click', () => {
    dialog.remove();
  });

  // 点击保存
  saveBtn.addEventListener('click', () => {
    const newName = input.value.trim();
    if (newName) {
      renameGroup(groupId, newName);
      pushHistory();
      updateGroupSelector();
      saveCurrentCanvas();
    }
    dialog.remove();
  });

  // Enter 键保存
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const newName = input.value.trim();
      if (newName) {
        renameGroup(groupId, newName);
        pushHistory();
        updateGroupSelector();
        saveCurrentCanvas();
      }
      dialog.remove();
    }
    if (e.key === 'Escape') {
      dialog.remove();
    }
  });

  // 点击外部关闭
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target === dialog) {
      dialog.remove();
    }
  });
}

/**
 * 选中整个组
 */
function selectGroup(groupId) {
  const group = appState.canvas.groups.find(g => g.id === groupId);
  if (!group) return;

  // 选中组内所有块
  appState.selectedBlockIds = [...group.blockIds];
  appState.selectedBlockId = group.blockIds[0];

  // 更新 UI
  $blockCanvas.querySelectorAll('.mm-block.selected, .mm-block.selected-multi').forEach(b => {
    b.classList.remove('selected');
    b.classList.remove('selected-multi');
  });

  group.blockIds.forEach((id, index) => {
    const el = $blockCanvas.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.classList.add('selected');
      el.classList.add('selected-multi');
    }
  });

  showNodeToolbar(appState.canvas.blocks.find(b => b.id === group.blockIds[0]));
  pushHistory();
}
