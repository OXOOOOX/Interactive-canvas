# Interactive-canvas

一个可直接打开运行的前端 Demo：

- 🎤 语音录音 -> STT 转写 -> 发送到大模型 -> 返回思维导图 JSON。
- 🧩 **交互式块画布（Canvas）**：每个节点是可拖拽块，连线会实时跟随。
- ✍️ 双击可编辑节点标题、导图标题、附注。
- ➕ 支持对选中块新增子块/同级块、删除块。
- 🔌 可切换通义千问 / 豆包 / 自定义 API（LLM、STT、TTS 分离配置）。
- 🔐 提供 OAuth 配置位（支持 CODEX / antigravity / 自定义）与 code 换 token 示例流程。

## 快速开始

> 这是纯前端静态页面，不需要构建。

```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 页面能力

1. **配置区**
   - 选择 LLM、STT、TTS 供应商。
   - 填写 API Key 与各自 Endpoint。
   - 配置 OAuth 参数（可选），执行授权与 code 换 token。
   - 支持保存/加载 localStorage 配置。

2. **语音与聊天区**
   - 开始/停止录音。
   - 自动上传音频到 STT endpoint 获取文本。
   - 文本送入 LLM endpoint，请求生成导图 JSON。
   - 日志区展示 system / user / assistant / error 事件。

3. **Canvas 画布区**
   - 节点以 block 形式渲染，可拖拽重排。
   - 连线为 SVG 曲线，拖拽时实时更新。
   - 支持新增子块、同级块、删除块。

模型建议输出结构：

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
  "notes": ["附注1"]
}
```


## 本地测试 API Key（推荐做法）

你提到要先用阿里云 DashScope key 做测试。为了避免把密钥提交到 Git：

1. 复制 `local.config.example.js` 为 `local.config.js`。
2. 在 `local.config.js` 中填写 `DASHSCOPE_KEY`。
3. 刷新页面后，系统会自动把 key 注入到 API Key 输入框（仅本地，`local.config.js` 已被 gitignore）。

## API 对接建议

当前代码将 endpoint 和 bearer token 直接在浏览器请求（便于快速验证）。
正式环境建议：

- 在服务端做代理，隐藏 API Key。
- 服务端统一适配各供应商返回格式（通义/豆包字段差异）。
- 做请求签名、限流、审计日志与错误映射。

## 文件说明

- `index.html`: 页面结构与交互控件。
- `styles.css`: 样式。
- `app.js`: 主要逻辑（录音、STT/LLM/TTS、Canvas 拖拽块、OAuth、配置存储）。
