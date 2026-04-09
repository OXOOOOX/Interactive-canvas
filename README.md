# Interactive-canvas

一个可直接打开运行的前端 Demo：

- 🎤 语音录音 -> STT 转写 -> 发送到大模型 -> 返回思维导图 JSON。
- 🧠 动态渲染思维导图（树形）+ 附注列表。
- ✍️ 双击可编辑节点标题、导图标题、附注。
- 🔌 可切换通义千问 / 豆包 / 自定义 API（LLM、STT、TTS 分离配置）。
- 🔐 提供 OAuth 配置位（支持 CODEX / antigravity / 自定义）与 code 换 token 示例流程。

## 快速开始

> 这是纯前端静态页面，不需要构建。

```bash
# 在项目根目录直接启动一个静态服务
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

3. **思维导图区**
   - 期望模型输出结构：

```json
{
  "title": "主题",
  "nodes": [
    {
      "id": "uuid",
      "label": "一级节点",
      "children": []
    }
  ],
  "notes": ["附注1"]
}
```

## API 对接建议

当前代码将 endpoint 和 bearer token 直接在浏览器请求（便于快速验证）。
正式环境建议：

- 在服务端做代理，隐藏 API Key。
- 服务端统一适配各供应商返回格式（通义/豆包字段差异）。
- 做请求签名、限流、审计日志与错误映射。

## 文件说明

- `index.html`: 页面结构与交互控件。
- `styles.css`: 样式。
- `app.js`: 主要逻辑（录音、STT/LLM/TTS、导图渲染、OAuth、配置存储）。
