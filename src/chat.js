/**
 * chat.js — 右侧聊天面板逻辑
 */

import { appState, pushHistory, saveCanvas } from './state.js';
import { callChatLlm, callCanvasLlm, callSuggestLlm } from './services/llm.js';
import { parseAiResponse, executeOperations, renderMarkdown } from './utils/parser.js';
import { findFreePosition } from './utils/layout.js';
import { renderBlocks } from './canvas.js';

let $messages, $input, $sendBtn;
let getConfig = () => ({});

/** 初始化聊天面板 */
export function initChat(configGetter) {
  $messages = document.getElementById('chatMessages');
  $input = document.getElementById('chatInput');
  $sendBtn = document.getElementById('sendBtn');
  getConfig = configGetter;

  // 发送按钮
  $sendBtn.addEventListener('click', () => sendMessage());

  // Enter 发送，Alt+Enter 换行
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.altKey) {
        e.preventDefault();
        const start = $input.selectionStart;
        const end = $input.selectionEnd;
        $input.value = $input.value.substring(0, start) + "\n" + $input.value.substring(end);
        $input.selectionStart = $input.selectionEnd = start + 1;
        $input.dispatchEvent(new Event('input'));
      } else if (!e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }
  });

  // 自动高度
  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
  });

  // 快捷提示 chips
  $messages.addEventListener('click', (e) => {
    const chip = e.target.closest('.hint-chip');
    if (chip) {
      $input.value = chip.dataset.hint;
      sendMessage();
    }
  });
}

/** 发送用户消息并处理 AI 响应 */
async function sendMessage() {
  const text = $input.value.trim();
  if (!text) return null;

  // 清空输入
  $input.value = '';
  $input.style.height = 'auto';

  // 清空欢迎消息
  const welcome = $messages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // 显示用户消息
  appendMessage('user', text);

  // 保存到对话历史
  appState.conversation.push({ role: 'user', content: text });

  // 显示 typing indicator
  const typing = showTyping();

  try {
    const config = getConfig();
    
    // 双路并发发起请求 (Dual-Agent)
    const [chatRaw, canvasRaw] = await Promise.all([
      callChatLlm(config, appState.conversation, appState.canvas),
      callCanvasLlm(config, appState.conversation, appState.canvas)
    ]);
    typing.remove();

    // 1. 处理聊天副驾回复
    const chatReply = chatRaw;
    appState.lastAssistantReply = chatReply;
    appState.conversation.push({ role: 'assistant', content: chatReply });

    // 2. 处理白板幽灵的后台操作
    const parsed = parseAiResponse(canvasRaw);

    // 执行画布操作
    if (parsed.operations && parsed.operations.length > 0) {
      // 为新增的块自动定位（基于虚拟的临时数组，防止多块重叠）
      const tempBlocks = [...appState.canvas.blocks];
      const tempConns = [...appState.canvas.connections];

      for (const op of parsed.operations) {
        if (op.op === 'add' && op.block) {
          const pos = findFreePosition(
            tempBlocks,
            op.parentId,
            tempConns
          );
          if (typeof op.block.x !== 'number' || op.block.x === 200) op.block.x = pos.x;
          if (typeof op.block.y !== 'number' || op.block.y === 100) op.block.y = pos.y;
          
          // 记录到临时数组供后续循环感知
          tempBlocks.push(op.block);
          if (op.parentId) {
            tempConns.push({ fromId: op.parentId, toId: op.block.id });
          }
        }
      }

      const result = executeOperations(appState.canvas, parsed.operations);
      pushHistory();

      // 重新渲染画布（带入场动画）
      renderBlocks(result.addedIds);

      // 构建操作摘要
      const summaryParts = [];
      if (result.addedIds.length) summaryParts.push(`新增 ${result.addedIds.length} 个块`);
      if (result.updatedIds.length) summaryParts.push(`更新 ${result.updatedIds.length} 个块`);
      if (result.removedIds.length) summaryParts.push(`删除 ${result.removedIds.length} 个块`);

      // 显示 AI 回复 + 操作摘要
      appendMessage('assistant', chatReply, summaryParts);

      // 自动保存
      saveCanvas();
    } else {
      appendMessage('assistant', chatReply);
    }

    // 触发自动命名扫描
    document.dispatchEvent(new CustomEvent('boardChanged'));

    // 后台加载推荐提问
    generateSuggestions();

    return chatReply;
  } catch (err) {
    typing.remove();
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
        container.innerHTML = ''; // 点击后清空
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
  $input.value = text;
  return await sendMessage();
}

/** 追加消息气泡 */
function appendMessage(role, text, opSummary = []) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${role}`;

  let content = `<div class="chat-msg-bubble">${renderMarkdown(text)}`;

  // 操作摘要徽章
  if (opSummary.length) {
    content += '<div style="margin-top:6px">';
    for (const s of opSummary) {
      let cls = 'added';
      if (s.includes('更新')) cls = 'updated';
      if (s.includes('删除')) cls = 'removed';
      content += `<span class="op-badge ${cls}">✓ ${s}</span> `;
    }
    content += '</div>';
  }

  content += '</div>';
  msgDiv.innerHTML = content;

  $messages.appendChild(msgDiv);
  $messages.scrollTop = $messages.scrollHeight;
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
