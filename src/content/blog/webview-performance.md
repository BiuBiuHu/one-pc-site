---
title: 性能：启动 / 白屏 / 渲染 / 内存
date: 2026-11-14
excerpt: "把点击到首屏拆成可测的段，白屏不等于慢，再看渲染掉帧、内存回收和监控看板。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 9
lang: zh
draft: false
ogImage: /images/webview-and-native/stage8-01-startup-waterfall.png
---

> 📖 本章由 4 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · 启动耗时拆解：把"点击到首屏"拆成可测、可归因的段
- 2 · 白屏诊断：白屏 ≠ 慢，四类根因四条路
- 3 · WebView 里的渲染与滑动：合成层、长列表、滚动掉帧定位
- 4 · 内存与监控指标：进程回收、白屏链路、T+1 看板
- 本章术语表

---
## 1 · 启动耗时拆解：把"点击到首屏"拆成可测、可归因的段

### 1.1 问题引入

月会上，产品拿着两个数字对峙："同样的 H5 首页，包 A 打开 2.5 秒，包 B 只要 0.8 秒。"前端说"我们接口没问题"，客户端说"我们 WebView 早就建好了"，网络说"我们 P99 很稳"。吵了半小时，没人能指出**慢在哪一拍**——因为没有分段数据。本节的目标：把"点击到首屏"拆成 6~8 段，每段有 Owner、有打点、有阈值，让这句话 30 秒内说完。

### 1.2 先破误区

> • 误区："启动耗时 就是接口耗时 + 渲染耗时，前端埋个接口计时就知道了。"
> • 事实：接口只是中间一段。WebView 创建本身可能吃掉 300~800ms（新建内核），预热命中可以压到几十毫秒；这段发生在你的任何 JS 跑起来之前——不接容器的数据，你根本看不见它。

> • 误区："performance API 会告诉我一切。"
> • 事实：`performance` 的导航段数据来自内核，它在 WebView 里的字段完整度与精度以实测为准（X5/XWeb 等自研内核可能整段缺失或为 0）。容器侧注入的时间戳变量是兜底手段，两者要交叉核对。

### 1.3 原理：六个可测的段

把"点击一个 URL"拆成 8 步；落到耗时归因，收敛成下面这张瀑布图：

![点击到首屏的启动耗时瀑布分段与归因](/images/webview-and-native/stage8-01-startup-waterfall.png)


| 段 | 内容 | Owner | 典型区间（经验参考，以实测为准） |
|---|---|---|---|
| ① 点击 | 触摸事件被容器捕获 | 容器 | 5–50ms |
| ② 路由决策 | scheme/路由表裁决、复用 or 新开 | 容器 | 10–100ms |
| ③ 取/建 WebView | 预热池命中 or 新建内核 + 注入 Bridge/UA | 容器 | 预热命中 10–80ms；新建 300–800ms |
| ④ 内核导航 | `loadUrl`/`loadRequest` 交给内核 | 容器 | 10–50ms |
| ⑤ HTML 到达 | DNS→TCP→TLS→HTTP 或缓存/离线包命中 | 网络 | 30–600ms |
| ⑥ 关键资源 | 首屏 CSS/JS/字体并行加载 | 网络 | 50–500ms |
| ⑦ 渲染首帧 | HTML 解析→样式→首个内容上屏（近 FCP） | 前端 | 80–400ms |
| ⑧ 可交互 | 脚本执行完、Bridge 就绪、首屏数据渲染完 | 前端 | 100–800ms |

**归因三条规矩**：

1. **谁的时间戳谁算差值**。容器段（①–④）用容器时钟、前端段（⑦–⑧）用内核时钟，各自算完再拼全程；跨时钟直接相减会把误差算成耗时。
2. **段 ③ 是双端分歧最大的段**，也是容器优化收益最大的一段——这就是预热池存在的理由（收益模型见第五节）。
3. **⑤⑥ 段归"网络"Owner**，但注意它走的是**管道二（WebView 内置网络栈）**，不在客户端网络库监控里（阶段 6 的结论在这里全部适用）；离线包命中时 ⑤⑥ 可以整段趋近于零。

### 1.4 代码验证：前端打点 + 容器对接

#### 1.4.1 前端怎么打（TypeScript，粘贴进入口即可）

```ts
// 前端 · 启动打点三件套：mark / measure / 上报
// 前提：容器在导航发起前注入 window.__PAGE_START__（常见做法，字段名以你们容器为准）

// ① 容器时钟 → 内核时钟换算系数（页面第一行 JS 执行，越早越好）
const offset = Date.now() - performance.timeOrigin;

// ② 首帧标记：给首屏第一个真实内容节点打 mark（比想象 FCP 更贴近业务）
export function markFirstContent(entrySelector = '[data-first-content]') {
  if (document.querySelector(entrySelector)) performance.mark('first-content-rendered');
}

// ③ 可交互标记：框架 mount 完成 + 首屏数据渲染完，由业务显式确认
export function markInteractive() {
  performance.mark('page-interactive');
}

// ④ 汇总上报：容器段用 __PAGE_START__，前端段用 mark，换算后拼全程
export function reportStartup() {
  const t0 = (window as any).__PAGE_START__;   // 容器参考时钟（导航发起前，epoch ms）
  const fcpM = performance.getEntriesByName('first-content-rendered')[0];
  const iaM  = performance.getEntriesByName('page-interactive')[0];
  const nav  = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;

  // 内核相对时刻 → 绝对时刻（epoch ms）：timeOrigin + startTime
  const toEpoch = (m?: PerformanceEntry) => (m ? performance.timeOrigin + m.startTime : NaN);

  return {
    // 前端段（内核时钟内互减，无跨钟问题）
    firstFrameMs:  fcpM ? fcpM.startTime : NaN,          // ⑦ 近 FCP
    interactiveMs: iaM  ? iaM.startTime  : NaN,          // ⑧
    // ⑤⑥ 段：navigation timing 在 WebView 里的完整度以实测为准（X5/自研内核可能缺字段或为 0）
    htmlArriveMs:  nav ? nav.responseEnd : NaN,
    // 全程（内核绝对时刻 - 容器起点）
    totalMs: t0 && iaM ? toEpoch(iaM) - t0 : NaN,
  };
}
```

