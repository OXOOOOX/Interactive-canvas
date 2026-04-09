const STORAGE_KEY = "voice-mindmap-config-v1";

const dom = {
  llmProvider: document.querySelector("#llmProvider"),
  sttProvider: document.querySelector("#sttProvider"),
  ttsProvider: document.querySelector("#ttsProvider"),
  apiKey: document.querySelector("#apiKey"),
  llmEndpoint: document.querySelector("#llmEndpoint"),
  sttEndpoint: document.querySelector("#sttEndpoint"),
  ttsEndpoint: document.querySelector("#ttsEndpoint"),
  oauthProvider: document.querySelector("#oauthProvider"),
  oauthClientId: document.querySelector("#oauthClientId"),
  oauthAuthUrl: document.querySelector("#oauthAuthUrl"),
  oauthTokenUrl: document.querySelector("#oauthTokenUrl"),
  oauthScope: document.querySelector("#oauthScope"),
  oauthRedirect: document.querySelector("#oauthRedirect"),
  oauthCode: document.querySelector("#oauthCode"),
  saveConfig: document.querySelector("#saveConfig"),
  loadConfig: document.querySelector("#loadConfig"),
  resetDemo: document.querySelector("#resetDemo"),
  recordBtn: document.querySelector("#recordBtn"),
  sendTextBtn: document.querySelector("#sendTextBtn"),
  speakBtn: document.querySelector("#speakBtn"),
  inputBox: document.querySelector("#inputBox"),
  chatLog: document.querySelector("#chatLog"),
  noteList: document.querySelector("#noteList"),
  mindmapJson: document.querySelector("#mindmapJson"),
  mindmapView: document.querySelector("#mindmapView"),
  applyJson: document.querySelector("#applyJson"),
  downloadJson: document.querySelector("#downloadJson"),
  oauthStart: document.querySelector("#oauthStart"),
  oauthExchange: document.querySelector("#oauthExchange"),
};

let appState = {
  map: {
    title: "语音思维导图",
    nodes: [
      {
        id: crypto.randomUUID(),
        label: "核心主题",
        children: [
          { id: crypto.randomUUID(), label: "分支 A", children: [] },
          { id: crypto.randomUUID(), label: "分支 B", children: [] },
        ],
      },
    ],
    notes: ["双击附注可以修改", "按录音按钮后可触发语音流程"],
  },
  lastAssistantReply: "",
};

function getConfig() {
  return {
    llmProvider: dom.llmProvider.value,
    sttProvider: dom.sttProvider.value,
    ttsProvider: dom.ttsProvider.value,
    apiKey: dom.apiKey.value,
    llmEndpoint: dom.llmEndpoint.value,
    sttEndpoint: dom.sttEndpoint.value,
    ttsEndpoint: dom.ttsEndpoint.value,
    oauthProvider: dom.oauthProvider.value,
    oauthClientId: dom.oauthClientId.value,
    oauthAuthUrl: dom.oauthAuthUrl.value,
    oauthTokenUrl: dom.oauthTokenUrl.value,
    oauthScope: dom.oauthScope.value,
    oauthRedirect: dom.oauthRedirect.value,
    oauthToken: localStorage.getItem("oauthToken") || "",
  };
}

function setConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (dom[key] && typeof value === "string") {
      dom[key].value = value;
    }
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getConfig()));
  log("system", "配置已保存到 localStorage");
}

function loadConfig() {
  const text = localStorage.getItem(STORAGE_KEY);
  if (!text) {
    log("system", "没有找到保存的配置");
    return;
  }
  setConfig(JSON.parse(text));
  log("system", "配置已加载");
}

function log(role, message) {
  const li = document.createElement("li");
  li.textContent = `[${new Date().toLocaleTimeString()}] ${role}: ${message}`;
  dom.chatLog.prepend(li);
}

function renderNotes() {
  dom.noteList.innerHTML = "";
  appState.map.notes.forEach((note, idx) => {
    const li = document.createElement("li");
    li.textContent = note;
    li.title = "双击编辑";
    li.ondblclick = () => {
      const edited = prompt("编辑附注", note);
      if (edited !== null) {
        appState.map.notes[idx] = edited;
        syncMapToTextarea();
      }
    };
    dom.noteList.append(li);
  });
}

