export function isEmptyGlobalMemorySuggestion(value) {
  if (typeof value !== 'string') return true;

  const stripped = value
    .trim()
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[([{（【]+|[)\]}）】]+$/g, '')
    .trim();

  if (!stripped) return true;

  const normalized = stripped.replace(/[。.!！?？\s]/g, '').toLowerCase();
  return [
    'empty',
    'none',
    'null',
    'nil',
    'n/a',
    'na',
    'no',
    '无',
    '无更新',
    '不更新',
    '无需更新',
    '没有更新',
    '没有记忆',
    '无记忆',
    '空',
    '空字符串',
  ].includes(normalized);
}
