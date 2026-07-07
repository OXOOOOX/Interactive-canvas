import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = join(rootDir, 'dist');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const DEFAULT_ENDPOINTS = {
  tongyi: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  deepseekV4Pro: 'https://api.deepseek.com/chat/completions',
  deepseekV4Flash: 'https://api.deepseek.com/chat/completions',
  custom: '',
};

const DEFAULT_MODELS = {
  tongyi: 'qwen-max-latest',
  doubao: 'doubao-1.5-pro',
  deepseekV4Pro: 'deepseek-v4-pro',
  deepseekV4Flash: 'deepseek-v4-flash',
};

const freeSearchBuckets = new Map();
const freeLlmBuckets = new Map();
const freeDoubaoVoiceBuckets = new Map();

function setupDoubaoAsrProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (!url.startsWith('/api/doubao-asr')) return;

    wss.handleUpgrade(req, socket, head, (clientSocket) => {
      wss.emit('connection', clientSocket, req);
    });
  });

  wss.on('connection', (clientSocket, req) => {
    const requestUrl = new URL(req.url || '', 'http://localhost');
    const target = requestUrl.searchParams.get('target') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
    const resourceId = requestUrl.searchParams.get('resourceId') || 'volc.seedasr.sauc.duration';
    const connectId = requestUrl.searchParams.get('connectId') || randomUUID();
    const userApiKey = requestUrl.searchParams.get('apiKey') || '';
    const serverApiKey = process.env.DOUBAO_API_KEY || '';
    const apiKey = userApiKey || serverApiKey;
    if (!apiKey) {
      clientSocket.close(1008, 'No Doubao API key is available.');
      return;
    }
    if (!userApiKey) {
      try {
        consumeFreeDoubaoVoiceQuota(req);
      } catch (error) {
        clientSocket.close(1008, error.message);
        return;
      }
    }
    const targetUrl = new URL(target);

    const headers = {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': connectId,
    };

    const upstream = new WebSocket(targetUrl.toString(), {
      headers,
      agent: targetUrl.protocol === 'wss:' ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    });

    const pendingClientMessages = [];

    const flushPendingClientMessages = () => {
      while (pendingClientMessages.length && upstream.readyState === WebSocket.OPEN) {
        const { data, isBinary } = pendingClientMessages.shift();
        upstream.send(data, { binary: isBinary });
      }
    };

    const closeBoth = () => {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };

    clientSocket.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pendingClientMessages.push({ data, isBinary });
      }
    });

    upstream.on('open', () => {
      flushPendingClientMessages();
    });

    upstream.on('message', (data, isBinary) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
      }
    });

    upstream.on('error', (error) => {
      console.error('[doubao-asr] upstream error:', error.message);
      closeBoth();
    });
    upstream.on('close', closeBoth);
    clientSocket.on('error', closeBoth);
    clientSocket.on('close', closeBoth);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendSseError(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  res.end();
}