注意这里**两类时钟**：`__PAGE_START__`/`Date.now()` 是容器注入那一刻的参考，`performance.mark/.startTime` 是内核时钟（相对页面时间原点）。**换算方法**：mark 事件的绝对时间 = `performance.timeOrigin + startTime`（timeOrigin 即页面时间原点的 epoch 毫秒），再减 `__PAGE_START__` 得全程；两类时钟精度都是毫秒级，残余偏差以实测为准。

#### 1.4.2 容器怎么打、双方怎么对接

容器负责 ①–④ 段，把两个时间戳随页面注入（**下面是约定示例，字段名要和你们容器对齐**）：

```kotlin
// Android · Kotlin（示意：注入打点起点，配合 shouldInterceptRequest 记录主文档到达）
val pageStart = System.currentTimeMillis()               // ① 点击后容器时钟 T0
webView.loadUrl(url)                                     // ④ 导航发起
// 容器约定：①④ 段耗时 + pageStart 通过 bridge 或注入变量下发给 H5 上报
```

```swift
// iOS · Swift（示意：WKUserScript 注入 __PAGE_START__）
let script = WKUserScript(
    source: "window.__PAGE_START__ = Date.now();",
    injectionTime: .atDocumentStart,          // 越早越好：文档元素创建即注入
    forMainFrameOnly: true)
config.userContentController.addUserScript(script)
webView.load(request)                          // ④ 导航发起
```

**对接清单**（写入你们团队的监控文档，而不是口头约定）：

| 段 | 谁打 | 打在哪个点 | 字段 |
|---|---|---|---|
| ①点击–②路由 | 容器 | 点击回调入口 | `routeDur` |
| ③建 WebView | 容器 | 池命中/新建返回时 | `webviewReadyDur` |
| ④导航发起 | 容器 | `loadUrl/loadRequest` 调用后 | `navStartTs`（下发） |
| ⑤HTML 到达 | 前端 | navigation timing / 容器网络回调 | `htmlArriveTs` |
| ⑥⑦⑧首帧/可交互 | 前端 | `performance.mark` | `fcp`、`interactive` |

#### 1.4.3 预热的收益模型

预热池为什么值几百毫秒：答案就是段 ③ 的两档数字（见上文表）——**新建内核 300–800ms，预热命中 10–80ms**。省下的不只是"创建组件"本身，还有内核第一次初始化网络栈、进程拉起等隐藏成本（具体省多少，双端不同内核版本以实测为准；验证代码：打点对比预热/冷启两次的 `webviewReadyDur`）。

但预热不是稳赚，两种场景反而亏：

1. **预热但没被用上**：用户点了别的入口，预热实例闲置占用内存，在内存压力大的机器上反而**加速了 WebContent 进程被回收**，下一页白屏兜底重来（白屏归因见本节 2.2 的决策树）。
2. **白屏兜底场景**：预热实例如果带上旧 Cookie/旧存储状态，或者在容器回退逻辑里复用了被杀过的实例而没有完整重置，会造成"看起来预热了、实际白一下再重来"——**用户感知耗时 = 预热时长 + 兜底重载时长，反而更慢**。兜底逻辑的设计细节在 阶段 7 · 05 预加载与预热池 里有完整展开。

**一句话**：预热收益 =（新建耗时 − 命中耗时）× 命中率 −（闲置成本 + 兜底重载成本）。要让乘法成立，命中率是关键——先打点"预热命中率"再谈优化。

### 1.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 跨时钟相减 | 总耗时经常为负或离谱大 | `Date.now()` 与 `performance.timeOrigin` 基准不同 | 页面首行算 offset 换算到同一时钟 |
| 只埋接口耗时 | 优化后大盘没动 | 慢在段 ③ 新建内核，接口数据看不到 | 接容器 `webviewReadyDur` 字段 |
| navigation timing 为 0/缺字段 | `responseEnd=0` | 自研内核不完整支持，可用性以实测为准 | 容器网络回调时间戳兜底 |
| 预热命中率看不见 | 优化没有抓手 | 没打"命中日志" | 容器上报：池命中/新建 两种 case 分开统计 |
| 离线包命中未分段 | ⑤⑥ 段数据糊在一起 | 容器把拦截映射和真网络混报 | 上报里加 `offlineHit` 标记，分开看分布 |

### 1.6 自测题

<details>
<summary>参考答案（思考后再点开）</summary>

