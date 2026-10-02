# dsh-region-probe

面向 **DeepSeek Harness** 的只读 [Cordis Inspect](https://github.com/orphiczhou/dsh-session-tree) provider：告诉 agent **壳实际渲染了哪些 UI 区域、以及渲染成了什么**——于是渲染 bug 可以由 agent 自己在真实应用里发现，不需要截图，也不需要人去看屏幕。

没有界面、没有工具、不发网络请求。一个 provider，三个只读方法。

## 为什么这行得通

Harness 壳把**每一个** UI 区域都渲染成一个 slot 锚点：

```html
<div data-slot="sidebar.workspaces">…what the occupant rendered…</div>
<div data-slot-error="tool.view.demo">…when that occupant failed to render…</div>
```

（锚点自身是 `display: contents`——它没有盒子，布局由占位者提供。）

因此每个区域——这个 DSH 版本自带的、以后版本新增的、以及第三方插件贡献的——都会在 DOM 里带上**稳定的 slot key**，不需要那个区域配合任何事。本 provider 就是读这些锚点，所以它**不需要区域清单、不需要按区域写代码、也不依赖 CSS 类名**（壳自己的类名是 `BynINW_frame` 这类 CSS-module 哈希，每次构建都变；slot key 不会）。

## agent 可以问什么

| 方法 | 回答 |
|---|---|
| `outline()` | 当前 DOM 里存在的每个区域：`slot`、`failed`、`failedBefore`、`empty`、`anchors`、`nodes`、屏幕盒子（`x,y,width,height`）、文本样本；外加 `total`、`failed`、`failedEver`。 |
| `snapshot({ slot \| selector, depth?, limit? })` | 某个区域的渲染内容（有界节点表）：`path`、`tag`、`role`、`aria-label`、所属 `slot`、自身文本、几何、`visible`、`fontSize`、`color`、`background`。 |
| `failures()` | **本页的失败历史**：哪些 slot 渲染失败过、分别失败了几次、现在还在坏还是已恢复（`active` / `recovered` / `firstSeenAgoMs` / `lastSeenAgoMs`）。 |

寻址用 **slot key**（首选）或任意 CSS 选择器（兜底）。`depth` 默认 3（锚点 → 表面 → 行 → 标签），上限 8；`limit` 默认 60 个节点，上限 300。

用 agent 已有的检视工具读取：

```jsonc
// cordis_inspect_query({ platform: "client", provider: "Regions", method: "outline" })
{
  "total": 36, "failed": 0, "failedEver": 1,
  "regions": [
    { "slot": "sidebar",        "nodes": 137, "x": 0,   "y": 0, "width": 280,  "height": 900, … },
    { "slot": "main",           "nodes": 110, "x": 280, "y": 0, "width": 1160, "height": 900, … },
    { "slot": "sidebar.workspaces", "nodes": 49, "x": 12, "y": 204, "width": 268, "height": 640,
      "failed": false, "failedBefore": true, "empty": false,
      "text": "会话树 + ⋯ ▶ xiaomi-power-key-proj …" }
  ]
}
```

`list` 型 slot 可能把同一个 key 渲染在多个位置（侧栏面板列表在展开态与收起轨道各渲染一次）：这些锚点会被合并成**一个**区域，`anchors: 2`，盒子取并集。

## 失败历史

`outline()` 只能看到**此刻**坏掉的区域，所以「坏了一瞬间又恢复」不会留下任何痕迹——而这正是单次快照抓不到的那类 bug。为此 provider 会在页面生命周期内维护一份有界账本（最多 200 条）：

- 随插件启动（`immediately: true`），因此从页面启动起就在看；
- `childList` 上的 `MutationObserver` 会在失败锚点出现/消失时重新同步，且**每次回答前也会同步**，所以即使 `MutationObserver` 不可用，账本依然正确；
- 不再失败的 slot 标记为 `recovered: true`，并且**保留**；
- 同一 slot 再次失败时 `count: 2`。

失败原因不在这里——壳只留下一个空的 `data-slot-error` 标记，错误本身进了页面 console。

## 能看到什么、看不到什么

- ✅ DOM 里的每个区域，包括其他插件贡献的区域、以及未来 DSH 新增的区域——不需要任何东西主动配合。
- ✅ shadow root 与同源 iframe 会进去读，路径里标出（`#shadow`、`#frame`）。
- ✅ 「声明了但什么都没渲染」（`empty: true`）与「渲染失败」（`failed: true`）与「根本不存在」被区分开——provider 从不用空数组冒充结论：「no region is rendered」「render-error」「selector matched nothing」「invalid-selector」是四个不同的 reason。
- ❌ **跨域 iframe** 内部、以及画进 **canvas** 的内容读不到；provider 只报宿主元素，不会假装读到了。
- ⚠️ `data-slot` / `data-slot-error` 是渲染器实现细节，不是有文档承诺的契约。若将来壳不再输出它们，`outline()` 会返回空——此时改用 `snapshot({ selector })`，它不依赖这两个属性。
- ⚠️ 「哪个页面应答」不由本插件决定：Harness 宿主会把检视查询广播给每个已连接页面并取第一个有效回答，所以多窗口下你读到的几何描述的是**应答那个页面**。

## 安装

DSH 以 **profile bundle** 形式安装插件。纯 ESM，无构建步骤，无依赖。

**图形界面：** 插件页 → **Add plugin** → 粘贴 `https://github.com/orphiczhou/dsh-region-probe`。

**命令行：**

```sh
dsh plugin add orphiczhou/dsh-region-probe
```

**本地 checkout：** 在同一个对话框里把该目录作为 spec 添加。

客户端半边随页面加载。装好后刷新一次 Harness 页面，此后 `cordis_inspect_list` 就会在 `client` 平台列出 `Regions` provider。

## 隐私与安全

这个 bundle 赋予 agent **读取** Harness 界面的能力：区域名、可见文本、计算后的颜色与几何。它不点击、不写入、不导航；不碰 cookie、不碰 `localStorage`、不发网络请求；每个回答都有界（节点数、深度、文本长度）且文本会截断。它的用途是自验证，因此请当作开发工具对待：如果你不希望某个会话能读到自己的界面，把它停用即可。

## 兼容性与版本策略

本 bundle **不声明任何 `peerDependencies`**。这是刻意的：`@deepseek-ai/dsh*` 上的 `peerDependencies` 是 DSH 唯一强制的兼容字段，不声明意味着运行时升级不会硬失败。它只对话一个可选客户端服务 `cordisInspect`，并用**可选注入**（`ctx.inject([...], cb)`）请求——在没有 client runner 的组合里，插件什么也不做，而不是加载失败。

## 开发

```sh
node test/contract.cjs        # 100+ 断言，无需安装 DSH
node scripts/verify-bundle.mjs
```

`test/contract.cjs` 让真实的 `client.js` 跑在一个迷你 DOM 上——它建模的正是壳产出的东西：`data-slot` 锚点、`data-slot-error` 锚点、内容在孩子里的 0×0 锚点、同一 list slot 渲染两次、嵌套透明包装、空区域、shadow host、同源 iframe、canvas——然后驱动一次 **崩溃 → 恢复 → 再崩溃** 的序列穿过账本；在本地能取到 DSH 自带 schema 引擎时，用它判定每一个回答（取不到时明确 SKIP，而不是假装通过）。

## 许可证

MIT
