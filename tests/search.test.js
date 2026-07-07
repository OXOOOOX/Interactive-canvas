import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCurrentDatePromptContext,
  buildContextualSearchQuery,
  buildFallbackSearchPlan,
  buildSearchContext,
  filterSearchResults,
  isVagueFollowupSearch,
  normalizeSearchPlan,
  planSearchWithLlm,
  reconcileSearchPlan,
  selectSearchResultsWithLlm,
  shouldAutoSearch,
  shouldUseBuiltinSearch,
  shouldUseExternalSearch,
} from '../server/index.js';

test('builds current date prompt context from runtime date and timezone', () => {
  const context = buildCurrentDatePromptContext(new Date('2026-07-08T00:30:00.000Z'), 'Asia/Shanghai');

  assert.match(context, /Current runtime date: 2026-07-08/);
  assert.match(context, /Current runtime time zone: Asia\/Shanghai/);
  assert.match(context, /knowledge cutoff/i);
});

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

test('LLM planner decision is not overridden by fallback search', () => {
  const fallback = buildFallbackSearchPlan('帮我搜索麦当劳最新的汉堡', [
    { role: 'user', content: '帮我搜索麦当劳最新的汉堡' },
  ]);
  const reconciled = reconcileSearchPlan(
    normalizeSearchPlan({ action: 'none', query: '', reason: 'bad planner' }, fallback.query),
    fallback
  );

  assert.equal(reconciled.action, 'none');
  assert.equal(reconciled.query, '');
});

test('contextual company info request reuses previous company topic', () => {
  const messages = [
    { role: 'user', content: '有没有上海智能算力这个智算科技公司相关的？资讯在世界人工智能大会上。' },
    { role: 'assistant', content: '根据搜索结果，上海智能算力科技有限公司是 WAIC 2026 的参与企业之一。' },
    { role: 'user', content: '帮搜索一些这个公司的信息。' },
  ];
  const plan = buildFallbackSearchPlan('帮搜索一些这个公司的信息。', messages);

  assert.equal(plan.action, 'search');
  assert.equal(plan.reason, 'rule_fallback_contextual_search');
  assert.match(plan.query, /上海智能算力/);
  assert.match(plan.query, /智算科技/);
});

test('retry search request reuses previous concrete search topic', () => {
  const messages = [
    { role: 'user', content: '有没有上海智能算力这个智算科技公司相关的？资讯在世界人工智能大会上。' },
    { role: 'assistant', content: '根据搜索结果，上海智能算力科技有限公司是 WAIC 2026 的参与企业之一。' },
    { role: 'user', content: '重新跑一趟搜索' },
  ];
  const plan = buildFallbackSearchPlan('重新跑一趟搜索', messages);

  assert.equal(plan.action, 'search');
  assert.equal(plan.reason, 'rule_fallback_contextual_search');
  assert.match(plan.query, /上海智能算力/);
});

test('retry search query strips filler count words', () => {
  const messages = [
    { role: 'user', content: '有没有上海智能算力这个智算科技公司相关的？资讯在世界人工智能大会上。' },
    { role: 'assistant', content: '根据搜索结果，上海智能算力科技有限公司是 WAIC 2026 的参与企业之一。' },
    { role: 'user', content: '再搜索一次' },
  ];
  const plan = buildFallbackSearchPlan('再搜索一次', messages);

  assert.equal(plan.action, 'search');
  assert.doesNotMatch(plan.query, /一次|一趟|一遍/);
  assert.match(plan.query, /上海智能算力/);
});

test('contextual retry fallback can correct an LLM none decision', () => {
  const fallback = buildFallbackSearchPlan('重新跑一趟搜索', [
    { role: 'user', content: '有没有上海智能算力这个智算科技公司相关的？资讯在世界人工智能大会上。' },
    { role: 'assistant', content: '整理如下。' },
    { role: 'user', content: '重新跑一趟搜索' },
  ]);
  const reconciled = reconcileSearchPlan(
    normalizeSearchPlan({ action: 'none', query: '', reason: 'bad planner' }, fallback.query),
    fallback
  );

  assert.equal(reconciled.action, 'search');
  assert.equal(reconciled.reason, 'rule_fallback_contextual_search');
  assert.match(reconciled.query, /上海智能算力/);
});

test('generic search result filter keeps WAIC company news results', () => {
  const results = filterSearchResults([
    {
      title: '告别闲聊迈向生产力 2026 WAIC前瞻：智算赛道迎来超进化',
      url: 'https://example.test/waic',
      snippet: '世界人工智能大会将在上海举行，智算赛道企业集中展示。',
    },
    {
      title: '无关娱乐新闻',
      url: 'https://example.test/ent',
      snippet: '明星活动和电影票房。',
    },
  ], '上海智能算力 智算科技 资讯在世界人工智能大会上');

  assert.equal(results.length, 1);
  assert.match(results[0].title, /WAIC|智算/);
});

