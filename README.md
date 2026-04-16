# 捕梦 · DreamCatcher

**边聊天边在白板上生长内容，AI 驱动的交互式思维导图工具**  
*Chat and grow ideas on a whiteboard — AI-powered interactive mind mapping studio*

一个可直接打开运行的前端 Demo：

- 🎤 语音录音 → STT 转写 → 发送到大模型 → 返回思维导图 JSON
- 🧩 **交互式块画布（Canvas）**：每个节点是可拖拽块，连线会实时跟随
- ✍️ 双击可编辑节点标题、导图标题、附注
- ➕ 支持对选中块新增子块/同级块、删除块
- 🔌 可切换通义千问 / 豆包 / 自定义 API（LLM、STT、TTS 分离配置）
- ⚙️ 选择供应商后会自动填充 Endpoint，你只需要选择供应商 + 输入 API Key（选自定义时可手动改 Endpoint）
- 🔐 提供 OAuth 配置位（支持 CODEX / antigravity / 自定义）与 code 换 token 示例流程

---

## 快速开始 / Quick Start

> 这是纯前端静态页面，不需要构建。  
> This is a pure frontend static page, no build required.

```bash
python3 -m http.server 8080
# 浏览器打开 Browser to http://localhost:8080
```

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

1. 复制 `public/local.config.example.js` 为 `public/local.config.js`  
   Copy `public/local.config.example.js` to `public/local.config.js`
2. 在 `local.config.js` 中填写 `DASHSCOPE_KEY`  
   Add your `DASHSCOPE_KEY` in `local.config.js`
3. 刷新页面后，系统会自动把 key 注入到 API Key 输入框（仅本地，`local.config.js` 已被 gitignore）  
   After refreshing, the system will automatically inject the key into the API Key input field (local only, `local.config.js` is gitignored)

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
