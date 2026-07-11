function getServerPromptTimeZone() {
  return process.env.APP_TIME_ZONE
    || process.env.TZ
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
}

function formatDateInTimeZone(date = new Date(), timeZone = getServerPromptTimeZone()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    if (parts.year && parts.month && parts.day) return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    // Fall back to UTC if an environment-provided time zone is invalid.
  }
  return date.toISOString().slice(0, 10);
}

function buildCurrentDatePromptContext(date = new Date(), timeZone = getServerPromptTimeZone()) {
  return `Current runtime date: ${formatDateInTimeZone(date, timeZone)}.
Current runtime time zone: ${timeZone}.
Treat the runtime date above as authoritative for "today", "now", and relative dates. Do not infer the current date from model knowledge cutoff or training data.`;
}

const SEARCH_FRESH_PRODUCT_PATTERN = /新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|官方|官网|new product|new drink|menu/i;
const SEARCH_REGION_PATTERN = /中国大陆|中国内地|内地|大陆|国内|中国市场|mainland/i;
const SEARCH_ACTION_PATTERN = /搜索|直接搜|搜一下|搜搜|查一下|查查|查找|查询|检索|联网|网上找|找一下|了解一下|重新搜|重新查|重新跑|再跑|最新|最近|今天|昨日|今年|新闻|来源|引用|价格|行情|法规|政策|竞品|官网|current|latest|recent|today|news|source|cite|price|policy|competitor/i;
const SEARCH_COMMAND_PATTERN = /帮我|帮|请|麻烦|帮忙|给我|能不能|可以|直接搜|搜索一下|搜索|搜一下|搜搜|查一下|查查|查找|查询|检索|联网|网上找|找一下|了解一下|重新搜|重新查|重新跑|再跑/g;
const GENERIC_SEARCH_TERMS_PATTERN = /中国大陆|中国内地|内地|大陆|国内|中国市场|mainland|地区|新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|官方|官网|产品|商品|服务|内容|信息|资料|新闻|消息|最近|最新|当前|现在|今天|昨日|今年|继续|再|重新|重跑|跑一趟|一趟|一次|一遍|跑|这个|那个|它|该|这家|那家|上述|前面|刚才|那么|然后|嗯|呃|额|还有|另外|其他|别的|什么|吗|么|嘛|有没有|有无|比如|例如|像是|之类|类似|配套|搭配|同期|同款|同系列|同活动|一下|一些|相关|有关|关于|一期|当期|本期|最新一期|公司|企业|机构|呢|current|latest|recent|today|news|menu|product|products|info|information/g;
const CONTEXTUAL_FOLLOWUP_PATTERN = /^(那么|那|嗯|呃|额|还有|另外|其他|别的|顺便|再看看|再查|再搜|重新搜|重新查|重新跑|再跑)|还有什么|配套|搭配|同期|同款|同系列|同活动|之类|类似|这个公司|这家公司|该公司|那个公司|那家公司|这个企业|该企业|它的|重新跑一趟|重跑/;
const GREETING_ONLY_PATTERN = /^(你好|您好|嗨|hi|hello|hey|哈喽|在吗|早上好|下午好|晚上好)[。.!！\s]*$/i;
const ORG_ENTITY_PATTERN = /[\u4e00-\u9fffA-Za-z0-9（）()·\-]{2,32}(?:有限公司|股份有限公司|科技有限公司|集团|公司|研究院|大学)/g;

