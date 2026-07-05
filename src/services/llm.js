/**
 * llm.js — LLM API 调用 (支持双模型并发: 聊天 Agent、白板 Agent)
 */

import { extractAssistantText, buildCanvasOutline } from '../utils/parser.js';

/**
 * 白板后台幽灵 Agent 的 System Prompt
 */
function buildCanvasSystemPrompt(canvasJson) {
  return `You are a silent 'Canvas Agent' organizing whiteboard data in the background. Your task is to organize concepts into a mind map structure based on the user's conversation.
Current Canvas State:
${canvasJson}

Available Operations:
- add: {op:"add", parentId:"parent id", block:{id, label, content}}
- update: {op:"update", targetId:"id", changes:{label, content, ...}}
- remove: {op:"remove", targetId:"id"}
- addConnection: {op:"addConnection", fromId:"source", toId:"target"}
- removeConnection: {op:"removeConnection", fromId:"source", toId:"target"}
Rules: Use short english strings for new ids. You are allowed to use simple Markdown like **bold** in content. Use real JSON newline escapes in strings; never write visible \\n, /n, \\N, or /N markers for layout. Markdown tables must include a divider row and consistent column counts. Target blocks that are locked (locked:true) MUST NEVER be modified or removed. Blocks with positionLocked:true may have label/content updates, but their position and size MUST NOT change. Output ONLY valid JSON array wrapped in: {"operations": [...]}`;
}

/**
 * 白板单节点提炼 Agent 的 System Prompt
 */
function buildRefineSystemPrompt(outline, blockLabel, blockContent) {
  return `You are an expert copywriter and logic refiner.
You will be provided with the current whiteboard outline context, as well as the specific node's content to refine.

Current Whiteboard Outline:
${outline}

Target Node Info:
"Label": "${blockLabel}"
"Content": "${blockContent}"

Analyze the context and deeply refine this node's content:
1. Remove fluff and verbal fillers, organizing it into concise Markdown (bold key terms).
2. RETAIN all original details, concepts, and key information! Do not translate user's content to English unless it was already in English. Keep the language identical to the user's original language!
3. MUST return exactly this JSON format:
{"label": "Optimized Label", "content": "Refined Content..."}`;
}

/**
 * 白板自动命名 Agent 的 System Prompt
 */
function buildNamingSystemPrompt(outline) {
  return `You are a meeting/whiteboard secretary.
Based on the provided content outline, generate a highly concise title name for this whiteboard.
Requirements:
- Strictly under 10 characters length.
- Output ONLY the title text directly without quotes or explanations.
- The title MUST be in the same language as the context.

Current Whiteboard Outline:
${outline}`;
}

/**
 * 聊天主力 Agent 的 System Prompt
 */
function getConversationStage(conversation = [], markdownDraft = '') {
  const userTurns = conversation.filter(message => message.role === 'user').length;
  if (userTurns <= 1 && !markdownDraft) return 'discovery';
  if (userTurns <= 3) return 'clarifying';
  return 'working';
}

