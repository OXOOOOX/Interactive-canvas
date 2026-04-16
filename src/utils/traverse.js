/**
 * traverse.js — 树遍历工具
 */

/** 扁平化遍历所有节点，返回 { node, parent, index, depth } 数组 */
export function traverse(nodes, parent = null, depth = 0, acc = []) {
  nodes.forEach((node, index) => {
    acc.push({ node, parent, index, depth });
    if (Array.isArray(node.children) && node.children.length) {
      traverse(node.children, node, depth + 1, acc);
    }
  });
  return acc;
}

/** 根据 id 查找节点及其上下文 */
export function findNodeById(nodes, id) {
  return traverse(nodes).find(({ node }) => node.id === id) || null;
}

/** 确保每个节点都有完整字段 */
export function ensureNodeFields(node, idx = 0) {
  if (!node.id) node.id = crypto.randomUUID();
  if (typeof node.label !== 'string') node.label = '未命名';
  if (typeof node.content !== 'string') node.content = '';
  if (typeof node.type !== 'string') node.type = 'text';
  if (typeof node.x !== 'number') node.x = 200 + (idx % 4) * 280;
  if (typeof node.y !== 'number') node.y = 100 + Math.floor(idx / 4) * 160;
  if (!Array.isArray(node.children)) node.children = [];
  node.children.forEach((child, i) => ensureNodeFields(child, i));
  return node;
}
