import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_RESEARCH_DEMO_PROMPT, createAgentResearchDemoCanvas } from '../src/utils/agent-demo.js';
import { validateCanvasIntegrity } from '../src/utils/parser.js';

test('agent research demo provides a valid research canvas and team prompt', () => {
  let id = 0;
  const canvas = createAgentResearchDemoCanvas(() => `demo-${++id}`);
  assert.equal(canvas.blocks.length, 6);
  assert.equal(canvas.connections.length, 5);
  assert.equal(validateCanvasIntegrity(canvas).valid, true);
  assert.match(canvas.memory, /来源/);
  assert.match(AGENT_RESEARCH_DEMO_PROMPT, /多智能体研究团队/);
  assert.match(AGENT_RESEARCH_DEMO_PROMPT, /质疑校验/);
  assert.match(AGENT_RESEARCH_DEMO_PROMPT, /更新到白板/);
});