function buildChatSystemPrompt(canvasOutline, markdownDraft = '', conversation = [], options = {}) {
  const draftSection = markdownDraft
    ? `\nCurrent Markdown Draft:\n${markdownDraft}\n`
    : '';
  const stage = getConversationStage(conversation, markdownDraft);
  const voiceSection = options.voiceOutputEnabled
    ? `
Voice output is ON.
Your first characters MUST be exactly the voice brief marker. At the very beginning of every response, output exactly one voice brief line in this format:
[[VOICE_BRIEF: your short spoken summary]]

Voice brief rules:
- This line is for TTS only and will be hidden from the chat transcript.
- Keep it natural, concise, and easy to speak aloud.
- Use 1-2 short sentences, no Markdown, no lists, no JSON.
- Focus on what you understood, the key takeaway, or the most important question for the user.
- Do not read the full answer aloud. After the VOICE_BRIEF line, continue with the full visible answer normally.
`
    : `
Voice output is OFF.
Do not output VOICE_BRIEF metadata. Write only the visible answer.
`;
  return `You are a highly professional and friendly 'Voice Chat Copilot'.
The user is brainstorming and exploring ideas with you via voice.
Please note:
1. Your responses must be logical and insightful, but do not jump into long essays too early.
2. There is a separate Canvas Agent handling whiteboard drawing, so DO NOT output any layout or drawing JSON commands.
3. Do not output JSON, tool calls, or canvas operation commands. If voice output is ON, the required VOICE_BRIEF control line is allowed and must come first.
4. Respond in the same language as the user.
5. When a Markdown draft is provided, treat it as the user's editable working draft. Continue from it instead of repeating it wholesale, and suggest precise incremental edits when useful.
6. Use search capabilities only when the user asks for current facts, market/news/policy/source-backed claims, or when you explicitly propose and the user accepts a research step.

Conversation Stage: ${stage}

Stage behavior:
- discovery: The user is probably still defining the task. Do NOT produce a comprehensive answer. Ask 2-4 targeted questions or offer 2-3 concrete directions. Keep the reply short.
- clarifying: Synthesize what you understand, identify missing constraints, and ask the next most important question. If the task would benefit from outside information, say you can do a web collection/deep integration next.
- working: Provide useful structure and actionable output. For research-heavy tasks, propose or perform an online collection/deep integration when the user's request implies current information is needed.

${voiceSection}

Default response shape:
- Prefer concise paragraphs or bullets.
- Avoid dumping background knowledge unless the user directly asks for a full explanation.
- End with one clear next step or one focused question when the task is still ambiguous.

Current Whiteboard Outline:
${canvasOutline}
${draftSection}

If the outline is helpful, integrate the current whiteboard state into your response to provide more contextually relevant replies.`;
}

function getEndpoint(config) {
  const endpoint = config.proxyUrl || config.llmEndpoint;
  if (!endpoint) throw new Error('未配置 LLM endpoint');
  return endpoint;
}

function shouldUseServerProxy(config) {
  if (config.forceDirectLlm) return false;
  if (config.proxyUrl) return false;
  return !import.meta.env.DEV;
}

function getServerProxyEndpoint(config) {
  return config.agentProxyUrl || `${window.location.origin}/api/chat/stream`;
}

const DEFAULT_LLM_MODELS = {
  tongyi: 'qwen-max-latest',
  doubao: 'doubao-1.5-pro',
  deepseekV4Pro: 'deepseek-v4-pro',
  deepseekV4Flash: 'deepseek-v4-flash',
};

function getDefaultModel(config) {
  return DEFAULT_LLM_MODELS[config.llmProvider] || 'qwen-max-latest';
}

function buildPayload(config, messages, isCanvas = false, stream = false) {
  const payload = {
    model: config.llmModel || getDefaultModel(config),
    messages,
  };

  if (isCanvas) {
    payload.temperature = 0.2;
  } else {
    payload.temperature = 0.7;
    if (config.llmProvider === 'tongyi' && config.searchMode !== 'off') {
      payload.enable_search = true;
    }

    if (stream) payload.stream = true;
  }

  return payload;
}

function buildProxyBody(config, messages, isCanvas = false, stream = false) {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
  return {
    messages,
    isCanvas,
    stream,
    temperature: isCanvas ? 0.2 : 0.7,
    searchMode: isCanvas ? 'off' : (config.searchMode || 'off'),
    searchQuery: lastUserMessage?.content || '',
    config: {
      llmProvider: config.llmProvider,
      llmEndpoint: config.llmEndpoint,
      llmModel: config.llmModel,
      llmApiKey: config.llmApiKey,
      preferBuiltinSearch: config.preferBuiltinSearch,
      searchProvider: config.searchProvider,
      searchApiKey: config.searchApiKey,
    },
  };
}

function buildHeaders(config) {
  return {
    'Content-Type': 'application/json',
    ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
  };
}

