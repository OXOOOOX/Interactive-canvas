const STORAGE_KEY = "voice-mindmap-config-v1";
const BLOCK_WIDTH = 220;
const BLOCK_HEIGHT = 72;

const ENDPOINT_PRESETS = {
  tongyi: {
    llm: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    stt: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    tts: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  },
  doubao: {
    llm: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    stt: "https://openspeech.bytedance.com/api/v1/vc/ata/submit",
    tts: "https://openspeech.bytedance.com/api/v1/tts",
  },
};


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
  blockCanvas: document.querySelector("#blockCanvas"),
  linkLayer: document.querySelector("#linkLayer"),
  addChild: document.querySelector("#addChild"),
  addSibling: document.querySelector("#addSibling"),
  deleteNode: document.querySelector("#deleteNode"),
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
        x: 360,
        y: 80,
        children: [
          { id: crypto.randomUUID(), label: "分支 A", x: 100, y: 240, children: [] },
          { id: crypto.randomUUID(), label: "分支 B", x: 620, y: 240, children: [] },
        ],
      },
    ],
    notes: ["双击附注可以修改", "拖拽块可以重新布局"],
  },
  selectedNodeId: "",
  lastAssistantReply: "",
};

function traverse(nodes, parent = null, acc = []) {
  nodes.forEach((node, index) => {
    acc.push({ node, parent, index });
    if (Array.isArray(node.children) && node.children.length) {
      traverse(node.children, node, acc);
    }
  });
  return acc;
}

function ensureLayout(map) {
  const nodes = traverse(map.nodes);
  nodes.forEach(({ node }, i) => {
    if (!node.id) node.id = crypto.randomUUID();
    if (typeof node.x !== "number") node.x = 120 + (i % 4) * 260;
    if (typeof node.y !== "number") node.y = 80 + Math.floor(i / 4) * 150;
    if (!Array.isArray(node.children)) node.children = [];
  });
}



function applyLocalConfig() {
  const cfg = window.__LOCAL_CONFIG__ || {};
  if (!dom.apiKey.value && typeof cfg.DASHSCOPE_KEY === "string") {
    dom.apiKey.value = cfg.DASHSCOPE_KEY;
    log("system", "已从 local.config.js 注入 DASHSCOPE_KEY（仅本地）");
  }
  if (!dom.llmEndpoint.value && cfg.DEFAULT_LLM_ENDPOINT) dom.llmEndpoint.value = cfg.DEFAULT_LLM_ENDPOINT;
  if (!dom.sttEndpoint.value && cfg.DEFAULT_STT_ENDPOINT) dom.sttEndpoint.value = cfg.DEFAULT_STT_ENDPOINT;
  if (!dom.ttsEndpoint.value && cfg.DEFAULT_TTS_ENDPOINT) dom.ttsEndpoint.value = cfg.DEFAULT_TTS_ENDPOINT;
}



function applyProviderPreset() {
  const llmPreset = ENDPOINT_PRESETS[dom.llmProvider.value]?.llm || "";
  const sttPreset = ENDPOINT_PRESETS[dom.sttProvider.value]?.stt || "";
  const ttsPreset = ENDPOINT_PRESETS[dom.ttsProvider.value]?.tts || "";

  const llmCustom = dom.llmProvider.value === "custom";
  const sttCustom = dom.sttProvider.value === "custom";
  const ttsCustom = dom.ttsProvider.value === "custom" || dom.ttsProvider.value === "browser";

  dom.llmEndpoint.readOnly = !llmCustom;
  dom.sttEndpoint.readOnly = !sttCustom;
  dom.ttsEndpoint.readOnly = !ttsCustom;

  if (!llmCustom) dom.llmEndpoint.value = llmPreset;
  if (!sttCustom) dom.sttEndpoint.value = sttPreset;
  if (!ttsCustom) dom.ttsEndpoint.value = ttsPreset;

  dom.llmEndpoint.title = llmCustom ? "自定义可编辑" : "已根据供应商自动配置";
  dom.sttEndpoint.title = sttCustom ? "自定义可编辑" : "已根据供应商自动配置";
  dom.ttsEndpoint.title = ttsCustom ? "自定义可编辑" : "已根据供应商自动配置";
}

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
    if (dom[key] && typeof value === "string") dom[key].value = value;
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

