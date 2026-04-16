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
Rules: Use short english strings for new ids. You are allowed to use simple Markdown like **bold** in content. Target blocks that are locked (locked:true) MUST NEVER be modified or removed. Output ONLY valid JSON array wrapped in: {"operations": [...]}`;
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
function buildChatSystemPrompt(canvasOutline) {
  return `You are a highly professional and friendly 'Voice Chat Copilot'.
The user is brainstorming and exploring ideas with you via voice.
Please note:
1. Your responses must be logical and insightful. Use search capabilities to provide deep answers while maintaining a conversational pacing.
2. There is a separate Canvas Agent handling whiteboard drawing, so DO NOT output any layout or drawing JSON commands.
3. Output pure text responses only.
4. Respond in the same language as the user.

Current Whiteboard Outline:
${canvasOutline}

If the outline is helpful, integrate the current whiteboard state into your response to provide more contextually relevant replies.`;
}

/**
 * 内部通用的调用请求
 */
async function sendRequest(config, messages, isCanvas = false) {
  const endpoint = config.proxyUrl || config.llmEndpoint;
  if (!endpoint) throw new Error('未配置 LLM endpoint');

  const payload = {
    // 升级至阿里云最新顶级旗舰大模型处理能力
    model: config.llmProvider === 'doubao' ? 'doubao-1.5-pro' : 'qwen-max-latest',
    messages,
  };

  // 白板Agent可以尝试加一点temperature或者改参数
  if (isCanvas) {
    payload.temperature = 0.2; // canvas需要更确定的json
    // 如果模型支持专门的 response_format，可以加上。不过各大模型支持不一致，暂时省略
  } else {
    payload.temperature = 0.7; // 聊天丰富一点
    // 为聊天副驾开启搜索能力，大幅增强智能（兼容通义千问等支持该参数的底层模型）
    payload.enable_search = true;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // 401/403 错误表示 API key 缺失或无效，触发自定义事件通知 UI
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new CustomEvent('api:key-missing', {
        detail: { status: res.status, message: text.slice(0, 200) }
      }));
    }

    throw new Error(`LLM 请求失败 (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return extractAssistantText(data);
}

/**
 * 前台主 Agent：聊天
 */
export async function callChatLlm(config, conversation, canvas) {
  const outline = buildCanvasOutline(canvas);
  const systemPrompt = buildChatSystemPrompt(outline);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation,
  ];
  const rawText = await sendRequest(config, messages, false);
  return rawText;
}

/**
 * 后台幽灵 Agent：白板更新
 */
export async function callCanvasLlm(config, conversation, canvas) {
  const canvasJson = JSON.stringify({
    title: canvas.title,
    blocks: canvas.blocks.map(b => ({ id: b.id, type: b.type, label: b.label, content: b.content, locked: b.locked })),
    connections: canvas.connections.map(c => ({ from: c.fromId, to: c.toId })),
  }, null, 2);

  const systemPrompt = buildCanvasSystemPrompt(canvasJson);
  const messages = [
    { role: 'system', content: systemPrompt },
    // 仅仅传递对话内容，看看需不需要画图
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
    blocks: canvas.blocks.map(b => ({ id: b.id, label: b.label, content: b.content })),
    connections: canvas.connections.map(c => ({ from: c.fromId, to: c.toId })),
  }, null, 2);

  const systemPrompt = `You are a whiteboard organization expert.
The user wants to organize the current whiteboard. Retain ALL details, but semantically merge duplicate/similar nodes, deduce better hierarchical structures (you may create new parent or categorization nodes), and adjust block connections.
Current Whiteboard State:
${canvasJson}

Analyze the true relationships between these nodes. Merge them, remove redundancies, or add parent nodes to group them.
Crucially, RETAIN useful 'content' from every node. When merging, concatenate the content.
Do NOT translate user content into English! Output in the user's language.

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
  const rawText = await sendRequest(config, messages, true); // true for low temp / structured
  
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
  const messages = [
    { role: 'system', content: systemPrompt }
  ];
  const title = await sendRequest(config, messages, true);
  return title ? title.trim() : null;
}