function createNodeEl(node) {
  const li = document.createElement("li");
  li.className = "mm-node";

  const label = document.createElement("span");
  label.className = "mm-label";
  label.textContent = node.label;
  label.ondblclick = () => {
    const edited = prompt("编辑节点标签", node.label);
    if (edited !== null) {
      node.label = edited;
      syncMapToTextarea();
    }
  };

  li.append(label);
  if (node.children?.length) {
    const ul = document.createElement("ul");
    node.children.forEach((child) => ul.append(createNodeEl(child)));
    li.append(ul);
  }
  return li;
}

function renderMindmap() {
  dom.mindmapView.innerHTML = "";
  const title = document.createElement("h3");
  title.textContent = appState.map.title;
  title.ondblclick = () => {
    const edited = prompt("编辑思维导图标题", appState.map.title);
    if (edited !== null) {
      appState.map.title = edited;
      syncMapToTextarea();
    }
  };
  dom.mindmapView.append(title);

  const ul = document.createElement("ul");
  ul.className = "mm-root";
  appState.map.nodes.forEach((node) => ul.append(createNodeEl(node)));
  dom.mindmapView.append(ul);

  renderNotes();
}

function syncMapToTextarea() {
  dom.mindmapJson.value = JSON.stringify(appState.map, null, 2);
  renderMindmap();
}

function tryParseModelJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.title && Array.isArray(parsed.nodes) && Array.isArray(parsed.notes)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function callLlm(promptText) {
  const cfg = getConfig();
  const endpoint = cfg.llmEndpoint;
  if (!endpoint) {
    return `未配置 LLM endpoint。请在配置区填写后重试。`;
  }

  const systemPrompt =
    "你是思维导图助手。请仅返回 JSON：{title:string,nodes:Node[],notes:string[]}，Node={id,label,children[]}。";
  const payload = {
    provider: cfg.llmProvider,
    model: cfg.llmProvider === "doubao" ? "doubao-1.5-pro" : "qwen-max",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: promptText },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`LLM 请求失败: ${res.status}`);
  }

  const data = await res.json();
  return data.output_text || data.text || JSON.stringify(data);
}

async function transcribe(audioBlob) {
  const cfg = getConfig();
  if (!cfg.sttEndpoint) {
    throw new Error("未配置 STT endpoint");
  }
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.webm");
  formData.append("provider", cfg.sttProvider);

  const res = await fetch(cfg.sttEndpoint, {
    method: "POST",
    headers: {
      Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "",
    },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`STT 请求失败: ${res.status}`);
  }

  const data = await res.json();
  return data.text || "";
}

async function speak(text) {
  const cfg = getConfig();
  if (cfg.ttsProvider === "browser") {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    speechSynthesis.speak(u);
    return;
  }
  if (!cfg.ttsEndpoint) {
    throw new Error("未配置 TTS endpoint");
  }

  const res = await fetch(cfg.ttsEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "",
    },
    body: JSON.stringify({ text, provider: cfg.ttsProvider }),
  });

  if (!res.ok) {
    throw new Error(`TTS 请求失败: ${res.status}`);
  }

  const data = await res.json();
  if (data.audioBase64) {
    const audio = new Audio(`data:audio/mpeg;base64,${data.audioBase64}`);
    await audio.play();
  }
}

function buildOAuthUrl() {
  const cfg = getConfig();
  const auth = new URL(cfg.oauthAuthUrl);
  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID().replaceAll("-", "");
  const codeChallenge = btoa(codeVerifier).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  localStorage.setItem("oauthState", state);
  localStorage.setItem("oauthVerifier", codeVerifier);

  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", cfg.oauthClientId);
  auth.searchParams.set("redirect_uri", cfg.oauthRedirect || location.origin + location.pathname);
  auth.searchParams.set("scope", cfg.oauthScope || "openid profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", codeChallenge);
  auth.searchParams.set("code_challenge_method", "plain");

  return auth.toString();
}