1. 容器时钟（`Date.now()` 系，epoch 毫秒）与内核时钟（`performance.now()` 系，相对页面原点）基准不同；把内核时刻用 `timeOrigin + startTime` 转成 epoch 再与 `__PAGE_START__` 相减。
2. 错。WebView 内 nav timing 字段完整度因内核而异（X5/XWeb 可能缺失），需容器网络回调时间戳兜底，以实测为准。
3. 两档数字（上半节）：经验值，以实测为准；用 `webviewReadyDur` 分别统计新建/命中等两种 case。
4. 命中率低导致预热实例闲置、占内存、加速进程回收；或兜底重载把它拖慢——收益 =（新建−命中）×命中率−（闲置+兜底）。
5. 错。⑤⑥ 走**管道二**（WebView 内置网络栈），默认不经客户端网络库监控；离线包拦截是容器层做的，映射命中与否要单独打标。

</details>

---

## 2 · 白屏诊断：白屏 ≠ 慢，四类根因四条路

### 2.1 问题引入

客服凌晨转来一个工单："App 里某 H5 页打开全白。"值班前端第一反应是"接口慢"，加了 loading 态了事；第二天同样白屏再报，接口监控绿的。真相是 iOS 用户的 WebContent 进程被系统回收，页面根本没渲染——**白屏和"慢"是两个问题，用"慢"的思路治白屏，永远治不对**。

### 2.2 先破误区

> • 误区："白屏就是加载慢，加个骨架屏/loading 就行。"
> • 事实：白屏的定义是页面容器在、内容空（术语见 AUTHORING-GUIDE 术语表），它和耗时无关。骨架屏治"慢"，治不了"进程被杀""脚本早崩""资源 404"这三类白屏。

> • 误区："白屏是前端的问题，前端自己查。"
> • 事实：四类白根因里，至少两类（进程被杀、资源加载失败）的检测点根本不在前端——只能靠容器侧回调与网络日志，必须双端分工。

### 2.3 原理：四类白屏 + 归因决策树

![页面白屏归因决策树：三问分流到四类叶子](/images/webview-and-native/stage8-02-blank-screen-tree.png)


| 大类 | 一句话根因 | 检测点在哪侧 | 典型诱因 |
|---|---|---|---|
| A 渲染进程被杀 | iOS WebContent 回收 / Android 内核异常，网页进程没了 | **容器**（回调） | 内存压力、系统回收（阈值以实测为准） |
| B HTML 资源加载失败 | 404 / 断网 / DNS 失败，主文档没到 | **容器**（网络事件）+ 抓包 | 灰度配置错、离线包版本缺失、弱网 |
| C JS 早期异常 | 入口脚本一跑就崩，挂载点永远空着 | **前端**（onerror/console） | 语法兼容、依赖缺失、Bridge 假设错误 |
| D 数据为空 | 接口 200 但返回空，渲染了"空态" | **前端** + 服务端 | 权限、签名、字段约定变更 |

**决策树口诀：网络 → 文档 → 渲染 → 数据，逐层排除。** 树里三问的答案决定了你进哪片叶子；四类叶子可叠加（如"进程被杀 + 资源 404"），按**最先出现的根因**上报大类。

#### 2.3.1 客户端怎么检测白屏（思路演示：截图像素统计）

容器侧常用做法：进入页面后延时（如 2s）对本机 WebView 做一次截图采样，把视图栅格化成小像素块，统计"非背景色"像素占比，低于阈值判白屏。**这是常见做法示例，非标准 API**，采样时机与阈值要结合业务页面调整：

```kotlin
// Android · 思路演示，非生产代码 —— 完整可粘贴版见 demo/WhiteScreenProbe.kt
webView.postDelayed({
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp); webView.draw(c)          // 把 WebView 画到位图
    var blank = 0; val total = w * h
    // 逐像素统计 × 步长采样降低开销
    for (y in 0 until h step 4) for (x in 0 until w step 4) {
        val p = bmp.getPixel(x, y)
        if (Color.red(p) > 245 && Color.green(p) > 245 && Color.blue(p) > 245) blank++
    }
    val blankRatio = blank.toFloat() / (total / 16)
    if (blankRatio > 0.95f) reportWhiteScreen(url, blankRatio)  // 上报，带白屏率
}, 2000)
```

iOS 对应思路：`WKWebView.takeSnapshot(with:)` 拿 `UIImage`，转 `CGImage` 后逐像素采样统计接近背景色的比例；或更轻量——只查 DOM 结构（见 2.3.2）。截图采样能兜住"渲染进程已死、DOM 都没有"的 case，DOM 查询兜不住；**双法并用，采样率控制在个位数百分比以控成本**（成本收益以实测为准）。

#### 2.3.2 前端怎么上报：FCP 与首帧内容节点标记

```ts
// 前端 · 白屏判定 + 首帧内容节点标记（TS，粘贴进入口）
export function reportFirstPaint(paintSel = '[data-first-content]') {
  // ① 平台 FCP：有值说明内核确实渲染了东西（paint entry，WebView 内可用性以实测为准）
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN;

  // ② 首帧内容节点标记：业务口径的"真的画出来了"
  const node = document.querySelector(paintSel);
  const nodeTs = node ? performance.now() : NaN;
  if (node) performance.mark('first-content-rendered');

  // ③ 白屏嗅探：load 后 2s 仍未出现标记节点 → 疑似白屏（配合容器侧截图像素统计互证）
  setTimeout(() => {
    if (!document.querySelector(paintSel)) {
      report({ type: 'suspected-blank', fcp, url: location.href,
               htmlLen: document.documentElement.outerHTML.length });
    }
  }, 2000);

  return { fcp, nodeTs };
}
```

上报字段至少带：`fcp`、`htmlLen`（主文档大小，区分叶子 B）、`onerrorFirst`（最早的 JS 异常栈，区分叶子 C）、容器侧的 `processAlive`/`netCode`——这些就是要与容器/服务端对齐的**分工接口**。

