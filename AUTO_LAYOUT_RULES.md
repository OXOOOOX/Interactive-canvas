# 自动排布规则详解

这份文档描述当前 `src/utils/layout.js` 里**真实生效**的自动排布规则，不只包含叶子矩阵，还包含：
- duplicate-id 安全跳过
- 多 root / 孤立 root 处理
- 骨架分层布局
- 叶子矩阵填充
- 同带避让 / 残余碰撞处理
- 链式对齐修正

---

## 一、总流程

自动排布入口：`src/utils/layout.js:autoLayout()`

整体流程可以概括为：

```text
输入 blocks / connections / groups
  ↓
validateLayoutInput()                     // duplicate-id 防护
  ↓
classifyRootComponents()                 // 识别主树 vs 孤立 root 卡片
  ↓
layoutSingleComponent(mainBlocks)        // 主树两段式布局
  ├─ identifyLeafClusters()              // 识别叶子聚类
  ├─ assignLayers() / barycentricSort()  // 骨架分层与排序
  ├─ positionBlocks()                    // 初始落位
  ├─ placeLeafGrids()                    // 叶子矩阵安置
  ├─ resolveGridCollisions()             // 矩阵与骨架碰撞微调
  └─ runStablePass()                     // 稳定化：压缩 / 避让 / 链式对齐
  ↓
packFloatingRootCards()                  // 孤立 root 外侧摆放
  ↓
resolveAllOverlaps()                     // 全局避让
  ↓
alignLinearChains()                      // 最终链式对齐收尾
  ↓
normalizeLayoutBounds()                  // 整体归一化到画布可见区
```

---

## 二、输入安全规则

### 1. duplicate-id 直接跳过

函数：`validateLayoutInput()`

规则：
- 如果检测到重复 block id，自动排布会直接 `return`，不继续执行。
- 这是为了避免布局阶段把同 id 块混在一起，造成更大的坐标污染。

当前阈值 / 行为：
- 不尝试“部分布局”
- 不尝试“自动修复 id”
- 直接保留用户当前数据

适用回归样例：
- `testcanvas/canvas-1776661037101.json`

---

## 三、多 root 规则

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

## 四、叶子矩阵触发条件

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

## 五、叶子矩阵排布规则

### 1. 核心参数

```javascript
const GRID_H_GAP = 40;
const GRID_V_GAP = 30;
const GRID_MAX_COLS = 3;
const GRID_PARENT_OFFSET = 40;
const LEAF_CLUSTER_MIN = 3;
```

### 2. 排布原则

函数：`placeLeafGrids()`

矩阵放置时会综合考虑：
- 父节点位置
- 整个骨架图的中心线
- 父节点是否还带有非叶子核心子树
- 外侧方向（outer side）

高层原则：
- 叶子矩阵优先放在父节点**外侧**
- 避免压到核心子树
- 避免把整张图中轴堵死
- 最多 3 列，优先保持可读性

### 3. 碰撞微调

函数：`resolveGridCollisions()`

规则：
- 把整个 cluster 当作一个整体 bounding box
- 与骨架块做碰撞检测
- 若发生明显碰撞，则整体平移 cluster
- 不逐个打散矩阵内部节点，保持矩阵形态稳定

---

## 六、骨架布局规则

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

## 七、稳定化规则

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

这条规则就是这次修复新增的重要点之一：
- 避免 `新同级块1 -> 新子块1` 这种真实链条因为 y 太近，被误判成同排卡片然后向右挤歪

---

## 八、链式对齐规则

函数：`alignLinearChains()`

这是这次更新后的重点规则。

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

这是这次更新后的第二个关键点。

以前：
- 只有正中轴位置完全可用，才回正
- 只要正中轴被其他块轻微挡住，就直接放弃

现在：
- 先尝试正中轴
- 如果不行，会向左右按步长搜索**最近可用 x**
- 目标是：
  - 优先保持“接近直线”
  - 同时不撞上其他块 / 矩阵块

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

## 九、当前自动排布的实际优先级

把当前实现压缩成一句话，大致是：

> 先保证主树层级和整体可读性，再把纯叶子批量放到外侧矩阵，随后清理碰撞，最后尽量把单父链条重新拉回父节点中心线。

具体优先级可理解为：

1. **数据安全优先**：duplicate-id 直接跳过
2. **主阅读流优先**：主树先排，孤立 root 不插中轴
3. **矩阵稳定优先**：纯叶子整体作为 cluster 处理
4. **不重叠优先**：先清理同带/残余碰撞
5. **链条美观优先**：最后把单父链尽量拉直

---

## 十、这次更新后重点修复的现象

### 样例：`testcanvas/canvas-1776687150705.json`

修复前：
- `结构细化与物料分解 -> Order Processing` 没有对齐
- `新同级块1 -> 新子块1 -> 新子块2` 中间块会被横向挤歪

修复后：
- `Order Processing` 会回到父块中轴附近
- `新同级块1 / 新子块1 / 新子块2` 恢复成稳定直线
- 不再与旁边的叶子矩阵重叠

### 样例：`testcanvas/canvas-1776668880388.json`

修复后继续保持：
- `新同级块1 -> 新子块1 -> 新子块2` 一条直线
- `Order Processing` 不再出现不必要右移

---

## 十一、推荐回归验证集

建议每次改布局后至少回放：

- `testcanvas/canvas-1776687150705.json`
  - 新链式回归样例
- `testcanvas/canvas-1776668880388.json`
  - 旧链式回归样例
- `testcanvas/canvas-1776671259528.json`
  - 多 root / 孤立 root 样例
- `testcanvas/canvas-1776612336942.json`
  - 复杂防重叠样例
- `testcanvas/canvas-1776577290796.json`
  - 综合场景样例
- `testcanvas/canvas-1776661037101.json`
  - duplicate-id 安全跳过样例

并建议结合 `testcanvas/REPLAY_TEST_STRATEGY.md` 中的脚本方式检查：
- 关键块坐标
- bbox
- overlap 数量
- 构建结果 `npm run build`

---

## 十二、相关文件

- 核心实现：`src/utils/layout.js`
  - `validateLayoutInput()`
  - `classifyRootComponents()`
  - `identifyLeafClusters()`
  - `placeLeafGrids()`
  - `resolveGridCollisions()`
  - `resolveHorizontalOverlaps()`
  - `resolveResidualSkeletonOverlaps()`
  - `alignLinearChains()`
  - `autoLayout()`
- 回放说明：`testcanvas/REPLAY_TEST_STRATEGY.md`