async function handleErrorResponse(res) {
  const text = await res.text().catch(() => '');

  if (res.status === 401 || res.status === 403 || res.status === 429) {
    window.dispatchEvent(new CustomEvent('api:key-missing', {
      detail: { status: res.status, message: text.slice(0, 200) }
    }));
  }

  throw new Error(`LLM 请求失败 (${res.status}): ${text.slice(0, 200)}`);
}

function extractStreamDelta(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text_delta === 'string') return payload.output_text_delta;
  if (typeof payload.delta === 'string') return payload.delta;
  if (typeof payload.text === 'string') return payload.text;

  const choice = payload.choices?.[0];
  if (!choice) return '';
  const delta = choice.delta || choice.message || {};

  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).join('');
  }
  if (typeof delta.text === 'string') return delta.text;
  return '';
}

function consumeSseBuffer(buffer, onEvent) {
  let rest = buffer;
  while (true) {
    let boundary = rest.indexOf('\n\n');
    let boundaryLength = 2;
    const windowsBoundary = rest.indexOf('\r\n\r\n');
    if (windowsBoundary !== -1 && (boundary === -1 || windowsBoundary < boundary)) {
      boundary = windowsBoundary;
      boundaryLength = 4;
    }
    if (boundary === -1) break;

    const rawEvent = rest.slice(0, boundary);
    rest = rest.slice(boundary + boundaryLength);

    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) continue;
    onEvent(dataLines.join('\n'));
  }
  return rest;
}

async function sendRequest(config, messages, isCanvas = false) {
  if (shouldUseServerProxy(config)) {
    const res = await fetch(getServerProxyEndpoint(config), {
      method: 'POST',
      headers: buildHeaders({}),
      body: JSON.stringify(buildProxyBody(config, messages, isCanvas, false)),
    });

    if (!res.ok) {
      await handleErrorResponse(res);
    }

    const data = await res.json();
    return extractAssistantText(data);
  }

  const endpoint = getEndpoint(config);
  const payload = buildPayload(config, messages, isCanvas, false);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    await handleErrorResponse(res);
  }

  const data = await res.json();
  return extractAssistantText(data);
}

async function sendStreamingChatRequest(config, messages, onDelta) {
  if (shouldUseServerProxy(config)) {
    const res = await fetch(getServerProxyEndpoint(config), {
      method: 'POST',
      headers: buildHeaders({}),
      body: JSON.stringify(buildProxyBody(config, messages, false, true)),
    });

    if (!res.ok) {
      await handleErrorResponse(res);
    }

    return await consumeStreamingResponse(res, onDelta);
  }

  const endpoint = getEndpoint(config);
  const payload = buildPayload(config, messages, false, true);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    await handleErrorResponse(res);
  }

  return await consumeStreamingResponse(res, onDelta);
}

