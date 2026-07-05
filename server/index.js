import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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

function shouldAutoSearch(query = '') {
  const text = query.toLowerCase();
  return /搜索|搜一下|查一下|联网|最新|最近|今天|昨日|今年|新闻|来源|引用|价格|行情|法规|政策|竞品|官网|current|latest|recent|today|news|source|cite|price|policy|competitor/.test(text)
    || /\b202[4-9]\b/.test(text);
}

function hasExternalSearchKey(config = {}) {
  return Boolean(config.searchApiKey || process.env.SEARCH_API_KEY);
}

function shouldUseBuiltinSearch(provider, mode, query, config = {}) {
  if (mode === 'builtin') return provider === 'tongyi';
  return mode === 'auto'
    && provider === 'tongyi'
    && shouldAutoSearch(query)
    && Boolean(config.preferBuiltinSearch);
}

function shouldUseExternalSearch(provider, mode, query, config = {}) {
  if (mode === 'external') return true;
  return mode === 'auto'
    && shouldAutoSearch(query)
    && (!Boolean(config.preferBuiltinSearch) || provider !== 'tongyi')
    && hasExternalSearchKey(config);
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

async function runExternalSearch(query, req, config = {}) {
  const provider = (config.searchProvider || process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
  const userApiKey = config.searchApiKey || '';
  const serverApiKey = process.env.SEARCH_API_KEY || '';
  const apiKey = userApiKey || serverApiKey;
  const maxResults = Math.max(1, Math.min(8, Number(process.env.SEARCH_MAX_RESULTS || 5)));

  if (!apiKey) {
    throw new Error('Search API key is not configured. Set SEARCH_API_KEY on the server or add your own Search API Key in settings.');
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
  return `Search results for reference. Use them only when relevant and cite URLs inline when making factual claims.\n${lines.join('\n\n')}`;
}

function buildPayload({ body, provider, model, searchContext, builtinSearch }) {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (searchContext) {
    messages.splice(1, 0, { role: 'system', content: searchContext });
  }

  const payload = {
    model,
    messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    stream: body.stream !== false,
  };

  if (builtinSearch && provider === 'tongyi') {
    payload.enable_search = true;
  }

  return payload;
}

async function proxyChatStream(req, res) {
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
  const builtinSearch = !isCanvas && shouldUseBuiltinSearch(provider, searchMode, query, config);
  const wantsAutoSearch = !isCanvas && searchMode === 'auto' && query && shouldAutoSearch(query);

  if (!isCanvas && searchMode === 'builtin' && !builtinSearch) {
    sendSseError(res, 400, 'LLM built-in search is currently supported only for Tongyi in this app. Use Auto or Independent Search for other providers.');
    return;
  }

  if (!isCanvas && query && shouldUseExternalSearch(provider, searchMode, query, config) && !builtinSearch) {
    try {
      writeStatus({ phase: 'searching', label: 'Web Search', provider: config.searchProvider || process.env.SEARCH_PROVIDER || 'tavily' });
      const searchResults = await runExternalSearch(query, req, config);
      searchContext = buildSearchContext(searchResults);
      writeStatus({ phase: 'thinking', label: 'Reading results', count: searchResults.length });
    } catch (error) {
      externalSearchError = error.message;
      if (searchMode === 'external') {
        writeStreamError(424, externalSearchError);
        return;
      }
    }
  } else if (wantsAutoSearch && !builtinSearch && !hasExternalSearchKey(config)) {
    externalSearchError = 'Search is on, but no Search API Key is configured. Add a Tavily / Serper / Bing key in settings or configure SEARCH_API_KEY on the server.';
  }

  const payload = buildPayload({ body, provider, model, searchContext, builtinSearch });
  if (builtinSearch) {
    writeStatus({ phase: 'searching', label: 'Web Search', provider: 'tongyi' });
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

server.listen(port, host, () => {
  console.log(`[server] Interactive Canvas listening on http://${host}:${port}`);
});
