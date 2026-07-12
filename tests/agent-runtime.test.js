import test from 'node:test';
import assert from 'node:assert/strict';

import { fallbackAgentPlan, runAgentRuntime, runWorker } from '../server/agent-runtime.js';
import { computeCanvasRevision as computeServerCanvasRevision } from '../server/canvas-revision.js';
import { getSearchProviderOrder, runExternalSearch } from '../server/index.js';
import { computeCanvasRevision as computeClientCanvasRevision } from '../src/utils/canvas-revision.js';

const canvas = {
  id: 'canvas-1',
  title: 'Plan',
  memory: '',
  blocks: [
    { id: 'open', type: 'text', label: 'Open', content: 'old' },
    { id: 'locked', type: 'text', label: 'Locked', content: 'keep', locked: true },
  ],
  connections: [],
};

function modelResponse(message, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('agent routing preserves the fast path and selects team only for complex work', () => {
  assert.equal(fallbackAgentPlan('你好').mode, 'fast');
  assert.equal(fallbackAgentPlan('把白板中的结论卡片润色一下').mode, 'single');
  assert.equal(fallbackAgentPlan('请用多智能体交叉验证多个来源').mode, 'team');
});

test('canvas revision changes after text edits and is stable across array order', () => {
  const original = computeServerCanvasRevision(canvas);
  const reordered = { ...canvas, blocks: [...canvas.blocks].reverse() };
  assert.equal(computeServerCanvasRevision(reordered), original);
  const edited = structuredClone(canvas);
  edited.blocks[0].content = 'new';
  assert.notEqual(computeServerCanvasRevision(edited), original);
  assert.equal(computeClientCanvasRevision(canvas), original);
  assert.equal(computeClientCanvasRevision(edited), computeServerCanvasRevision(edited));
});

test('bounded worker executes multiple tools and rejects locked block edits', async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return modelResponse({
        content: '',
        tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_canvas', arguments: '{}' } }],
      });
    }
    if (call === 2) {
      return modelResponse({
        content: '',
        tool_calls: [{
          id: 'edit-1',
          type: 'function',
          function: {
            name: 'edit_canvas_text',
            arguments: JSON.stringify({ updates: [
              { blockId: 'open', content: 'new' },
              { blockId: 'locked', content: 'overwrite' },
            ] }),
          },
        }],
      });
    }
    return modelResponse({ content: 'Updated the unlocked block; left the locked block unchanged.', tool_calls: [] });
  };

  try {
    const events = [];
    const result = await runWorker({
      id: 'whiteboard_agent',
      role: 'test',
      prompt: 'edit',
      canvas,
      allowedTools: new Set(['read_canvas', 'edit_canvas_text']),
      endpoint: 'https://example.test/chat/completions',
      apiKey: 'key',
      model: 'model',
      searchWeb: async () => [],
      emit: (name, payload) => events.push({ name, payload }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].targetId, 'open');
    assert.equal(events.filter(event => event.name === 'tool.completed').length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker reports the iteration limit and supports cancellation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => modelResponse({
    content: '',
    tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'read_canvas', arguments: '{}' } }],
  });
  try {
    const limited = await runWorker({
      id: 'agent', role: 'test', prompt: 'loop', canvas,
      allowedTools: new Set(['read_canvas']), endpoint: 'https://example.test', apiKey: 'key', model: 'model',
      searchWeb: async () => [], maxIterations: 2,
    });
    assert.equal(limited.status, 'limit');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => runWorker({
      id: 'agent', role: 'test', prompt: 'cancel', canvas,
      allowedTools: new Set(['read_canvas']), endpoint: 'https://example.test', apiKey: 'key', model: 'model',
      searchWeb: async () => [], signal: controller.signal,
    }), /cancelled/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team orchestration continues when one specialist fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    const system = String(body.messages?.[0]?.content || '');
    if (system.includes('Classify whether')) return modelResponse({ content: '{"mode":"team","reason":"test"}', tool_calls: [] });
    if (system.includes('source-backed research')) return modelResponse({ content: 'provider failed' }, 500);
    if (system.includes('current whiteboard structure')) return modelResponse({ content: 'Canvas structure is coherent.', tool_calls: [] });
    if (system.includes('independent critic')) return modelResponse({ content: 'Flag the missing research evidence.', tool_calls: [] });
    return modelResponse({ content: 'ok', tool_calls: [] });
  };
  try {
    const events = [];
    const result = await runAgentRuntime({
      query: '请用多智能体交叉验证', messages: [], canvas,
      endpoint: 'https://example.test', apiKey: 'key', model: 'model', searchWeb: async () => [],
      emit: (name, payload) => events.push({ name, payload }),
    });
    assert.equal(result.mode, 'team');
    assert.match(result.context, /researcher[\s\S]*failed/);
    assert.match(result.context, /Canvas structure is coherent/);
    assert.ok(events.some(event => event.name === 'team.agent.updated' && event.payload.agentId === 'researcher' && event.payload.status === 'failed'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search provider order and fallback expose the actual source', async () => {
  const order = getSearchProviderOrder('example', {
    searchProvider: 'tavily',
    searchApiKeys: { tavily: 't-key', serper: 's-key' },
  });
  assert.deepEqual(order, ['tavily', 'serper']);

  const originalFetch = globalThis.fetch;
  let tavilyCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('tavily')) {
      tavilyCalls += 1;
      return new Response(JSON.stringify({ error: 'temporary' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ organic: [{ title: 'Result', link: 'https://source.test/page', snippet: 'Evidence' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await runExternalSearch('example', { socket: { remoteAddress: '127.0.0.1' }, headers: {} }, {
      searchProvider: 'tavily',
      searchApiKeys: { tavily: 't-key', serper: 's-key' },
    });
    assert.equal(tavilyCalls, 2);
    assert.equal(result.provider, 'serper');
    assert.equal(result.results[0].provider, 'serper');
    assert.equal(result.attempts.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
