import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const origin = 'http://127.0.0.1:8080';
const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000) });
assert.equal(health.status, 200);
assert.match(health.headers.get('content-type') || '', /application\/json/);
assert.equal((await health.json()).ok, true);
const response = await fetch(origin, { signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type') || '', /text\/html/);
const html = await response.text();
assert.equal(html, await readFile('/app/dist/index.html', 'utf8'));
const paths = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]));
assert([...paths].some(path => path.endsWith('.js')));
paths.add('/vad/vad.worklet.bundle.min.js');
paths.add('/vad/silero_vad_legacy.onnx');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const path of paths) {
  assert(!path.includes('..'));
  const asset = await fetch(origin + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(asset.status, 200);
  const actual = Buffer.from(await asset.arrayBuffer());
  assert.equal(digest(actual), digest(await readFile('/app/dist' + path)), 'Served asset differs from built file');
}
// This deliberately invalid payload is rejected before any upstream request.
const invalidTts = await fetch(origin + '/api/doubao-tts', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  signal: AbortSignal.timeout(10000),
});
assert.equal(invalidTts.status, 400);
assert.match(invalidTts.headers.get('content-type') || '', /application\/json/);
console.log(JSON.stringify({ health: true, html: true, matchingAssets: paths.size, backendValidation: true }));
