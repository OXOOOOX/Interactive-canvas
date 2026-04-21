# 自动排布规则详解

这份文档描述当前自动排布链路里**真实生效**的规则，主要来自 `src/utils/layout.js`，也包含自动排布前在 `src/canvas.js` 中发生的尺寸自适应。内容包含：
- duplicate-id 安全跳过
- 自动排布前的块尺寸自适应
- 多 root / 孤立 root 处理
- 骨架分层布局
- 叶子矩阵填充
- 同带避让 / 残余碰撞处理
- 链式对齐修正
- tall leaf / 尺寸离群块保留策略

---

## 一、总流程

自动排布入口：`src/utils/layout.js:autoLayout()`

除了 `autoLayout()` 内部流程，UI 入口在真正重排前还会先执行：

```text
renderBlocks()
  ↓
syncBlockSizes({ adaptForAutoLayout: true })   // 按真实 DOM 内容重测并在需要时适度加宽
  ↓
autoLayout(...)
```

因此当前排布策略分成两层：
1. **排布前尺寸自适应**：先让明显“窄而高”的文本块变得更接近可读比例
2. **layout.js 主布局**：再进行骨架布局、叶子矩阵安置与碰撞修正

整体流程可以概括为：

```text
输入 blocks / connections / groups
  ↓
validateLayoutInput()                     // duplicate-id 防护
  ↓
classifyRootComponents()                  // 识别主树 vs 孤立 root 卡片
  ↓
layoutSingleComponent(mainBlocks)         // 主树两段式布局
  ├─ normalizeExtremePortraitBlocks()     // 极端竖向块兜底修正
  ├─ identifyLeafClusters()               // 识别叶子聚类
  ├─ assignLayers() / barycentricSort()   // 骨架分层与排序
  ├─ positionBlocks()                     // 初始落位
  ├─ placeLeafGrids()                     // 叶子矩阵安置
  ├─ resolveGridCollisions()              // 矩阵与骨架碰撞微调
  └─ runStablePass()                      // 稳定化：压缩 / 避让 / 链式对齐
  ↓
packFloatingRootCards()                   // 孤立 root 外侧摆放
  ↓
resolveAllOverlaps()                      // 全局避让
  ↓
alignLinearChains()                       // 最终链式对齐收尾
  ↓
normalizeLayoutBounds()                   // 整体归一化到画布可见区
```

---

## 二、输入安全规则

### 1. duplicate-id 直接跳过

函数：`validateLayoutInput()`

规则：
- 如果检测到重复 block id，自动排布会直接 `return`，不继续执行。
- 这是为了避免布局阶段把同 id 块混在一起，造成更大的坐标污染。

当前行为：
- 不尝试“部分布局”
- 不尝试“自动修复 id”
- 直接保留用户当前数据

适用回归样例：
- `testcanvas/canvas-1776661037101.json`

---

## 三、排布前尺寸自适应规则

函数：`src/canvas.js:syncBlockSizes({ adaptForAutoLayout: true })`

### 1. 触发位置

当前只在“即将自动排布”的入口触发：
- 内容编辑后重排
- 手动点击自动排布
- 新增同级块后重排
- AI 更新块后进入自动排布

普通渲染时的 `syncBlockSizes()` 仍然只做纯测量，不主动改宽。

### 2. 核心目标

当块内文本在当前宽度下被换行撑得过高时，自动排布前会先尝试增加宽度，让块的最终比例更接近 **3:2**，避免形成过多“窄而高”的内容块。

当前关键参数：

```javascript
AUTO_LAYOUT_TARGET_RATIO = 1.5;
AUTO_LAYOUT_RATIO_TOLERANCE = 0.2;
AUTO_LAYOUT_MAX_WIDTH = 640;
AUTO_LAYOUT_WIDTH_STEP = 24;
AUTO_LAYOUT_MIN_HEIGHT_GAIN = 24;
```

### 3. 当前行为

