/**
 * chat.js — 右侧聊天面板逻辑
 */

import { appState, pushHistory, saveCurrentCanvas, loadGlobalMemory } from './state.js';
import { callChatLlmStream, callCanvasLlm, callDraftMemoryLlm, callGlobalMemoryLlm, callSuggestLlm, callMarkdownRepairLlm } from './services/llm.js';
import { parseAiResponse, executeOperations, dedupeConnections, renderMarkdown, inspectMarkdownFormatting, repairMarkdownFormatting, assertCanvasIntegrity } from './utils/parser.js';
import { autoLayout, findFreePosition } from './utils/layout.js';
import { renderBlocks, syncBlockSizes } from './canvas.js';

const DRAFT_STORAGE_KEY = 'canvas-studio-markdown-draft-v1';
const DRAFT_AUTO_APPEND_KEY = 'canvas-studio-draft-auto-append-v1';

let $messages, $input, $sendBtn, $draftPanel, $draftToggle, $markdownDraft, $draftAutoAppend;
let $sessionSelect, $newSessionBtn, $exportSessionBtn, $importSessionBtn;
let getConfig = () => ({});

function setChatModelBusy(isBusy) {
  const current = Number(window.__CHAT_MODEL_BUSY_COUNT__ || 0);
  window.__CHAT_MODEL_BUSY_COUNT__ = Math.max(0, current + (isBusy ? 1 : -1));
  window.__CHAT_MODEL_BUSY__ = window.__CHAT_MODEL_BUSY_COUNT__ > 0;
}

function createSession(title = '新会话', messages = []) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title,
    messages: messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

function ensureCanvasSessions() {
  if (!Array.isArray(appState.canvas.sessions)) appState.canvas.sessions = [];
  appState.canvas.sessions = appState.canvas.sessions.filter(session => session && typeof session === 'object');
  if (appState.canvas.sessions.length === 0) {
    appState.canvas.sessions.push(createSession('默认会话'));
  }
  if (!appState.canvas.activeSessionId || !appState.canvas.sessions.some(session => session.id === appState.canvas.activeSessionId)) {
    appState.canvas.activeSessionId = appState.canvas.sessions[0].id;
  }
  return appState.canvas.sessions;
}

function getActiveSession() {
  const sessions = ensureCanvasSessions();
  return sessions.find(session => session.id === appState.canvas.activeSessionId) || sessions[0];
}

function syncConversationFromActiveSession() {
  const session = getActiveSession();
  appState.conversation = session.messages.map(message => ({
    role: message.role,
    content: message.content,
  }));
}

function persistActiveConversation() {
  const session = getActiveSession();
  session.messages = appState.conversation.map(message => ({
    role: message.role,
    content: message.content,
  }));
  session.updatedAt = Date.now();
  if ((!session.title || session.title === '新会话' || session.title === '默认会话') && session.messages.length) {
    const firstUser = session.messages.find(message => message.role === 'user')?.content || '';
    if (firstUser) session.title = firstUser.slice(0, 16);
  }
  saveCurrentCanvas();
  renderSessionSelect();
}

function extractVoiceBrief(text = '') {
  const source = String(text || '');
  const bracketMatch = source.match(/\[\[\s*VOICE[_\s-]*BRIEF\s*[:：]\s*([\s\S]*?)\]\]/i);
  if (bracketMatch) return bracketMatch[1].trim();

  const lineMatch = source.match(/^\s*(?:VOICE[_\s-]*BRIEF|语音摘要|口播)\s*[:：]\s*(.+)$/im);
  return lineMatch ? lineMatch[1].trim() : '';
}

