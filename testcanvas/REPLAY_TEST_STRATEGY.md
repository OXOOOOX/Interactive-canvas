# 布局问题的模拟 / 回放测试策略

这份文档总结了我在这个项目里排查布局、连线、尺寸同步问题时常用的“模拟 / 回放”测试方法。目标不是做正式测试框架，而是**快速、稳定地复现用户给出的坏样例**，并在改动后做回归确认。

---

## 1. 什么时候用回放测试

适合以下场景：

- 用户给了一个具体画布 JSON，例如 `canvas-1776671259528.json`
- 某次布局回归只在特定结构下出现
- UI 上肉眼可见问题，但根因在 `src/utils/layout.js` 等纯计算逻辑里
- 改动容易牵一发而动全身，需要快速验证多个历史样例

不适合的场景：

- 纯 DOM / CSS 交互问题，必须在浏览器里看
- 依赖用户实时操作节奏的问题，例如拖拽中间态

---

## 2. 核心思路

把 `testcanvas/*.json` 当成**固定输入样本**，把布局函数当成**纯计算器**来回放：

1. 读取某个画布 JSON
2. 深拷贝 `blocks / connections / groups`
3. 在 Node 脚本里直接 `import` 布局模块
4. 调用 `autoLayout(...)`
5. 打印关键块坐标、边界框、重叠情况
6. 改代码后重复运行同一批样本，比较结果是否变好、是否回退

这样做的优点是：

- 快：不需要每次都手动打开页面操作
- 稳：输入固定，结果可复现
- 准：适合盯住某几个块的位置变化
- 便于回归：可以一次跑多个历史坏样例

---

## 3. 基本回放模板

最常用的是直接在命令行里跑一个临时 Node 脚本：

```bash
node - <<'EOF'
const fs = require('fs');
(async () => {
  const mod = await import('file:///C:/Users/23479/Documents/GitHub/Interactive-canvas/src/utils/layout.js?ts=' + Date.now());
  const data = JSON.parse(fs.readFileSync('C:/Users/23479/Documents/GitHub/Interactive-canvas/testcanvas/canvas-1776671259528.json', 'utf8'));
  const blocks = JSON.parse(JSON.stringify(data.blocks));
  const connections = JSON.parse(JSON.stringify(data.connections));
  mod.autoLayout(blocks, connections, data.groups || []);
  console.log(JSON.stringify(blocks.map(b => ({
    label: b.label,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  })), null, 2));
})();
EOF
```

几点说明：

- `?ts=${Date.now()}` 是为了避免 ESM import 缓存，确保拿到最新代码
- 要先深拷贝 `blocks / connections`，避免污染原始样本
- 输出里优先打印 `label / x / y / width / height`，方便人工对照

---

## 4. 我通常会看的指标

### 4.1 关键块坐标

最直接的方法：只盯用户关心的几个块。

例如：

- `Order Processing` 是否被异常拖到很右边
- `新同级块1 / 新子块1 / 新子块2` 是否仍保持竖直对齐
- 孤立 root 是否还插在主树中间

可以打印全部块，也可以只筛选一部分：

```js
const focus = new Set(['Order Processing', '新同级块1', '新子块1', '新子块2']);
console.log(blocks.filter(b => focus.has(b.label)).map(b => ({
  label: b.label,
  x: b.x,
  y: b.y,
})));
```

### 4.2 整体边界框

用于判断这次修改有没有把画布拉得过宽或过高：

```js
const bbox = mod.getBoundingBox(blocks);
console.log(bbox);
```

常看：

- `width` 是否突然变得很大
- `height` 是否被多 root 方案拉得很长

### 4.3 重叠情况

如果改动可能影响碰撞处理，就要检查是否重新引入块重叠。

常见做法：遍历所有 block 两两比较 AABB：

```js
function overlaps(a, b) {
  return a.x < b.x + (b.width || 200)
    && a.x + (a.width || 200) > b.x
    && a.y < b.y + (b.height || 72)
    && a.y + (a.height || 72) > b.y;
}
```

然后统计 overlap 数量或打印具体冲突对。

---

## 5. 常用的回归样例分工