async function consumeStreamingResponse(res, onDelta) {
  if (!res.body) {
    const data = await res.json();
    const text = extractAssistantText(data);
    onDelta?.(text, text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let streamError = null;

  const handleEvent = (dataLine) => {
    if (!dataLine || dataLine === '[DONE]') return;

    try {
      const payload = JSON.parse(dataLine);
      if (payload?.error) {
        streamError = new Error(payload.error);
        return;
      }
      const delta = extractStreamDelta(payload);
      if (!delta) return;
      fullText += delta;
      onDelta?.(fullText, delta);
    } catch {
      fullText += dataLine;
      onDelta?.(fullText, dataLine);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSseBuffer(buffer, handleEvent);
    if (streamError) throw streamError;
  }

  buffer += decoder.decode();
  buffer = consumeSseBuffer(buffer, handleEvent);
  const trailing = buffer.trim().replace(/^data:/, '').trim();
  if (trailing) handleEvent(trailing);
  if (streamError) throw streamError;

  return fullText;
}

/**
 * 前台主 Agent：聊天
 */
export async function callChatLlm(config, conversation, canvas) {
  const outline = buildCanvasOutline(canvas);
  const systemPrompt = buildChatSystemPrompt(outline, config.markdownDraft, conversation, {
    voiceOutputEnabled: Boolean(config.voiceOutputEnabled),
  });
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(config.voiceOutputEnabled ? [{
      role: 'system',
      content: 'Critical voice-mode rule: the assistant response must start with [[VOICE_BRIEF: ...]] before any visible answer text.',
    }] : []),
    ...conversation,
  ];
  const rawText = await sendRequest(config, messages, false);
  return rawText;
}

export async function callChatLlmStream(config, conversation, canvas, handlers = {}) {
  const outline = buildCanvasOutline(canvas);
  const systemPrompt = buildChatSystemPrompt(outline, config.markdownDraft, conversation, {
    voiceOutputEnabled: Boolean(config.voiceOutputEnabled),
  });
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(config.voiceOutputEnabled ? [{
      role: 'system',
      content: 'Critical voice-mode rule: the assistant response must start with [[VOICE_BRIEF: ...]] before any visible answer text.',
    }] : []),
    ...conversation,
  ];
  return await sendStreamingChatRequest(config, messages, handlers.onDelta);
}

export async function callDraftMemoryLlm(config, currentDraft, userText, assistantText, canvas) {
  if (!assistantText?.trim()) return currentDraft || '';

  const outline = buildCanvasOutline(canvas);
  const systemPrompt = `You are a concise project memory agent.
Maintain a Markdown working memory for an interactive whiteboard session.
This memory is NOT a chat log. It should be a compact, deduplicated, editable brief that helps future turns use fewer tokens.

Rules:
- Preserve important user intent, decisions, constraints, facts, open questions, and next actions.
- Merge repeated ideas instead of appending messages.
- Remove stale chatter, greetings, and transient wording.
- Keep the same primary language as the user.
- Use Markdown headings and bullets.
- Keep it under 900 Chinese characters or 600 English words unless the existing draft is already longer.
- Output ONLY the updated Markdown memory.`;

  const userPrompt = `Current whiteboard outline:
${outline}

Current Markdown memory:
${currentDraft || '(empty)'}

Latest user message:
${userText}

Latest assistant response:
${assistantText}

Rewrite the Markdown memory now.`;

  return await sendRequest(
    {
      ...config,
      searchMode: 'off',
    },
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    true
  );
}

export async function callMarkdownRepairLlm(config, text, context = {}) {
  const systemPrompt = `You repair malformed Markdown for an interactive whiteboard node.
Return ONLY valid JSON with this exact shape:
{"content":"..."}

Rules:
- Preserve the original language, facts, order, and wording as much as possible.
- Convert visible newline markers such as \\n, /n, \\N, /N into real line breaks.
- Repair Markdown tables so every row has the same number of columns.
- If a cell needs a literal pipe character, escape it as \\|.
- Add the required Markdown divider row after a table header.
- Do not add commentary or new information.`;

  const userPrompt = `Node context:
${JSON.stringify(context, null, 2)}

Malformed content:
${text}`;

  const rawText = await sendRequest(
    {
      ...config,
      searchMode: 'off',
    },
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    true
  );

  try {
    const jsonStr = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.content === 'string') return parsed.content;
  } catch (error) {
    console.warn('Markdown repair parse failed:', error);
  }

  return text;
}

/**
 * 后台幽灵 Agent：白板更新
 */
export async function callCanvasLlm(config, conversation, canvas) {
  const canvasJson = JSON.stringify({
    title: canvas.title,
    blocks: canvas.blocks.map(b => ({ id: b.id, type: b.type, label: b.label, content: b.content, locked: b.locked, positionLocked: b.positionLocked })),
    connections: canvas.connections.map(c => ({ from: c.fromId, to: c.toId })),
  }, null, 2);

  const systemPrompt = buildCanvasSystemPrompt(canvasJson);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation,
  ];

  const rawText = await sendRequest(config, messages, true);
  return rawText;
}

/**
 * 整理白板 Agent：一键整理和合并
 */
