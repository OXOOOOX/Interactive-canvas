# 捕梦 · DreamCatcher

**边聊天边在白板上生长内容，AI 驱动的交互式思维导图工具**  
*Chat and grow ideas on a whiteboard — AI-powered interactive mind mapping studio*

一个可直接打开运行的前端 Demo：

- 🎤 语音录音 → STT 转写 → 发送到大模型 → 返回思维导图 JSON
- 🧩 **交互式块画布（Canvas）**：每个节点是可拖拽块，连线会实时跟随
- ✍️ 双击可编辑节点标题、导图标题、附注
- ➕ 支持对选中块新增子块/同级块、删除块
- 🔌 可切换通义千问 / 豆包 / DeepSeek V4 Pro/Flash / 自定义 API（LLM、STT、TTS 分离配置）
- ⚙️ 选择供应商后会自动填充 Endpoint，你只需要选择供应商 + 输入 API Key（选自定义时可手动改 Endpoint）
- 🔐 提供 OAuth 配置位（支持 CODEX / antigravity / 自定义）与 code 换 token 示例流程

---

## 快速开始 / Quick Start

当前项目基于 Vite 开发与构建。  
This project uses Vite for development and build.

```bash
npm install
npm run dev
# 浏览器打开 Browser to http://localhost:8080
```

构建预览：

```bash
npm run build
npm run preview
# 浏览器打开 Browser to http://localhost:8080
```

Docker / Zeabur 部署：

```bash
docker build -t interactive-canvas .
docker run --rm -p 8080:8080 interactive-canvas
# 浏览器打开 Browser to http://localhost:8080
```

## Zeabur 部署 / Zeabur Deployment

生产部署不要把任何 API Key 提交到 GitHub。仓库里只保留 `.env.example` 作为变量名参考，真实 Key 在 Zeabur 控制台配置。

推荐使用仓库内 `Dockerfile` 部署。当前镜像会先执行 `npm run build`，再用 `node server/index.js` 托管静态页面和 `/api/chat/stream` 服务端代理。

部署步骤：

1. 将代码推送到 GitHub。
2. 在 Zeabur 中 `Add Service -> GitHub`，选择这个仓库。
3. 使用 Dockerfile 部署；如果改用 Node preset，请把 Build Command 设为 `npm run build`，Start Command 设为 `npm run serve`。
4. 在 Zeabur Service 的 `Variables` tab 添加服务端环境变量。不要创建或上传包含真实 Key 的 `.env` 文件。
5. 部署完成后绑定域名并启用 HTTPS。

建议的 Zeabur Variables：

```env
NODE_ENV=production

# LLM free-trial fallback. User-provided keys in Settings take priority.
# For Volcengine Ark / Doubao, LLM_MODEL should be a model ID enabled in your Ark account.
# Some Ark accounts use endpoint-style IDs such as ep-xxxxxxxx; others use model IDs.
LLM_PROVIDER=doubao
LLM_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/chat/completions
LLM_MODEL=your-enabled-doubao-model-or-endpoint-id
LLM_API_KEY=your-volcengine-ark-api-key
FREE_LLM_QUOTA_LIMIT=5
FREE_LLM_QUOTA_WINDOW_MS=86400000
FREE_LLM_MAX_OUTPUT_TOKENS=2000

# Optional Doubao ASR / TTS free-trial fallback for public users without their own Doubao key.
DOUBAO_API_KEY=your-doubao-speech-api-key
DOUBAO_VOICE_FREE_QUOTA_LIMIT=20
DOUBAO_VOICE_FREE_QUOTA_WINDOW_MS=86400000

# Server fallback search key. Users can still enter their own key in Settings.
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=your-server-side-tavily-key
SEARCH_MAX_RESULTS=5

# Free fallback quota for users without their own Search API Key.
# Example: each client IP can use server search 30 times per hour.
SEARCH_FREE_QUOTA_LIMIT=30
SEARCH_FREE_QUOTA_WINDOW_MS=3600000

# Only enable this when a reverse proxy can inject x-api-auth-key.
REQUIRE_API_AUTH_KEY=0
API_AUTH_KEY=replace-with-a-long-random-secret-if-needed
```

关于搜索 Key：

- 如果用户没有填写自己的搜索 Key，服务端会使用 `SEARCH_PROVIDER + SEARCH_API_KEY` 作为兜底，并按 `SEARCH_FREE_QUOTA_*` 限额。
- 如果用户在设置里填写了自己的 Tavily / Serper / Bing Key，则优先使用用户自己的 Key，不消耗服务器免费额度。
- 两三个内测用户通常可以把 `SEARCH_FREE_QUOTA_LIMIT` 设得宽松一些，例如每 IP 每小时 30 次；最终上限仍取决于搜索平台账号本身的免费额度。

关于 LLM Key：

- 如果用户在设置里填写了自己的 LLM Key，优先使用用户自己的 Key，不消耗服务器免费体验额度。
- 如果用户没有填写 LLM Key，服务端会使用 `LLM_API_KEY` 作为免费试用兜底，并按 `FREE_LLM_QUOTA_*` 限额。
- 推荐初始免费额度是每 IP 每天 5 轮主聊天，每轮服务器兜底输出最多 2000 tokens。后台白板整理和智能记忆会跟随这 5 轮体验，但主聊天额度用完后不会继续触发后台 Agent。