#### 2.3.3 与服务端/客户端的分工表

| 根因 | 前端责任 | 容器责任 | 服务端责任 |
|---|---|---|---|
| A 进程被杀 | 白屏兜底 UI（自动 reload 提示） | 监听进程回收回调、重载、降级 | — |
| B 资源失败 | 资源版本/域名配置自查 | 网络事件上报（状态码/错误码）、离线包版本核对 | 静态资源可用性 |
| C JS 早期异常 | `window.onerror` 接入、 Sourcemap 还原 | 把 console 转发到容器日志（可配置） | — |
| D 数据为空 | 空态渲染规范、接口失败重试 | — | 接口可用性、字段契约 |

### 2.4 代码验证：白屏 MTT 定位手册

MTT（Mean Time To Locate）的核心是**先查便宜的**：日志和回调一分钟出结果，比连调试器快。按顺序走：

| 现象 | 先查什么（<1 分钟） | 再查什么（工具/命令） |
|---|---|---|
| 疑似 A：进程被杀 | 容器回调日志（iOS `webViewWebContentProcessDidTerminate` / Android `onRenderProcessGone`） | 崩溃平台过滤"WebContent/Render 进程"（非 App 闪退）；内存水位曲线 |
| 疑似 B：资源失败 | 容器网络事件日志的状态码 | Charles 抓主文档（状态码/响应体长度）；`curl -I <url>` 直连复制；离线包版本号比对 |
| 疑似 C：JS 早崩 | 前端 onerror 上报最早异常栈 | `chrome://inspect`（`adb forward` 或同网段）连 Android WebView 看 console；Safari 开发菜单连 iOS 检查器（第 10 阶段详解） |
| 疑似 D：数据空 | 接口监控 200 的返回体长度 | 抓包看响应体；用同账号在浏览器直连接口复现；查字段契约变更记录 |
| 全白且无 JS 报错、无网络请求 | 会不会根本没走到 load？看容器埋点 ①–④ 段 | 第 1 节的分段数据：路由决策是否拦截、预热实例是否复活失败 |

操作细节提示：Android 开 WebView 调试需容器已调 `WebView.setWebContentsDebuggingEnabled(true)`（X5/XWeb 有各自开关，以实现为准）；iOS 需真机开启 Web 检查器且容器打开检查能力（互操作细节第 10 阶段详解）。

### 2.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 把慢当白屏 | 骨架屏后仍被算"白屏率"高 | 指标没分口径：白屏率只统计"超时后仍无内容" | 指标定义见第 4 节：白屏率必须带超时阈值 |
| 只查 DOM 就下结论 | DOM 是空的就报"前端白屏" | A 类进程被杀时 DOM 根本查不到 | 前端嗅探 + 容器截图像素统计互证 |
| 截图采样太贵 | 全量用户截图 → CPU/内存成本高 | 采样率 100% | 采样率 1%~5%，只在疑似 case 截图 |
| A 类误归 C 类 | 有 JS 报错就定案 | 进程被杀后 perf 上下文全丢，残留报错是旧页面 | 以容器回调日志为 A 类唯一准据 |
| D 类当 A/B 类治 | 拼命查进程与网络 | 空态视觉上就是"白"，但根本不在渲染层 | 空态要有明确占位样式，别用纯白兜底 |

### 2.6 自测题

1. 白屏的四个大类分别是什么？各自由哪侧最先感知？
2. 为什么 A 类（进程被杀）必须以容器回调为准，前端 DOM 查询为什么不可靠？
3. 截图像素统计的思路是什么？它的成本陷阱在哪？
4. 动手：在你的页面接入 `reportFirstPaint`，故意把入口脚本第一行改成 `.getWindow()`（未定义函数）制造 C 类白屏，分别用 B/C 两类手段定位，记录 MTT 差异。
5. 有人说"白屏率 = 打开后 5 秒内容器截图为白的比例"，这个定义有什么漏洞？

<details>
<summary>参考答案（思考后再点开）</summary>

1. A 渲染进程被杀（容器回调先感知）、B HTML 资源加载失败（容器网络事件/抓包先感知）、C JS 早期异常（前端 console/onerror 先感知）、D 数据为空（前端+服务端）。口诀：网络→文档→渲染→数据。
2. A 类发生时渲染进程已死，DOM/JS 上下文整个消失，前端代码没有执行机会，自然查不到——只有容器侧回调（iOS `webViewWebContentProcessDidTerminate`、Android `onRenderProcessGone`）能拿到第一现场。
3. 对 WebView 截图→栅格化→统计近背景色像素占比，超阈值判白屏；能兜住"DOM 都没有"的极端 case。陷阱：全量采样 CPU/内存贵，应限采样率与时机（如 2s 后 3% 用户）。
4. 答案要点：C 类路径（console 报错→定位语法错误）比 B 类路径（抓包→发现其实是 200）快数倍；这就是"先查便宜的日志"的理由。
5. 至少三处漏洞：没排除 D 类空态（渲染了但内容空）；没区分超时阈值（3s 白 !==5s 白）；没说像素统计阈值（0.95 判白的依据要给业务口径）。

</details>

---

## 3 · WebView 里的渲染与滑动：合成层、长列表、滚动掉帧定位

### 3.1 问题引入