test('LLM selector can keep semantically relevant search results', async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload = null;
  globalThis.fetch = async (_url, options = {}) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            keep: [1],
            reason: 'WAIC and intelligent computing track are relevant to the query',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const selected = await selectSearchResultsWithLlm({
      query: '上海智能算力 智算科技 资讯在世界人工智能大会上',
      results: [
        { title: '无关娱乐新闻', url: 'https://example.test/ent', snippet: '明星活动。' },
        { title: '2026 WAIC前瞻：智算赛道迎来超进化', url: 'https://example.test/waic', snippet: '世界人工智能大会将在上海举行。' },
      ],
      endpoint: 'https://example.test/chat/completions',
      model: 'test-model',
      apiKey: 'test-key',
    });

    assert.equal(selected.length, 1);
    assert.match(selected[0].title, /WAIC|智算/);
    assert.equal(capturedPayload.temperature, 0);
    assert.match(capturedPayload.messages[0].content, /semantically related/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLM selector returns null on invalid selector output so caller can fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"bad":true}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const selected = await selectSearchResultsWithLlm({
      query: '上海智能算力',
      results: [{ title: 'WAIC 智算', url: 'https://example.test', snippet: '上海' }],
      endpoint: 'https://example.test/chat/completions',
      model: 'test-model',
      apiKey: 'test-key',
    });

    assert.equal(selected, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('generic fallback contextual follow-up keeps previous context and new scope', () => {
  const query = buildContextualSearchQuery('那么，嗯，还有什么配套的新品吗？比如冰淇淋之类的。', [
    { role: 'user', content: '帮我搜索一下麦当劳2026年7月的汉堡新品。' },
    { role: 'assistant', content: '根据搜索结果，麦当劳在2026年7月主推的新品汉堡是厚薯泥培根肉酱双牛堡。' },
    { role: 'user', content: '那么，嗯，还有什么配套的新品吗？比如冰淇淋之类的。' },
  ]);

  assert.equal(query, '麦当劳 汉堡 冰淇淋 新品 2026年7月');
  assert.equal(shouldAutoSearch(query), true);
});

test('fallback search plan searches generic contextual follow-ups', () => {
  const plan = buildFallbackSearchPlan('那么，嗯，还有什么配套的新品吗？比如冰淇淋之类的。', [
    { role: 'user', content: '帮我搜索一下麦当劳2026年7月的汉堡新品。' },
    { role: 'assistant', content: '整理如下。' },
    { role: 'user', content: '那么，嗯，还有什么配套的新品吗？比如冰淇淋之类的。' },
  ]);

  assert.equal(plan.action, 'search');
  assert.equal(plan.query, '麦当劳 汉堡 冰淇淋 新品 2026年7月');
});

test('LLM planner can rewrite contextual follow-ups beyond fallback rules', async () => {
  const originalFetch = globalThis.fetch;
  let capturedMessages = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    capturedMessages = body.messages;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            action: 'search',
            query: '麦当劳 冰淇淋 新品 2026年7月',
            question: '',
            reason: 'follow-up resolved from context',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const plan = await planSearchWithLlm({
      query: '那么，嗯，还有什么配套的新品吗？比如冰淇淋之类的。',
      messages: [
        { role: 'user', content: '帮我搜索一下麦当劳2026年7月的汉堡新品。' },
        { role: 'assistant', content: '根据搜索结果，麦当劳在2026年7月主推的新品汉堡是厚薯泥培根肉酱双牛堡。' },
        { role: 'user', content: '那么，嗯，还有什么配套的新品吗？比如冰淇淋之类的。' },
      ],
      provider: 'tongyi',
      endpoint: 'https://example.test/chat/completions',
      model: 'test-model',
      apiKey: 'test-key',
    });

    assert.equal(plan.action, 'search');
    assert.equal(plan.query, '麦当劳 冰淇淋 新品 2026年7月');
    assert.match(capturedMessages[0].content, /Preserve domain-specific terms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLM planner can clarify garbled explicit search requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          action: 'clarify',
          query: '',
          question: '你想核对哪段航程或哪个目的地的信息？',
          reason: 'latest request is incomplete after transcription',
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const plan = await planSearchWithLlm({
      query: '好的，那么这样的话，请你帮我做一个，就是根据我们的既现在目前地理情况做一些互联网的搜索，以核对一些确保航。',
      messages: [
        { role: 'user', content: '好的，那么这样的话，请你帮我做一个，就是根据我们的既现在目前地理情况做一些互联网的搜索，以核对一些确保航。' },
      ],
      provider: 'tongyi',
      endpoint: 'https://example.test/chat/completions',
      model: 'test-model',
      apiKey: 'test-key',
    });

    assert.equal(plan.action, 'clarify');
    assert.equal(plan.query, '');
    assert.equal(plan.question, '你想核对哪段航程或哪个目的地的信息？');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('search context tells assistant to summarize results instead of outputting queries', () => {
  const context = buildSearchContext([
    {
      title: '上海浦东到福冈航班',
      url: 'https://example.test/flights',
      snippet: '示例航班结果',
    },
  ]);

  assert.match(context, /Web search has already been executed/);
  assert.match(context, /Do NOT output search plans/);
  assert.match(context, /<search>.*<query>/s);
  assert.match(context, /summarize what was found/);
});
