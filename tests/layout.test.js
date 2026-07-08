import test from 'node:test';
import assert from 'node:assert/strict';

import { autoLayout, compactLayout } from '../src/utils/layout.js';

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

test('compactLayout arranges a linear chain into alternating bands', () => {
  const blocks = Array.from({ length: 10 }, (_, index) => ({
    id: `n${index}`,
    label: `Node ${index}`,
    x: 0,
    y: 0,
    width: 220,
    height: 80,
  }));
  const connections = blocks.slice(1).map((block, index) => ({
    fromId: blocks[index].id,
    toId: block.id,
  }));

  compactLayout(blocks, connections, []);

  const ys = blocks.map(block => block.y);
  const distinctRows = new Set(ys.map(y => Math.round(y / 10) * 10));
  assert.ok(distinctRows.size >= 2, 'expected nodes to use multiple vertical bands');
  assert.notEqual(blocks[0].y, blocks[1].y, 'expected adjacent chain nodes to alternate vertically');

  const minX = Math.min(...blocks.map(block => block.x));
  const maxX = Math.max(...blocks.map(block => block.x + block.width));
  const minY = Math.min(...blocks.map(block => block.y));
  const maxY = Math.max(...blocks.map(block => block.y + block.height));
  const ratio = (maxX - minX) / (maxY - minY);
  assert.ok(ratio > 1.1 && ratio < 4.5, `expected compact rectangle ratio, got ${ratio}`);
});

test('compactLayout packs a star-shaped planning canvas into a readable rectangle', () => {
  const root = { id: 'root', label: 'Trip', x: 1000, y: 1000, width: 200, height: 120 };
  const children = Array.from({ length: 9 }, (_, index) => ({
    id: `topic-${index}`,
    label: `Topic ${index}`,
    x: 2000 + index * 20,
    y: 2000 + index * 20,
    width: index % 3 === 0 ? 580 : 460,
    height: index % 2 === 0 ? 230 : 140,
  }));
  const blocks = [root, ...children];
  const connections = children.map(child => ({ fromId: 'root', toId: child.id }));

  compactLayout(blocks, connections, []);

  const minX = Math.min(...blocks.map(block => block.x));
  const maxX = Math.max(...blocks.map(block => block.x + block.width));
  const minY = Math.min(...blocks.map(block => block.y));
  const maxY = Math.max(...blocks.map(block => block.y + block.height));
  const ratio = (maxX - minX) / (maxY - minY);
  const columnCenters = [...children]
    .map(block => block.x + block.width / 2)
    .sort((a, b) => a - b)
    .reduce((groups, center) => {
      const last = groups[groups.length - 1];
      if (!last || Math.abs(last[last.length - 1] - center) > 180) groups.push([center]);
      else last.push(center);
      return groups;
    }, []);

  assert.ok(ratio > 1.15 && ratio < 1.9, `expected screen-friendly rectangle ratio, got ${ratio}`);
  assert.ok(columnCenters.length <= 3, 'expected star children to pack into a small number of columns');
  assert.ok(root.x < Math.min(...children.map(block => block.x)), 'expected root to remain left of topic columns');
});

test('compactLayout leaves a rail lane when comb routing is forced', () => {
  const root = { id: 'root', label: 'Trip', x: 1000, y: 1000, width: 220, height: 100 };
  const children = Array.from({ length: 6 }, (_, index) => ({
    id: `topic-${index}`,
    label: `Topic ${index}`,
    x: 2000,
    y: 2000,
    width: 360,
    height: 130,
  }));
  const blocks = [root, ...children];
  const connections = children.map(child => ({ fromId: 'root', toId: child.id }));

  compactLayout(blocks, connections, [], { routingMode: 'comb' });

  const rootBottom = root.y + root.height;
  const firstChildY = Math.min(...children.map(block => block.y));
  assert.ok(
    firstChildY - rootBottom >= 150,
    `expected space for comb rail between root and children, got ${firstChildY - rootBottom}`
  );
});