function writeSseEvent(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function authorize(req, res) {
  const requiredKey = process.env.API_AUTH_KEY || '';
  const providedKey = req.headers['x-api-auth-key'];
  const local = isLocalRequest(req);
  const requireAuthKey = process.env.REQUIRE_API_AUTH_KEY === '1';

  if (requireAuthKey && requiredKey && !local && providedKey !== requiredKey) {
    sendSseError(res, 401, 'Invalid API auth key.');
    return false;
  }

  if (requireAuthKey && process.env.NODE_ENV === 'production' && !requiredKey && !local) {
    sendSseError(res, 403, 'API_AUTH_KEY is required when REQUIRE_API_AUTH_KEY=1.');
    return false;
  }

  return true;
}

async function readJsonBody(req, maxBytes = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function proxyDoubaoTts(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const endpoint = body.endpoint || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
  const userApiKey = body.apiKey || '';
  const serverApiKey = process.env.DOUBAO_API_KEY || '';
  const apiKey = userApiKey || serverApiKey;
  const resourceId = body.resourceId || 'seed-tts-2.0';
  const requestId = body.requestId || randomUUID();
  const payload = body.payload;

  if (!apiKey || !payload) {
    sendJson(res, 400, { error: 'Missing Doubao TTS apiKey or payload.' });
    return;
  }

  if (!userApiKey) {
    try {
      consumeFreeDoubaoVoiceQuota(req);
    } catch (error) {
      sendJson(res, 429, { error: error.message });
      return;
    }
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': requestId,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
    return;
  }

  const text = await upstream.text().catch(() => '');
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function getProviderConfig(config = {}) {
  const provider = config.llmProvider || process.env.LLM_PROVIDER || 'tongyi';
  const endpoint = config.llmEndpoint || process.env.LLM_ENDPOINT || DEFAULT_ENDPOINTS[provider];
  const model = config.llmModel || process.env.LLM_MODEL || DEFAULT_MODELS[provider] || DEFAULT_MODELS.tongyi;
  const userApiKey = config.llmApiKey || '';
  const serverApiKey = process.env.LLM_API_KEY || '';
  const apiKey = userApiKey || serverApiKey;
  return { provider, endpoint, model, apiKey, usesServerKey: Boolean(!userApiKey && serverApiKey) };
}

function normalizeSearchMode(mode) {
  if (mode === 'builtin' || mode === 'external' || mode === 'auto' || mode === 'off') return mode;
  return 'off';
}

const SEARCH_FRESH_PRODUCT_PATTERN = /新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|官方|官网|new product|new drink|menu/i;
const SEARCH_REGION_PATTERN = /中国大陆|中国内地|内地|大陆|国内|中国市场|mainland/i;
const SEARCH_ACTION_PATTERN = /搜索|直接搜|搜一下|搜搜|查一下|查查|查找|查询|检索|联网|网上找|找一下|了解一下|最新|最近|今天|昨日|今年|新闻|来源|引用|价格|行情|法规|政策|竞品|官网|current|latest|recent|today|news|source|cite|price|policy|competitor/i;
const SEARCH_COMMAND_PATTERN = /帮我|请|麻烦|帮忙|给我|能不能|可以|直接搜|搜索一下|搜索|搜一下|搜搜|查一下|查查|查找|查询|检索|联网|网上找|找一下|了解一下/g;
const GENERIC_SEARCH_TERMS_PATTERN = /中国大陆|中国内地|内地|大陆|国内|中国市场|mainland|地区|新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|官方|官网|产品|商品|服务|内容|信息|资料|新闻|消息|最近|最新|当前|现在|今天|昨日|今年|继续|再|这个|那个|它|上述|前面|刚才|一下|一些|相关|有关|关于|一期|当期|本期|最新一期|呢|current|latest|recent|today|news|menu|product|products|info|information/g;

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
  const specificTopic = getSpecificSearchTopic(text);
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

function shouldUseBaiduForQuery(query = '') {
  const text = normalizeSearchText(query);
  return /中国大陆|中国内地|内地|大陆|国内|中国市场|中文|本地|小红书|微信|公众号|微博|抖音|百度|大陆/.test(text)
    || /\.(cn)\b/.test(text);
}

function resolveSearchProvider(query = '', config = {}) {
  const configured = (config.searchProvider || process.env.SEARCH_PROVIDER || 'auto').toLowerCase();
  if (configured === 'auto') return shouldUseBaiduForQuery(query) ? 'baidu' : 'tavily';
  if (configured === 'qianfan') return 'baidu';
  return configured;
}

function getServerSearchApiKey(provider) {
  if (provider === 'baidu') {
    return process.env.BAIDU_SEARCH_API_KEY || process.env.QIANFAN_API_KEY || (String(process.env.SEARCH_PROVIDER || '').toLowerCase() === 'baidu' ? process.env.SEARCH_API_KEY : '');
  }
  return process.env.SEARCH_API_KEY || '';
}

function hasExternalSearchKey(config = {}, query = '') {
  const provider = resolveSearchProvider(query, config);
  return Boolean(config.searchApiKey || getServerSearchApiKey(provider));
}

function shouldUseBuiltinSearch(provider, mode, query, config = {}) {
  if (mode === 'builtin') return provider === 'tongyi';
  return false;
}

function shouldUseExternalSearch(provider, mode, query, config = {}) {
  if (mode === 'external') return true;
  return mode === 'auto'
    && shouldAutoSearch(query)
    && hasExternalSearchKey(config, query);
}

function normalizeSearchText(value = '') {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isVagueFollowupSearch(query = '') {
  const text = normalizeSearchText(query);
  if (!text) return true;
  if (hasSpecificSearchTopic(text)) {
    return false;
  }
  return /^(挺好|好的|可以|继续|再搜|搜一下|查一下|帮我搜|帮我搜索|中国大陆的|大陆的|国内的)/.test(text)
    || /^(这个|那个|它|上述|前面|刚才)(呢|也一样|继续|再来|再搜|查一下|搜一下)?$/.test(text)
    || /(这个|那个|它|上述|前面|刚才).*(搜|查|搜索)/.test(text);
}

function getRecentUserMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === 'user' && typeof message.content === 'string')
    .map(message => message.content.trim())
    .filter(Boolean);
}

function buildContextualSearchQuery(query = '', messages = []) {
  const cleaned = String(query || '').trim();
  const userMessages = getRecentUserMessages(messages);
  const previous = [...userMessages].reverse().find(message => message !== cleaned && !isVagueFollowupSearch(message));
  const source = isVagueFollowupSearch(cleaned) && previous
    ? `${previous} ${cleaned}`
    : cleaned;

  const dateMatch = source.match(/20[2-9]\d\s*年\s*(?:0?[1-9]|1[0-2])\s*月|20[2-9]\d[-/.](?:0?[1-9]|1[0-2])|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+20[2-9]\d/i);
  if (dateMatch && !SEARCH_ACTION_PATTERN.test(source) && !SEARCH_FRESH_PRODUCT_PATTERN.test(source)) {
    return dateMatch[0].replace(/\s+/g, '');
  }

  const topic = getSpecificSearchTopic(source);
  const parts = topic ? [topic] : [];
  if (SEARCH_REGION_PATTERN.test(source) && !parts.includes('中国大陆')) parts.push('中国大陆');
  if (/新品|新饮品|上新|新品上市|new product|new drink/i.test(source) && !parts.includes('新品')) parts.push('新品');
  if (/菜单|menu/i.test(source) && !parts.includes('菜单')) parts.push('菜单');
  if (/官方|官网|小程序|app/i.test(source) && !parts.includes('官方')) parts.push('官方');
  if (dateMatch) parts.push(dateMatch[0].replace(/\s+/g, ''));
  else if (/最新|当前|现在|recent|latest|today/i.test(source) && !parts.includes('最新')) parts.push('最新');

  const compact = parts.join(' ').trim();
  return compact || normalizeSearchQueryText(source);
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
  const normalizedAction = action === 'search' || action === 'clarify' || action === 'none'
    ? action
    : 'none';
  const rawQuery = normalizeSearchQueryText(value.query || fallbackQuery);
  const query = rawQuery || fallbackQuery;
  return {
    action: normalizedAction,
    query,
    question: String(value.question || '').trim(),
    reason: String(value.reason || '').trim(),
  };
}

function reconcileSearchPlan(plan = {}, fallbackPlan = {}) {
  if (fallbackPlan.action === 'search' && plan.action !== 'search') {
    return fallbackPlan;
  }
  if (fallbackPlan.action === 'clarify' && plan.action === 'none') {
    return fallbackPlan;
  }
  if (plan.action === 'search' && !hasSpecificSearchTopic(plan.query)) {
    return fallbackPlan;
  }
  return plan;
}

function buildFallbackSearchPlan(query = '', messages = []) {
  const searchQuery = buildContextualSearchQuery(query, messages);
  if (shouldAutoSearch(searchQuery)) {
    return { action: 'search', query: searchQuery, question: '', reason: 'rule_fallback_search' };
  }
  if (SEARCH_ACTION_PATTERN.test(query) && !hasSpecificSearchTopic(searchQuery)) {
    return { action: 'clarify', query: searchQuery, question: '', reason: 'rule_fallback_clarify' };
  }
  return { action: 'none', query: searchQuery, question: '', reason: 'rule_fallback_none' };
}

async function planSearchWithLlm({ query = '', messages = [], provider, endpoint, model, apiKey }) {
  const recentMessages = (Array.isArray(messages) ? messages : [])
    .filter(message => message && typeof message.content === 'string' && (message.role === 'user' || message.role === 'assistant'))
    .slice(-8)
    .map(message => ({ role: message.role, content: message.content.slice(0, 1000) }));
  const fallbackPlan = buildFallbackSearchPlan(query, messages);

  if (!endpoint || !apiKey || !query.trim()) return fallbackPlan;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const plannerMessages = [
      {
        role: 'system',
        content: `You decide whether an assistant should use web search before answering.
Return ONLY JSON with this exact shape:
{"action":"search|clarify|none","query":"...","question":"...","reason":"..."}

Rules:
- Use "search" when current or source-backed information is needed, or the user explicitly asks to search.
- Use "clarify" when the user asks to search but the subject/scope is too ambiguous for a reliable query.
- Use "none" when web search is not needed.
- If action is "search", write a concise search query. Remove command wrappers such as "help me search", "directly search", "latest issue", quotes, filler words, and conversational text. Preserve concrete entities, product/category names, regions, and freshness words such as "latest" when useful.
- If action is "clarify", write one short clarification question in the user's language.
- Current date: 2026-07-07.`
      },
      ...recentMessages,
      { role: 'user', content: `Decide search plan for this latest user request:\n${query}` },
    ];

    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: plannerMessages,
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
    const data = extractJsonObject(text) || extractJsonObject(assistantText);
    if (!data) return fallbackPlan;
    const plan = reconcileSearchPlan(normalizeSearchPlan(data, fallbackPlan.query), fallbackPlan);
    if (plan.action === 'search' && !plan.query) return fallbackPlan;
    return plan;
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
  return {
    topic: getSpecificSearchTopic(query),
    mainland: /中国大陆|中国内地|大陆|国内|中国市场|mainland/.test(text),
    newProduct: /新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|new product|new drink/.test(text),
    year,
    month,
  };
}

function scoreSearchResult(item, intent) {
  const haystack = normalizeSearchText(`${item.title || ''} ${item.url || ''} ${item.snippet || ''}`);
  let score = 0;

  if (intent.topic) {
    const topicTokens = intent.topic.split(/\s+/).filter(Boolean);
    const matchedTokens = topicTokens.filter(token => haystack.includes(token.toLowerCase()));
    if (matchedTokens.length === topicTokens.length) score += 4;
    else if (matchedTokens.length > 0) score += 2;
    else score -= 6;
  }

  if (intent.mainland) {
    if (/中国大陆|中国内地|内地|大陆|中国市场|\.cn\//.test(haystack)) score += 3;
    if (/台湾|臺灣|taiwan|starbucks\.com\.tw|香港|澳门|澳門|hong kong|macau/.test(haystack)) score -= 8;
  }

  if (intent.newProduct) {
    if (/新品|新饮品|上新|新品上市|限定|菜单|饮料|饮品|星冰乐|拿铁|咖啡|new|menu|beverage|drink/.test(haystack)) score += 4;
    else score -= 4;
    if (/公司介绍|在中国|门店|融资|出售|股权|财报|业务|扩至|市场|wikipedia|维基百科/.test(haystack)) score -= 5;
  }

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
  const threshold = intent.topic || intent.mainland || intent.newProduct ? 2 : -2;
  return scored
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}

function getClientId(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function consumeFreeSearchQuota(req) {
  const limit = Math.max(0, Number(process.env.SEARCH_FREE_QUOTA_LIMIT || 5));
  const windowMs = Math.max(60_000, Number(process.env.SEARCH_FREE_QUOTA_WINDOW_MS || 3_600_000));
  if (limit === 0) return;

  const now = Date.now();
  const id = getClientId(req);
  const bucket = freeSearchBuckets.get(id);

  if (!bucket || bucket.resetAt <= now) {
    freeSearchBuckets.set(id, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (bucket.count >= limit) {
    const minutes = Math.max(1, Math.ceil((bucket.resetAt - now) / 60_000));
    throw new Error(`Server free search quota exceeded. Configure your own Search API Key or retry in about ${minutes} minutes.`);
  }

  bucket.count += 1;
}

function consumeFreeLlmQuota(req) {
  const limit = Math.max(0, Number(process.env.FREE_LLM_QUOTA_LIMIT || 5));
  const windowMs = Math.max(60_000, Number(process.env.FREE_LLM_QUOTA_WINDOW_MS || 86_400_000));
  if (limit === 0) return;

  const now = Date.now();
  const id = getClientId(req);
  const bucket = freeLlmBuckets.get(id);

  if (!bucket || bucket.resetAt <= now) {
    freeLlmBuckets.set(id, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (bucket.count >= limit) {
    const hours = Math.max(1, Math.ceil((bucket.resetAt - now) / 3_600_000));
    throw new Error(`Free AI trial quota exceeded. Add your own LLM API Key in settings or retry in about ${hours} hours.`);
  }

  bucket.count += 1;
}

function consumeFreeDoubaoVoiceQuota(req) {
  const limit = Math.max(0, Number(process.env.DOUBAO_VOICE_FREE_QUOTA_LIMIT || 20));
  const windowMs = Math.max(60_000, Number(process.env.DOUBAO_VOICE_FREE_QUOTA_WINDOW_MS || 86_400_000));
  if (limit === 0) return;

  const now = Date.now();
  const id = getClientId(req);
  const bucket = freeDoubaoVoiceBuckets.get(id);

  if (!bucket || bucket.resetAt <= now) {
    freeDoubaoVoiceBuckets.set(id, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (bucket.count >= limit) {
    const hours = Math.max(1, Math.ceil((bucket.resetAt - now) / 3_600_000));
    throw new Error(`Free Doubao voice quota exceeded. Add your own Doubao API Key in settings or retry in about ${hours} hours.`);
  }

  bucket.count += 1;
}

function collectBaiduResultCandidates(value, out = []) {
  if (!value || out.length > 30) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectBaiduResultCandidates(item, out));
    return out;
  }
  if (typeof value !== 'object') return out;

  const url = value.url || value.link || value.href || value.source_url || value.web_url;
  const title = value.title || value.name || value.source || value.site_name;
  const snippet = value.snippet || value.summary || value.content || value.text || value.description;
  if (typeof url === 'string' && url.startsWith('http')) {
    out.push({
      title: title || url,
      url,
      snippet: typeof snippet === 'string' ? snippet : '',
    });
  }

  for (const key of ['references', 'citations', 'search_results', 'searchResults', 'web_search_results', 'results', 'sources', 'documents', 'data']) {
    if (value[key]) collectBaiduResultCandidates(value[key], out);
  }
  if (value.choices) collectBaiduResultCandidates(value.choices, out);
  if (value.message) collectBaiduResultCandidates(value.message, out);
  return out;
}

function extractBaiduSearchResults(data, maxResults) {
  const seen = new Set();
  return collectBaiduResultCandidates(data)
    .filter(item => {
      if (!item.url || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, maxResults)
    .map(item => ({
      title: item.title || item.url || 'Untitled',
      url: item.url || '',
      snippet: item.snippet || '',
    }));
}

async function runExternalSearch(query, req, config = {}) {
  const provider = resolveSearchProvider(query, config);
  const userApiKey = config.searchApiKeys?.[provider] || config.searchApiKey || '';
  const serverApiKey = getServerSearchApiKey(provider);
  const apiKey = userApiKey || serverApiKey;
  const maxResults = Math.max(1, Math.min(8, Number(process.env.SEARCH_MAX_RESULTS || 5)));

  if (!apiKey) {
    throw new Error(`Search API key is not configured for ${provider}. Set ${provider === 'baidu' ? 'BAIDU_SEARCH_API_KEY or QIANFAN_API_KEY' : 'SEARCH_API_KEY'} on the server or add your own Search API Key in settings.`);
  }

  if (!userApiKey) {
    consumeFreeSearchQuota(req);
  }

  if (provider === 'tavily') {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Tavily search failed (${res.status}).`);
    return (data.results || []).slice(0, maxResults).map(item => ({
      title: item.title || item.url || 'Untitled',
      url: item.url || '',
      snippet: item.content || '',
    }));
  }

  if (provider === 'serper') {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q: query, num: maxResults }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `Serper search failed (${res.status}).`);
    return (data.organic || []).slice(0, maxResults).map(item => ({
      title: item.title || item.link || 'Untitled',
      url: item.link || '',
      snippet: item.snippet || '',
    }));
  }

  if (provider === 'bing') {
    const url = new URL('https://api.bing.microsoft.com/v7.0/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Bing search failed (${res.status}).`);
    return (data.webPages?.value || []).slice(0, maxResults).map(item => ({
      title: item.name || item.url || 'Untitled',
      url: item.url || '',
      snippet: item.snippet || '',
    }));
  }

  if (provider === 'bocha') {
    const res = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        summary: true,
        freshness: 'oneYear',
        count: maxResults,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || data?.error || `Bocha search failed (${res.status}).`);
    const items = data?.data?.webPages?.value || data?.webPages?.value || data?.results || [];
    return items.slice(0, maxResults).map(item => ({
      title: item.name || item.title || item.url || 'Untitled',
      url: item.url || item.link || '',
      snippet: item.summary || item.snippet || item.content || '',
    }));
  }

  if (provider === 'baidu') {
    const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        stream: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `Baidu AI Search failed (${res.status}).`);
    return extractBaiduSearchResults(data, maxResults);
  }

  throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
}

function buildSearchContext(results = []) {
  if (!results.length) return '';
  const lines = results.map((item, index) => {
    const title = String(item.title || 'Untitled').slice(0, 120);
    const url = String(item.url || '').slice(0, 220);
    const snippet = String(item.snippet || '').replace(/\s+/g, ' ').slice(0, 500);
    return `${index + 1}. ${title}\nURL: ${url}\nSnippet: ${snippet}`;
  });
  return `Search results for reference. Use them only when relevant. The app displays source links separately in the search result card, so do NOT repeat raw URLs in the assistant answer. Refer to source titles briefly only when needed.\n${lines.join('\n\n')}`;
}

function buildSearchStatusResults(results = []) {
  return results.slice(0, 8).map(item => ({
    title: String(item.title || item.url || 'Untitled').slice(0, 140),
    url: String(item.url || '').slice(0, 260),
    snippet: String(item.snippet || '').replace(/\s+/g, ' ').slice(0, 220),
  }));
}

function buildSearchFailureContext(message = '') {
  if (!message) return '';
  return `Web search was requested, but no web pages were retrieved for this turn.
Search failure reason: ${message}
Do not claim that you searched the web, read web pages, found sources, or verified current facts online. If current/source-backed information is needed, say clearly that web search failed and answer only from existing context or ask the user to retry/configure search.`;
}

function buildSearchClarificationContext(query = '') {
  return `The user asked for web search, but the query is too broad or underspecified to search reliably.
Current underspecified query: ${query}
Do not claim that you searched the web, read web pages, found sources, or verified current facts online.
Ask one concise clarification question for the missing subject, product, organization, place, or other concrete scope before searching.`;
}

function buildNoSearchContext(query = '') {
  return `The user mentioned search, but no web search was executed for this turn.
Current query: ${query}
Do not claim that you searched the web, checked online sources, saw current pages, or verified current facts.
If current information is needed, say that web search did not run and ask the user to retry or check search settings.`;
}

function disableVoiceBriefInMessages(messages = []) {
  return messages
    .filter(message => !String(message?.content || '').includes('Critical voice-mode rule:'))
    .map(message => {
      if (message?.role !== 'system' || typeof message.content !== 'string') return message;
      if (!message.content.includes('Voice output is ON.')) return message;
      return {
        ...message,
        content: message.content
          .replace(/Voice output is ON\.[\s\S]*?Voice brief rules:[\s\S]*?Do not read the full answer aloud\. After the VOICE_BRIEF line, continue with the full visible answer normally\.\n/, 'Voice output is OFF.\nDo not output VOICE_BRIEF metadata. Write only the visible answer.\n')
          .replace(/If voice output is ON, the required VOICE_BRIEF control line is allowed and must come first\./, 'Do not output VOICE_BRIEF metadata.'),
      };
    });
}

function buildPayload({ body, provider, model, searchContext, searchFailureContext, searchClarificationContext, noSearchContext, builtinSearch, disableVoiceBrief }) {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const finalMessages = disableVoiceBrief ? disableVoiceBriefInMessages(messages) : messages;
  if (searchContext) {
    finalMessages.splice(1, 0, { role: 'system', content: searchContext });
  } else if (searchFailureContext) {
    finalMessages.splice(1, 0, { role: 'system', content: searchFailureContext });
  } else if (searchClarificationContext) {
    finalMessages.splice(1, 0, { role: 'system', content: searchClarificationContext });
  } else if (noSearchContext) {
    finalMessages.splice(1, 0, { role: 'system', content: noSearchContext });
  }

  const payload = {
    model,
    messages: finalMessages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    stream: body.stream !== false,
  };

  if (builtinSearch && provider === 'tongyi') {
    payload.enable_search = true;
  }

  return payload;
}

export async function proxyChatStream(req, res) {
  if (!authorize(req, res)) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendSseError(res, 400, error.message);
    return;
  }

  const config = body.config || {};
  const { provider, endpoint, model, apiKey, usesServerKey } = getProviderConfig(config);
  const searchMode = normalizeSearchMode(body.searchMode || config.searchMode);
  const isCanvas = Boolean(body.isCanvas);
  const query = String(body.searchQuery || body.userText || '').trim();
  const isStreaming = body.stream !== false;
  let sseStarted = false;
  const ensureSse = (status = 200) => {
    if (sseStarted || !isStreaming) return;
    res.writeHead(status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sseStarted = true;
  };
  const writeStatus = (payload) => {
    ensureSse();
    writeSseEvent(res, 'status', payload);
  };
  const writeStreamError = (status, message) => {
    if (!sseStarted) {
      sendSseError(res, status, message);
      return;
    }
    writeSseEvent(res, '', { error: message });
    res.end();
  };

  if (!endpoint) {
    sendSseError(res, 400, 'LLM endpoint is not configured.');
    return;
  }

  if (!apiKey) {
    sendSseError(res, 401, 'No LLM API key is available. You can try the server free trial when LLM_API_KEY is configured, or add your own LLM API Key in settings.');
    return;
  }

  if (!isCanvas && usesServerKey) {
    try {
      consumeFreeLlmQuota(req);
    } catch (error) {
      sendSseError(res, 429, error.message);
      return;
    }
  }

  let searchContext = '';
  let externalSearchError = '';
  let searchClarificationContext = '';
  let didAttemptExternalSearch = false;
  const searchPlan = !isCanvas && searchMode === 'auto'
    ? await planSearchWithLlm({ query, messages: body.messages, provider, endpoint, model, apiKey })
    : buildFallbackSearchPlan(query, body.messages);
  const searchQuery = searchMode === 'external'
    ? buildContextualSearchQuery(query, body.messages)
    : searchPlan.query;
  const effectiveSearchProvider = resolveSearchProvider(searchQuery, config);
  const builtinSearch = !isCanvas && shouldUseBuiltinSearch(provider, searchMode, searchQuery, config);
  const wantsAutoSearch = !isCanvas && searchMode === 'auto' && searchPlan.action === 'search' && searchQuery;
  const disableVoiceBriefForDirectSearch = Boolean(!isCanvas && config.voiceOutputEnabled && wantsAutoSearch);
  const needsSearchClarification = !isCanvas
    && searchMode === 'auto'
    && query
    && searchPlan.action === 'clarify';

  if (!isCanvas && searchMode === 'builtin' && !builtinSearch) {
    sendSseError(res, 400, 'LLM built-in search is currently supported only for Tongyi in this app. Use Auto or Independent Search for other providers.');
    return;
  }

  if (disableVoiceBriefForDirectSearch) {
    writeStatus({
      phase: 'voice_brief_disabled',
      label: 'Voice brief disabled during search',
      reason: 'direct_search',
    });
  }

  if (!isCanvas && searchQuery && (searchMode === 'external' || (wantsAutoSearch && hasExternalSearchKey(config, searchQuery))) && !builtinSearch) {
    try {
      didAttemptExternalSearch = true;
      writeStatus({
        phase: 'searching',
        label: 'Web Search',
        provider: effectiveSearchProvider,
        query: searchQuery,
      });
      const rawSearchResults = await runExternalSearch(searchQuery, req, config);
      const searchResults = filterSearchResults(rawSearchResults, searchQuery);
      if (!searchResults.length) {
        externalSearchError = `Search returned ${rawSearchResults.length} pages, but none matched the requested brand / region / new-product intent closely enough. Query: ${searchQuery}`;
        writeStatus({
          phase: 'search_no_relevant_results',
          label: 'No relevant search results',
          count: 0,
          rawCount: rawSearchResults.length,
          query: searchQuery,
          provider: config.searchProvider || process.env.SEARCH_PROVIDER || 'tavily',
          error: externalSearchError,
        });
      }
      searchContext = buildSearchContext(searchResults);
      writeStatus({
        phase: 'searched',
        label: 'Search complete',
        count: searchResults.length,
        provider: effectiveSearchProvider,
        query: searchQuery,
        results: buildSearchStatusResults(searchResults),
      });
      if (searchResults.length) {
        writeStatus({ phase: 'thinking', label: 'Reading results', count: searchResults.length });
      }
    } catch (error) {
      externalSearchError = error.message;
      writeStatus({
        phase: 'search_failed',
        label: 'Search failed',
        error: externalSearchError,
        query: searchQuery,
        provider: effectiveSearchProvider,
      });
      if (searchMode === 'external') {
        writeStreamError(424, externalSearchError);
        return;
      }
    }
  } else if (wantsAutoSearch && !builtinSearch && !hasExternalSearchKey(config, searchQuery)) {
    externalSearchError = 'Search is on, but no Search API Key is configured. Add a Tavily / Serper / Bing key in settings or configure SEARCH_API_KEY on the server.';
    writeStatus({
      phase: 'search_unavailable',
      label: 'Search unavailable',
      error: externalSearchError,
    });
  } else if (needsSearchClarification) {
    searchClarificationContext = searchPlan.question
      ? buildSearchClarificationContext(`${searchQuery}\nSuggested question: ${searchPlan.question}`)
      : buildSearchClarificationContext(searchQuery);
    writeStatus({
      phase: 'search_needs_clarification',
      label: 'Search needs clarification',
      query: searchQuery,
    });
  }

  const searchFailureContext = !searchContext && externalSearchError
    ? buildSearchFailureContext(externalSearchError)
    : '';
  const noSearchContext = !searchContext
    && !searchFailureContext
    && !searchClarificationContext
    && !didAttemptExternalSearch
    && !builtinSearch
    && searchMode === 'auto'
    && SEARCH_ACTION_PATTERN.test(query)
    ? buildNoSearchContext(searchQuery || query)
    : '';
  const payload = buildPayload({
    body,
    provider,
    model,
    searchContext,
    searchFailureContext,
    searchClarificationContext,
    noSearchContext,
    builtinSearch,
    disableVoiceBrief: disableVoiceBriefForDirectSearch,
  });
  if (builtinSearch) {
    writeStatus({ phase: 'builtin_searching', label: 'Tongyi built-in search requested', provider: 'tongyi' });
  }
  if (usesServerKey) {
    const maxTokens = Number(process.env.FREE_LLM_MAX_OUTPUT_TOKENS || 2000);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      payload.max_tokens = Math.min(Number(payload.max_tokens || maxTokens), maxTokens);
    }
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    writeStreamError(502, error.message);
    return;
  }

  if (payload.stream === false) {
    const text = await upstream.text().catch(() => '');
    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: `LLM request failed (${upstream.status}): ${text.slice(0, 300)}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
    return;
  }

  ensureSse(upstream.ok ? 200 : upstream.status);

  if (externalSearchError) {
    writeSseEvent(res, 'warning', { warning: externalSearchError });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    writeSseEvent(res, '', { error: `LLM request failed (${upstream.status}): ${text.slice(0, 300)}` });
    res.end();
    return;
  }

  if (!upstream.body) {
    const text = await upstream.text();
    writeSseEvent(res, '', { text });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch (error) {
    writeSseEvent(res, '', { error: error.message });
  } finally {
    res.end();
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const rawPath = decodeURIComponent(url.pathname);
  const candidate = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = normalize(join(distDir, candidate));

  if (!filePath.startsWith(distDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  const resolvedPath = existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : join(distDir, 'index.html');

  const ext = extname(resolvedPath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(resolvedPath).pipe(res);
}

function createInteractiveCanvasServer() {
  const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/api/doubao-tts')) {
    proxyDoubaoTts(req, res);
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/api/chat/stream')) {
    proxyChatStream(req, res);
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/health')) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  serveStatic(req, res);
  });

  setupDoubaoAsrProxy(server);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createInteractiveCanvasServer();
  server.listen(port, host, () => {
    console.log(`[server] Interactive Canvas listening on http://${host}:${port}`);
  });
}

export {
  buildContextualSearchQuery,
  buildFallbackSearchPlan,
  isVagueFollowupSearch,
  normalizeSearchPlan,
  reconcileSearchPlan,
  shouldAutoSearch,
  shouldUseBuiltinSearch,
  shouldUseExternalSearch,
};
