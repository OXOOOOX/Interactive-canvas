import test from 'node:test';
import assert from 'node:assert/strict';

import { autoLayout } from '../src/utils/layout.js';

test('autoLayout preserves locked block geometry', () => {
  const blocks = [
    { id: 'root', label: 'Root', x: 20, y: 20, width: 220, height: 80 },
    { id: 'locked-child', label: 'Locked child', x: 777, y: 333, width: 260, height: 140, locked: true },
    { id: 'free-child-a', label: 'Free child A', x: 10, y: 10, width: 200, height: 72 },
    { id: 'free-child-b', label: 'Free child B', x: 10, y: 10, width: 200, height: 72 },
  ];
  const connections = [
    { fromId: 'root', toId: 'locked-child' },
    { fromId: 'root', toId: 'free-child-a' },
    { fromId: 'root', toId: 'free-child-b' },
  ];

  autoLayout(blocks, connections, []);

  const locked = blocks.find(block => block.id === 'locked-child');
  assert.equal(locked.x, 777);
  assert.equal(locked.y, 333);
  assert.equal(locked.width, 260);
  assert.equal(locked.height, 140);
});

test('autoLayout preserves positionLocked block geometry', () => {
  const blocks = [
    { id: 'root', label: 'Root', x: 0, y: 0, width: 200, height: 72 },
    { id: 'pinned', label: 'Pinned', x: 640, y: 480, width: 240, height: 120, positionLocked: true },
    { id: 'free-a', label: 'Free A', x: 0, y: 0, width: 200, height: 72 },
    { id: 'free-b', label: 'Free B', x: 0, y: 0, width: 200, height: 72 },
  ];
  const connections = [
    { fromId: 'root', toId: 'pinned' },
    { fromId: 'root', toId: 'free-a' },
    { fromId: 'root', toId: 'free-b' },
  ];

  autoLayout(blocks, connections, []);

  const pinned = blocks.find(block => block.id === 'pinned');
  assert.equal(pinned.x, 640);
  assert.equal(pinned.y, 480);
  assert.equal(pinned.width, 240);
  assert.equal(pinned.height, 120);
});