async function exchangeOAuthCode() {
  const cfg = getConfig();
  const code = dom.oauthCode.value.trim();
  if (!code || !cfg.oauthTokenUrl) {
    throw new Error("缺少 code 或 token URL");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.oauthClientId,
    redirect_uri: cfg.oauthRedirect || location.origin + location.pathname,
    code_verifier: localStorage.getItem("oauthVerifier") || "",
  });

  const res = await fetch(cfg.oauthTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token 交换失败: ${res.status}`);
  }

  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem("oauthToken", data.access_token);
    log("system", "OAuth token 已保存到 localStorage.oauthToken");
  }
}

async function processUserPrompt(text) {
  if (!text.trim()) return;
  log("user", text);
  try {
    const assistantText = await callLlm(text);
    appState.lastAssistantReply = assistantText;
    log("assistant", assistantText.slice(0, 220));

    const parsed = tryParseModelJson(assistantText);
    if (parsed) {
      appState.map = parsed;
      syncMapToTextarea();
      log("system", "已根据模型输出更新思维导图");
    } else {
      log("system", "模型返回不是标准 JSON，未自动覆盖思维导图");
    }
  } catch (error) {
    log("error", error.message);
  }
}

let recorder;
let audioChunks = [];

dom.recordBtn.onclick = async () => {
  if (!recorder || recorder.state === "inactive") {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    audioChunks = [];
    recorder.ondataavailable = (e) => audioChunks.push(e.data);
    recorder.onstop = async () => {
      try {
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        const text = await transcribe(blob);
        dom.inputBox.value = text;
        log("stt", text || "(空结果)");
        await processUserPrompt(text);
      } catch (error) {
        log("error", `语音处理失败: ${error.message}`);
      }
    };
    recorder.start();
    dom.recordBtn.textContent = "⏹️ 停止录音";
    log("system", "录音中...");
  } else {
    recorder.stop();
    dom.recordBtn.textContent = "🎤 开始录音";
  }
};

dom.sendTextBtn.onclick = () => processUserPrompt(dom.inputBox.value);

dom.speakBtn.onclick = async () => {
  try {
    if (!appState.lastAssistantReply) {
      log("system", "没有可朗读的内容");
      return;
    }
    await speak(appState.lastAssistantReply);
  } catch (error) {
    log("error", error.message);
  }
};

dom.applyJson.onclick = () => {
  try {
    const parsed = JSON.parse(dom.mindmapJson.value);
    if (!parsed.title || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.notes)) {
      throw new Error("JSON 字段不完整，需要 title/nodes/notes");
    }
    appState.map = parsed;
    syncMapToTextarea();
    log("system", "手动 JSON 已应用");
  } catch (error) {
    log("error", `JSON 解析失败: ${error.message}`);
  }
};

dom.downloadJson.onclick = () => {
  const blob = new Blob([JSON.stringify(appState.map, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mindmap-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

dom.saveConfig.onclick = saveConfig;
dom.loadConfig.onclick = loadConfig;

dom.resetDemo.onclick = () => {
  appState.map = {
    title: "创业计划",
    nodes: [
      {
        id: crypto.randomUUID(),
        label: "产品",
        children: [
          { id: crypto.randomUUID(), label: "MVP", children: [] },
          { id: crypto.randomUUID(), label: "迭代路线", children: [] },
        ],
      },
      {
        id: crypto.randomUUID(),
        label: "市场",
        children: [
          { id: crypto.randomUUID(), label: "用户画像", children: [] },
          { id: crypto.randomUUID(), label: "竞品分析", children: [] },
        ],
      },
    ],
    notes: ["目标：3个月内验证 PMF", "附注：记录每次访谈结论"],
  };
  syncMapToTextarea();
  log("system", "已加载演示数据");
};

dom.oauthStart.onclick = () => {
  try {
    const url = buildOAuthUrl();
    window.open(url, "_blank", "noopener,noreferrer");
    log("system", "OAuth 页面已打开，请登录并复制 code");
  } catch (error) {
    log("error", `OAuth 启动失败: ${error.message}`);
  }
};

dom.oauthExchange.onclick = async () => {
  try {
    await exchangeOAuthCode();
  } catch (error) {
    log("error", error.message);
  }
};

(function init() {
  dom.oauthRedirect.value = location.origin + location.pathname;
  loadConfig();
  syncMapToTextarea();
})();
