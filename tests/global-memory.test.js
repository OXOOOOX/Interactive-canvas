import test from 'node:test';
import assert from 'node:assert/strict';

import { isEmptyGlobalMemorySuggestion } from '../src/utils/memory.js';

test('isEmptyGlobalMemorySuggestion treats model empty placeholders as empty', () => {
  for (const value of [
    '',
    '   ',
    'empty',
    'EMPTY.',
    '(empty)',
    '"empty"',
    '```text\nempty\n```',
    'none',
    'null',
    '无',
    '无更新',
    '没有记忆',
    '空字符串',
  ]) {
    assert.equal(isEmptyGlobalMemorySuggestion(value), true, value);
  }
});

test('isEmptyGlobalMemorySuggestion keeps real memory content', () => {
  assert.equal(isEmptyGlobalMemorySuggestion('用户偏好：用中文简洁回答。'), false);
  assert.equal(isEmptyGlobalMemorySuggestion('- Prefer concise answers in Chinese.'), false);
});
