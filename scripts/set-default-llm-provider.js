import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const DEFAULT_PROVIDER = 'deepseekV4Pro';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

function read(filePath) {
  return fs.readFileSync(path.join(rootDir, filePath), 'utf8');
}

function write(filePath, content) {
  fs.writeFileSync(path.join(rootDir, filePath), content);
}

function replaceAll(text, search, replacement) {
  return text.split(search).join(replacement);
}

function patchFile(filePath, replacements) {
  const absolutePath = path.join(rootDir, filePath);
  if (!fs.existsSync(absolutePath)) return;

  let content = read(filePath);
  const original = content;

  for (const [search, replacement] of replacements) {
    if (content.includes(search)) {
      content = replaceAll(content, search, replacement);
    }
  }

  if (content !== original) {
    write(filePath, content);
    console.log(`[default-llm] patched ${filePath}`);
  }
}

patchFile('index.html', [
  ['<option value="tongyi" selected>通义千问</option>', '<option value="tongyi">通义千问</option>'],
  ['<option value="deepseekV4Pro">DeepSeek V4 Pro</option>', '<option value="deepseekV4Pro" selected>DeepSeek V4 Pro</option>'],
]);

patchFile('src/main.js', [
  ["let lastLlmProvider = 'tongyi';", `let lastLlmProvider = '${DEFAULT_PROVIDER}';`],
  ["const provider = config.llmProvider || dom.llmProvider?.value || 'tongyi';", `const provider = config.llmProvider || dom.llmProvider?.value || '${DEFAULT_PROVIDER}';`],
  ["const merged = {\n    voiceMode: 'doubao-pipeline',", `const merged = {\n    llmProvider: '${DEFAULT_PROVIDER}',\n    llmEndpoint: ENDPOINT_PRESETS.${DEFAULT_PROVIDER}?.llm || '${DEFAULT_ENDPOINT}',\n    llmModel: ENDPOINT_PRESETS.${DEFAULT_PROVIDER}?.llmModel || '${DEFAULT_MODEL}',\n    voiceMode: 'doubao-pipeline',`],
  ["config.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm", `config.llmEndpoint || ENDPOINT_PRESETS.${DEFAULT_PROVIDER}.llm`],
  ["model: config.llmModel || 'qwen-plus',", `model: config.llmModel || ENDPOINT_PRESETS.${DEFAULT_PROVIDER}.llmModel || '${DEFAULT_MODEL}',`],
]);

patchFile('src/state.js', [
  ["const endpoint = config?.llmEndpoint || ENDPOINT_PRESETS.tongyi.llm;", `const endpoint = config?.llmEndpoint || ENDPOINT_PRESETS.${DEFAULT_PROVIDER}.llm;`],
  ["const model = config?.llmModel || 'qwen-plus';", `const model = config?.llmModel || ENDPOINT_PRESETS.${DEFAULT_PROVIDER}.llmModel || '${DEFAULT_MODEL}';`],
]);

patchFile('src/services/llm.js', [
  ["return DEFAULT_LLM_MODELS[config.llmProvider] || 'qwen-max-latest';", `return DEFAULT_LLM_MODELS[config.llmProvider] || DEFAULT_LLM_MODELS.${DEFAULT_PROVIDER};`],
]);

patchFile('server/index.js', [
  ["const provider = config.llmProvider || process.env.LLM_PROVIDER || 'tongyi';", `const provider = config.llmProvider || process.env.LLM_PROVIDER || '${DEFAULT_PROVIDER}';`],
  ["DEFAULT_MODELS[provider] || DEFAULT_MODELS.tongyi;", `DEFAULT_MODELS[provider] || DEFAULT_MODELS.${DEFAULT_PROVIDER};`],
]);

patchFile('.env.example', [
  ['# For Volcengine Ark / Doubao, LLM_MODEL should be a model ID enabled in your Ark account.\n# Some Ark accounts use endpoint-style IDs such as ep-xxxxxxxx; others use model IDs.\nLLM_PROVIDER=doubao\nLLM_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/chat/completions\nLLM_MODEL=your-enabled-doubao-model-or-endpoint-id\nLLM_API_KEY=your-volcengine-ark-api-key', `# DeepSeek default LLM fallback. User-provided keys in Settings take priority.\nLLM_PROVIDER=${DEFAULT_PROVIDER}\nLLM_ENDPOINT=${DEFAULT_ENDPOINT}\nLLM_MODEL=${DEFAULT_MODEL}\nLLM_API_KEY=your-deepseek-api-key`],
]);

patchFile('README.md', [
  ['# For Volcengine Ark / Doubao, LLM_MODEL should be a model ID enabled in your Ark account.\n# Some Ark accounts use endpoint-style IDs such as ep-xxxxxxxx; others use model IDs.\nLLM_PROVIDER=doubao\nLLM_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/chat/completions\nLLM_MODEL=your-enabled-doubao-model-or-endpoint-id\nLLM_API_KEY=your-volcengine-ark-api-key', `# DeepSeek default LLM fallback. User-provided keys in Settings take priority.\nLLM_PROVIDER=${DEFAULT_PROVIDER}\nLLM_ENDPOINT=${DEFAULT_ENDPOINT}\nLLM_MODEL=${DEFAULT_MODEL}\nLLM_API_KEY=your-deepseek-api-key`],
]);
