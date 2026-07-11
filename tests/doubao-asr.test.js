import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDoubaoTranscriptUpdate,
  normalizeDoubaoTranscriptUpdate,
} from '../src/services/doubao-asr.js';

test('Doubao result text replaces progressive correction snapshots', () => {
  const snapshots = [
    '我，我不想要',
    '我不想要经停的转机的',
    '我不想要经停的转机的，就是我想要快点到日本',
  ];

  const finalText = snapshots.reduce((current, text, index) => {
    const update = normalizeDoubaoTranscriptUpdate(
      { result: { text } },
      { sessionId: 7, sequence: index + 1 },
    );
    assert.equal(update.updateMode, 'replace');
    return applyDoubaoTranscriptUpdate(current, update);
  }, '');

  assert.equal(finalText, snapshots.at(-1));
});

test('shorter corrections and punctuation changes remain authoritative', () => {
  const first = normalizeDoubaoTranscriptUpdate({ result: { text: '我，我想去日本。' } });
  const corrected = normalizeDoubaoTranscriptUpdate({ result: { text: '我想去日本' } });
  const result = applyDoubaoTranscriptUpdate(applyDoubaoTranscriptUpdate('', first), corrected);
  assert.equal(result, '我想去日本');
});

test('an empty full snapshot clears an earlier recognition', () => {
  const first = normalizeDoubaoTranscriptUpdate({ result: { text: '误识别内容' } });
  const cleared = normalizeDoubaoTranscriptUpdate({ result: { text: '' } });
  assert.equal(cleared.updateMode, 'replace');
  assert.equal(applyDoubaoTranscriptUpdate(applyDoubaoTranscriptUpdate('', first), cleared), '');
});

test('middle words, punctuation, and numbers can all be corrected by a snapshot', () => {
  const first = normalizeDoubaoTranscriptUpdate({ result: { text: '订三张，下午两点。' } });
  const corrected = normalizeDoubaoTranscriptUpdate({ result: { text: '订两张，下午三点半。' } });
  assert.equal(
    applyDoubaoTranscriptUpdate(applyDoubaoTranscriptUpdate('', first), corrected),
    '订两张，下午三点半。',
  );
});

test('legitimate repeated words are preserved in snapshots', () => {
  const update = normalizeDoubaoTranscriptUpdate({ result: { text: '看看看看有没有合适的航班' } });
  assert.equal(applyDoubaoTranscriptUpdate('', update), '看看看看有没有合适的航班');
});

test('explicit delta updates append with exact boundary overlap only', () => {
  const first = normalizeDoubaoTranscriptUpdate({ result: { text: '今天天气' } });
  const delta = normalizeDoubaoTranscriptUpdate({ result: { delta: '天气怎么样' } });
  assert.equal(delta.updateMode, 'append');
  assert.equal(
    applyDoubaoTranscriptUpdate(applyDoubaoTranscriptUpdate('', first), delta),
    '今天天气怎么样',
  );
});

test('utterances are sorted and rebuilt as one replacement snapshot', () => {
  const update = normalizeDoubaoTranscriptUpdate({
    result: {
      utterances: [
        { start_time: 900, text: '快点到日本', final: false },
        { start_time: 100, text: '我不想要转机，', definite: true },
      ],
    },
  });
  assert.deepEqual(
    { text: update.text, updateMode: update.updateMode, final: update.final },
    { text: '我不想要转机，快点到日本', updateMode: 'replace', final: false },
  );
});

test('result text wins when utterances are present in the same payload', () => {
  const update = normalizeDoubaoTranscriptUpdate({
    result: {
      text: '权威整句',
      utterances: [{ start_time: 0, text: '不应使用', definite: true }],
    },
  });
  assert.equal(update.text, '权威整句');
});
