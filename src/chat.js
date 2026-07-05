/**
 * chat.js — 右侧聊天面板逻辑
 */

import { appState, pushHistory, saveCanvas } from './state.js';
import { callChatLlmStream, callCanvasLlm, callDraftMemoryLlm, callSuggestLlm, callMarkdownRepairLlm } from './services/llm.js';
import { parseAiResponse, executeOperations, dedupeConnections, renderMarkdown, inspectMarkdownFormatting, repairMarkdownFormatting, assertCanvasIntegrity } from './utils/parser.js';
import { autoLayout, findFreePosition } from './utils/layout.js';
import { renderBlocks, syncBlockSizes } from './canvas.js';

const DRAFT_STORAGE_KEY = 'canvas-studio-markdown-draft-v1';
const DRAFT_AUTO_APPEND_KEY = 'canvas-studio-draft-auto-append-v1';

let $messages, $input, $sendBtn, $draftPanel, $draftToggle, $markdownDraft, $draftAutoAppend;
let getConfig = () => ({});

/** 初始化聊天面板 */
export function initChat(configGetter) {
  $messages = document.getElementById('chatMessages');
  $input = document.getElementById('chatInput');
  $sendBtn = document.getElementById('sendBtn');
  $draftPanel = document.getElementById('draftPanel');
  $draftToggle = document.getElementById('draftToggle');
  $markdownDraft = document.getElementById('markdownDraft');
  $draftAutoAppend = document.getElementById('draftAutoAppend');
  getConfig = configGetter;

  initDraftPanel();

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

  $markdownDraft.value = localStorage.getItem(DRAFT_STORAGE_KEY) || '';
  if ($draftAutoAppend) {
    $draftAutoAppend.checked = localStorage.getItem(DRAFT_AUTO_APPEND_KEY) !== '0';
    $draftAutoAppend.addEventListener('change', () => {
      localStorage.setItem(DRAFT_AUTO_APPEND_KEY, $draftAutoAppend.checked ? '1' : '0');
    });
  }

  $markdownDraft.addEventListener('input', () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, $markdownDraft.value);
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
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  });
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

async function updateDraftMemory(config, userText, assistantText) {
  if (!$markdownDraft || !$draftAutoAppend?.checked) return;
  const updated = (await callDraftMemoryLlm(config, getMarkdownDraft(), userText, assistantText, appState.canvas)).trim();
  if (!updated) return;
  $markdownDraft.value = updated;
  localStorage.setItem(DRAFT_STORAGE_KEY, updated);
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
async function sendMessage(explicitText = null) {
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

  appendMessage('user', text);
  appState.conversation.push({ role: 'user', content: text });

  const typing = showTyping();
  let assistantMessage = null;

  try {
    const config = { ...getConfig(), markdownDraft: getMarkdownDraft() };
    let hasStreamText = false;

    const ensureAssistantMessage = () => {
      if (!assistantMessage) assistantMessage = createMessageController('assistant');
      return assistantMessage;
    };

    const chatReply = await callChatLlmStream(config, appState.conversation, appState.canvas, {
      onDelta(fullText) {
        if (!hasStreamText) {
          typing.remove();
          hasStreamText = true;
        }
        ensureAssistantMessage().setText(fullText);
      }
    });

    if (!hasStreamText) {
      typing.remove();
      ensureAssistantMessage().setText(chatReply);
    }

    const message = ensureAssistantMessage();

    appState.lastAssistantReply = chatReply;

    appState.lastAssistantReply = chatReply;
    appState.conversation.push({ role: 'assistant', content: chatReply });
    const draftPromise = updateDraftMemory(config, text, chatReply).catch((error) => {
      console.warn('Draft memory update failed:', error);
    });

    const canvasRaw = await callCanvasLlm(config, appState.conversation, appState.canvas);
    const parsed = parseAiResponse(canvasRaw);
    const parsedReply = parsed.reply || '';

    if (!chatReply && parsedReply) {
      message.setText(parsedReply);
      appState.lastAssistantReply = parsedReply;
      appState.conversation[appState.conversation.length - 1] = { role: 'assistant', content: parsedReply };
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
      saveCanvas();
    } else {
      message.setSummary([]);
    }

    await draftPromise;
    document.dispatchEvent(new CustomEvent('boardChanged'));
    generateSuggestions();
    return appState.lastAssistantReply;
  } catch (err) {
    typing.remove();
    assistantMessage?.remove();
    appendMessage('system', `❌ ${err.message}`);
    console.error('Chat error:', err);
    return null;
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
export async function sendText(text) {
  if (!text) return null;
  return await sendMessage(text);
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

function createMessageController(role, text = '', opSummary = []) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble';
  msgDiv.appendChild(bubble);
  $messages.appendChild(msgDiv);

  const state = { text, opSummary };
  const render = () => {
    bubble.innerHTML = `${renderMarkdown(state.text)}${buildOpSummaryHtml(state.opSummary)}`;
    $messages.scrollTop = $messages.scrollHeight;
  };

  render();

  return {
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
function appendMessage(role, text, opSummary = []) {
  return createMessageController(role, text, opSummary);
}

/** 显示 typing indicator */
function showTyping() {
  const el = document.createElement('div');
  el.className = 'chat-msg assistant';
  el.innerHTML = `
    <div class="chat-msg-bubble">
      <div class="typing-indicator">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    </div>
  `;
  $messages.appendChild(el);
  $messages.scrollTop = $messages.scrollHeight;
  return el;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