目前我会把这些样例当成一组最小回归集：

- `canvas-1776671259528.json`
  - 多 root / 孤立 root 场景
  - 看第二个顶级块是否横插主树

- `canvas-1776668880388.json`
  - 链式对齐场景
  - 看 `新同级块1 -> 新子块1 -> 新子块2` 是否一条线
  - 看 `Order Processing` 是否重新右移

- `canvas-1776612336942.json`
  - 复杂业务图
  - 用于防止改动后重新出现重叠

- `canvas-1776577290796.json`
  - 较复杂综合场景
  - 用于看整体布局是否明显回退

- `canvas-1776661037101.json`
  - duplicate-id 场景
  - 用于确认 `validateLayoutInput()` 仍然安全跳过

---

## 6. 一次跑多个样例

当改动容易影响全局时，我通常会批量回放：

```bash
node - <<'EOF'
const fs = require('fs');
const path = require('path');
(async () => {
  const mod = await import('file:///C:/Users/23479/Documents/GitHub/Interactive-canvas/src/utils/layout.js?ts=' + Date.now());
  const files = [
    'testcanvas/canvas-1776671259528.json',
    'testcanvas/canvas-1776668880388.json',
    'testcanvas/canvas-1776612336942.json',
    'testcanvas/canvas-1776577290796.json',
    'testcanvas/canvas-1776661037101.json'
  ];

  for (const rel of files) {
    const abs = path.join('C:/Users/23479/Documents/GitHub/Interactive-canvas', rel);
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const blocks = JSON.parse(JSON.stringify(data.blocks));
    const connections = JSON.parse(JSON.stringify(data.connections));

    try {
      mod.autoLayout(blocks, connections, data.groups || []);
      const bbox = mod.getBoundingBox(blocks);
      console.log('FILE', rel, JSON.stringify(bbox));
    } catch (err) {
      console.log('FILE', rel, 'ERROR', err.stack || String(err));
    }
  }
})();
EOF
```

这一步主要是看：

- 有没有脚本直接跑挂
- 有没有某个样例 bbox 明显异常
- duplicate-id 是否仍然被安全跳过

---

## 7. 和浏览器手测的分工

回放测试解决的是：

- 计算逻辑是否正确
- 回归样例是否稳定
- 块坐标 / 尺寸 / 边界框是否符合预期

浏览器手测补的是：

- 真实视觉效果是否自然
- 连线是否看起来顺
- hover / ctrl / 剪刀按钮等交互是否正常
- 改完后是否还有“看起来不对但坐标没错”的情况

最稳妥的流程通常是：

1. 先用回放脚本锁定计算问题
2. 修代码
3. 再跑整组回归样例
4. 最后在浏览器里看用户报的问题场景

---

## 8. 最后一定要做的事

### 8.1 跑构建

```bash
npm run build
```

作用：

- 确认没有语法错误
- 确认 import / export 没写坏
- 顺手暴露 CSS / JS 构建 warning

### 8.2 不直接改样例文件

`testcanvas/*.json` 应该被当成**只读基准输入**。

原则上：

- 不覆盖原样例
- 不把回放结果写回原文件
- 所有分析都基于内存里的深拷贝完成

这样样例才能长期稳定地做回归基准。

---

## 9. 实战判断规则

我实际排查时，通常按下面顺序判断：

1. **先确认能否稳定复现**
   - 没法稳定复现，就先别急着改

2. **先盯关键块，不先看全图**
   - 先看用户点名的块是否真的错位

3. **修完先跑原样例，再跑历史样例**
   - 防止“修了 A，坏了 B”

4. **看到 bbox 变大，不一定是 bug；要结合用户目标判断**
   - 有时更宽换来更清晰，是可接受的
   - 有时只是孤立 root 横插进中轴，那就不对

5. **坐标正确不等于视觉正确**
   - 回放通过后，仍要去浏览器里看最终效果

---

## 10. 一句话总结

这套方法的本质是：

> 用 `testcanvas` 里的 JSON 当固定输入，用 `autoLayout()` 当纯函数回放器，用关键块坐标、bbox、重叠数和批量回归来验证修改是否真的解决问题且没有带出新回退。