function stripVoiceBrief(text = '') {
  const source = String(text || '');
  const complete = source
    .replace(/\s*\[\[\s*VOICE[_\s-]*BRIEF\s*[:：]\s*[\s\S]*?\]\]\s*/i, '')
    .replace(/^\s*(?:VOICE[_\s-]*BRIEF|语音摘要|口播)\s*[:：]\s*.+(?:\r?\n)?/im, '')
    .trimStart();
  if (complete !== source.trimStart()) return complete;
  const openIndex = source.search(/\[\[\s*VOICE[_\s-]*BRIEF\s*[:：]/i);
  if (openIndex < 0) return source;
  return source.slice(0, openIndex).trimStart();
}

function buildFallbackVoiceBrief(text = '') {
  const cleaned = stripVoiceBrief(text)
    .replace(/[#*_`>\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > 90 ? `${cleaned.slice(0, 90)}...` : cleaned;
}

function formatAgentStatus(status = {}) {
  const phase = status?.phase || '';
  if (phase === 'searching') return `正在 Web 搜索${status.provider ? `（${status.provider}）` : ''}`;
  if (phase === 'searched') return `已搜索到 ${Number(status.count || 0)} 个网页`;
  if (phase === 'search_needs_clarification') return '搜索条件不够明确，本轮未检索网页';
  if (phase === 'search_no_relevant_results') return '没有找到匹配意图的网页';
  if (phase === 'thinking' && status?.count) return `正在阅读 ${status.count} 条网页结果`;
  if (phase === 'thinking') return '正在整理搜索结果';
  if (phase === 'search_failed') return 'Web 搜索失败，本轮未使用网页结果';
  if (phase === 'search_unavailable') return 'Web 搜索不可用，本轮未使用网页结果';
  if (phase === 'builtin_searching') return '已请求通义内置搜索，结果数量由模型返回';
  if (phase === 'canvas') return '大模型正在更新白板';
  return status?.label || '';
}

function shouldShowInitialSearchStatus(config = {}) {
  return false;
}

function getSearchStatusTitle(status = {}) {
  const phase = status?.phase || '';
  if (phase === 'searched') return `已搜索到 ${Number(status.count || 0)} 个网页`;
  if (phase === 'search_needs_clarification') return '搜索条件不够明确';
  if (phase === 'search_no_relevant_results') return '没有找到匹配意图的网页';
  if (phase === 'search_failed') return 'Web 搜索失败';
  if (phase === 'search_unavailable') return 'Web 搜索不可用';
  if (phase === 'builtin_searching') return '已请求通义内置搜索';
  return `正在 Web 搜索${status.provider ? `（${status.provider}）` : ''}`;
}

function getSearchStatusNote(status = {}) {
  const phase = status?.phase || '';
  if (phase === 'searched') return '以下结果已传给大模型参考，正文不再重复展示链接。';
  if (phase === 'search_needs_clarification') return '本轮没有检索网页，需要先补充具体主题、品牌、对象或范围。';
  if (phase === 'search_no_relevant_results') return status.error || '搜索返回了一些网页，但都不够贴合当前问题。';
  if (phase === 'search_failed' || phase === 'search_unavailable') return status.error || '本轮未使用网页结果。';
  if (phase === 'builtin_searching') return '内置搜索结果由模型供应商处理，应用无法读取网页列表或数量。';
  return '正在检索网页结果...';
}

function getMissingVoiceBriefFallback() {
  return '我已经把回复写出来了，你可以先看屏幕上的内容。';
}

/** 初始化聊天面板 */
export function initChat(configGetter) {
  $messages = document.getElementById('chatMessages');
  $input = document.getElementById('chatInput');
  $sendBtn = document.getElementById('sendBtn');
  $draftPanel = document.getElementById('draftPanel');
  $draftToggle = document.getElementById('draftToggle');
  $markdownDraft = document.getElementById('markdownDraft');
  $draftAutoAppend = document.getElementById('draftAutoAppend');
  $sessionSelect = document.getElementById('sessionSelect');
  $newSessionBtn = document.getElementById('newSessionBtn');
  $exportSessionBtn = document.getElementById('exportSessionBtn');
  $importSessionBtn = document.getElementById('importSessionBtn');
  getConfig = configGetter;

  initDraftPanel();
  initSessionControls();
  syncChatSessionUI();

  $sendBtn.addEventListener('click', () => sendMessage());

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.altKey) {
        e.preventDefault();
        const start = $input.selectionStart;
        const end = $input.selectionEnd;
        $input.value = $input.value.substring(0, start) + '\n' + $input.value.substring(end);
        $input.selectionStart = $input.selectionEnd = start + 1;
        $input.dispatchEvent(new Event('input'));
      } else if (!e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
  });

  $messages.addEventListener('click', (e) => {
    const chip = e.target.closest('.hint-chip');
    if (chip) {
      $input.value = chip.dataset.hint;
      sendMessage();
    }
  });
}

function initDraftPanel() {
  if (!$markdownDraft) return;

  syncCanvasMemoryDraft({ migrateLegacy: true });
  if ($draftAutoAppend) {
    $draftAutoAppend.checked = localStorage.getItem(DRAFT_AUTO_APPEND_KEY) !== '0';
    $draftAutoAppend.addEventListener('change', () => {
      localStorage.setItem(DRAFT_AUTO_APPEND_KEY, $draftAutoAppend.checked ? '1' : '0');
    });
  }

  $markdownDraft.addEventListener('input', () => {
    appState.canvas.memory = $markdownDraft.value;
    saveCurrentCanvas();
  });

  $draftToggle?.addEventListener('click', () => {
    const nextOpen = !$draftPanel?.classList.contains('open');
    setDraftPanelOpen(nextOpen);
  });

  document.getElementById('draftCopyBtn')?.addEventListener('click', async () => {
    const text = getMarkdownDraft();
    if (!text) return;
    await navigator.clipboard?.writeText(text);
  });

  document.getElementById('draftClearBtn')?.addEventListener('click', () => {
    $markdownDraft.value = '';
    appState.canvas.memory = '';
    saveCurrentCanvas();
  });
}

function initSessionControls() {
  $sessionSelect?.addEventListener('change', () => {
    if (!$sessionSelect.value) return;
    appState.canvas.activeSessionId = $sessionSelect.value;
    syncConversationFromActiveSession();
    renderConversation();
    saveCurrentCanvas();
  });

  $newSessionBtn?.addEventListener('click', () => {
    const session = createSession(`会话 ${ensureCanvasSessions().length + 1}`);
    appState.canvas.sessions.unshift(session);
    appState.canvas.activeSessionId = session.id;
    syncChatSessionUI();
    saveCurrentCanvas();
  });

  $exportSessionBtn?.addEventListener('click', exportActiveSession);
  $importSessionBtn?.addEventListener('click', importSessionFromFile);
}

export function syncChatSessionUI() {
  ensureCanvasSessions();
  syncConversationFromActiveSession();
  renderSessionSelect();
  renderConversation();
}

function renderSessionSelect() {
  if (!$sessionSelect) return;
  ensureCanvasSessions();
  $sessionSelect.innerHTML = appState.canvas.sessions.map(session => {
    const title = escapeHtml(session.title || '未命名会话');
    const count = Array.isArray(session.messages) ? session.messages.length : 0;
    return `<option value="${escapeHtml(session.id)}">${title} (${count})</option>`;
  }).join('');
  $sessionSelect.value = appState.canvas.activeSessionId;
}

function renderConversation() {
  if (!$messages) return;
  $messages.innerHTML = '';
  if (!appState.conversation.length) {
    renderWelcome();
    return;
  }
  appState.conversation.forEach((message, index) => {
    appendMessage(message.role, message.content, [], index);
  });
}

function renderWelcome() {
  const welcome = document.createElement('div');
  welcome.className = 'chat-welcome';
  welcome.innerHTML = `
    <div class="chat-welcome-icon">💡</div>
    <p>你好！我是你的白板助手。</p>
    <p>可以先免费试用；额度用完或长期使用时，再在设置里填写自己的模型 Key。</p>
    <div class="chat-welcome-hints">
      <button class="hint-chip" data-hint="总结近期AI大模型的最新突破与应用方向">科技前沿探索</button>
      <button class="hint-chip" data-hint="帮我梳理大语言模型底层的核心原理">学习技术原理</button>
      <button class="hint-chip" data-hint="有哪些结合AI的创新产品点子？不妨头脑风暴一下">记录灵感创意</button>
    </div>
  `;
  $messages.appendChild(welcome);
}

export function syncCanvasMemoryDraft(options = {}) {
  if (!$markdownDraft) return;
  if (typeof appState.canvas.memory !== 'string') appState.canvas.memory = '';

  const legacyDraft = options.migrateLegacy ? (localStorage.getItem(DRAFT_STORAGE_KEY) || '') : '';
  if (!appState.canvas.memory && legacyDraft) {
    appState.canvas.memory = legacyDraft;
    saveCurrentCanvas();
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  }

  $markdownDraft.value = appState.canvas.memory || '';
}

function setDraftPanelOpen(open) {
  if (!$draftPanel || !$draftToggle) return;
  $draftPanel.classList.toggle('open', open);
  $draftPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  $draftToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function getMarkdownDraft() {
  return ($markdownDraft?.value || '').trim();
}

function forkSessionAt(messageIndex) {
  const sourceSession = getActiveSession();
  const index = Number(messageIndex);
  if (!Number.isInteger(index) || index < 0) return;

  const messages = sourceSession.messages.slice(0, index + 1);
  const baseTitle = sourceSession.title || '会话';
  const session = createSession(`${baseTitle} 派生`, messages);
  appState.canvas.sessions.unshift(session);
  appState.canvas.activeSessionId = session.id;
  syncChatSessionUI();
  saveCurrentCanvas();
}

function exportActiveSession() {
  const session = getActiveSession();
  const payload = {
    version: 1,
    type: 'interactive-canvas-session',
    canvasTitle: appState.canvas.title || '',
    session: {
      title: session.title || '未命名会话',
      messages: session.messages || [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  const title = (session.title || 'session').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40) || 'session';
  link.href = URL.createObjectURL(blob);
  link.download = `${title}.session.json`;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function importSessionFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ''));
        const rawSession = data?.session || data;
        const messages = Array.isArray(rawSession.messages)
          ? rawSession.messages.filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
          : [];
        if (!messages.length) throw new Error('Session 文件里没有可导入的对话消息');

        const session = createSession(rawSession.title || `导入会话 ${ensureCanvasSessions().length + 1}`, messages);
        appState.canvas.sessions.unshift(session);
        appState.canvas.activeSessionId = session.id;
        syncChatSessionUI();
        saveCurrentCanvas();
      } catch (error) {
        alert(`导入 session 失败：${error.message}`);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

async function updateDraftMemory(config, userText, assistantText) {
  if (!$markdownDraft || !$draftAutoAppend?.checked) return;
  const updated = (await callDraftMemoryLlm(config, getMarkdownDraft(), userText, assistantText, appState.canvas)).trim();
  if (!updated) return;
  $markdownDraft.value = updated;
  appState.canvas.memory = updated;
  saveCurrentCanvas();
}

async function suggestGlobalMemory(config, userText, assistantText) {
  const currentMemory = loadGlobalMemory();
  const updated = (await callGlobalMemoryLlm(config, currentMemory, userText, assistantText)).trim();
  const normalized = updated.replace(/[。.\s]/g, '').toLowerCase();
  if (!updated || updated === currentMemory.trim()) return;
  if (['empty', 'none', 'null', '无', '无更新', '不更新', '无需更新'].includes(normalized)) return;

  window.dispatchEvent(new CustomEvent('global-memory:suggest', {
    detail: {
      previousMemory: currentMemory,
      suggestedMemory: updated,
    },
  }));
}

async function repairOperationMarkdown(config, operations) {
  let repairedByModel = 0;

  for (const op of operations) {
    const targets = [];
    if (op.op === 'add' && op.block) {
      targets.push({ object: op.block, field: 'label', blockId: op.block.id, label: op.block.label });
      targets.push({ object: op.block, field: 'content', blockId: op.block.id, label: op.block.label });
    }
    if (op.op === 'update' && op.changes) {
      targets.push({ object: op.changes, field: 'label', blockId: op.targetId, label: op.changes.label });
      targets.push({ object: op.changes, field: 'content', blockId: op.targetId, label: op.changes.label });
    }

    for (const target of targets) {
      if (typeof target.object[target.field] !== 'string') continue;

      const local = repairMarkdownFormatting(target.object[target.field]);
      target.object[target.field] = local.text;

      const inspection = inspectMarkdownFormatting(target.object[target.field]);
      if (!inspection.needsModelRepair) continue;

      target.object[target.field] = await callMarkdownRepairLlm(config, target.object[target.field], {
        blockId: target.blockId,
        label: target.label,
        field: target.field,
      });
      target.object[target.field] = repairMarkdownFormatting(target.object[target.field]).text;
      repairedByModel += 1;
    }
  }

  return { repairedByModel };
}

/** 发送用户消息并处理 AI 响应 */
async function sendMessage(explicitText = null, options = {}) {
  const text = (typeof explicitText === 'string' ? explicitText : $input.value).trim();
  if (!text) return null;

  if (typeof explicitText !== 'string') {
    $input.value = '';
  } else if ($input.value.trim() === text) {
    $input.value = '';
  }
  $input.style.height = 'auto';

  const welcome = $messages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  appState.conversation.push({ role: 'user', content: text });
  appendMessage('user', text, [], appState.conversation.length - 1);
  persistActiveConversation();

  const typing = showTyping();
  let assistantMessage = null;
  setChatModelBusy(true);
  let searchCard = null;

  try {
    const config = {
      ...getConfig(),
      markdownDraft: getMarkdownDraft(),
      globalMemory: loadGlobalMemory(),
      voiceOutputEnabled: Boolean(options.voiceOutputEnabled),
    };
    if (shouldShowInitialSearchStatus(config)) {
      typing.setStatus('已请求通义内置搜索，结果数量由模型返回', 'builtin_searching');
      searchCard = createSearchStatusCard({
        phase: 'builtin_searching',
        provider: 'tongyi',
      });
    }
    let hasStreamText = false;
    let hasNotifiedStreamStart = false;
    let hasNotifiedVoiceBrief = false;
    let hasShownSearchWarning = false;
    let allowEarlyVoiceBrief = false;
    let suppressEarlyVoiceBrief = false;
    let voiceBriefDisabledForSearch = false;

    const ensureAssistantMessage = () => {
      if (!assistantMessage) assistantMessage = createMessageController('assistant');
      return assistantMessage;
    };

    const chatReply = await callChatLlmStream(config, appState.conversation, appState.canvas, {
      onStatus(status) {
        if (hasStreamText) return;
        const label = formatAgentStatus(status);
        if (label) typing.setStatus(label, status?.phase);
        if (status?.phase === 'voice_brief_disabled') {
          voiceBriefDisabledForSearch = true;
          suppressEarlyVoiceBrief = true;
          allowEarlyVoiceBrief = false;
          return;
        }
        if (status?.phase === 'searching') {
          suppressEarlyVoiceBrief = true;
          allowEarlyVoiceBrief = false;
        }
        if (status?.phase === 'search_needs_clarification') {
          allowEarlyVoiceBrief = true;
          suppressEarlyVoiceBrief = false;
        }
        if (status?.phase && String(status.phase).includes('search')) {
          if (!searchCard) searchCard = createSearchStatusCard(status);
          else searchCard.update(status);
        }
        if (status?.phase === 'searched' || status?.phase === 'search_no_relevant_results' || status?.phase === 'search_failed' || status?.phase === 'search_unavailable') {
          if (!searchCard) searchCard = createSearchStatusCard(status);
          else searchCard.update(status);
        }
      },
      onWarning(payload = {}) {
        if (hasStreamText || hasShownSearchWarning) return;
        hasShownSearchWarning = true;
        const message = payload.warning || payload.message || 'Web 搜索失败，本轮未使用网页结果';
        typing.setStatus(`Web 搜索失败，本轮未使用网页结果`, 'search_failed');
        const status = { phase: 'search_failed', error: message, results: [] };
        if (!searchCard) searchCard = createSearchStatusCard(status);
        else searchCard.update(status);
      },
      onDelta(fullText) {
        if (!hasStreamText) {
          typing.remove();
          hasStreamText = true;
        }
        if (!hasNotifiedStreamStart) {
          hasNotifiedStreamStart = true;
          options.onAssistantStreamStart?.();
        }
        if (config.voiceOutputEnabled && !hasNotifiedVoiceBrief && allowEarlyVoiceBrief && !suppressEarlyVoiceBrief) {
          const voiceBrief = extractVoiceBrief(fullText);
          if (voiceBrief) {
            hasNotifiedVoiceBrief = true;
            options.onVoiceBrief?.(voiceBrief);
          }
        }
        ensureAssistantMessage().setText(stripVoiceBrief(fullText));
      }
    });

    const voiceText = config.voiceOutputEnabled && !voiceBriefDisabledForSearch
      ? (extractVoiceBrief(chatReply) || '')
      : '';
    if (voiceText && !hasNotifiedVoiceBrief && !suppressEarlyVoiceBrief) {
      hasNotifiedVoiceBrief = true;
      options.onVoiceBrief?.(voiceText);
    }
    if (config.voiceOutputEnabled && !voiceText && !voiceBriefDisabledForSearch) {
      console.warn('[voice] Missing VOICE_BRIEF in assistant response:', chatReply.slice(0, 240));
    }
    const visibleChatReply = stripVoiceBrief(chatReply);

    if (!hasStreamText) {
      typing.remove();
      ensureAssistantMessage().setText(visibleChatReply);
    }

    const message = ensureAssistantMessage();
    if (!visibleChatReply.trim()) {
      const fallbackText = '本轮没有收到聊天回复，已停止白板更新。请重试或检查模型/搜索配置。';
      message.setText(fallbackText);
      appState.lastAssistantReply = fallbackText;
      appState.conversation.push({ role: 'assistant', content: fallbackText });
      assistantMessage?.setIndex(appState.conversation.length - 1);
      persistActiveConversation();
      return options.returnVoicePayload
        ? { reply: fallbackText, voiceText: getMissingVoiceBriefFallback() }
        : fallbackText;
    }

    appState.lastAssistantReply = visibleChatReply;

    appState.lastAssistantReply = visibleChatReply;
    appState.conversation.push({ role: 'assistant', content: visibleChatReply });
    assistantMessage?.setIndex(appState.conversation.length - 1);
    persistActiveConversation();
    const draftPromise = updateDraftMemory(config, text, visibleChatReply).catch((error) => {
      console.warn('Draft memory update failed:', error);
    });
    const globalMemoryPromise = suggestGlobalMemory(config, text, visibleChatReply).catch((error) => {
      console.warn('Global memory suggestion failed:', error);
    });

    const canvasStatus = showTyping();
    canvasStatus.setStatus('大模型正在更新白板', 'canvas');
    let canvasRaw = '';
    try {
      canvasRaw = await callCanvasLlm(config, appState.conversation, appState.canvas);
    } finally {
      canvasStatus.remove();
    }
    const parsed = parseAiResponse(canvasRaw);
    const parsedReply = parsed.reply || '';

    if (!visibleChatReply && parsedReply) {
      message.setText(parsedReply);
      appState.lastAssistantReply = parsedReply;
      appState.conversation[appState.conversation.length - 1] = { role: 'assistant', content: parsedReply };
      persistActiveConversation();
    }

    if (parsed.operations && parsed.operations.length > 0) {
      const repairResult = await repairOperationMarkdown(config, parsed.operations);
      const tempBlocks = [...appState.canvas.blocks];
      const tempConns = [...appState.canvas.connections];

      for (const op of parsed.operations) {
        if (op.op === 'add' && op.block) {
          const pos = findFreePosition(tempBlocks, op.parentId, tempConns);
          if (typeof op.block.x !== 'number' || op.block.x === 200) op.block.x = pos.x;
          if (typeof op.block.y !== 'number' || op.block.y === 100) op.block.y = pos.y;
          tempBlocks.push(op.block);
          if (op.parentId) {
            tempConns.push({ fromId: op.parentId, toId: op.block.id });
          }
        }
      }

      const result = executeOperations(appState.canvas, parsed.operations);
      dedupeConnections(appState.canvas);
      assertCanvasIntegrity(appState.canvas);
      pushHistory();

      const changedIds = [...result.addedIds, ...result.updatedIds];
      if (changedIds.length > 0) {
        for (const block of appState.canvas.blocks) {
          if (!changedIds.includes(block.id)) continue;
          delete block.height;
        }
      }

      renderBlocks(result.addedIds);
      syncBlockSizes({ adaptForAutoLayout: true });
      autoLayout(appState.canvas.blocks, appState.canvas.connections, appState.canvas.groups);
      renderBlocks(result.addedIds);
      syncBlockSizes();
      renderBlocks(result.addedIds);

      const summaryParts = [];
      if (result.addedIds.length) summaryParts.push(`新增 ${result.addedIds.length} 个块`);
      if (result.updatedIds.length) summaryParts.push(`更新 ${result.updatedIds.length} 个块`);
      if (result.removedIds.length) summaryParts.push(`删除 ${result.removedIds.length} 个块`);
      if (repairResult.repairedByModel) summaryParts.push(`修复 ${repairResult.repairedByModel} 处格式`);
      message.setSummary(summaryParts);
      saveCurrentCanvas();
    } else {
      message.setSummary([]);
      persistActiveConversation();
    }

    await draftPromise;
    await globalMemoryPromise;
    document.dispatchEvent(new CustomEvent('boardChanged'));
    generateSuggestions();
    if (options.returnVoicePayload) {
      return {
        reply: appState.lastAssistantReply,
        voiceText: voiceText || buildFallbackVoiceBrief(appState.lastAssistantReply) || getMissingVoiceBriefFallback(),
      };
    }
    return appState.lastAssistantReply;
  } catch (err) {
    typing.remove();
    assistantMessage?.remove();
    appendMessage('system', `❌ ${err.message}`);
    console.error('Chat error:', err);
    return null;
  } finally {
    setChatModelBusy(false);
  }
}

/** 生成推荐输入选项 */
async function generateSuggestions() {
  const container = document.getElementById('chatSuggestions');
  if (!container) return;
  container.innerHTML = '<span style="font-size:12px; color:var(--text-muted);">正在思考...</span>';

  try {
    const config = getConfig();
    const suggestions = await callSuggestLlm(config, appState.canvas);
    container.innerHTML = '';

    for (const text of suggestions) {
      const btn = document.createElement('button');
      btn.className = 'hint-chip';
      btn.textContent = text;
      btn.onclick = () => {
        $input.value = text;
        sendMessage();
        container.innerHTML = '';
      };
      container.appendChild(btn);
    }
  } catch(e) {
    container.innerHTML = '';
  }
}

/** 从外部触发发送（用于语音转写后） */
export async function sendText(text, options = {}) {
  if (!text) return null;
  return await sendMessage(text, options);
}

function buildOpSummaryHtml(opSummary = []) {
  if (!opSummary.length) return '';
  let html = '<div style="margin-top:6px">';
  for (const s of opSummary) {
    let cls = 'added';
    if (s.includes('更新')) cls = 'updated';
    if (s.includes('删除')) cls = 'removed';
    html += `<span class="op-badge ${cls}">✓ ${s}</span> `;
  }
  html += '</div>';
  return html;
}

function createMessageController(role, text = '', opSummary = [], messageIndex = null) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble';
  const actions = document.createElement('div');
  actions.className = 'chat-msg-actions';
  const forkBtn = document.createElement('button');
  forkBtn.type = 'button';
  forkBtn.className = 'chat-msg-action';
  forkBtn.textContent = '派生';
  forkBtn.title = '从这条消息派生新会话';
  actions.appendChild(forkBtn);
  msgDiv.appendChild(bubble);
  msgDiv.appendChild(actions);
  $messages.appendChild(msgDiv);

  const state = { text, opSummary, messageIndex };
  const render = () => {
    bubble.innerHTML = `${renderMarkdown(state.text)}${buildOpSummaryHtml(state.opSummary)}`;
    forkBtn.disabled = !Number.isInteger(state.messageIndex);
    $messages.scrollTop = $messages.scrollHeight;
  };

  forkBtn.addEventListener('click', () => {
    forkSessionAt(state.messageIndex);
  });

  render();

  return {
    setIndex(nextIndex) {
      state.messageIndex = nextIndex;
      render();
    },
    setText(nextText = '') {
      state.text = nextText;
      render();
    },
    setSummary(nextSummary = []) {
      state.opSummary = nextSummary;
      render();
    },
    remove() {
      msgDiv.remove();
    },
  };
}

/** 追加消息气泡 */
function createSearchStatusCard(initialStatus = {}) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg system search-status-msg';
  const card = document.createElement('div');
  card.className = 'search-status-card';
  msgDiv.appendChild(card);
  $messages.appendChild(msgDiv);

  const state = { ...initialStatus };
  const render = () => {
    const phase = state.phase || 'searching';
    const results = Array.isArray(state.results) ? state.results : [];
    const count = Number.isFinite(Number(state.count)) ? Number(state.count) : results.length;
    const provider = state.provider ? `<span class="search-provider">${escapeHtml(state.provider)}</span>` : '';
    const resultHtml = results.length
      ? `<div class="search-result-list">${results.map((item, index) => {
          const title = item.title || item.url || `网页 ${index + 1}`;
          const url = item.url || '';
          const snippet = item.snippet || '';
          return `
            <a class="search-result-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
              <span class="search-result-title">${escapeHtml(title)}</span>
              ${snippet ? `<span class="search-result-snippet">${escapeHtml(snippet)}</span>` : ''}
              ${url ? `<span class="search-result-url">${escapeHtml(url)}</span>` : ''}
            </a>
          `;
        }).join('')}</div>`
      : '';

    card.dataset.phase = phase;
    card.innerHTML = `
      <div class="search-status-head">
        <span class="search-status-dot"></span>
        <strong>${escapeHtml(getSearchStatusTitle({ ...state, count }))}</strong>
        ${provider}
      </div>
      ${state.query ? `<div class="search-query">搜索词：${escapeHtml(state.query)}</div>` : ''}
      <div class="search-status-note">${escapeHtml(getSearchStatusNote({ ...state, count }))}</div>
      ${resultHtml}
    `;
    $messages.scrollTop = $messages.scrollHeight;
  };

  render();

  return {
    update(nextStatus = {}) {
      Object.assign(state, nextStatus);
      render();
    },
    remove() {
      msgDiv.remove();
    },
  };
}

function appendMessage(role, text, opSummary = [], messageIndex = null) {
  return createMessageController(role, text, opSummary, messageIndex);
}

/** 显示 typing indicator */
function showTyping() {
  const el = document.createElement('div');
  el.className = 'chat-msg assistant';
  el.innerHTML = `
    <div class="chat-msg-bubble">
      <div class="typing-indicator">
        <span class="typing-label" hidden></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    </div>
  `;
  $messages.appendChild(el);
  $messages.scrollTop = $messages.scrollHeight;
  const label = el.querySelector('.typing-label');
  return {
    setStatus(text = '', phase = '') {
      if (!label) return;
      label.textContent = text;
      label.hidden = !text;
      el.dataset.phase = phase || '';
      $messages.scrollTop = $messages.scrollHeight;
    },
    remove() {
      el.remove();
    },
  };
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