关于 `API_AUTH_KEY`：

- Zeabur 直连公网时不要开启 `REQUIRE_API_AUTH_KEY=1`，因为浏览器不能安全持有服务器总密钥。
- 如果前面接了 Cloudflare Worker、Nginx、Caddy 或业务网关，并且网关能给后端注入 `x-api-auth-key`，再设置 `REQUIRE_API_AUTH_KEY=1`。

参考文档：

- [Zeabur Environment Variables](https://zeabur.com/docs/en-US/deploy/config/environment-variables)
- [Zeabur Best Practices](https://zeabur.com/docs/en-US/get-started/best-practices)

## 页面能力 / Features

1. **配置区 / Configuration**
   - 选择 LLM、STT、TTS 供应商（会自动填充默认 Endpoint）
   - 填写 API Key 与各自 Endpoint
   - 配置 OAuth 参数（可选），执行授权与 code 换 token
   - 支持保存/加载 localStorage 配置

2. **语音与聊天区 / Voice & Chat**
   - 开始/停止录音
   - 自动上传音频到 STT endpoint 获取文本
   - 文本送入 LLM endpoint，请求生成导图 JSON
   - 日志区展示 system / user / assistant / error 事件

3. **Canvas 画布区 / Canvas Board**
   - 节点以 block 形式渲染，可拖拽重排
   - 连线为 SVG 曲线，拖拽时实时更新
   - 支持新增子块、同级块、删除块

模型建议输出结构 / Suggested Model Output Structure：

```json
{
  "title": "主题",
  "nodes": [
    {
      "id": "uuid",
      "label": "一级节点",
      "x": 360,
      "y": 120,
      "children": []
    }
  ],
  "notes": ["附注 1"]
}
```

---

## 本地测试 API Key（推荐做法）/ Local Testing with API Key

为避免把密钥提交到 Git，可使用本地配置文件：  
To avoid committing secrets to Git, use a local config file:

1. 在 `public/local.config.js` 中填写本地凭证（文件已被 gitignore）  
   Fill your local credentials in `public/local.config.js` (this file is gitignored)
2. 建议填写 `LLM_API_KEY` 与 `DOUBAO_API_KEY`，按需补充默认 endpoint  
   Recommended fields are `LLM_API_KEY` and `DOUBAO_API_KEY`, plus optional default endpoints
3. 刷新页面后，系统会自动把本地配置注入到对应输入框  
   After refreshing, the app injects the local config into the corresponding input fields

示例：

```javascript
window.__LOCAL_CONFIG__ = {
  LLM_API_KEY: "sk-your-llm-key",
  DOUBAO_API_KEY: "your-doubao-key",
  DEFAULT_LLM_ENDPOINT: "",
  DEFAULT_STT_ENDPOINT: "",
  DEFAULT_TTS_ENDPOINT: "",
};
```

---

## API 对接建议 / API Integration Best Practices

当前代码将 endpoint 和 bearer token 直接在浏览器请求（便于快速验证）。  
The current code sends requests directly from the browser with endpoint and bearer token (for quick validation).

正式环境建议 / For production environments：

- 在服务端做代理，隐藏 API Key  
  Use a server-side proxy to hide API keys
- 服务端统一适配各供应商返回格式（通义/豆包字段差异）  
  Standardize response formats from different providers (field differences between Tongyi/Doubao)
- 做请求签名、限流、审计日志与错误映射  
  Implement request signing, rate limiting, audit logs, and error mapping

---

## 文件说明 / File Structure

| 文件 / File | 说明 / Description |
|------------|-------------------|
| `index.html` | 页面结构与交互控件 / Page structure and UI controls |
| `src/style.css` | 样式 / Styles |
| `src/main.js` | 应用入口和全局事件绑定 / App entry and global event bindings |
| `src/canvas.js` | 画布渲染、拖拽、缩放 / Canvas rendering, drag & drop, zoom |
| `src/chat.js` | 聊天面板逻辑 / Chat panel logic |
| `src/state.js` | 状态管理和历史栈 / State management and history stack |
| `src/services/llm.js` | LLM API 调用（双 Agent 架构）/ LLM API calls (dual-agent architecture) |
| `src/services/stt.js` | 语音转写服务 / Speech-to-text service |
| `src/services/tts.js` | 语音合成服务 / Text-to-speech service |
| `src/services/oauth.js` | OAuth 认证 / OAuth authentication |
| `src/utils/parser.js` | AI 响应解析和 Markdown 渲染 / AI response parsing and Markdown rendering |
| `src/utils/layout.js` | 自动布局算法 / Auto-layout algorithm |
| `src/utils/traverse.js` | 树遍历工具 / Tree traversal utilities |

---

## 设计理念 / Design Philosophy

**捕梦 (DreamCatcher)** — 捕捉你一闪而过的梦幻想法  
*Catch your fleeting dream ideas*

灵感来自印地安人的捕梦网传说 —— 好念头穿过网眼，坏想法被滤去。  
Inspired by the Native American dreamcatcher legend — good ideas pass through, bad ones are filtered out.
