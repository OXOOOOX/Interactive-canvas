/**
 * chat.js — 右侧聊天面板逻辑
 */

import { appState, pushHistory, saveCanvas } from './state.js';
import { callChatLlmStream, callCanvasLlm, callSuggestLlm } from './services/llm.js';
import { parseAiResponse, executeOperations, dedupeConnections, renderMarkdown } from './utils/parser.js';
import { autoLayout, findFreePosition } from './utils/layout.js';
import { renderBlocks, syncBlockSizes } from './canvas.js';

let $messages, $input, $sendBtn;
let getConfig = () => ({});

/** 初始化聊天面板 */
export function initChat(configGetter) {
  $messages = document.getElementById('chatMessages');
  $input = document.getElementById('chatInput');
  $sendBtn = document.getElementById('sendBtn');
  getConfig = configGetter;

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
    const config = getConfig();
    const canvasPromise = callCanvasLlm(config, appState.conversation, appState.canvas);
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

    const canvasRaw = await canvasPromise;
    const parsed = parseAiResponse(canvasRaw);
    const parsedReply = parsed.reply || '';

    if (!chatReply && parsedReply) {
      message.setText(parsedReply);
      appState.lastAssistantReply = parsedReply;
      appState.conversation[appState.conversation.length - 1] = { role: 'assistant', content: parsedReply };
    }

    if (parsed.operations && parsed.operations.length > 0) {
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
      message.setSummary(summaryParts);
      saveCanvas();
    } else {
      message.setSummary([]);
    }

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