function normalizeSearchQueryText(value = '') {
  return String(value || '')
    .replace(/[“”"‘’'「」『』]/g, '')
    .replace(/[，。！？、；：,.!?;:()[\]{}<>《》【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSpecificSearchTopic(query = '') {
  return normalizeSearchQueryText(query)
    .replace(SEARCH_COMMAND_PATTERN, ' ')
    .replace(/第?\s*[0-9一二三四五六七八九十百千万]+\s*期/gi, ' ')
    .replace(/20[2-9]\d\s*年\s*(?:0?[1-9]|1[0-2])\s*月|20[2-9]\d[-/.](?:0?[1-9]|1[0-2])/gi, ' ')
    .replace(GENERIC_SEARCH_TERMS_PATTERN, ' ')
    .replace(/[的地得]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSpecificSearchTopic(query = '') {
  const topic = getSpecificSearchTopic(query);
  return /[a-z0-9]{2,}/i.test(topic) || /[\u4e00-\u9fff]{2,}/.test(topic);
}

function shouldAutoSearch(query = '') {
  const text = query.toLowerCase();
  const hasSpecificTopic = hasSpecificSearchTopic(text);
  const hasFreshProduct = SEARCH_FRESH_PRODUCT_PATTERN.test(text);
  const hasRegion = SEARCH_REGION_PATTERN.test(text);
  const hasSearchAction = SEARCH_ACTION_PATTERN.test(text);
  const hasDate = /20[2-9]\d\s*年|20[2-9]\d[-/.]/.test(text);
  if (!hasSpecificTopic && (hasFreshProduct || hasRegion)) return false;
  return (hasSearchAction && hasSpecificTopic)
    || (hasSpecificTopic && hasRegion)
    || (hasSpecificTopic && hasFreshProduct)
    || (hasSpecificTopic && hasFreshProduct && hasDate);
}

function normalizeSearchText(value = '') {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isGreetingOnly(query = '') {
  return GREETING_ONLY_PATTERN.test(normalizeSearchText(query));
}

function isVagueFollowupSearch(query = '') {
  const text = normalizeSearchText(query);
  if (!text) return true;
  if (isGreetingOnly(text)) return true;
  if (CONTEXTUAL_FOLLOWUP_PATTERN.test(text)) return true;
  if (hasSpecificSearchTopic(text)) return false;
  return /^(挺好|好的|可以|继续|再搜|搜一下|查一下|帮我搜|帮我搜索|中国大陆的|大陆的|国内的)/.test(text)
    || /^(这个|那个|它|上述|前面|刚才)(呢|也一样|继续|再来|再搜|查一下|搜一下)?$/.test(text)
    || /(这个|那个|它|上述|前面|刚才).*(搜|查|搜索)/.test(text);
}

function isContextualFollowupSearch(query = '') {
  return CONTEXTUAL_FOLLOWUP_PATTERN.test(normalizeSearchText(query));
}

function getSearchDateText(query = '') {
  const match = String(query || '').match(/20[2-9]\d\s*年\s*(?:0?[1-9]|1[0-2])\s*月|20[2-9]\d[-/.](?:0?[1-9]|1[0-2])|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+20[2-9]\d/i);
  return match ? match[0].replace(/\s+/g, '') : '';
}

function getRecentUserMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'user' && typeof message.content === 'string')
    .map(message => message.content.trim())
    .filter(Boolean);
}

function cleanExtractedEntity(value = '') {
  return normalizeSearchQueryText(value)
    .replace(/^(?:你想查|想查|查询|搜索|检索|了解|关于|根据搜索结果|结果显示|刚才我们在聊的是)/, '')
    .replace(/[，。！？、；：,.!?;:].*$/, '')
    .trim();
}

function extractRecentAssistantEntity(messages = []) {
  const assistantMessages = (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'assistant' && typeof message.content === 'string')
    .map(message => message.content)
    .reverse();
  for (const content of assistantMessages) {
    const matches = content.match(ORG_ENTITY_PATTERN) || [];
    const entity = matches
      .map(cleanExtractedEntity)
      .filter(Boolean)
      .find(item => /[a-z0-9]{2,}/i.test(item) || /[\u4e00-\u9fff]{2,}/.test(item));
    if (entity) return entity;
  }
  return '';
}

function buildContextualSearchQuery(query = '', messages = []) {
  const cleaned = String(query || '').trim();
  const userMessages = getRecentUserMessages(messages);
  const previous = [...userMessages].reverse().find(message => (
    message !== cleaned
    && !isGreetingOnly(message)
    && !isVagueFollowupSearch(message)
    && hasSpecificSearchTopic(message)
  ));
  const assistantEntity = extractRecentAssistantEntity(messages);
  const contextualPrevious = previous || assistantEntity;
  const shouldReuseFullPrevious = isVagueFollowupSearch(cleaned) && previous;
  const shouldReuseStablePrevious = !shouldReuseFullPrevious && contextualPrevious && isContextualFollowupSearch(cleaned);
  const source = shouldReuseFullPrevious
    ? `${previous} ${cleaned}`
    : shouldReuseStablePrevious
      ? `${contextualPrevious} ${cleaned}`
      : cleaned;

  const dateText = getSearchDateText(source);
  if (dateText && !SEARCH_ACTION_PATTERN.test(source) && !SEARCH_FRESH_PRODUCT_PATTERN.test(source)) return dateText;

  const topic = getSpecificSearchTopic(source);
  const parts = topic ? [topic] : [];
  if (SEARCH_REGION_PATTERN.test(source) && !parts.includes('中国大陆')) parts.push('中国大陆');
  if (/新品|新饮品|上新|新品上市|new product|new drink/i.test(source) && !parts.includes('新品')) parts.push('新品');
  if (/菜单|menu/i.test(source) && !parts.includes('菜单')) parts.push('菜单');
  if (/官方|官网|小程序|app/i.test(source) && !parts.includes('官方')) parts.push('官方');
  if (dateText) parts.push(dateText);
  else if (/最新|当前|现在|recent|latest|today/i.test(source) && !parts.includes('最新')) parts.push('最新');
  return parts.join(' ').trim() || normalizeSearchQueryText(source);
}

function extractJsonObject(text = '') {
  const source = String(text || '').trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function extractPlannerText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (typeof payload.text === 'string') return payload.text;
  const choice = payload.choices?.[0];
  const content = choice?.message?.content ?? choice?.delta?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).join('');
  }
  return '';
}

function normalizeSearchPlan(value = {}, fallbackQuery = '') {
  const action = String(value.action || '').toLowerCase();
  const normalizedAction = action === 'search' || action === 'clarify' || action === 'none' ? action : 'none';
  const rawQuery = normalizeSearchQueryText(value.query || '');
  const query = rawQuery || (normalizedAction === 'search' ? fallbackQuery : '');
  return {
    action: normalizedAction,
    query,
    question: String(value.question || '').trim(),
    reason: String(value.reason || '').trim(),
  };
}

function reconcileSearchPlan(plan = {}, fallbackPlan = {}) {
  if (fallbackPlan.reason === 'rule_fallback_contextual_search' && plan.action !== 'search') return fallbackPlan;
  if (plan.action === 'search' && !hasSpecificSearchTopic(plan.query)) {
    if (fallbackPlan.action === 'search' && hasSpecificSearchTopic(fallbackPlan.query)) return fallbackPlan;
    return {
      action: 'clarify',
      query: plan.query || fallbackPlan.query || '',
      question: plan.question || '你想搜索哪个具体主题或对象？',
      reason: plan.reason || fallbackPlan.reason || 'planner_search_query_too_vague',
    };
  }
  return plan;
}

function buildFallbackSearchPlan(query = '', messages = []) {
  const searchQuery = buildContextualSearchQuery(query, messages);
  const userMessages = getRecentUserMessages(messages);
  const hasPreviousTopic = userMessages.some(message => message !== String(query || '').trim() && !isVagueFollowupSearch(message));
  const isContextualRetry = hasPreviousTopic && isVagueFollowupSearch(query) && SEARCH_ACTION_PATTERN.test(query);
  if (isContextualRetry && hasSpecificSearchTopic(searchQuery)) {
    return { action: 'search', query: searchQuery, question: '', reason: 'rule_fallback_contextual_search' };
  }
  if (shouldAutoSearch(searchQuery) || (SEARCH_ACTION_PATTERN.test(query) && hasSpecificSearchTopic(searchQuery))) {
    return { action: 'search', query: searchQuery, question: '', reason: 'rule_fallback_search' };
  }
  if (SEARCH_ACTION_PATTERN.test(query) && !hasSpecificSearchTopic(searchQuery)) {
    return { action: 'clarify', query: searchQuery, question: '', reason: 'rule_fallback_clarify' };
  }
  return { action: 'none', query: searchQuery, question: '', reason: 'rule_fallback_none' };
}

async function planSearchWithLlm({ query = '', messages = [], endpoint, model, apiKey }) {
  const recentMessages = (Array.isArray(messages) ? messages : [])
    .filter(message => message && typeof message.content === 'string' && (message.role === 'user' || message.role === 'assistant'))
    .slice(-8)
    .map(message => ({ role: message.role, content: message.content.slice(0, 1000) }));
  const fallbackPlan = buildFallbackSearchPlan(query, messages);
  if (!endpoint || !apiKey || !query.trim()) return fallbackPlan;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You are the Intent and Query Planner for a research assistant.
Return ONLY JSON with this exact shape:
{"action":"search|clarify|none","query":"...","question":"...","reason":"..."}

Rules:
- Use "search" when current or source-backed information is needed, or the user explicitly asks to search.
- Use "clarify" when the user asks to search but the subject/scope is too ambiguous for a reliable query.
- Use "none" when web search is not needed.
- If action is "search", write a concise search-engine query, not a natural-language sentence.
- Use conversation history to resolve pronouns, ellipsis, and follow-ups. Reuse concrete constraints such as entity, product, place, region, date, version, platform, audience, budget, or task type.
- For follow-ups such as "anything matching it", "what about nearby hotels", "for example ice cream", or "same for React", keep stable context from the previous topic and combine it with the new scope.
- Remove command wrappers, filler words, greetings, quotes, and conversational text.
- Preserve domain-specific terms even if unfamiliar. Do not rely on a fixed set of product categories.
- If the latest message appears garbled, incomplete, or mostly filler after ASR/transcription, use "clarify".
- ${buildCurrentDatePromptContext()}`,
          },
          ...recentMessages,
          { role: 'user', content: `Decide search plan for this latest user request:\n${query}` },
        ],
        temperature: 0,
        stream: false,
        max_tokens: 220,
      }),
    });
    const text = await res.text();
    if (!res.ok) return fallbackPlan;
    let assistantText = '';
    try {
      assistantText = extractPlannerText(JSON.parse(text));
    } catch {
      assistantText = '';
    }
    const data = extractJsonObject(assistantText) || extractJsonObject(text);
    if (!data) return fallbackPlan;
    const plan = reconcileSearchPlan(normalizeSearchPlan(data, fallbackPlan.query), fallbackPlan);
    return plan.action === 'search' && !plan.query ? fallbackPlan : plan;
  } catch {
    return fallbackPlan;
  } finally {
    clearTimeout(timeout);
  }
}

function inferSearchIntent(query = '') {
  const text = normalizeSearchText(query);
  const monthMatch = text.match(/(20[2-9]\d)\s*年\s*(0?[1-9]|1[0-2])\s*月|20[2-9]\d[-/.](0?[1-9]|1[0-2])/);
  const year = monthMatch ? (monthMatch[1] || text.match(/20[2-9]\d/)?.[0] || '') : (text.match(/20[2-9]\d/)?.[0] || '');
  const month = monthMatch ? String(monthMatch[2] || monthMatch[3] || '').padStart(2, '0') : '';
  const topic = getSpecificSearchTopic(query);
  const keywords = Array.from(new Set(topic.split(/\s+/).map(token => token.trim().toLowerCase()).filter(Boolean)));
  return {
    topic,
    keywords,
    mainland: /中国大陆|中国内地|大陆|国内|中国市场|mainland/.test(text),
    newProduct: /新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|new product|new drink/.test(text),
    year,
    month,
  };
}

function tokenMatchesHaystack(token = '', haystack = '') {
  if (!token) return false;
  if (haystack.includes(token)) return true;
  if (/[\u4e00-\u9fff]/.test(token) && token.length >= 4) {
    for (let size = Math.min(4, token.length - 1); size >= 2; size -= 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        if (haystack.includes(token.slice(index, index + size))) return true;
      }
    }
  }
  return false;
}

function scoreSearchResult(item, intent) {
  const haystack = normalizeSearchText(`${item.title || ''} ${item.url || ''} ${item.snippet || ''}`);
  let score = 0;
  if (intent.keywords?.length) {
    const matchedTokens = intent.keywords.filter(token => tokenMatchesHaystack(token, haystack));
    score += matchedTokens.length * 3;
    if (matchedTokens.length === 0) score -= 3;
    if (intent.keywords.length > 1 && matchedTokens.length >= Math.ceil(intent.keywords.length / 2)) score += 2;
  }
  if (intent.mainland) {
    if (/中国大陆|中国内地|内地|大陆|中国市场|\.cn\//.test(haystack)) score += 3;
    if (/台湾|臺灣|taiwan|starbucks\.com\.tw|香港|澳门|澳門|hong kong|macau/.test(haystack)) score -= 8;
  }
  if (intent.newProduct && /新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|星冰乐|拿铁|咖啡|new|menu|beverage|drink/.test(haystack)) score += 4;
  if (intent.year) {
    if (haystack.includes(intent.year)) score += 2;
    if (/202[0-5]/.test(haystack) && !haystack.includes(intent.year)) score -= 4;
  }
  if (intent.year && intent.month) {
    const monthNumber = String(Number(intent.month));
    const monthPattern = new RegExp(`${intent.year}\\s*年\\s*0?${monthNumber}\\s*月|${intent.year}[-/.]${intent.month}|${intent.year}[-/.]${monthNumber}`);
    if (monthPattern.test(haystack)) score += 3;
  }
  return score;
}

function filterSearchResults(results = [], query = '') {
  const intent = inferSearchIntent(query);
  const scored = results.map(item => ({ item, score: scoreSearchResult(item, intent) }));
  const threshold = intent.keywords?.length ? 1 : -2;
  return scored
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}

async function selectSearchResultsWithLlm({ query = '', results = [], endpoint, model, apiKey }) {
  if (!endpoint || !apiKey || !query.trim() || !results.length) return null;
  const candidates = results.slice(0, 8).map((item, index) => ({
    index,
    title: String(item.title || item.url || 'Untitled').slice(0, 180),
    url: String(item.url || '').slice(0, 240),
    snippet: String(item.snippet || '').replace(/\s+/g, ' ').slice(0, 700),
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You judge whether web search results are relevant to a user's query.
Return ONLY JSON with this exact shape:
{"keep":[0,1],"reason":"..."}

Rules:
- Keep results that can help answer the query, even if they match only aliases, abbreviations, translated names, event names, industry terms, or partial Chinese terms.
- Drop clearly unrelated results.
- If several results are broadly about the same requested event/company/topic, keep the best ones.
- If the query asks for current/news/company/background information, broad reputable news or official event pages can be relevant.
- Do not require exact keyword overlap when the title/snippet is semantically related.
- Keep at most 5 results.`,
          },
          { role: 'user', content: JSON.stringify({ query, candidates }, null, 2) },
        ],
        temperature: 0,
        stream: false,
        max_tokens: 180,
      }),
    });
    const text = await res.text();
    if (!res.ok) return null;
    let assistantText = '';
    try {
      assistantText = extractPlannerText(JSON.parse(text));
    } catch {
      assistantText = '';
    }
    const data = extractJsonObject(assistantText) || extractJsonObject(text);
    if (!data || !Array.isArray(data.keep)) return null;
    const seen = new Set();
    return data.keep
      .map(index => Number(index))
      .filter(index => Number.isInteger(index) && index >= 0 && index < candidates.length && !seen.has(index) && seen.add(index))
      .map(index => results[index]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSearchContext(results = []) {
  if (!results.length) return '';
  const lines = results.map((item, index) => {
    const title = String(item.title || 'Untitled').slice(0, 120);
    const url = String(item.url || '').slice(0, 220);
    const snippet = String(item.snippet || '').replace(/\s+/g, ' ').slice(0, 500);
    return `${index + 1}. ${title}\nURL: ${url}\nSnippet: ${snippet}`;
  });
  return `Web search has already been executed for this turn. Use the results below only when relevant.
The visible answer should summarize what was found in user-friendly language.
Do NOT output search plans, alternate queries, XML/tool tags, or blocks such as <search>, <query>, <tool>, or code fences containing search queries.
Do NOT say you are going to search again. If the results are weak or off-topic, say that the retrieved pages did not directly answer the request and suggest what the user should verify on official booking sites.
The app displays source links separately in the search result card, so do NOT repeat raw URLs in the assistant answer. Refer to source titles briefly only when needed.

Search results for reference:
${lines.join('\n\n')}`;
}

function buildSearchStatusResults(results = []) {
  return results.slice(0, 8).map(item => ({
    title: String(item.title || item.url || 'Untitled').slice(0, 140),
    url: String(item.url || '').slice(0, 260),
    snippet: String(item.snippet || '').replace(/\s+/g, ' ').slice(0, 220),
    provider: String(item.provider || ''),
    domain: (() => {
      try { return new URL(String(item.url || '')).hostname; } catch { return ''; }
    })(),
    retrievedAt: String(item.retrievedAt || ''),
  }));
}

function buildSearchClarificationContext(query = '') {
  return `The user asked for web search, but the query is too broad or underspecified to search reliably.
Current underspecified query: ${query}
Do not claim that you searched the web, read web pages, found sources, or verified current facts online.
Ask one concise clarification question for the missing subject, product, organization, place, or other concrete scope before searching.`;
}

function shouldUseBuiltinSearch(provider, mode) {
  if (mode === 'builtin') return provider === 'tongyi';
  return false;
}

async function runResearchAgent({
  query = '',
  messages = [],
  searchMode = 'off',
  isCanvas = false,
  provider,
  endpoint,
  model,
  apiKey,
  config = {},
  runExternalSearch,
  hasExternalSearchKey,
  resolveSearchProvider,
} = {}) {
  const statusEvents = [];
  if (isCanvas || searchMode === 'off') {
    return {
      action: 'none',
      query: '',
      clarification: '',
      results: [],
      statusEvents,
      reason: 'search_disabled',
      fallbackUsed: false,
      searchContext: '',
      searchClarificationContext: '',
      externalSearchError: '',
      didAttemptExternalSearch: false,
      fatalError: '',
      builtinSearch: false,
      wantsAutoSearch: false,
      needsSearchClarification: false,
      disableVoiceBriefForDirectSearch: false,
      effectiveSearchProvider: config.searchProvider || 'auto',
    };
  }
  const plan = !isCanvas && (searchMode === 'auto' || searchMode === 'external')
    ? await planSearchWithLlm({ query, messages, endpoint, model, apiKey })
    : buildFallbackSearchPlan(query, messages);
  const searchQuery = searchMode === 'external'
    ? (plan.query || buildContextualSearchQuery(query, messages))
    : plan.query;
  const builtinSearch = !isCanvas && shouldUseBuiltinSearch(provider, searchMode, searchQuery, config);
  const wantsAutoSearch = !isCanvas && searchMode === 'auto' && plan.action === 'search' && searchQuery;
  const disableVoiceBriefForDirectSearch = Boolean(!isCanvas && config.voiceOutputEnabled && wantsAutoSearch);
  const needsSearchClarification = !isCanvas && searchMode === 'auto' && query && plan.action === 'clarify';
  const effectiveSearchProvider = resolveSearchProvider ? resolveSearchProvider(searchQuery, config) : (config.searchProvider || 'auto');

  const baseResult = {
    action: plan.action,
    query: searchQuery,
    clarification: plan.question || '',
    results: [],
    statusEvents,
    reason: plan.reason || '',
    fallbackUsed: /^rule_/.test(plan.reason || ''),
    searchContext: '',
    searchClarificationContext: '',
    externalSearchError: '',
    didAttemptExternalSearch: false,
    fatalError: '',
    builtinSearch,
    wantsAutoSearch,
    needsSearchClarification,
    disableVoiceBriefForDirectSearch,
    effectiveSearchProvider,
  };

  const canUseExternal = !isCanvas
    && searchQuery
    && (searchMode === 'external' || (wantsAutoSearch && hasExternalSearchKey?.(config, searchQuery)))
    && !builtinSearch;

  if (canUseExternal) {
    try {
      statusEvents.push({ phase: 'searching', label: 'Web Search', provider: effectiveSearchProvider, query: searchQuery });
      const searchResponse = await runExternalSearch(searchQuery);
      const rawSearchResults = Array.isArray(searchResponse) ? searchResponse : (searchResponse?.results || []);
      const actualProvider = Array.isArray(searchResponse) ? effectiveSearchProvider : (searchResponse?.provider || effectiveSearchProvider);
      const fallbackAttempts = Array.isArray(searchResponse) ? [] : (searchResponse?.attempts || []);
      const llmSelectedResults = await selectSearchResultsWithLlm({ query: searchQuery, results: rawSearchResults, endpoint, model, apiKey });
      const searchResults = Array.isArray(llmSelectedResults) ? llmSelectedResults : filterSearchResults(rawSearchResults, searchQuery);
      if (!searchResults.length) {
        baseResult.externalSearchError = `Search returned ${rawSearchResults.length} pages, but none matched the requested topic closely enough. Query: ${searchQuery}`;
        statusEvents.push({
          phase: 'search_no_relevant_results',
          label: 'No relevant search results',
          count: 0,
          rawCount: rawSearchResults.length,
          query: searchQuery,
          provider: actualProvider,
          attempts: fallbackAttempts,
          error: baseResult.externalSearchError,
        });
      }
      baseResult.didAttemptExternalSearch = true;
      baseResult.results = searchResults;
      baseResult.searchContext = buildSearchContext(searchResults);
      statusEvents.push({
        phase: 'searched',
        label: 'Search complete',
        count: searchResults.length,
        provider: actualProvider,
        query: searchQuery,
        results: buildSearchStatusResults(searchResults),
        attempts: fallbackAttempts,
      });
      if (searchResults.length) statusEvents.push({ phase: 'thinking', label: 'Reading results', count: searchResults.length });
      return baseResult;
    } catch (error) {
      baseResult.didAttemptExternalSearch = true;
      baseResult.externalSearchError = error.message;
      statusEvents.push({
        phase: 'search_failed',
        label: 'Search failed',
        error: baseResult.externalSearchError,
        query: searchQuery,
        provider: effectiveSearchProvider,
      });
      if (searchMode === 'external') baseResult.fatalError = baseResult.externalSearchError;
      return baseResult;
    }
  }

  if (wantsAutoSearch && !builtinSearch && !hasExternalSearchKey?.(config, searchQuery)) {
    baseResult.externalSearchError = 'Search is on, but no Search API Key is configured. Add a Tavily / Serper / Bing key in settings or configure SEARCH_API_KEY on the server.';
    statusEvents.push({ phase: 'search_unavailable', label: 'Search unavailable', error: baseResult.externalSearchError });
  } else if (needsSearchClarification) {
    baseResult.searchClarificationContext = plan.question
      ? buildSearchClarificationContext(`${searchQuery}\nSuggested question: ${plan.question}`)
      : buildSearchClarificationContext(searchQuery);
    statusEvents.push({
      phase: 'search_needs_clarification',
      label: 'Search needs clarification',
      query: searchQuery,
      question: plan.question || '',
    });
  } else if (builtinSearch) {
    statusEvents.push({ phase: 'builtin_searching', label: 'Tongyi built-in search requested', provider: 'tongyi' });
  }

  return baseResult;
}

export {
  buildContextualSearchQuery,
  buildCurrentDatePromptContext,
  buildFallbackSearchPlan,
  buildSearchContext,
  filterSearchResults,
  isVagueFollowupSearch,
  normalizeSearchPlan,
  planSearchWithLlm,
  reconcileSearchPlan,
  runResearchAgent,
  selectSearchResultsWithLlm,
  shouldAutoSearch,
  shouldUseBuiltinSearch,
};