"页面在 Chrome 里滑得飞起，进我们 App 就掉帧飕飕"——双端协作里最常见的纠纷。前端把责任推给容器，容器拿 performance panel 一看 JS 才 10ms，判"不是前端问题"。真相往往是：**JS 不慢，慢在合成与滚动**。WebView 的渲染坑和浏览器不同，本节把图层/长列表/滚动/字体一次讲透。

### 3.2 先破误区

> • 误区："掉帧就是 JS 执行太慢，去优化算法。"
> • 事实：滚动掉帧三大来源——JS 主线程阻塞、合成层爆炸、重绘/合成。先分清走哪条路再动手，否则优化 JS 优化到死也白搭（判定顺序见 3.3.4）。

> • 误区："performance panel 在 WebView 里跟浏览器一样好用。"
> • 事实：调试面板依赖调试通道（chrome://inspect / Safari 检查器），不是所有容器都默认暴露；且 WebView 进程模型让你看到的不只是你的页面。能用时才有数据，用不了时靠打点与 `requestAnimationFrame` 计数兜底。

### 3.3 原理：WebView 里的渲染五坑

#### 3.3.1 长列表：DOM 节点 / GC / 图片解码

一个"一次渲染一万行"的 H5 列表在浏览器或许能扛，进 WebView 未必：

- **DOM 节点数与内存**：WebView 的渲染进程有独立内存预算，节点上万后 GC 频繁、推高内存水位（进程回收链路见第 4 节）。优先**虚拟列表/分页**。
- **图片解码**：`<img>` 解码发生在渲染进程，大图首屏一并解码会推高首帧与内存峰值。用 `loading="lazy"` + 指定宽高（避免布局抖动）分离首屏与屏外。
- **lazy 属性**：现代 Chromium 支持 `<img loading="lazy">`、`<iframe loading="lazy">`，懒加载时机由内核判定（进入视口前约一个视口距离，具体以实测为准）。WebView 里是否生效随内核版本，**以你设备实测为准**（打开 devtools 看网络瀑布是否首屏就下载全图即可验证）。

#### 3.3.2 will-change 滥用与合成层爆炸

`will-change: transform/opacity` 会提前造合成层（独立上屏的一层位图）。滥用（对几十上百个节点都开）会在**低端机**上挤爆 GPU 内存，把"想省滚动开销"变成"滚动掉帧元凶"。规则：

- 只对**数量少、确实会持续动**的节点开（如轮播、固定表头）。
- 单节点统一用 transform 制造层，别 opacity/字体各开一层叠层。
- 用完 `will-change: auto` 释放——长列表组件复用最容易漏。

#### 3.3.3 fixed 元素、字体与滚动差异

- **fixed 与滚动**：`position: fixed` 在 WebView 里偶发"跟滚滑动/掉帧"，根因多是 fixed 元素触发整页重绘而非 fixed 失效。缓解：fixed 走 `transform` 由合成层承担、或用 `position: sticky`（支持情况以实测为准）。
- **字体加载闪烁（FOIT/FOUT）**：字体文件走的是管道二（WebView 网络栈），弱网下更易闪。方案：`font-display: swap` 控回退，首屏关键字体内联/子集化。
- **iOS 橡皮筋 vs Android 溢出滚动**：iOS 原生橡皮筋默认在 WebView 里也生效，容器边界回弹是系统行为，别去禁；Android 则靠 `overscroll` 与 WebView 自身滚动。想统一手感，两端分别验证，别把一端的设置原样抄给另一端。

#### 3.3.4 判定顺序：先看合成层还是先看 JS 执行？

滚动掉帧用固定顺序定位，别跳步：

1. **先测"空滚动"帧率**：滚动一段无残留内容的页面，若仍掉帧 → 是合成/滚动层问题；若很顺 → 是你的内容渲染问题。
2. **再看 JS 执行**：performance panel 的 Main thread 是否有长任务集中在滚动 handler。有 → 优化 JS（防抖、纯 transform、`requestAnimationFrame` 节流）。
3. **最后看合成**：Layers 面板看图层数、每帧是否都在局部（local）区域重绘。图层>几百且局部重绘面积大 → 修 will-change/图层爆炸。

**一句话**：先排除"滚不动"，再查"JS 挡"，最后查"图层多"——三层从便宜到贵，反着做最容易在合成层白耗一轮。

### 3.4 代码验证：容器里连性能面板细看

工具能用才谈定位，所以先把通道打开。

#### 3.4.1 Android：chrome://inspect 连 WebView 调 performance

1. **容器必须暴露调试**：Android 原生 WebView 需宿主调 `WebView.setWebContentsDebuggingEnabled(true)`；X5/XWeb 等内核有各自开关（以容器文档为准）。
2. 手机开 USB 调试，`adb devices` 确认；本机开 `chrome://inspect`，在列表里找到目标 WebView 卡片（和网页标签混在一起，靠标记认）。
3. inspect 进 DevTools → **Performance** 面板记录 CPU throttling 模拟低端机，滑动 5~10 秒，看主线程 Long Task 与合成/绘制阶段；**Layers** 页看图层数与重绘面积。

#### 3.4.2 iOS：Safari 检查器对应能力

Safari「开发」菜单连 WebView（需真机开 Web 检查器 + 容器可检查）。Timeline / Performance / Layers 与桌面对齐，能看 WebContent 进程的 CPU/内存占比（高说明渲染进程吃紧）。注意：iOS 检查器不区分 WebContent 与 App 进程的内存分界，单看「WebContent 占比」判断是否接近回收阈值（数值以实测为准）。

#### 3.4.3 前端兜底埋点（调试通道不可用时的哨兵）