function drawLinks(flat) {
  dom.linkLayer.innerHTML = "";
  const rect = dom.mindmapView.getBoundingClientRect();
  dom.linkLayer.setAttribute("viewBox", `0 0 ${Math.max(rect.width, 1100)} ${Math.max(rect.height, 900)}`);

  flat.forEach(({ node, parent }) => {
    if (!parent) return;
    const x1 = parent.x + BLOCK_WIDTH / 2;
    const y1 = parent.y + BLOCK_HEIGHT;
    const x2 = node.x + BLOCK_WIDTH / 2;
    const y2 = node.y;
    const midY = (y1 + y2) / 2;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
    );
    path.setAttribute("stroke", "#38bdf8");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("fill", "none");
    path.setAttribute("opacity", "0.9");
    dom.linkLayer.append(path);
  });
}

function attachDrag(block, node) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  block.addEventListener("pointerdown", (event) => {
    dragging = true;
    block.setPointerCapture(event.pointerId);
    offsetX = event.clientX - node.x;
    offsetY = event.clientY - node.y;
  });

  block.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    node.x = Math.max(0, event.clientX - offsetX + dom.mindmapView.scrollLeft);
    node.y = Math.max(0, event.clientY - offsetY + dom.mindmapView.scrollTop);
    block.style.left = `${node.x}px`;
    block.style.top = `${node.y}px`;
    drawLinks(traverse(appState.map.nodes));
  });

  block.addEventListener("pointerup", () => {
    dragging = false;
    syncMapToTextarea(false);
  });
}

function renderMindmap() {
  ensureLayout(appState.map);
  dom.blockCanvas.innerHTML = "";

  const title = document.createElement("div");
  title.className = "mm-title";
  title.textContent = `主题：${appState.map.title}（双击此处改标题）`;
  title.ondblclick = () => {
    const edited = prompt("编辑思维导图标题", appState.map.title);
    if (edited !== null) {
      appState.map.title = edited;
      syncMapToTextarea();
    }
  };
  dom.blockCanvas.append(title);

  const flat = traverse(appState.map.nodes);
  flat.forEach(({ node }) => {
    const block = document.createElement("article");
    block.className = "mm-block";
    if (node.id === appState.selectedNodeId) block.classList.add("selected");
    block.style.left = `${node.x}px`;
    block.style.top = `${node.y}px`;
    block.innerHTML = `<div class="mm-label">${node.label}</div>`;

    block.onclick = () => {
      appState.selectedNodeId = node.id;
      renderMindmap();
    };

    block.ondblclick = () => {
      const edited = prompt("编辑节点标签", node.label);
      if (edited !== null) {
        node.label = edited;
        syncMapToTextarea();
      }
    };

    attachDrag(block, node);
    dom.blockCanvas.append(block);
  });

  drawLinks(flat);
  renderNotes();
}

function syncMapToTextarea(render = true) {
  dom.mindmapJson.value = JSON.stringify(appState.map, null, 2);
  if (render) renderMindmap();
}

function tryParseModelJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.title && Array.isArray(parsed.nodes) && Array.isArray(parsed.notes)) return parsed;
  } catch {
    return null;
  }
  return null;
}

async function callLlm(promptText) {
  const cfg = getConfig();
  if (!cfg.llmEndpoint) return "未配置 LLM endpoint。请先配置。";

  const payload = {
    provider: cfg.llmProvider,
    model: cfg.llmProvider === "doubao" ? "doubao-1.5-pro" : "qwen-max",
    messages: [
      {
        role: "system",
        content:
          "你是思维导图助手。仅返回 JSON：{title:string,nodes:Node[],notes:string[]}，Node={id,label,x,y,children[]}。",
      },
      { role: "user", content: promptText },
    ],
  };

  const res = await fetch(cfg.llmEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`LLM 请求失败: ${res.status}`);
  const data = await res.json();
  return data.output_text || data.text || JSON.stringify(data);
}

async function transcribe(audioBlob) {
  const cfg = getConfig();
  if (!cfg.sttEndpoint) throw new Error("未配置 STT endpoint");

  const formData = new FormData();
  formData.append("file", audioBlob, "audio.webm");
  formData.append("provider", cfg.sttProvider);

  const res = await fetch(cfg.sttEndpoint, {
    method: "POST",
    headers: { Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "" },
    body: formData,
  });
  if (!res.ok) throw new Error(`STT 请求失败: ${res.status}`);
  const data = await res.json();
  return data.text || "";
}

async function speak(text) {
  const cfg = getConfig();
  if (cfg.ttsProvider === "browser") {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    speechSynthesis.speak(utterance);
    return;
  }
  if (!cfg.ttsEndpoint) throw new Error("未配置 TTS endpoint");

  const res = await fetch(cfg.ttsEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : "",
    },
    body: JSON.stringify({ text, provider: cfg.ttsProvider }),
  });

  if (!res.ok) throw new Error(`TTS 请求失败: ${res.status}`);
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

  localStorage.setItem("oauthState", state);
  localStorage.setItem("oauthVerifier", codeVerifier);

  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", cfg.oauthClientId);
  auth.searchParams.set("redirect_uri", cfg.oauthRedirect || location.origin + location.pathname);
  auth.searchParams.set("scope", cfg.oauthScope || "openid profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", codeVerifier);
  auth.searchParams.set("code_challenge_method", "plain");
  return auth.toString();
}

