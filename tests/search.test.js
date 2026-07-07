import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContextualSearchQuery,
  buildFallbackSearchPlan,
  isVagueFollowupSearch,
  normalizeSearchPlan,
  reconcileSearchPlan,
  shouldAutoSearch,
  shouldUseBuiltinSearch,
  shouldUseExternalSearch,
} from '../server/index.js';

test('builds a concrete query for explicit mainland Starbucks new-product search', () => {
  const query = buildContextualSearchQuery('帮我搜索中国大陆星巴克的新品。', [
    { role: 'user', content: '帮我搜索中国大陆星巴克的新品。' },
  ]);

  assert.equal(query, '星巴克 中国大陆 新品');
  assert.equal(shouldAutoSearch(query), true);
});

test('keeps McDonalds in mainland new-product search query', () => {
  const query = buildContextualSearchQuery('帮我搜索一下中国大陆地区麦当劳的新品。', [
    { role: 'user', content: '帮我搜索一下中国大陆地区麦当劳的新品。' },
  ]);

  assert.equal(query, '麦当劳 中国大陆 新品');
  assert.equal(shouldAutoSearch(query), true);
});

test('keeps concrete product category in a generic search query', () => {
  const query = buildContextualSearchQuery('帮我搜索一些新的汉堡，中国大陆地区的麦当劳，新的汉堡。', [
    { role: 'user', content: '帮我搜索一些新的汉堡，中国大陆地区的麦当劳，新的汉堡。' },
  ]);

  assert.match(query, /麦当劳/);
  assert.match(query, /汉堡/);
  assert.match(query, /中国大陆/);
  assert.equal(shouldAutoSearch(query), true);
});

test('strips command wrappers from quoted current search query', () => {
  const query = buildContextualSearchQuery('直接搜最新一期的「麦当劳当月汉堡」。', [
    { role: 'user', content: '直接搜最新一期的「麦当劳当月汉堡」。' },
  ]);

  assert.equal(query, '麦当劳当月汉堡 最新');
  assert.equal(shouldAutoSearch(query), true);
});

test('normalizes LLM search planner JSON decisions', () => {
  const plan = normalizeSearchPlan({
    action: 'SEARCH',
    query: '  麦当劳当月汉堡 最新  ',
    reason: 'current info',
  }, 'fallback');

  assert.deepEqual(plan, {
    action: 'search',
    query: '麦当劳当月汉堡 最新',
    question: '',
    reason: 'current info',
  });
});

test('fallback search plan preserves explicit search behavior', () => {
  const plan = buildFallbackSearchPlan('直接搜最新一期的「麦当劳当月汉堡」。', [
    { role: 'user', content: '直接搜最新一期的「麦当劳当月汉堡」。' },
  ]);

  assert.equal(plan.action, 'search');
  assert.equal(plan.query, '麦当劳当月汉堡 最新');
});

test('fallback search plan handles explicit latest burger search', () => {
  const plan = buildFallbackSearchPlan('帮我搜索麦当劳最新的汉堡', [
    { role: 'user', content: '帮我搜索麦当劳最新的汉堡' },
  ]);

  assert.equal(plan.action, 'search');
  assert.equal(plan.query, '麦当劳 汉堡 最新');
});

test('LLM planner cannot downgrade explicit searchable request to none', () => {
  const fallback = buildFallbackSearchPlan('帮我搜索麦当劳最新的汉堡', [
    { role: 'user', content: '帮我搜索麦当劳最新的汉堡' },
  ]);
  const reconciled = reconcileSearchPlan(
    normalizeSearchPlan({ action: 'none', query: '', reason: 'bad planner' }, fallback.query),
    fallback
  );

  assert.equal(reconciled.action, 'search');
  assert.equal(reconciled.query, '麦当劳 汉堡 最新');
});

test('does not search a generic regional new-product request without a brand or category', () => {
  const query = buildContextualSearchQuery('帮我搜索一下中国大陆地区的新品。', [
    { role: 'user', content: '帮我搜索一下中国大陆地区的新品。' },
  ]);

  assert.equal(query, '中国大陆 新品');
  assert.equal(shouldAutoSearch(query), false);
});

test('does not turn a date correction into a follow-up search', () => {
  const query = buildContextualSearchQuery('你按什么手的？现在是2026年7月。', [
    { role: 'user', content: '帮我搜索中国大陆星巴克的新品。' },
    { role: 'assistant', content: '整理如下。' },
    { role: 'user', content: '你按什么手的？现在是2026年7月。' },
  ]);

  assert.equal(isVagueFollowupSearch('你按什么手的？现在是2026年7月。'), false);
  assert.equal(query, '2026年7月');
  assert.equal(shouldAutoSearch(query), false);
});

test('explicit vague follow-up search reuses the previous concrete topic', () => {
  const query = buildContextualSearchQuery('再搜一下', [
    { role: 'user', content: '帮我搜索中国大陆星巴克的新品。' },
    { role: 'assistant', content: '整理如下。' },
    { role: 'user', content: '再搜一下' },
  ]);

  assert.equal(query, '星巴克 中国大陆 新品');
  assert.equal(shouldAutoSearch(query), true);
});

test('auto mode uses auditable external search instead of unobservable built-in search', () => {
  const config = {
    llmProvider: 'tongyi',
    preferBuiltinSearch: true,
    searchApiKey: 'test-key',
  };

  assert.equal(shouldUseBuiltinSearch('tongyi', 'auto', '星巴克 中国大陆 新品', config), false);
  assert.equal(shouldUseExternalSearch('tongyi', 'auto', '星巴克 中国大陆 新品', config), true);
});
