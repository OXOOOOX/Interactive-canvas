export const AGENT_RESEARCH_DEMO_PROMPT = `请使用多智能体研究团队，对“2026 年个人 AI 工作站的发展趋势”进行一次可追溯研究。

要求：
1. 资料研究智能体搜索并筛选近期来源，记录来源平台与关键证据。
2. 白板分析智能体读取当前白板，围绕硬件、模型与工具链、典型用户、风险四个维度补充内容。
3. 质疑校验智能体检查时间、数据、推断和来源可靠性，明确哪些结论仍需验证。
4. 综合智能体输出简明研究结论，并把重要结论、证据和待验证项更新到白板。

请区分“来源支持的事实”“分析判断”和“后续待验证事项”，不要编造没有检索到的信息。`;

export function createAgentResearchDemoCanvas(randomId = () => crypto.randomUUID()) {
  const rootId = randomId();
  const hardwareId = randomId();
  const stackId = randomId();
  const audienceId = randomId();
  const riskId = randomId();
  const evidenceId = randomId();

  return {
    title: '智能体研究：个人 AI 工作站',
    memory: `## 研究目标
形成一份有来源、可质疑、可继续编辑的 2026 年个人 AI 工作站趋势简报。

## 输出规则
- 事实必须能够回到搜索来源
- 推断与事实分开
- 不确定信息进入“待验证”`,
    blocks: [
      { id: rootId, type: 'text', label: '个人 AI 工作站研究', content: '**研究问题**\n\n2026 年个人 AI 工作站会如何发展，哪些用户和场景最先受益？', x: 430, y: 60, width: 300 },
      { id: hardwareId, type: 'text', label: '硬件与本地算力', content: '- NPU / GPU / 统一内存\n- 本地推理性能\n- 功耗与价格', x: 80, y: 250, width: 240 },
      { id: stackId, type: 'text', label: '模型与工具链', content: '- 小型本地模型\n- 云端协同\n- Agent 与开发工具', x: 350, y: 250, width: 240 },
      { id: audienceId, type: 'text', label: '典型用户与场景', content: '- 开发者与研究者\n- 内容创作者\n- 隐私敏感组织', x: 620, y: 250, width: 240 },
      { id: riskId, type: 'text', label: '风险与待验证', content: '- 产品发布时间\n- 厂商宣传与实测差异\n- 成本、兼容性和数据安全', x: 890, y: 250, width: 250 },
      { id: evidenceId, type: 'text', label: '证据标准', content: '**优先级**\n\n1. 官方产品与技术文档\n2. 可信测试与研究报告\n3. 新闻与行业分析\n\n每条结论保留来源。', x: 430, y: 470, width: 300 },
    ],
    connections: [
      { id: randomId(), fromId: rootId, toId: hardwareId },
      { id: randomId(), fromId: rootId, toId: stackId },
      { id: randomId(), fromId: rootId, toId: audienceId },
      { id: randomId(), fromId: rootId, toId: riskId },
      { id: randomId(), fromId: rootId, toId: evidenceId },
    ],
    groups: [],
    linkRoutingMode: 'auto',
    sessions: [],
    activeSessionId: '',
  };
}