```ts
// 前端 · 滚动帧率哨兵：不依赖调试通道估滚动是否掉帧。若每秒帧数明显低于 60 且呈长任务特征，即掉帧信号
export function startFrameProbe() {
  let frames = 0;
  const loop = () => { frames++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { reportFrames(frames); frames = 0; }, 1000); // rAF 被长任务压掉时帧数走低
}
```

### 3.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 万行列表全渲染 | 滚动卡、内存涨 | DOM/GC/图片解码全挤在渲染进程 | 虚拟列表 + `loading="lazy"` + 指定宽高 |
| will-change 一键全开 | 低端机更卡 | 合成层爆炸挤 GPU | 只对少数动态节点开，用完 `auto` |
| fixed 抖动 | 固定元素滚动时闪 | fixed 触发整页重绘 | 用 transform / sticky（以实测为准） |
| 字体首屏闪 | 文字回退闪烁 | 网络字体 FOIT | `font-display: swap` + 关键字体子集 |
| iOS/Android 滚动手感不同 | 橡皮筋 vs 溢出不一致 | 两端系统滚动模型不同 | 别互抄设置，按端验证 |

### 3.6 自测题

1. 滚动掉帧三层定位顺序是什么？为什么先"空滚动"？
2. 什么时候该给元素开 `will-change`？滥用会造成什么？
3. `<img loading="lazy">` 在 WebView 里怎么判断有没有生效？
4. 动手：用 chrome://inspect 连你容器里的 H5，分别制造"JS 长任务掉帧"和"合成层爆炸"两个场景，在 Performance 面板上指出二者的不同点。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 先空滚动看是否合成/滚动层本身掉帧 → 再看 JS 长任务 → 最后看合成层。先"空滚动"能最快隔离"是内容渲染问题还是滚动机制问题"，免得在晦涩信号里白耗。
2. 只对数量少、持续动态变化的节点开；滥用会造大量合成层，挤爆 GPU 内存，低端机上把"省滚动"变"滚动更卡"。
3. 看网络瀑布：首屏未进视口的图不在首屏下载、滚动接近才请求 → 生效；是否随内核版本而异，以实测为准。
4. 答案要点：JS 长任务掉帧在主线程有长条阻塞、rAF 断档；合成层爆炸在 Layers 面板图层上百、空滚动仍卡。一个在主线程、一个在合成线程，Timeline 能分开。

</details>

---

## 4 · 内存与监控指标：进程回收、白屏链路、T+1 看板

### 4.1 问题引入

线上一个 H5 列表页，越用越卡，最后"啪"地白屏，App 没崩。用户以为是 Bug，其实是**渲染进程把 iOS 的内存配额吃到顶，被系统回收**——WebView 的内存归属和"回收→白屏"这条链，前端几乎看不见但天天踩。本节先把内存讲透，再给一版可落地的 T+1 监控看板。

### 4.2 先破误区

> • 误区："内存泄漏是客户端的事，App 自己管，跟我 H5 无关。"
> • 事实：你的页面 JS、图片、长列表全住在 WebView 的渲染进程里。渲染进程内存被吃爆 → 进程回收 → 页面白屏，这条链的起点往往是你的代码。

> • 误区："白屏率和崩溃率就是 FCP 之外的两个普通指标，收到告警排一下就行。"
> • 事实：指标要先定义清楚才有可排性。白屏率的反例一大堆（把空态算成白屏、超时阈值不统一），定义不清的看板只会让值班天天在噪音里打转。

### 4.3 原理一：WebView 内存归谁算

#### 4.3.1 进程边界（iOS）

iOS 上你的 H5 运行在 **WebContent 进程**（iOS 14+ 手术分进程），它从 App 进程剥离，**内存独立计算**：

- WebContent 把内存吃到某个水平，系统（Jetsam）优先回收这些**后台/低优先级**进程——表现就是"App 还在，页面白屏"，即第 2 节的 A 类白屏。
- 回收阈值受设备物理内存、当前内存压力影响，**无公开固定数字**。校准：用 Xcode Instruments（Allocations / VM Tracker）真机压测，记录 WebContent"被杀前"峰值作警戒线（数值以实测为准）。
- JS 拿不到进程级内存，只有 `performance.memory.usedJSHeapSize`（**Chrome 系才有，iOS WebKit 可用性以实测为准**），它是 JS 堆不是整进程，别拿它当回收阈值报警。

#### 4.3.2 进程边界（Android）

Android WebView 是否单独进程、内存怎么算，**随内核与系统版本差异很大**：有的走 Chromium 多进程（专门渲染进程），有的代码就在 App 进程内，回收表现也不同（是否回调 `onRenderProcessGone`、还是 App 直接阵亡）。**结论：别假设 Android 一定有独立渲染进程**，核实你 App 的 WebView 模型（以实测为准）——看崩溃平台报哪个进程，或在容器打印进程内存统计即可。

#### 4.3.3 内存超标 → 进程回收 → 白屏的链路

```
你页面的长列表 / 大图 / 未清理监听
   → WebView 渲染进程内存持续上涨
   → 触及系统回收阈值（JS 堆 / 本地内存，数值因设备而异）
   → iOS WebContent 进程被杀 / Android 渲染进程 gone
   → 页面内容消失 → 白屏（容器如做自愈则 reload 回来）
```

**前端能做的**（降低"吃得快"）：
- **未清理的监听**：`addEventListener` 与 `removeEventListener` 成对；轮询/Interval 离开页时清。
- **大图**：解码内存和分辨率成正比，列表里别放超大图。
- **长列表**：DOM 节点设上限（虚拟列表），避免无限累积。

