import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanvasOutline,
  dedupeConnections,
  executeOperations,
  extractAssistantText,
  extractJson,
  parseAiResponse,
  renderMarkdown,
} from '../src/utils/parser.js';

test('extractJson parses JSON wrapped in markdown fences', () => {
  const parsed = extractJson('before\n```json\n{"reply":"ok","operations":[]}\n```\nafter');

  assert.deepEqual(parsed, { reply: 'ok', operations: [] });
});

test('extractAssistantText supports OpenAI-compatible message payloads', () => {
  const text = extractAssistantText({
    choices: [
      {
        message: {
          content: [
            { text: 'hello' },
            { text: 'world' },
          ],
        },
      },
    ],
  });

  assert.equal(text, 'hello\nworld');
});

test('parseAiResponse normalizes operation responses', () => {
  const result = parseAiResponse(JSON.stringify({
    reply: 'done',
    operations: [
      {
        op: 'add',
        parentId: 'root',
        block: {
          id: 'child',
          label: 'Child',
        },
      },
      {
        op: 'unknown',
      },
    ],
  }));

  assert.equal(result.reply, 'done');
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].block.id, 'child');
  assert.equal(result.operations[0].block.content, '');
  assert.equal(result.operations[0].block.type, 'text');
});

test('renderMarkdown renders pipe tables with escaped cell content', () => {
  const html = renderMarkdown([
    '| 项目 | Pocket 4 | Pocket 4 Pro |',
    '|------|-----------|---------------|',
    '| 传感器 | 1英寸堆栈式 BSI CMOS | M43 (4/3英寸) CMOS，双原生ISO |',
    '| 编码格式 | **H.265** | <script>alert(1)</script> |',
  ].join('\n'));

  assert.match(html, /<table class="markdown-table">/);
  assert.match(html, /<th>项目<\/th>/);
  assert.match(html, /<td><strong>H\.265<\/strong><\/td>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('executeOperations adds blocks, connections, updates, and removes safely', () => {
  const canvas = {
    blocks: [
      { id: 'root', label: 'Root', content: '', type: 'text' },
      { id: 'locked', label: 'Locked', content: '', type: 'text', locked: true },
    ],
    connections: [],
  };

  const result = executeOperations(canvas, [
    {
      op: 'add',
      parentId: 'root',
      block: { id: 'child', label: 'Child', content: '', type: 'text' },
    },
    {
      op: 'update',
      targetId: 'child',
      changes: { label: 'Updated', x: 999, locked: true },
    },
    {
      op: 'remove',
      targetId: 'locked',
    },
  ]);

  assert.deepEqual(result.addedIds, ['child']);
  assert.deepEqual(result.updatedIds, ['child']);
  assert.deepEqual(result.removedIds, []);
  assert.equal(canvas.blocks.find(block => block.id === 'child').label, 'Updated');
  assert.equal(canvas.blocks.find(block => block.id === 'child').x, undefined);
  assert.equal(canvas.blocks.some(block => block.id === 'locked'), true);
  assert.deepEqual(canvas.connections.map(conn => [conn.fromId, conn.toId]), [['root', 'child']]);
});

test('dedupeConnections removes duplicate directed edges', () => {
  const canvas = {
    connections: [
      { id: 'a', fromId: 'one', toId: 'two' },
      { id: 'b', fromId: 'one', toId: 'two' },
      { id: 'c', fromId: 'two', toId: 'one' },
    ],
  };

  assert.equal(dedupeConnections(canvas), true);
  assert.deepEqual(canvas.connections.map(conn => conn.id), ['a', 'c']);
});

test('buildCanvasOutline renders roots and nested children once', () => {
  const outline = buildCanvasOutline({
    blocks: [
      { id: 'root', label: 'Root' },
      { id: 'child', label: 'Child', locked: true },
      { id: 'other', label: 'Other' },
    ],
    connections: [
      { fromId: 'root', toId: 'child' },
    ],
  });

  assert.equal(outline, '【当前图表大纲】\n- [Root] \n  - [Child] (已被图钉锁定)\n- [Other]');
});