- 只会**增大宽度**，不会自动缩窄
- 会按真实 DOM 内容试探更宽尺寸并重新测量高度
- 只有当高度改善或比例更接近目标时才采纳
- 对 `locked` / `isVirtual` 块不做这一步
- 重排后的第二次 `syncBlockSizes()` 仍保持纯测量，避免每次自动排布都继续膨胀

### 4. 与 layout.js 中极端竖向块修正的关系

`src/utils/layout.js` 里仍保留 `normalizeExtremePortraitBlocks()`：
- 这条规则处理的是**极端**高宽比（`height / width > 5`）
- 属于 layout 内部的兜底修正
- 新增的 `adaptForAutoLayout` 则是更早一层、基于真实 DOM 内容的可读性优化

优先顺序是：
1. 先按真实 DOM 内容做 pre-layout 尺寸适配
2. layout 内再对极端竖向块做兜底修正

---

## 四、多 root 规则

### 1. 主树与孤立 root 的区分

函数：`classifyRootComponents()`

当前实现不是把所有 root 都平均打散重排，而是区分：
- **主树 root / 有连接的 root**：继续走正常骨架布局
- **孤立 root card**：没有父、没有子、单独成块的 root

### 2. 孤立 root 的摆放原则

函数：`packFloatingRootCards()`

规则：
- 孤立 root 不插进主树中轴
- 会被放到主树外侧，避免破坏主阅读流
- 同时尽量保持整体 bbox 不要过宽 / 过长

适用回归样例：
- `testcanvas/canvas-1776671259528.json`

---

## 五、叶子矩阵触发条件

函数：`identifyLeafClusters()`

当一个父节点满足以下条件时，其子节点会进入叶子矩阵逻辑：

| 条件 | 说明 |
|------|------|
| 叶子数量 ≥ 3 | `LEAF_CLUSTER_MIN = 3` |
| 纯叶子节点 | 出度 = 0，没有自己的子节点 |
| 单一父节点 | 当前叶子只有一个父节点 |

也就是说：
- 只有“同一父节点下的纯叶子集合”才会被剥离成 cluster
- 像 `新同级块1 -> 新子块1 -> 新子块2` 这种带后续链条的节点，不算纯叶子，不会进矩阵

---

## 六、叶子矩阵排布规则

### 1. 核心参数

```javascript
GRID_H_GAP = 40;
GRID_V_GAP = 30;
GRID_MAX_COLS = 3;
GRID_PARENT_OFFSET = 40;
LEAF_CLUSTER_MIN = 3;
LEAF_DIMENSION_SIMILARITY_THRESHOLD = 1.2;
TALL_LEAF_HEIGHT_THRESHOLD = 500;
```

### 2. 尺寸相似性分组

这是当前新增的重要规则。

现在不再简单地把“同父级下所有普通叶子”都塞进同一个矩阵，而是：
- 先把 **tall leaf**（原始 tall 或 `height > 500`）拆出去
- 对剩余普通 leaf 按宽高相似性做分桶
- 只有同一桶内块的宽高都满足 **不超过 1.2 倍差异**，才允许进入同一矩阵
- 只有数量达到 `LEAF_CLUSTER_MIN` 的桶，才会生成矩阵 cluster

因此现在的矩阵规则是：
- **尺寸接近的同级块**：仍可组成矩阵
- **尺寸离群块**：不会再被强行塞进同一矩阵
- **超高块**：继续走 tall leaf 特殊逻辑

### 3. 一个父级可以产生多个矩阵簇

当前实现允许同一父节点下出现多个普通矩阵簇：
- 每个簇内部尺寸接近
- 同父级多个簇在 `placeLeafGrids()` 里按顺序分配初始纵向位置
- 后续再交给 `resolveGridCollisions()` 做整体避让

### 4. 排布原则

函数：`placeLeafGrids()`

矩阵放置时会综合考虑：
- 父节点位置
- 整个骨架图的中心线
- 父节点是否还带有非叶子核心子树
- 外侧方向（outer side）
- 同父级下是否存在多个矩阵簇