**容器能做的**（"被杀"前兜底）：
- **内存水位监听降级**：容器周期性读本 WebView 进程内存，接近实测校准的警戒线时切轻量模式——如图片降为仅首屏、终止闲置 WebView、或降级页面复杂度。
- **自愈**：进程被杀回调里自动 `reload`（第 2 节叶子 A）。
- 思路演示见 demo/WhiteScreenProbe.kt（示例代码详见 demo 包）。

### 4.4 原理二：监控指标的真实度

#### 4.4.1 FCP / 首帧在 WebView 里的真实度

- **容器注入时间戳**（`__PAGE_START__`，常见做法）：含客户端初始化等前端不可见成本，是"用户侧真实度"更高的口径。
- **performance API 的 FCP**（`first-contentful-paint`）：内核渲染进度、纯 Web 口径，不含容器段；paint entry 在部分自研内核可能缺失（以实测为准）。
- **别二选一**：`__PAGE_START__`→首帧 = 用户感知总耗时；内核 FCP = 页面自身快慢。看板同时给两个值，才能归因"容器慢还是页面慢"。

#### 4.4.2 白屏率 / 崩溃率 / 加载成功率的定义与反例

| 指标 | 建议定义 | 反例 |
|---|---|---|
| 白屏率 | 超过 X ms（如 3s）**仍无首帧内容节点**的会话占比（X 写进文档） | 不设时间阈值，把"加载中"也算白屏 |
| 崩溃率 | App 进程或渲染进程造成的**会话中断**占比 | 把不中断会话的 JS Error 算进崩溃率 |
| 加载成功率 | `load` + 首帧出现都算成功；失败按 404/断网归因 | 只看有无发起请求，404 也算成功 |

白屏率要**排除 D 类空态**：接口 200 但渲染空列表视觉上是白的，需用"首帧内容节点"判定而非纯像素（像素判定对空态无能为力）。

#### 4.4.3 一版 T+1 看板指标清单

> 以下阈值是**经验参考值，不是标准**，用你们环境实测校准后再定告警线。

| 维度 | 指标 | 口径 | 健康阈值（经验参考） |
|---|---|---|---|
| 启动 | 用户感知首屏（`__PAGE_START__`→首帧）P50/P90 | 容器口径 | P50<1.5s，P90<3s |
| 启动 | 预热命中率 | 容器日志 | >70% |
| 白屏 | 白屏率（3s 无首帧节点） | 前端+容器互证 | <1% |
| 白屏 | 进程被杀率 | 容器回调 | <0.5% |
| 渲染 | 首帧节点出现耗时 P90 | 前端 mark | <1s |
| 渲染 | 滚动帧率<30fps 占比 | 前端 rAF 哨兵 | <2% |
| 崩溃 | 渲染进程崩溃率 | 崩溃平台（区分 WebContent） | <0.3% |
| 加载 | 主文档 4xx/5xx 率 | 容器网络事件 | <0.5% |

**一个看板至少两头各一个人认领**：容器段指标容器同学盯、前端段指标前端盯，别让"谁都能看但谁都不负责"又回到本节开头那场月会。

### 4.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 用 JS 堆估进程阈值 | 报警爆但不回收 | JS 堆≠渲染进程总内存 | 容器按进程内存判断，JS 堆只参考 |
| 空态当白屏 | 白屏率噪音 | 空态判定没排除 D 类 | 用"首帧内容节点"而非纯像素 |
| 无自愈 | 被杀页永远挂 | 容器没做 reload 兜底 | 被杀回调自动 reload（第 2 节叶子 A） |
| 看板无 Owner | 指标没人认领 | 口径和 Owner 双缺 | 每项标 Owner + 口径 + 告警线 |

### 4.6 自测题

1. iOS 上你的 H5 内存在哪个进程里算？为什么前端拿不到准确的回收阈值？
2. 描述"内存超标 → 进程回收 → 白屏"的完整链路，以及前端能做的最小干预。
3. `window.__PAGE_START__`→首帧 与 performance FCP 两个口径分别回答什么问题？为什么要同时做？
4. 白屏率的"3s 无首帧内容节点"定义里，"首帧内容节点"为什么比"像素统计"更稳？
5. 动手：在你容器里用真机压一个长列表页，记录它接近被杀前的 WebContent 内存峰值与 FPS，写进你团队的校准表。

<details>
<summary>参考答案（思考后再点开）</summary>

1. iOS 在 WebContent 进程，从 App 进程剥离独立。阈值因设备/系统版本/内存压力动态变化、无公开固定值，且 JS 只读 JS 堆（非整进程），只能靠容器按进程口径实测校准。
2. 列表/大图/监听撑爆渲染进程 → 触及回收阈值 → WebContent/渲染进程被杀 → 白屏（可自愈 reload）。前端最小干预：虚拟列表保 DOM 上限、图降分辨率、监听成对清理。
3. 前者=用户感知总耗时（含容器段）；后者=页面自身渲染快慢（纯 Web）。前者答"体验好不好"，后者答"页面自己慢在哪"，两者才能归因容器 vs 页面。
4. 像素统计对"渲染了但内容空的空态（D 类）"无能为力，会误判成白屏；"首帧内容节点"是业务口径，能排除纯空态。
5. 动手题：记录实测的 WebContent 峰值与 FPS 作为校准基准——不同设备/系统/内核的回收点不同，只能实测。

