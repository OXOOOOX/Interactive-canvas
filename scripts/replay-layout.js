import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testcanvasDir = path.join(projectRoot, 'testcanvas');

const defaultFiles = [
  'canvas-1776695209582.json',
  'canvas-1776701765577.json',
  'canvas-1776668880388.json',
  'canvas-1776671259528.json',
  'canvas-1776612336942.json',
  'canvas-1776577290796.json',
  'canvas-1776661037101.json',
  'canvas-1776612036104.json',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findDuplicateBlockIds(blocks) {
  const seen = new Set();
  const duplicates = new Set();
  for (const block of blocks) {
    if (seen.has(block.id)) duplicates.add(block.id);
    seen.add(block.id);
  }
  return [...duplicates];
}

function overlaps(a, b) {
  const aw = a.width || 200;
  const ah = a.height || 72;
  const bw = b.width || 200;
  const bh = b.height || 72;
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
}

function collectOverlaps(blocks) {
  const pairs = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (overlaps(blocks[i], blocks[j])) {
        pairs.push([blocks[i].label, blocks[j].label]);
      }
    }
  }
  return pairs;
}

function buildParentMaps(blocks, connections) {
  const childIdsByParent = new Map();
  const parentIdsByChild = new Map();
  for (const block of blocks) {
    childIdsByParent.set(block.id, []);
    parentIdsByChild.set(block.id, []);
  }
  for (const conn of connections) {
    if (!childIdsByParent.has(conn.fromId)) childIdsByParent.set(conn.fromId, []);
    if (!parentIdsByChild.has(conn.toId)) parentIdsByChild.set(conn.toId, []);
    childIdsByParent.get(conn.fromId).push(conn.toId);
    parentIdsByChild.get(conn.toId).push(conn.fromId);
  }
  return { childIdsByParent, parentIdsByChild };
}

function getTallLeafRows(blocks, connections) {
  const blockMap = new Map(blocks.map(block => [block.id, block]));
  const { childIdsByParent, parentIdsByChild } = buildParentMaps(blocks, connections);

  const tallBlocks = blocks.filter(block => (block.height || 0) > 500);
  return tallBlocks.map(block => {
    const parentIds = parentIdsByChild.get(block.id) || [];
    const singleParentId = parentIds.length === 1 ? parentIds[0] : null;
    const siblingBlocks = singleParentId
      ? (childIdsByParent.get(singleParentId) || [])
          .map(id => blockMap.get(id))
          .filter(Boolean)
      : [];

    const rowMap = new Map();
    for (const sibling of siblingBlocks) {
      const rowKey = Math.round(sibling.y || 0);
      if (!rowMap.has(rowKey)) rowMap.set(rowKey, []);
      rowMap.get(rowKey).push({
        label: sibling.label,
        height: sibling.height || 72,
        x: Math.round(sibling.x || 0),
      });
    }

    const rows = [...rowMap.entries()].sort((a, b) => a[0] - b[0]).map(([y, items]) => ({
      y,
      count: items.length,
      maxHeight: Math.max(...items.map(item => item.height)),
      labels: items.map(item => item.label),
    }));

    return {
      label: block.label,
      id: block.id,
      parentId: singleParentId,
      position: { x: Math.round(block.x || 0), y: Math.round(block.y || 0) },
      height: block.height || 72,
      rows,
    };
  });
}

async function loadLayoutModule() {
  const layoutPath = path.join(projectRoot, 'src', 'utils', 'layout.js');
  const layoutUrl = `${pathToFileURL(layoutPath).href}?ts=${Date.now()}`;
  return import(layoutUrl);
}

async function replayFile(layout, fileName) {
  const abs = path.join(testcanvasDir, fileName);
  const raw = fs.readFileSync(abs, 'utf8');
  const data = JSON.parse(raw);
  const blocks = clone(data.blocks || []);
  const connections = clone(data.connections || []);
  const groups = clone(data.groups || []);
  const duplicateIds = findDuplicateBlockIds(blocks);

  try {
    layout.autoLayout(blocks, connections, groups);
    const bbox = layout.getBoundingBox(blocks);
    const skipped = duplicateIds.length > 0;
    const overlapPairs = skipped ? [] : collectOverlaps(blocks);
    return {
      file: fileName,
      ok: true,
      skipped,
      duplicateIds,
      bbox: {
        x: Math.round(bbox.x),
        y: Math.round(bbox.y),
        width: Math.round(bbox.width),
        height: Math.round(bbox.height),
      },
      overlapCount: overlapPairs.length,
      overlapPairs: overlapPairs.slice(0, 12),
      tallLeafRows: skipped ? [] : getTallLeafRows(blocks, connections),
    };
  } catch (error) {
    return {
      file: fileName,
      ok: false,
      duplicateIds,
      error: error.stack || String(error),
    };
  }
}

async function main() {
  const layout = await loadLayoutModule();
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : defaultFiles;
  const results = [];

  for (const fileName of files) {
    results.push(await replayFile(layout, fileName));
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