高层原则：
- 叶子矩阵优先放在父节点**外侧**
- 避免压到核心子树
- 避免把整张图中轴堵死
- 最多 3 列，优先保持可读性
- 同父级多个矩阵簇会先纵向错开，避免初始位置重叠

### 5. tall leaf 保留策略

规则保持不变：
- tall leaf 不进入普通矩阵格子
- 如果只有 tall leaf，会在父节点下方垂直堆叠
- 如果同时有普通矩阵和 tall leaf，tall leaf 会放在矩阵外侧并保持独立纵向堆叠

### 6. 碰撞微调

函数：`resolveGridCollisions()`

规则：
- 把整个 cluster 当作一个整体 bounding box
- 与骨架块做碰撞检测
- 若发生明显碰撞，则整体平移 cluster
- 不逐个打散矩阵内部节点，保持矩阵形态稳定

---

## 七、骨架布局规则

### 1. 骨架定义

在两段式布局里：
- 被剥离成叶子矩阵的块，不参与骨架主排序
- 剩余块构成 skeleton

### 2. 分层与排序

函数链：
- `assignLayers()`
- `insertVirtualNodes()`
- `barycentricSort()`
- `reorderLeavesToOuterSide()`

规则：
- 先按连接关系分层
- 对跨层边插 virtual 节点
- 用 barycenter 降低交叉数
- 再把外侧叶子分支尽量排到更外边

### 3. 初始落位

函数：`positionBlocks()`

规则：
- 按 layer 自上而下排布
- 同层块根据排序结果做横向放置
- 每层放置后立即跑一次横向避让，防止明显同层重叠

---

## 八、稳定化规则

稳定化发生在 `runStablePass()`，这是现在最关键的一层修正。

### 1. 纵向压缩

函数：`compactSkeletonLayersY()`

规则：
- 在不破坏主要层级关系的前提下，尽量压缩层间距
- 但仍保留最小垂直间距 `MIN_V_GAP`
- 若上下块有水平投影重叠，会给出更保守的纵向间隔

### 2. 同带横向避让

函数：`resolveHorizontalOverlaps()`

规则：
- 对同一纵向带里的块做横向分离
- 如果两个块共享父节点，gap 更小
- 如果不共享父节点，gap 会更大，避免视觉缠绕

### 3. 残余骨架碰撞处理

函数：`resolveResidualSkeletonOverlaps()`

规则：
- 对稳定化后仍然相撞的骨架块再做一次清理
- 普通同排冲突优先横向推开
- 但**直接父子链**不再当作同排普通块横向推开，而是优先拉开 y 间距

这条规则解决了：
- 避免 `新同级块1 -> 新子块1` 这种真实链条因为 y 太近，被误判成同排卡片然后向右挤歪

---

## 九、链式对齐规则

函数：`alignLinearChains()`

### 1. 哪些块会尝试做链式对齐

当前规则：
- 当前块恰好有 **1 个父节点**
- 当前块 **最多 1 个子节点**
- 不是 virtual block
- 不是 locked block

注意：
- 这里已经不再要求“父节点只能有这一个子节点”
- 所以像 `结构细化与物料分解 -> Order Processing` 这种“父节点还有别的支路”的场景，也会尝试回中轴

### 2. 对齐目标

目标 x：

```javascript
parent.x + parent.width / 2 - child.width / 2
```

也就是：
- 子块尽量与父块中心线对齐

### 3. 若正中轴被占，用最近可用位

当前规则：
- 先尝试正中轴
- 如果不行，会向左右按步长搜索**最近可用 x**
- 目标是既尽量保持直线感，又避免撞上其他块 / 矩阵块

这条规则解决了：
- `结构细化与物料分解 -> Order Processing` 本该是一条直线却长期偏移

### 4. chain-aware overlap protection

当前在 `resolveHorizontalOverlaps()` 之前，还会构建一份“已接近父节点中轴的链节点”保护集。