async function exchangeOAuthCode() {
  const cfg = getConfig();
  const code = dom.oauthCode.value.trim();
  if (!code || !cfg.oauthTokenUrl) throw new Error("缺少 code 或 token URL");

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

  if (!res.ok) throw new Error(`Token 交换失败: ${res.status}`);
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
      ensureLayout(parsed);
      appState.map = parsed;
      appState.selectedNodeId = traverse(appState.map.nodes)[0]?.node.id || "";
      syncMapToTextarea();
      log("system", "已根据模型输出更新块画布");
    } else {
      log("system", "模型返回不是标准 JSON，未自动覆盖导图");
    }
  } catch (error) {
    log("error", error.message);
  }
}

function addChildNode() {
  const selected = traverse(appState.map.nodes).find(({ node }) => node.id === appState.selectedNodeId)?.node;
  if (!selected) {
    log("system", "请先选中一个块");
    return;
  }
  const child = {
    id: crypto.randomUUID(),
    label: "新子块",
    x: selected.x + 260,
    y: selected.y + 150,
    children: [],
  };
  selected.children.push(child);
  appState.selectedNodeId = child.id;
  syncMapToTextarea();
}

function addSiblingNode() {
  const selectedItem = traverse(appState.map.nodes).find(({ node }) => node.id === appState.selectedNodeId);
  if (!selectedItem) {
    log("system", "请先选中一个块");
    return;
  }
  const sibling = {
    id: crypto.randomUUID(),
    label: "新同级块",
    x: selectedItem.node.x + 260,
    y: selectedItem.node.y,
    children: [],
  };
  if (selectedItem.parent) {
    selectedItem.parent.children.push(sibling);
  } else {
    appState.map.nodes.push(sibling);
  }
  appState.selectedNodeId = sibling.id;
  syncMapToTextarea();
}

function deleteNode() {
  const selectedItem = traverse(appState.map.nodes).find(({ node }) => node.id === appState.selectedNodeId);
  if (!selectedItem) {
    log("system", "请先选中一个块");
    return;
  }

  if (selectedItem.parent) {
    selectedItem.parent.children.splice(selectedItem.index, 1);
  } else {
    appState.map.nodes.splice(selectedItem.index, 1);
  }

  appState.selectedNodeId = traverse(appState.map.nodes)[0]?.node.id || "";
  syncMapToTextarea();
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
    ensureLayout(parsed);
    appState.map = parsed;
    appState.selectedNodeId = traverse(appState.map.nodes)[0]?.node.id || "";
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

dom.resetDemo.onclick = () => {
  appState.map = {
    title: "创业计划",
    nodes: [
      {
        id: crypto.randomUUID(),
        label: "产品",
        x: 360,
        y: 80,
        children: [
          { id: crypto.randomUUID(), label: "MVP", x: 80, y: 240, children: [] },
          { id: crypto.randomUUID(), label: "迭代路线", x: 360, y: 240, children: [] },
        ],
      },
      {
        id: crypto.randomUUID(),
        label: "市场",
        x: 640,
        y: 80,
        children: [
          { id: crypto.randomUUID(), label: "用户画像", x: 640, y: 240, children: [] },
          { id: crypto.randomUUID(), label: "竞品分析", x: 920, y: 240, children: [] },
        ],
      },
    ],
    notes: ["目标：3个月内验证 PMF", "附注：记录每次访谈结论"],
  };
  appState.selectedNodeId = appState.map.nodes[0].id;
  syncMapToTextarea();
  log("system", "已加载演示数据");
};

dom.addChild.onclick = addChildNode;
dom.addSibling.onclick = addSiblingNode;
dom.deleteNode.onclick = deleteNode;
dom.llmProvider.onchange = applyProviderPreset;
dom.sttProvider.onchange = applyProviderPreset;
dom.ttsProvider.onchange = applyProviderPreset;
dom.saveConfig.onclick = saveConfig;
dom.loadConfig.onclick = loadConfig;

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
  applyProviderPreset();
  applyLocalConfig();
  ensureLayout(appState.map);
  appState.selectedNodeId = traverse(appState.map.nodes)[0]?.node.id || "";
  syncMapToTextarea();
})();