export async function callOrganizeLlm(config, canvas) {
  const canvasJson = JSON.stringify({
    title: canvas.title,
    blocks: canvas.blocks.map(b => ({ id: b.id, label: b.label, content: b.content, locked: b.locked, positionLocked: b.positionLocked })),
    connections: canvas.connections.map(c => ({ from: c.fromId, to: c.toId })),
  }, null, 2);

  const systemPrompt = `You are a whiteboard organization expert.
The user wants to organize the current whiteboard. Retain ALL details, but semantically merge duplicate/similar nodes, deduce better hierarchical structures (you may create new parent or categorization nodes), and adjust block connections.
Current Whiteboard State:
${canvasJson}

Analyze the true relationships between these nodes. Merge them, remove redundancies, or add parent nodes to group them.
Crucially, RETAIN useful 'content' from every node. When merging, concatenate the content.
Do NOT translate user content into English! Output in the user's language.
Never modify or remove locked:true nodes. Nodes with positionLocked:true may have label/content updates, but their position and size must not change.

Requirements:
Return ONLY valid JSON. Format exactly as:
{
  "operations": [
    { "op": "add", "block": { "id": "newId", "label": "Label", "content": "Content" }, "parentId": "optional new/old parent ID" },
    { "op": "update", "targetId": "existingId", "changes": { "label": "New Label", "content": "Merged Content" } },
    { "op": "remove", "targetId": "existingId" },
    { "op": "addConnection", "fromId": "sourceId", "toId": "targetId" },
    { "op": "removeConnection", "fromId": "sourceId", "toId": "targetId" }
  ]
}
Note:
1. "parentId" in add op can reference an existing node or a newly added node.
2. Only return operations for nodes that are changed or moved.
3. Use short english strings for new ids.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Please organize the whiteboard, merge similar nodes, improve structure, and return JSON operations.' }
  ];

  return await sendRequest(config, messages, true);
}

/**
 * 猜你想问 Agent：根据当前白板生成推荐请求
 */
export async function callSuggestLlm(config, canvas) {
  const canvasJson = JSON.stringify({
    title: canvas.title,
    blocks: canvas.blocks.map(b => ({ label: b.label, content: b.content })),
  }, null, 2);

  const systemPrompt = `You are a brainstorming assistant. Based on the current whiteboard content, deduce the 3 most likely next actions, questions, or structure expansions the user might want.
Requirements:
- Strictly return a JSON array containing exactly 3 string items.
- Each phrase must be 5-15 characters long, written as a spoken command (e.g. "Add technical risks").
- Must be in the user's language! Do not output English unless the board is English.
- Return ONLY the JSON.
Current Whiteboard State:
${canvasJson}`;

  const rawText = await sendRequest(config, [{ role: 'system', content: systemPrompt }], true);
  try {
    const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return arr.slice(0, 3);
  } catch(e) {
    console.error('Failed to parse suggestions:', e);
  }
  return [];
}

/**
 * 后台局部提炼：重写单个节点
 */
export async function callRefineLlm(config, block, canvas) {
  const outline = buildCanvasOutline(canvas);
  const systemPrompt = buildRefineSystemPrompt(outline, block.label, block.content);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Please refine this node.' }
  ];
  const rawText = await sendRequest(config, messages, true);

  let result = { label: block.label, content: block.content };
  try {
    const jsonStr = rawText.replace(/```json\n?|\n?```/gi, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed.label) result.label = parsed.label;
    if (parsed.content) result.content = parsed.content;
  } catch(e) {
    console.error('Refine parse failed', e);
  }
  return result;
}

/**
 * 自动命名请求
 */
export async function callNamingLlm(config, canvas) {
  const outline = buildCanvasOutline(canvas);
  const systemPrompt = buildNamingSystemPrompt(outline);
  const rawText = await sendRequest(config, [{ role: 'system', content: systemPrompt }], true);
  return rawText.replace(/^['"]|['"]$/g, '').trim();
}