作用：
- 这些链节点在同带横向避让里不会轻易被当作普通右侧块继续向右推
- 先尽量移动非链式块
- 降低“前面挤歪、后面又救不回来”的概率

这条规则解决了：
- `新同级块1 -> 新子块1 -> 新子块2` 中间节点被错误推到右边的问题

---

## 十、当前自动排布的实际优先级

把当前实现压缩成一句话，大致是：

> 先用真实 DOM 内容把明显窄高的文本块修到更可读的比例，再做主树布局；纯叶子仍优先矩阵化，但现在只有尺寸接近的块才会进同一矩阵，随后清理碰撞，最后尽量把单父链条重新拉回父节点中心线。

具体优先级可理解为：
1. **数据安全优先**：duplicate-id 直接跳过
2. **可读比例优先**：自动排布前先修正明显窄高的文本块
3. **主阅读流优先**：主树先排，孤立 root 不插中轴
4. **矩阵稳定优先**：纯叶子整体作为 cluster 处理，但只与尺寸接近块成组
5. **不重叠优先**：先清理同带/残余碰撞
6. **链条美观优先**：最后把单父链尽量拉直

---

## 十一、当前新增/保持的关键现象

### 样例：`testcanvas/canvas-1776695209582.json`

当前应保持：
- `螺栓计算与管理` 这种超高块仍按 tall leaf 逻辑处理
- 不会被重新塞回普通矩阵
- 周围普通叶子仍可继续组成矩阵

### 样例：`testcanvas/canvas-1776701765577.json`

当前应保持：
- 钢结构相关子树不会因为矩阵与 tall block 处理被重新挤坏
- 关键连线遮挡问题的回归不应复发

### 尺寸离群 sibling 场景

当前新增：
- 同父级下如果某块宽或高与其他叶子差异超过 1.2 倍，不会再强行进同一矩阵
- 同父级可同时出现“普通矩阵 + tall leaf + 离群块保留”三种并存形态

---

## 十二、推荐回归验证集

建议每次改布局后至少回放：
- `testcanvas/canvas-1776687150705.json`
  - 链式回归样例
- `testcanvas/canvas-1776668880388.json`
  - 旧链式回归样例
- `testcanvas/canvas-1776671259528.json`
  - 多 root / 孤立 root 样例
- `testcanvas/canvas-1776612336942.json`
  - 尺寸差异较大的 leaf 混排样例
- `testcanvas/canvas-1776577290796.json`
  - 综合场景样例
- `testcanvas/canvas-1776695209582.json`
  - tall leaf 保留样例
- `testcanvas/canvas-1776701765577.json`
  - 钢结构/遮挡回归样例
- `testcanvas/canvas-1776661037101.json`
  - duplicate-id 安全跳过样例

并建议结合 `testcanvas/REPLAY_TEST_STRATEGY.md` 中的脚本方式检查：
- 关键块坐标
- bbox
- overlap 数量
- 构建结果 `npm run build`
- 目标样例回放 `npm run replay:layout -- <file...>`

---

## 十三、相关文件

- 核心实现：`src/utils/layout.js`
  - `validateLayoutInput()`
  - `classifyRootComponents()`
  - `normalizeExtremePortraitBlocks()`
  - `identifyLeafClusters()`
  - `placeLeafGrids()`
  - `resolveGridCollisions()`
  - `resolveHorizontalOverlaps()`
  - `resolveResidualSkeletonOverlaps()`
  - `alignLinearChains()`
  - `autoLayout()`
- 排布前尺寸同步：`src/canvas.js`
  - `syncBlockSizes({ adaptForAutoLayout: true })`
- 自动排布入口：`src/main.js`、`src/chat.js`
- 回放说明：`testcanvas/REPLAY_TEST_STRATEGY.md`

---

## 十四、当前一句话总结

> 先用真实 DOM 内容把明显窄高的文本块修到更可读的比例，再做主树布局；纯叶子仍优先矩阵化，但现在只有尺寸接近的块才会进同一矩阵，tall leaf 和离群块会被保留下来。
