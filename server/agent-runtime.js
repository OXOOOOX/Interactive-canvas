import { randomUUID } from 'node:crypto';
import { computeCanvasRevision } from './canvas-revision.js';

const TEAM_PATTERN = /多智能体|多代理|多个智能体|组队|团队分析|研究团队|交叉验证|正反分析|分别研究|multi[- ]?agent|swarm|research team/i;
const COMPLEX_RESEARCH_PATTERN = /深度研究|综合研究|全面调研|多个来源|多方来源|来源核验|方案对比|竞品分析|风险审查|批判性分析|research|compare|verify sources/i;
const CANVAS_ACTION_PATTERN = /编辑|修改|改写|润色|整理|重构|新增|添加|连接|关联|拆分|合并|白板|卡片|节点|文本块|mindmap|canvas|edit|rewrite|add block|connect/i;
const MAX_TOOL_ITERATIONS = 8;

function extractAssistantMessage(payload = {}) {
  const message = payload?.choices?.[0]?.message;
  if (message && typeof message === 'object') return message;
  if (typeof payload.output_text === 'string') return { content: payload.output_text, tool_calls: [] };
  return { content: '', tool_calls: [] };
}

function extractJson(text = '') {
  const source = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

function fallbackAgentPlan(query = '') {
  if (TEAM_PATTERN.test(query) || COMPLEX_RESEARCH_PATTERN.test(query)) {
    return { mode: 'team', reason: 'complex_research' };
  }
  if (CANVAS_ACTION_PATTERN.test(query)) {
    return { mode: 'single', reason: 'canvas_action' };
  }
  return { mode: 'fast', reason: 'ordinary_chat' };
}

async function requestModel({ endpoint, apiKey, model, messages, tools, signal, temperature = 0.2 }) {
  if (signal?.aborted) throw new Error('Agent run cancelled.');
  const body = { model, messages, temperature, stream: false };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Agent model request failed (${response.status}): ${text.slice(0, 240)}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Agent model returned invalid JSON.'); }
  return extractAssistantMessage(payload);
}

async function planAgentMode({ query, endpoint, apiKey, model, messages = [], signal }) {
  const fallback = fallbackAgentPlan(query);
  if (fallback.mode === 'fast' || !endpoint || !apiKey) return fallback;
  try {
    const message = await requestModel({
      endpoint,
      apiKey,
      model,
      signal,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Classify whether a whiteboard assistant request needs a bounded tool agent.
Return ONLY JSON: {"mode":"fast|single|team","reason":"..."}.
- fast: ordinary conversation or a direct answer with no canvas inspection/editing.
- single: one agent needs canvas read/edit tools or a short sequence of tool calls.
- team: complex research, source verification, multi-perspective comparison, or an explicit multi-agent request.
Never select team only because the request is long.`,
        },
        ...messages.slice(-4).map(item => ({ role: item.role, content: String(item.content || '').slice(0, 800) })),
        { role: 'user', content: query },
      ],
    });
    const parsed = extractJson(message.content);
    if (['fast', 'single', 'team'].includes(parsed?.mode)) return { mode: parsed.mode, reason: String(parsed.reason || '') };
  } catch {
    // The classifier is advisory; fall back to the deterministic route.
  }
  return fallback;
}

function cloneCanvas(canvas = {}) {
  return JSON.parse(JSON.stringify({
    id: canvas.id || '',
    title: canvas.title || '',
    memory: canvas.memory || '',
    blocks: Array.isArray(canvas.blocks) ? canvas.blocks : [],
    connections: Array.isArray(canvas.connections) ? canvas.connections : [],
  }));
}

function canvasSummary(canvas) {
  return JSON.stringify({
    title: canvas.title,
    memory: canvas.memory,
    blocks: canvas.blocks.map(block => ({
      id: block.id,
      type: block.type,
      label: block.label,
      content: block.content,
      locked: Boolean(block.locked),
      positionLocked: Boolean(block.positionLocked),
    })),
    connections: canvas.connections.map(connection => ({ fromId: connection.fromId, toId: connection.toId })),
  });
}

function safeToolArguments(toolCall = {}) {
  const raw = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function toolDefinitions(allowedTools) {
  const definitions = {
    read_canvas: {
      type: 'function', function: { name: 'read_canvas', description: 'Read the current whiteboard text blocks and connections.', parameters: { type: 'object', properties: {} } },
    },
    search_web: {
      type: 'function', function: { name: 'search_web', description: 'Search the web for current or source-backed information.', parameters: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'] } },
    },
    edit_canvas_text: {
      type: 'function', function: { name: 'edit_canvas_text', description: 'Update labels or Markdown content of existing unlocked blocks.', parameters: { type: 'object', properties: { updates: { type: 'array', items: { type: 'object', properties: { blockId: { type: 'string' }, label: { type: 'string' }, content: { type: 'string' } }, required: ['blockId'] } } }, required: ['updates'] } },
    },
    add_canvas_block: {
      type: 'function', function: { name: 'add_canvas_block', description: 'Add a text block, optionally as a child of an existing unlocked block.', parameters: { type: 'object', properties: { label: { type: 'string' }, content: { type: 'string' }, parentId: { type: 'string' } }, required: ['label'] } },
    },
    connect_blocks: {
      type: 'function', function: { name: 'connect_blocks', description: 'Connect two existing unlocked blocks.', parameters: { type: 'object', properties: { fromId: { type: 'string' }, toId: { type: 'string' } }, required: ['fromId', 'toId'] } },
    },
  };
  return [...allowedTools].map(name => definitions[name]).filter(Boolean);
}

function applyOperationToWorkingCanvas(canvas, operation) {
  if (operation.op === 'update') {
    const block = canvas.blocks.find(item => item.id === operation.targetId);
    if (block && !block.locked) Object.assign(block, operation.changes);
  } else if (operation.op === 'add') {
    canvas.blocks.push(operation.block);
    if (operation.parentId) canvas.connections.push({ id: randomUUID(), fromId: operation.parentId, toId: operation.block.id });
  } else if (operation.op === 'addConnection') {
    canvas.connections.push({ id: randomUUID(), fromId: operation.fromId, toId: operation.toId });
  }
}

async function executeTool({ name, args, canvas, operations, searchWeb }) {
  if (name === 'read_canvas') return { status: 'ok', canvas: JSON.parse(canvasSummary(canvas)) };
  if (name === 'search_web') {
    const search = await searchWeb(String(args.query || '').trim(), Number(args.maxResults || 5));
    return { status: 'ok', ...(Array.isArray(search) ? { results: search } : search) };
  }
  if (name === 'edit_canvas_text') {
    const changed = [];
    const rejected = [];
    for (const update of Array.isArray(args.updates) ? args.updates : []) {
      const block = canvas.blocks.find(item => item.id === update.blockId);
      if (!block || block.locked) { rejected.push(update.blockId); continue; }
      const changes = {};
      if (typeof update.label === 'string') changes.label = update.label;
      if (typeof update.content === 'string') changes.content = update.content;
      if (!Object.keys(changes).length) continue;
      const operation = { op: 'update', targetId: block.id, changes };
      operations.push(operation);
      applyOperationToWorkingCanvas(canvas, operation);
      changed.push(block.id);
    }
    return { status: 'ok', changed, rejected };
  }
  if (name === 'add_canvas_block') {
    const parent = args.parentId ? canvas.blocks.find(item => item.id === args.parentId) : null;
    if (args.parentId && (!parent || parent.locked)) return { status: 'error', error: 'Parent block is missing or locked.' };
    const block = { id: `agent-${randomUUID()}`, type: 'text', label: String(args.label || '新卡片'), content: String(args.content || ''), children: [] };
    const operation = { op: 'add', block, parentId: parent?.id || null };
    operations.push(operation);
    applyOperationToWorkingCanvas(canvas, operation);
    return { status: 'ok', blockId: block.id };
  }
  if (name === 'connect_blocks') {
    const from = canvas.blocks.find(item => item.id === args.fromId);
    const to = canvas.blocks.find(item => item.id === args.toId);
    if (!from || !to || from.locked || to.locked) return { status: 'error', error: 'Connection endpoint is missing or locked.' };
    if (canvas.connections.some(item => item.fromId === from.id && item.toId === to.id)) return { status: 'ok', unchanged: true };
    const operation = { op: 'addConnection', fromId: from.id, toId: to.id };
    operations.push(operation);
    applyOperationToWorkingCanvas(canvas, operation);
    return { status: 'ok', connected: [from.id, to.id] };
  }
  return { status: 'error', error: `Unsupported tool: ${name}` };
}

async function runWorker({ id, role, prompt, canvas, allowedTools, endpoint, apiKey, model, searchWeb, signal, emit, maxIterations = MAX_TOOL_ITERATIONS }) {
  const operations = [];
  const workingCanvas = cloneCanvas(canvas);
  const messages = [
    {
      role: 'system',
      content: `${role}
Use only the provided tools. Never invent block IDs or search results. Locked blocks cannot be changed.
When the requested work is complete, stop calling tools and return a concise public work summary.`,
    },
    { role: 'user', content: prompt },
  ];
  const tools = toolDefinitions(allowedTools);
  let summary = '';

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (signal?.aborted) throw new Error('Agent run cancelled.');
    const response = await requestModel({ endpoint, apiKey, model, messages, tools: iteration === maxIterations - 1 ? [] : tools, signal });
    const toolCalls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
    if (!toolCalls.length) {
      summary = String(response.content || '').trim();
      return { id, status: 'completed', summary, operations, iterations: iteration + 1 };
    }
    messages.push({ role: 'assistant', content: response.content || '', tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call?.function?.name || call?.name || '';
      const callId = call.id || randomUUID();
      const args = safeToolArguments(call);
      emit?.('tool.started', { agentId: id, callId, tool: name, iteration: iteration + 1 });
      const startedAt = Date.now();
      try {
        const result = await executeTool({ name, args, canvas: workingCanvas, operations, searchWeb });
        emit?.(result.status === 'error' ? 'tool.failed' : 'tool.completed', {
          agentId: id,
          callId,
          tool: name,
          elapsedMs: Date.now() - startedAt,
          summary: result.status === 'error' ? result.error : JSON.stringify(result).slice(0, 260),
        });
        messages.push({ role: 'tool', tool_call_id: callId, name, content: JSON.stringify(result) });
      } catch (error) {
        emit?.('tool.failed', { agentId: id, callId, tool: name, elapsedMs: Date.now() - startedAt, summary: error.message });
        messages.push({ role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ status: 'error', error: error.message }) });
      }
    }
  }
  return { id, status: 'limit', summary: 'Agent reached its tool iteration limit.', operations, iterations: maxIterations };
}

function formatTeamContext(results) {
  return results.map(result => `## ${result.id}\nStatus: ${result.status}\n${result.summary || '(no summary)'}`).join('\n\n');
}

async function runTeam({ query, canvas, endpoint, apiKey, model, searchWeb, signal, emit }) {
  const members = [
    { id: 'researcher', role: '资料研究', status: 'pending' },
    { id: 'canvas_analyst', role: '白板结构分析', status: 'pending' },
    { id: 'critic', role: '质疑校验', status: 'blocked' },
    { id: 'synthesizer', role: '综合输出', status: 'blocked' },
  ];
  emit?.('team.started', { members });

  const runMember = async (member, options) => {
    emit?.('team.agent.updated', { agentId: member.id, role: member.role, status: 'running' });
    try {
      const result = await runWorker(options);
      emit?.('team.agent.updated', { agentId: member.id, role: member.role, status: result.status, iterations: result.iterations, summary: result.summary.slice(0, 180) });
      return result;
    } catch (error) {
      emit?.('team.agent.updated', { agentId: member.id, role: member.role, status: signal?.aborted ? 'cancelled' : 'failed', error: error.message });
      return { id: member.id, status: signal?.aborted ? 'cancelled' : 'failed', summary: '', operations: [], error: error.message };
    }
  };

  const [research, canvasAnalysis] = await Promise.all([
    runMember(members[0], { id: 'researcher', role: 'You are the source-backed research specialist.', prompt: query, canvas, allowedTools: new Set(['search_web', 'read_canvas']), endpoint, apiKey, model, searchWeb, signal, emit }),
    runMember(members[1], { id: 'canvas_analyst', role: 'You analyze the current whiteboard structure and make precise canvas edits only when the user explicitly requests them.', prompt: query, canvas, allowedTools: new Set(['read_canvas', 'edit_canvas_text', 'add_canvas_block', 'connect_blocks']), endpoint, apiKey, model, searchWeb, signal, emit }),
  ]);

  const upstream = formatTeamContext([research, canvasAnalysis]);
  const critic = await runMember(members[2], {
    id: 'critic',
    role: 'You are an independent critic. Check unsupported claims, contradictions, missing evidence, and risky canvas edits.',
    prompt: `${query}\n\nUpstream reports:\n${upstream}`,
    canvas,
    allowedTools: new Set(['read_canvas']),
    endpoint, apiKey, model, searchWeb, signal, emit,
    maxIterations: 4,
  });
  emit?.('team.agent.updated', { agentId: 'synthesizer', role: '综合输出', status: 'running' });
  return {
    context: `A multi-agent team prepared the following reports. Synthesize them into the final answer, distinguish verified facts from suggestions, and do not claim failed work succeeded.\n\n${formatTeamContext([research, canvasAnalysis, critic])}`,
    operations: [...research.operations, ...canvasAnalysis.operations, ...critic.operations],
    members: [research, canvasAnalysis, critic],
  };
}

async function runAgentRuntime({ query = '', messages = [], canvas = {}, endpoint, apiKey, model, searchWeb, signal, emit }) {
  const plan = await planAgentMode({ query, endpoint, apiKey, model, messages, signal });
  emit?.('agent.plan', { mode: plan.mode, reason: plan.reason, maxIterations: MAX_TOOL_ITERATIONS });
  if (plan.mode === 'fast') return { mode: 'fast', context: '', operations: [], baseRevision: computeCanvasRevision(canvas) };

  const baseRevision = computeCanvasRevision(canvas);
  if (plan.mode === 'team') {
    const team = await runTeam({ query, canvas, endpoint, apiKey, model, searchWeb, signal, emit });
    return { mode: 'team', baseRevision, ...team };
  }

  const worker = await runWorker({
    id: 'whiteboard_agent',
    role: 'You are a bounded whiteboard agent. Inspect and edit the current canvas only when the user asks.',
    prompt: query,
    canvas,
    allowedTools: new Set(['read_canvas', 'search_web', 'edit_canvas_text', 'add_canvas_block', 'connect_blocks']),
    endpoint, apiKey, model, searchWeb, signal, emit,
  });
  return {
    mode: 'single',
    baseRevision,
    operations: worker.operations,
    context: `A bounded whiteboard agent completed preparatory work. Use this public summary when answering:\n${worker.summary || '(no summary)'}`,
    worker,
  };
}

export {
  fallbackAgentPlan,
  planAgentMode,
  runAgentRuntime,
  runWorker,
};