</details>

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| 首帧 | 页面第一次真正画出内容的那一帧，用户能从"白"变为"看见东西"的时刻 |
| 启动耗时 | 从用户点下去到页面可用所花的全部时间，由多段耗时拼成，不是单指渲染 |
| 归因 | 把总耗时按责任切分到容器/网络/前端，回答"慢在谁那一拍" |
| performance.mark | 手动给某个时刻打标记，配合 measure 算两标记之间的耗时 |
| performance.measure | 用两个 mark 算出一段耗时的 API，前端打点的标配 |
| performance.timeOrigin | 页面时间原点的绝对时刻，用来把内核时钟换算成真实时间 |
| 内核时钟 | 页面加载后从 0 开始计时的时间轴（performance API），基准与设备时钟不同 |
| 预热池 | 提前建好闲置 WebView 的机制，命中时新建内核的几百毫秒降到几十毫秒 |
| 预热收益模型 | 一条公式：省下的时间 × 命中率 − 闲置成本 − 兜底重载成本，判断预热是否划算 |
| WebContent 进程 | iOS 上承载网页渲染的独立进程，内存另算，被系统回收就是白屏 |
| 渲染进程被杀 | 进程内存吃爆被系统回收，页面内容消失，表现是"App 在、页面白" |
| 管道二 | WebView 内置网络栈这趟请求通道，默认不在客户端网络库监控范围内 |
| 离线包命中 | 主文档直接取自本地缓存包而非网络，⑤⑥ 段耗时可趋近于零 |
| 跨时钟换算 | 把容器时钟和内核时钟对齐再算差值，避免负时长或离谱误差 |
| 白屏 | 页面容器在、内容却是空的，与"慢"是两个不同的问题 |
| 白屏率 | 超过设定超时仍无首帧内容的会话占比，必须带时间阈值才算数 |
| 归因决策树 | 用"网络→文档→渲染→数据"逐层提问，把白屏分流到四类根因的排查路径 |
| WebContent 进程被杀 | iOS 网页渲染进程被系统回收，页面连 DOM 都没了，只能靠容器回调确认 |
| 截图像素统计 | 对 WebView 截图栅格化、统计接近背景色像素占比来判断白不白 |
| MTT | 定位一个问题平均要花多少时间的指标，先查便宜的日志比连调试器快 |
| FCP | 浏览器首次画出一块内容的时间点，有值说明内核确实渲染了东西 |
| 首帧内容节点 | 页面自己标记的"真画出来了"的业务节点，用于区分真是白屏还是空态 |
| 空态（D 类） | 接口返回空、页面渲染了"没数据"的占位，视觉上是白但不是白屏 |
| JS 早期异常 | 入口脚本一跑就崩，挂载点永远空着导致的 C 类白屏 |
| onRenderProcessGone | Android 的渲染进程被回收时的回调，容器据此上报 A 类白屏 |
| webViewWebContentProcessDidTerminate | iOS WebContent 进程被杀时容器收到的回调，A 类白屏的第一现场 |
| 采样率 | 抽样分析的用户占比，全量截图太贵，只对部分 case 采样 |
| 合成层 | 独立上屏的一层位图，多几个能省重绘，乱开一堆却会挤爆 GPU 内存 |
| 合成层爆炸 | 对几十上百个节点都开合成层，把"想省滚动"变成"滚动更卡" |
| will-change | 提前告诉浏览器某个属性要动、先给它造好合成层的 CSS 声明 |
| 长列表 | 一次渲染成千上万行的列表，DOM/GC/图片解码全压在渲染进程里 |
| 虚拟列表 | 只渲染视口附近节点的方案，用来控制 DOM 数量和内存水位 |
| 掉帧 | 一秒钟画不满 60 帧，用户感觉画面一卡一卡 |
| 空滚动 | 滚动没内容的页面测帧率，用来隔离是滚动机制问题还是内容渲染问题 |
| requestAnimationFrame | 浏览器每帧回调一次的定时器，rAF 被长任务压掉就说明主线程在阻塞 |
| 长任务 | 主线程上卡住超过一定时长、挡了渲染/滚动的 JS 执行块 |
| 橡皮筋 | iOS 滚动到边界时的回弹效果，是系统行为别去禁 |
| FOIT/FOUT | 网络字体没到时的两种闪法：先隐藏或先回退，弱网下更明显 |
| loading="lazy" | 图片/iframe 进入视口附近才加载的属性，能否生效随内核版本而异 |
| overflow 滚动 | Android 上元素内部滚动的机制，与 iOS 橡皮筋手感不一样 |
| 内存泄漏 | 该释放的内存没释放（如没清理的监听），越用越卡直到被杀 |
| Jetsam | iOS 系统优先回收后台/低优先级进程的机制 |
| 回收阈值 | 系统杀进程的内存线，随设备与压力变动，只能实测校准 |
| performance.memory | 读 JS 堆大小的 API（Chrome 系才有），不等于整进程内存 |
| 崩溃率 | 由 App/渲染进程造成会话中断的占比，JS Error 不算崩溃 |
| 加载成功率 | load 且首帧出现才算成功，404/断网要单独立项 |
| 预热命中率 | 打开页面时命中预热好的 WebView 的比例，决定预热是否划算 |
| 自愈 | 进程被杀后容器自动 reload 把页面救回来的兜底机制 |
| T+1 看板 | 次日看到前一天数据的监控报表，每项指标要有 Owner 和口径 |
| P50/P90 | 把耗时的第 50/90 百分位拉出来看，比平均值更能暴露长尾 |
