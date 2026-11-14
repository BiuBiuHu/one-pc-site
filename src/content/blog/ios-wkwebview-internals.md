---
title: iOS WKWebView 深入
date: 2026-11-14
excerpt: "WKWebView 的多进程、脚本注入、导航弹窗、Cookie 同步与 302 竞态，以及视口、键盘和崩溃白屏自愈。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 4
lang: zh
draft: false
ogImage: /images/webview-and-native/stage3-01-wkwebview-process.png
---

> 📖 本章由 6 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · WKWebView 架构与多进程
- 2 · 配置与脚本注入
- 3 · 导航控制与弹窗的坑
- 4 · JS 与 Native 互调
- 5 · Cookie 与存储
- 6 · 视口 / 键盘 / 崩溃白屏自愈
- 本章术语表

---
## 1 · WKWebView 架构与多进程

---

### 1.1 问题引入

一个线上 case：iOS App 的 H5 详情页停在半截渲染状态，几秒后彻底白掉；用户点返回、切 Tab，App 一切正常；前端监控（JS 异常、资源加载）**没有收到任何报错**。客户端同学在崩溃平台也查不到记录。最后结论是一句谁都听了不舒服的话："页面进程没了"。

这一篇讲清楚三件事：WKWebView 到底是什么、它内部有哪些进程、以及"白屏但 App 活"发生时前端凭什么归因。

### 1.2 先破误区

> • 误区 一：WKWebView 是 App 里的一个"浏览器控件"，它挂了等于 App 崩了。
> • 事实：页面的解析、渲染、你的全部 JS 跑在独立的 WebContent 进程里。WebContent 被回收，App 主进程毫发无伤——这正是"白屏但 App 活着"的来源（见阶段 1 的"进程被杀"概念，iOS 侧的实体就是它）。

> • 误区 二：页面崩了可以从 JS 探测到，比如读一个 `window.__WEBKIT_CRASH__`。
> • 事实：不存在这种全局钩子（本文写作时各系统版本均无，以实测为准）。进程死亡时，页面里的 JS 定时器、事件循环、连同这个"探针"一起陪葬——页面内部发生不了任何求救信号。归因只能靠 App 进程这侧的 Swift 回调。

> • 误区 三：多开几个 WKWebView 而已，想开几个开几个，进程随便用。
> • 事实：iOS 14 起，每个 App 可用的 WebContent 进程有数量上限（社区实测约 10 个，以实测为准），超限后新建实例要复用进程或排队。多标签、直播间、多文档类容器必须按这个预算设计。

### 1.3 原理讲解

#### 1.3.1 UIWebView → WKWebView：一次"手术式"升级

| | UIWebView（iOS 2–11，已废弃） | WKWebView（iOS 8 起） |
|---|---|---|
| 内核归属 | 系统老 WebKit，**与 App 同进程** | 与 Safari **同一套现代 WebKit 引擎** |
| 渲染/JS | 跑在 App 进程内（WebThread） | 独立 WebContent 进程 |
| 崩溃影响 | 内核出错 → App 连坐崩溃 | 内核出错 → 页面白屏，App 活 |
| 内存记账 | 全记在 App 头上 | 渲染、网络记账在各自进程 |
| JS 引擎提速 | 被 JIT 政策卡死 | 进程隔离后 JIT（Nitro/FTL）解禁 |

升级的本质不是"换个类名"，而是**把 Web 从 App 进程里挪了出去**。这也回答了阶段 1 留下的问题：为什么 iOS 没有第三方内核——壳（UIKit 组件）你可以选，引擎是系统统一提供的，是你 App 的一组子进程，不是共享常驻服务。

#### 1.3.2 进程角色：外壳 ⇄ WebContent ⇄ 辅助

![WKWebView 多进程架构：App 外壳、WebContent 与辅助进程群](/images/webview-and-native/stage3-01-wkwebview-process.png)


你 `new` 出来的 `WKWebView` 对象本身只是**App 进程里的一层 API 外壳**：配置、`WKNavigationDelegate`/`WKUIDelegate` 回调、`scrollView`、主线程时序都在这侧。真正的网页活在 **WebContent 进程**：DOM、CSS、你的 `fetch`、事件循环、`window.webkit` 都在那里。再往外是辅助进程群——**Networking 进程**（WebKit 内置网络栈，即总章说的"管道二"，H5 所有请求从这里发出）、**Storage 计量**（Cookie 与站点存储归属 `WKWebsiteDataStore`，按 DataStore 路由而非按 WebView）、以及 GPU/合成支撑。这些子进程归你 App 所有，在 Xcode 的 Memory Graph 里能看到，随 App 存亡。

#### 1.3.3 iOS 14+：每 App 的 WebContent 进程上限

早期 iOS 里，WebKit 对"开多少个渲染进程"比较放任；**iOS 14 起系统给每个 App 的 WebContent 进程设了上限**（社区实测约 10 个，以实测为准）。超限后的行为：新建 WKWebView 不再独享新进程，而是复用/共享已有进程或等旧进程回收。多 WebView 容器（多标签、预加载下一个页面、悬浮窗播放器）在 iOS 14 前后手感不同的根因就在这。

**实测思路**：在 App 里循环创建 20 个 WKWebView 并各自 load 一个页面，打开 Xcode → Debug → Memory Graph，数 `WebContent` 条目；再换成共享 `WKProcessPool` 的写法对比数量变化（以实测为准）。

#### 1.3.4 "WebContent 挂了 → 白屏但 App 活"

进程隔离的本质是**故障隔离**：页面 JS 死循环、内存超限被系统 jetsam 回收、渲染崩溃，全部限定在 WebContent 里。用户侧表现：最后一帧画面残留或纯白、触摸无响应；App 侧表现：无崩溃日志、Tab 照常切换。阶段 8 讲的白屏自愈（06 篇给恢复策略）就建立在这个机理上。

#### 1.3.5 WKProcessPool 的现状与历史意义

`WKProcessPool` 至今仍是**一个没有公开属性的"分组标记"**。它的历史意义：早期系统上，共享同一个 pool 的多个 WKWebView 倾向于共用同一个 WebContent 进程——同进程意味着同 cookie 罐子，于是老项目流传下"多实例要共享 pool"的口诀，**它当年确实是为了进程复用与 Cookie 一致**。现状：iOS 11 起 Cookie 的正确抓手是挂在 `WKWebsiteDataStore` 上的 `WKHTTPCookieStore`，Cookie 语义跟着 DataStore 走而不是跟 pool 走；共享 pool 仍有合并进程的倾向，但把 pool 当 Cookie 方案属于历史误用（05 篇展开，以实测为准）。

#### 1.3.6 SFSafariViewController / ASWebAuthenticationSession 的边界

这两个是"整屏浏览器任务"，不是 WKWebView 的替代品：

| | SFSafariViewController | ASWebAuthenticationSession | WKWebView |
|---|---|---|---|
| 定位 | 满屏打开一条外部链接 | OAuth 授权跳转（`callbackScheme` 回跳） | 嵌在你页面里的容器 |
| 注入 JS / 装桥 | 不可以 | 不可以 | 可以 |
| Cookie | Safari 体系(cookie 隔离随版本有差异，以实测为准) | 与 Safari 联动（免重复登录） | 你 App 的 DataStore |
| UI 定制 | 几乎没有 | 没有 | 完全可定制 |

**判断标准**：页面需要"桥、容器能力（注入 UA/离线包/Cookie 同步）、与 App 共享登录态"——必须 WKWebView。纯粹的"打开一份协议页""跑一遍第三方 OAuth"——用前两者更省事也更安全。

### 1.4 代码验证

**平台 · iOS（Swift）**——WebContent 崩溃的归因最小实现，粘进任意 `WKNavigationDelegate` 所在类：

```swift
import WebKit

extension MyWebContainer: WKNavigationDelegate {
    // 关键回调 1：WebContent 进程被回收（最直接的信号）
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[WK] WebContent 进程被回收 → 白屏现场，触发自愈/上报")
    }

    // 关键回调 2：导航未提交即失败。网络错误常在 NSURLErrorDomain，
    // 进程回收场景实测也常从这里冒错误（domain/code 以实测为准）
    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        let e = error as NSError
        NSLog("[WK] provisional fail domain=\(e.domain) code=\(e.code) \(e.localizedDescription)")
    }
}
```

**平台 · H5（JS）**——证明"页面内部没有求救信号"：进程死亡后，页面里的任何东西都取不到。

```js
// 页面里埋一个心跳探针
window.__HEARTBEAT__ = 0;
setInterval(() => { window.__HEARTBEAT__++; }, 1000);

// 白屏现场，容器侧用 evaluateJavaScript 读探针：
// 读得到数值 → JS 进程活着，是"加载慢/逻辑问题"；
// 回调超时或报错 → WebContent 已亡，走崩溃自愈（以实测为准）。
console.log(typeof window.__WEBKIT_CRASH__); // "undefined"：根本不存在这种钩子
```

### 1.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 白屏但 App 活 | H5 无响应，App 正常，双端监控都干净 | WebContent 进程被回收 | 容器实现 `webViewWebContentProcessDidTerminate`，触发重建自愈（06 篇） |
| 想从 JS 拿崩溃信号 | 找不到 API / 探针从未触发 | 页面 JS 与进程同生共死 | 归因一律走容器侧回调与 NSError domain/code |
| iOS 14+ 多 WebView 异常 | 并发的页签打不开/互相拖累 | 每 App WebContent 进程有上限 | 控制并发 WebView 数；评估共享进程池 |
| 拿 WKProcessPool 同步 Cookie | 时好时坏，升级后彻底失灵 | Cookie 语义已归 `WKWebsiteDataStore` | 用 `WKHTTPCookieStore`（05 篇） |
| 用 SFSafariViewController 装业务页 | 装不了桥、拿不到登录态 | 它不是容器，是小型 Safari | 带桥/带登录态的页面一律 WKWebView |

### 1.6 自测题

1. "WKWebView 崩了导致 App 闪退"这句话哪里错了？用进程语言重说一遍。
2. 为什么页面内部不可能探测到"自己所在进程死亡"？这决定了归因必须怎么做？
3. iOS 14 起，并发开 15 个各 load 不同网站的 WKWebView，WebContent 进程数大约是多少？多出来的 WebView 会怎样？
4. 老代码靠"多实例共享 WKProcessPool"保 Cookie 一致，为什么在现在的系统上不可靠？正确抓手是什么？
5. 产品要在你的 App 里打开一个第三方 OAuth 授权页并回跳，该用 WKWebView 还是 ASWebAuthenticationSession？说出一个关键取舍。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 错在主体：App 进程没有崩。崩/被回收的是 **WebContent（渲染+JS）进程**，表现为页面白屏或冻结，App 主进程存活。
2. 求救信号的发送方（页面 JS）与崩溃同生共死，信号发不出进程边界。归因必须由**活着的 App 进程侧**完成：`webViewWebContentProcessDidTerminate`、`didFailProvisionalNavigation`、NSError domain/code（以实测为准）。
3. 约 10 个（社区实测，以实测为准）；超限的新 WebView 复用/共享已有进程或等待回收。
4. pool 只决定进程分组，不承诺 Cookie 同步语义；iOS 11 起 Cookie 归 `WKWebsiteDataStore.WKHTTPCookieStore` 管。正确姿势是"写 Cookie 等 completion 再 load"（05 篇）。
5. 授权页属于标准 OAuth 场景，优先 `ASWebAuthenticationSession`：有 Safari 联动 Cookie（已登录免重输）、无注入面、回跳走 `callbackScheme`。除非需要在授权页里装桥/深度定制 UI，才退回 WKWebView。

</details>

---

## 2 · 配置与脚本注入

---

### 2.1 问题引入

前端反馈："容器注入的桥，我们页面首屏偶尔拿不到，第二次进入就好了。"客户端同学回一句："脚本我明明 atDocumentEnd 注入了。"两边都觉得自己没改过任何东西。这类"时有时无"十有八九是**注入时机**与**配置归属**没对齐——这一篇把 `WKWebViewConfiguration` 全景和两个注入点的精确语义讲透。

### 2.2 先破误区

> • 误区："atDocumentEnd 就是 DOMContentLoaded 的回调，我按 DOM 事件理解就行。"
> • 事实：官方只承诺时序区间，不承诺与 DOMContentLoaded 等价。相对顺序可能随系统版本变化，必须用探针实测（下文给验证代码）。

> • 误区："UserScript 每次路由切换都会重新注入。"
> • 事实：UserScript 只在导航时注入（主文档导航一次）。SPA 的 pushState/hash 路由切换不产生导航，不会重放；路由级逻辑要页面自己挂钩子。

> • 误区："configuration 是 webview 的属性，随时改随时生效。"
> • 事实：`WKWebViewConfiguration` 的大量设置（DataStore、UserScript、processPool）在 `init(frame:configuration:)` 那一刻生效，创建后再改要么不生效要么行为怪异。姿势是先配好 configuration，再创建 WKWebView。

### 2.3 原理讲解

#### 2.3.1 configuration 三大件

![WKUserScript 注入时机时间轴](/images/webview-and-native/stage3-02-userscript-timing.png)


| 组件 | 管什么 | 常用点 |
|---|---|---|
| `WKPreferences` | 渲染偏好 | `minimumFontSize`；JS 开关自 iOS 13 起挪到 `WKWebpagePreferences.allowsContentJavaScript`（按导航粒度设置） |
| `WKUserContentController` | 注入与消息 | `addUserScript`、`addScriptMessageHandler`（04 篇） |
| `WKWebsiteDataStore` | Cookie/存储归属 | `.default()`（落盘、App 内持久）vs `.ephemeral()`（内存态、退出即逝） |

**DataStore 的选择直接决定 Cookie 与存储归属**：default 数据落在本 App 沙盒目录，`WKHTTPCookieStore` 读写的是它；ephemeral 用内存存储，适合"阅后即焚"的浏览（预览页、分享暴露页）。页面里的 `localStorage` 也同样跟随 DataStore——这也是很多"预览页污染正式存储"问题的根。

#### 2.3.2 atDocumentStart：精确到那一条语句

官方语义：**文档元素已创建、后续内容与脚本尚未执行**。翻译成前端语言：`document.documentElement` 已存在、`readyState === "loading"`、`document.body` 大概率还是 null、**页面自己的 `<script>` 一个都没跑**。它是"网页还没开始跑"的空档，适合：改写环境（UA 补丁、`fetch` 钩子）、垫 `window.webkit` 兼容层、埋"先于一切"的埋点。

#### 2.3.3 atDocumentEnd ≠ DOMContentLoaded：给探针

`atDocumentEnd` 的注入点在 DOM 就绪之后、`load` 之前——但"是否恰好在 DOMContentLoaded 回调同一拍"**没有承诺**。不要写" injectionTime 与 DOMContentLoaded 事件等价"这种话，用代码说话：

**平台 · iOS（Swift）**——注入 `__TIME__` 探针，两个时机各记一笔：

```swift
let cfg = WKWebViewConfiguration()
let ucc = WKUserContentController()

let probe = { (phase: String) in
    "window.__TIME__ = window.__TIME__||{};" +
    "window.__TIME__.\(phase) = JSON.stringify({" +
    "  readyState: document.readyState," +
    "  hasBody: !!document.body" +
    "});"
}

// injectionTime 只换这一处，其余相同
ucc.addUserScript(WKUserScript(source: probe("start"), injectionTime: .atDocumentStart, forMainFrameOnly: true))
ucc.addUserScript(WKUserScript(source: probe("end"),   injectionTime: .atDocumentEnd,   forMainFrameOnly: true))
cfg.userContentController = ucc

let wv = WKWebView(frame: .zero, configuration: cfg)   // ① 先配好 config ② 再建 webview
wv.navigationDelegate = self
wv.load(URLRequest(url: testURL))

// 页面 load 后读取探针（自行实现 webView(_:didFinish:)）：
wv.evaluateJavaScript("JSON.stringify(window.__TIME__)") { r, _ in
    print("[__TIME__]", r as? String ?? "nil")
}
```

**平台 · H5（JS）**——页面上打补丁同时监听 DOM 事件，与注入记录对齐：

```js
addEventListener('DOMContentLoaded', () =>
  window.__TIME__ && (window.__TIME__.dcl = document.readyState));
addEventListener('load', () =>
  window.__TIME__ && (window.__TIME__.load = document.readyState));
```

对比输出里的 `readyState` 与 `hasBody`，就能确证你的机型/系统版本上两个注入点各落在哪个阶段（结论以实测为准）。

#### 2.3.4 addUserScript 的叠加与 SPA

`addUserScript` **不去重**：同一条脚本 add 两次就执行两次。正确姿势是每次进入页面**新建** configuration（或维护"只 add 一次"的复用池）。同时记住 SPA 规则：路由切换不触发 UserScript 重放——桥的可用性校验、PV 埋点要页面侧监听 `popstate`/`hashchange`，这正是阶段 4 "Bridge 注册与注入"的前置知识。

#### 2.3.5 synchronous 选项的代价

iOS 14+ 起可用 `WKUserScript(source:injectionTime:forMainFrameOnly:contentWorld:synchronously:)`。同步注入会**阻塞**：页面脚本必须等你这条脚本跑完才开始。收益是"一次成型"——脚本内部的多步赋值不会被页面脚本插队读走中间态。代价是拖慢首帧。**只在 ContentWorld 与页面隔离（非 `.page`）时生效**，`.page` 世界会忽略它（以实测为准）。只放必须先于页面脚本运行的小 bootstrap，别把业务堆进去。

#### 2.3.6 "原生先注入对象 readiness" 的前置条件

页面第一个脚本能看到 `window.webkit.messageHandlers.<name>`，前提是 **handler 在 webview 创建之前/首字节到达之前已注册在 configuration 上**。时序口诀：**注册 handler → 建 WebView → loadRequest**。缺 handler 时 `window.webkit` 可能是 undefined，前端判断桥存在性写 `window.webkit?.messageHandlers?.nativeBridge`（阶段 4 展开协议设计）。

### 2.4 代码验证

**平台 · iOS（Swift）**——总章视角的三种注入方式同框（完整可跑版在 `demo/stage-3-ios/WKWebViewController.swift`）：

```swift
// 方式一：UserScript 注入"环境补丁"（无回调，纯改页面世界）
let ua  = WKUserScript(source: "window.__IS_CONTAINER__ = true;",
                       injectionTime: .atDocumentStart, forMainFrameOnly: true)
ucc.addUserScript(ua)

// 方式二：注册 messageHandler——H5 可主动调原生（双向通道见 04 篇）
ucc.add(self, name: "nativeBridge")   // H5→Native 通道（API 细节见 04 篇）

// 方式三：evaluateJavaScript——原生主动注入/取值（主线程调用）
wv.evaluateJavaScript("window.__VERSION__ = 'v1'") { _, _ in }
```

三者分工：**① 时机型注入**（atDocumentStart/End，先于页面）→ **② 通道**（H5→Native，事件驱动）→ **③ 主动注入**（Native→H5，手拉手）。容器三种都会用，页面只需要认识 `window.webkit` 和收"回流"。

### 2.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 桥"偶发拿不到" | 首进偶发、复进正常 | 页面脚本早于 handler 就绪 | 容器：注册→建 WebView→load 的固定顺序；页面：就绪握手 |
| atDocumentEnd 当 DOMContentLoaded 用 | 某版本上顺序对不上 | 官方不承诺等价 | `__TIME__` 探针实测（本文 §2.3.3） |
| 脚本执行了两次 | 埋点翻倍/逻辑重复 | `addUserScript` 不去重 | 新建 configuration 或"只 add 一次" |
| SPA 路由后桥逻辑不跑 | 切页后无埋点 | UserScript 不随路由重放 | 页面监听 `popstate`/`hashchange` |
| 创建后改 configuration | 改了没效果/行为怪 | 大量配置仅 init 前生效 | 先配好 config 再 `init(frame:configuration:)` |
| 滥用 synchronous | 首帧变慢 | 阻塞页面脚本 | 只放微型 bootstrap；非 `.page` ContentWorld 才生效 |

### 2.6 自测题

1. `atDocumentStart` 注入时，`document.readyState`、`document.body`、页面 `<script>` 三者各处于什么状态？
2. 为什么说"atDocumentEnd ≈ DOMContentLoaded"是不严谨的？用一句"承诺范围"的话重述正确关系。
3. 同一条 UserScript 被 add 了两次，后果是什么？怎么从工程上杜绝？
4. SPA 单页容器里，UserScript 注入的 PV 统计为什么第二次路由后不再触发？补一个前端层的补救。
5. `WKWebsiteDataStore.ephemeral()` 里种下的 Cookie 和 localStorage，什么时候消失？什么业务适合用它？
6. `synchronously: true` 什么时候值得开？开了之后最大的代价值是什么？

<details>
<summary>参考答案（思考后再点开）</summary>

1. `readyState === "loading"`；`document.body` 大概率为 null；页面自家 `<script>` **尚未执行**（只保证"文档元素已创建、后续内容与脚本尚未执行"）。
2. 官方只承诺"注入发生在 DOM 就绪之后、load 之前"的时序区间，不承诺与 DOMContentLoaded 回调同拍/等价；具体顺序以 `__TIME__` 探针在你的目标系统上实测为准。
3. 执行两次 → 埋点/补丁翻倍。工程上加"只 add 一次"的门闩，或每次进入页面新建 configuration。
4. UserScript 只随导航注入，SPA 路由不产生导航。页面侧在 `popstate`/`hashchange` 里重跑统计逻辑。
5. 关闭该 WebView/退出会话后随内存态销毁（不落盘）。适合临时预览、免污染正式登录态的一次性页面（边界细节以实测为准）。
6. 脚本必须"一次成型"且先于页面脚本时（如环境补丁、fetch 钩子 bootstrap）。代价：阻塞、拖慢首帧；且非 `.page` ContentWorld 才生效。

</details>

---

## 3 · 导航控制与弹窗的坑

---

### 3.1 问题引入

两个高频事故，都在 iOS 容器上：一是 H5 里 `<a target="_blank">` 的链接，用户点了**毫无反应**，安卓上却正常新开；二是 H5 的 `alert('提交成功')` 在某些 App 里**悄无声息地消失**，提交流程继续走但用户以为没点上。这两件事的共同根：容器该实现的 delegate 没实现——iOS 上"WKWebView 默认什么都不做"。

### 3.2 先破误区

> • 误区 一："和安卓一样，不写回调 WKWebView 也有默认弹窗。"
> • 事实：不实现 `WKUIDelegate` 的弹窗三件套，JS 的 `alert/confirm/prompt` 被静默吞掉——不弹窗、不阻塞，脚本继续走（confirm/prompt 的返回值约定为"取消"，具体取值以实测为准）。

> • 误区 二："`decidePolicyFor` 是拦截请求的，和安卓 `shouldInterceptRequest` 一回事。"
> • 事实：它只管导航（主文档/子 frame 的跳转），管不到子资源——H5 的 fetch/XHR/img 不经过它。iOS 侧替代 `shouldInterceptRequest` 的位置是 `WKURLSchemeHandler`（且仅限自定义 scheme，阶段 6/7 展开）。

> • 误区 三："decisionHandler 想调就调、晚点调也行。"
> • 事实：必须恰好调用一次。不调用 = WebKit 等待后按违约处理（App 崩掉/导航永久卡死，以实测为准）；调用第二次 = 直接崩溃。这是 iOS 锚点级红线。

### 3.3 原理讲解

#### 3.3.1 decidePolicyFor navigationAction 全解

每个"导航动作"（主文档跳转、iframe 跳转、service worker 发起的导航等）进入 WebKit 前都会在这里停一次，等你裁决：

```swift
func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = navigationAction.request.url
    // navigationAction.navigationType：这次导航从哪来
    switch navigationAction.navigationType {
    case .linkActivated:    break // 用户点了 <a>
    case .formSubmitted:    break // 表单提交
    case .backForward:      break // 历史前进/后退
    case .reload:           break // reload()
    case .formResubmitted:  break // 表单重提交
    case .other:            break // JS location 跳转、loadRequest、重定向跟随等
    @unknown default:       break
    }
    decisionHandler(.allow)                        // 或 .cancel
}
```

四个必记事实：**①** `navigationType == .other` 覆盖面极广（代码发起的跳转全部落这里），别用它区分"用户点的还是 JS 跳的"；**②** 重定向链上的每一跳都会再进这个回调；**③** 子 frame（iframe）导航也会进（`navigationAction.targetFrame.isMainFrame` 区分）；**④** H5 里 `fetch/XHR/img` **不进**这个回调。

#### 3.3.2 三层拦截：action / response / authChallenge

导航要过的闸口不止一道，而是**分层的三道闸口**，各层 delegate 方法分工明确：

| 层 | 回调 | 你拿什么裁决 | 典型用途 |
|---|---|---|---|
| ①动作层 | `decidePolicyFor: navigationAction` | URL、navigationType、frame | scheme 路由、白名单、target=_blank 转办 |
| ②响应层 | `decidePolicyFor: navigationResponse` | 响应头、MIME、状态码 | 按 Content-Disposition 拦下载；Content-Type 风控拦截 |
| ③证书层 | `didReceive: challenge` | URLAuthenticationChallenge | 自签证书、客户端证书、代理认证 |

三层都要求各自的 completionHandler **恰好一次**。取消已开始的主文档导航走 `.cancel`：已渲染内容保留、页面不跳；取消子 frame 导航只影响该 iframe。

#### 3.3.3 target=_blank 不响应：高频事故第一名

`<a target="_blank">`/`window.open` 在 WKWebView 里默认**既不开新页也不在当前页打开**，因为"开新窗"需要 App 提供一个新窗口——那是 `WKUIDelegate` 的职责：

```swift
func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    // 最常见取舍：塞回当前 webview（体验近似"本页跳转"）
    if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
    return nil   // 返回 nil = 不真的开新窗口
}
```

不实现它，安卓同事永远无法理解你 iOS 上"点了没反应"的 bug 单。记得连同 3.1 的 allow 一起裁决。

#### 3.3.4 WKUIDelegate：弹窗三件套一个都不能少

alert / confirm / prompt 全部依赖 UI Delegate 提供原生面板。最简实现三件套（Swift）：

```swift
func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    ac.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
    topVC?.present(ac, animated: true)
}
func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
             initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    ac.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
    ac.addAction(UIAlertAction(title: "取消", style: .cancel)  { _ in completionHandler(false) })
    topVC?.present(ac, animated: true)
}
func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
             defaultText: String?, initiatedByFrame frame: WKFrameInfo,
             completionHandler: @escaping (String?) -> Void) {
    let ac = UIAlertController(title: prompt, message: nil, preferredStyle: .alert)
    ac.addTextField { $0.text = defaultText }
    ac.addAction(UIAlertAction(title: "确定", style: .default) { _ in
        completionHandler(ac.textFields?.first?.text) })
    ac.addAction(UIAlertAction(title: "取消", style: .cancel)  { _ in completionHandler(nil) })
    topVC?.present(ac, animated: true)
}
```

两个延伸，点到为止：**prompt 还能当通道**——H5 侧"同步式"传数据给原生（prompt 的返回值即回执），老牌桥库借它做过同步通信，Android 侧有 `onJsPrompt` 的对应玩法，同构思路可给阶段 4 铺垫（prompt 通道**是否要用作桥**：能用，但阻塞 UI、超时不可控，现代方案首选 `WKScriptMessageHandler`，04 篇）；**输入/文件类面板**还有 `runJavaScriptTextInputPanel`（上文）、`runOpenPanelWithParameters`（`<input type=file>` 的系统文件选择器）等，实现套路相同——**每个 completionHandler 都要调**。

#### 3.3.5 错误页自绘：didFailProvisionalNavigation 与 didFail 是两回事

| 回调 | 时机 | 典型错误 |
|---|---|---|
| `didFailProvisionalNavigation` | 导航**尚未提交**就失败（页面还是旧的/空白） | DNS 失败、断网、TLS 握手失败（NSURLErrorDomain 系列） |
| `didFail` | 导航**已提交之后**中途失败 | 渲染/加载中断、部分资源导致的导航失败（错误域与码以实测为准） |

两者发生时页面处于完全不同的状态：前者你还能"留在旧页"或"换错误页"，后者页面世界已经半死。自绘错误页的最小骨架：

```swift
func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    let e = error as NSError
    guard e.domain == NSURLErrorDomain else { return }        // 归因：网络类才自绘
    showNativeErrorPage(url: webView.url, code: e.code)       // 用原生视图盖住 webview
}
```

白屏与失败的完整分流矩阵（含进程级死亡）见 06 篇自愈策略。

### 3.4 代码验证

**平台 · iOS（Swift）**——三层拦截 + 弹窗桥回执的最小链路（并入 `WKNavigationDelegate` + `WKUIDelegate`）：

```swift
// ① 动作层：scheme 路由 + target=_blank 兜底
func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    if url.scheme == "myapp" { Router.open(url); return decisionHandler(.cancel) }
    decisionHandler(url.host.map(whiteList.contains) == true ? .allow : .cancel)
}
// ③ 证书层：自定义信任判断（示例：company 证书放行，其余默认处理）
func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
             completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    completionHandler(.performDefaultHandling, nil)
}
```

**平台 · H5（JS）**——验证"弹窗被吞"与 prompt 回执：

```js
console.log(alert('这条如果没弹，说明 WKUIDelegate 没实现'));   // 阻塞？无感？
const ok = confirm('确认吗？');      // 被吞 → 约定为 false（以实测为准）
const v  = prompt('输入 token');     // 被吞 → 约定为 null（以实测为准）
```

对照实验：同一段代码在实现/不实现三件套的容器里各跑一遍，两端的感知差异立刻对齐。

### 3.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| decisionHandler 漏调/双调 | App 崩溃（违约），console 可见 "exactly once" 类断言 | WebKit 视为 delegate 违约 | 每条分支**恰好一次**；用 `defer`/单一出口写法 |
| target=_blank 没反应 | H5 链接点击无响应，安卓正常 | 未实现 `createWebViewWith` | WKUIDelegate 里接住并 load（§3.3.3） |
| alert/confirm 消失 | 提交成功提示不见了 | 未实现 WKUIDelegate 弹窗三件套 | 实现三个面板方法，completionHandler 必调 |
| fetch 走不进拦截 | 白名单请求抓不到/改不了 | decidePolicyFor 只管导航 | 子资源另寻方案（WKURLSchemeHandler，阶段 6/7） |
| 错误页误伤 | 正常页被错误页顶掉 | 把 didFail 当 didFailProvisional 用 | 按两回调语义分流自绘逻辑 |

### 3.6 自测题

1. `decisionHandler` 调了两次，或不调用，分别会发生什么？
2. 为什么 `navigationType == .other` 不能当作"用户没点"的判断依据？举两个会落进 `.other` 的场景。
3. H5 的 `fetch('/api/x')` 会进入 `decidePolicyFor` 吗？那进入哪一层（或者说哪个设施）？
4. 不实现 `WKUIDelegate` 弹窗三件套时，`alert/confirm/prompt` 各表现成什么样（以实测为准的约定值）？
5. 断网时打开一个新页面，触发的应该是哪个回调？页面此刻还是旧内容吗？
6. 想拦"响应是 zip 就下载"，该在三层枪口的哪一层做？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 两次：WebKit 认为违约，直接崩溃；零次：WebKit 等待导航决定，最终同样按违约处理（崩溃/卡死形态以实测为准）。红线：恰好一次。
2. `.other` 是"非用户交互类导航"的大杂烩：`loadRequest`、`location.href`、重定向跟随都落这里；它是"代码发起"而非"用户不点"的可靠信号。
3. 不会。`decidePolicyFor` 只管导航（主文档/子 frame）；子资源请求归 WebKit 内置网络栈，自定义拦截走 `WKURLSchemeHandler`（仅自定义 scheme）。
4. alert 不弹不阻塞继续；confirm 约定按"取消"→ false；prompt 约定 → null（返回值细节以实测为准）。
5. `didFailProvisionalNavigation`——导航没提交，页面保留旧内容，适合"提示网络错误并留在旧页"。
6. 响应层：`decidePolicyFor: navigationResponse`，看响应头/MIME 后 allow 或 cancel。

</details>

---

## 4 · JS 与 Native 互调

---

### 4.1 问题引入

线上一个"回调全丢"的 case：H5 调 `bridge.getData` 拿设备信息，90% 正常，偶发整批回调没有返回。排查到最后是 iOS 侧 bridge 对象被 `dealloc` 抢跑了——`WKScriptMessageHandler` 的 **持有关系**没处理好，回调随着对象销毁一起没了。这一篇把 iOS 互调的两个方向 + 内存清理讲透，并给一个双端可跑的 Demo。

### 4.2 先破误区

> • 误区 一："iOS 调 H5 用 `loadURL("javascript:...")`，安卓才用 evaluate。"
> • 事实：iOS 用 `evaluateJavaScript(_:completionHandler:)`，回调在主线程。"往导航里塞 `javascript:` 串"是 Android `loadUrl("javascript:")` 时代的老路，WKWebView 上并无等价可靠做法（无返回值、时机飘忽），放弃它。

> • 误区 二："回调放哪儿都一样，闭包捕获了对象自然会活着。"
> • 事实：H5→Native 的方向链是 `window.webkit.messageHandlers.x` ← `WKScriptMessageHandler` ← 你 add 进去的 self。`add(_:name:)` 会 strong 持有 self——换成 block 式 handler + `[weak self]` 也治标不治本，必须配 `removeScriptMessageHandler` 或在 deinit 里移出，否则对象出不掉、回调没保障。

> • 误区 三："iOS 一次注册一个 name 一个方法，和安卓一样。"
> • 事实：iOS 是单通道多 name（一个 handler 可注册多个 name，按 name 分发）；安卓是单对象多方法（`addJavascriptInterface` 注入一个对象，JS 直呼其方法）。语义模型不同，写桥时要对齐习惯。

### 4.3 原理讲解

#### 4.3.1 H5 → Native：注册 → postMessage → 回调主线程

三步走，链条拆开看：

1. **注册**：`userContentController.add(self, name: "nativeBridge")`。
2. **消息**：页面执行 `window.webkit.messageHandlers.nativeBridge.postMessage({...})`。
3. **回调**：`WKScriptMessageHandler` 的回调方法在 **主线程**跑，参数 `WKScriptMessage.body` 是 JS 传过来的值（对象自动转成 Swift 侧的类型，如 `[String: Any]`）。

前端视角一句话：**`window.webkit.messageHandlers.<name>.postMessage(数据)`**。这是与安卓 `addJavaScriptInterface` 完全不同的入口——没有"对象方法反射"，只有"命名通道 + 一次一帧消息"。

#### 4.3.2 持有关系：不清理就泄漏（编译器不会提示你）

`addScriptMessageHandler(_:name:)` 的第一个参数被**强引用**。最常见病灶：VC 里写 `config.userContentController.add(self, name:…)`，然后 `self` 永生。

```swift
deinit {
    config.userContentController.removeScriptMessageHandler(forName: "nativeBridge")
}

// 轻量适配器：把协议回调转成闭包，方便配合 [weak self]
final class BlockMessageHandler: NSObject, WKScriptMessageHandler {
    let onMessage: (WKScriptMessage) -> Void
    init(_ onMessage: @escaping (WKScriptMessage) -> Void) { self.onMessage = onMessage }
    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        onMessage(message)
    }
}
// 注册；iOS 14+ 也可用 addScriptMessageHandler(_:contentWorld:name:) 指定 ContentWorld
config.userContentController.add(
    BlockMessageHandler { [weak self] msg in self?.route(msg) },
    name: "nativeBridge")
```

清理时机：**退出页面前** `removeScriptMessageHandler`。注意 `add(self, name:...)` 已对 handler 强持有，**deinit 不会触发**，必须显式移除。不清理的两笔账单：VC 泄漏（Memory Graph 长红）、以及**对象被回收时回调跟着丢**（开篇那个 case 的根因）。

#### 4.3.3 Native → H5：evaluateJavaScript 与 JSON 解析

```swift
// 参数转义（防 JS 字符串注入）；回调主线程
let safe = name.replacingOccurrences(of: "\\", with: "\\\\")
               .replacingOccurrences(of: "'", with: "\\'")
wv.evaluateJavaScript("window.renderHello('\(safe)')") { result, err in
    guard err == nil, let json = result as? String else {
        if let e = err as NSError? { print("[JS] \(e.domain) \(e.code)") }
        return
    }
    // renderHello 返回 JSON.stringify 的字符串 → 本地反序列化
    let dict = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
    print(dict?["ok"] as? Bool ?? false, dict?["at"] as? Double ?? 0)
}
```

铁律三点：**主线程调用**（非主线程调用会怎样以实测为准，直接写 main 保险）；**把值序列化成 JSON 字符串喂**；**completion 里解析回来**——JS 里 `JSON.stringify(obj)` 返回字符串，本地 `JSONSerialization` 再转对象，是标准往返。

#### 4.3.4 iOS vs Android：互调语义差对比

| 维度 | iOS（WKWebView） | Android（addJavascriptInterface） |
|---|---|---|
| H5→原生入口 | `window.webkit.messageHandlers.<name>.postMessage` | `window.<obj>.<method>(...)` 反射调用 |
| 通道模型 | 单通道 · 多 name | 单对象 · 多方法 |
| 数据格式 | 消息体自动桥接（对象按字典） | 参数直传，对象方法参数类型受限 |
| 回调线程 | `didReceive` 主线程 | 运行在名为 `JavaBridge` 的后台线程 |
| Native→H5 | `evaluateJavaScript:completionHandler:`（主线程） | `evaluateJavascript`（主线程）+ `postMessage` |
| 内存 | handler strong 持 self，须 remove | `@JavascriptInterface` 对象随 WebView 释放 |

**写桥时对齐这套差异**是阶段 4 的主题：同一份桥协议，两端语义不同——iOS 倾向"命名通道 + 消息体"，Android 倾向"对象方法"。

### 4.4 代码验证

**平台 · 双端可跑 Demo** —— 完整最小工程见 `demo/stage-3-ios/WKWebViewController.swift` + 配对 `bridge-demo.html`。这里摘出互调核心两块：

**iOS（Swift），Native → H5 的 renderHello + H5 → Native 的 showToast with completion：**

```swift
// H5 → Native：在 didReceiveScriptMessage 里按 name 路由
func userContentController(_ userContentController: WKUserContentController,
                           didReceive message: WKScriptMessage) {
    guard message.name == "nativeBridge",
          let body = message.body as? [String: Any],
          let action = body["action"] as? String else { return }
    switch action {
    case "showToast":
        let p = body["payload"] as? String ?? ""
        toast(p)   // 弹原生 toast
        // 回执给 H5（约定见 bridge-demo.html）：
        let js = "window.__bridgeCB && window.__bridgeCB('ok','toast done')"
        webView.evaluateJavaScript(js) { _, _ in }
    default: break
    }
}

// Native → H5：完成后 JS 把名字写进容器可见区（safeName 为已转义的名字）
webView.evaluateJavaScript("window.renderHello('\(safeName)')") { r, e in
    print("[evaluateJs]", r as? String ?? (e as NSError?)?.localizedDescription ?? "")
}
```

**H5（bridge-demo.html），配对前端：**

```html
<script>
  // 1) 等桥就绪（缺失=容器没注册）
  if (window.webkit?.messageHandlers?.nativeBridge) {
    window.webkit.messageHandlers.nativeBridge.postMessage({
      action: 'showToast', payload: '从 H5 发来'
    });
  } else {
    console.warn('[bridge] webkit.messageHandlers.nativeBridge 未注册');
  }
  // 2) 原生主动调用的渲染函数
  window.renderHello = function (name) {
    document.getElementById('greet').innerText = 'Hello, ' + name;
    return JSON.stringify({ ok: true, at: Date.now() }); // 供 evaluateJavaScript completion 取回
  };
  // 3) 原生的"回执"钩子（与 showToast 的 completion 呼应）
  window.__bridgeCB = function (code, msg) {
    document.getElementById('cb').innerText = code + ' ' + msg;
  };
</script>
```

对照 Demo 目录的 `README.md` 拼装说明运行即可。

### 4.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 回调偶发全丢 | bridge 返回时有时无 | handler 强持的 self 被回收 | 退出前 `removeScriptMessageHandler`/deinit 清理 |
| `window.webkit` 是 undefined | H5 判桥失败静默降级 | handler 注册晚于页面脚本 | 注册→建 WebView→load 的固定顺序；H5 做就绪巡逻 |
| evaluateJavaScript 在子线程调 | 崩溃/异常（以实测为准） | API 要求主线程 | 统一 `DispatchQueue.main` 包装 |
| JS 返回值取到的是字符串 | JSON 版 Object 被当字典 | 没做反序列化 | NSJSONSerialization / `as? [String: Any]` |
| 回调里强持 webview | convert 内存那条链卡死 | 闭包捕获 | `[weak self]`，配合 remove handler |
| 想同步取 JS 值 | 拿不到"立刻的"值 | evaluate 是异步的 | 用 completionHandler 或消息回执，别硬凑同步 |

### 4.6 自测题

1. `window.webkit.messageHandlers.nativeBridge.postMessage(x)` 里 `postMessage` 调用发生在哪个线程的信号通路？（提示：三个角色各在哪侧）
2. 为什么 `removeScriptMessageHandler` 不做会"回调偶发丢"？
3. iOS 注册 handler 时把哪一侧的对象强持了？用什么姿势避免闭包侧泄漏？
4. 对比 iOS / Android 的互调模型，各举一句"语义差"。
5. `evaluateJavaScript` 的 completion 回调里，`result` 的类型和线程有何约定？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 页面侧 JS 在 WebContent 进程执行 → 走 iOS message handler 机制 → 回调你的 App 主线程 `didReceiveScriptMessage`。链路两端都是"各自进程 + 主线程回包"。
2. handler 强持 self，self 无法释放；对象一旦被回收，已注册的消息回调随之失效 → "时有时无"。
3. 强持的是你传进去的对象（`add(_:name:)` 的 self）。用 `addScriptMessageHandler(_, name:, contentWorld:)` + `[weak self]`，并 deinit/退出前 remove。
4. iOS = 单通道多 name（`messageHandlers.<name>`）+ 一帧一消息体；Android = 单对象多方法（`window.<obj>.<method>()`），回调跑 `JavaBridge` 后台线程。
5. 回调在主线程；JS 的 object 被桥接为 NSDictionary/NSArray 等本地类型，字符串 JSON 需自行反序列化（以实测为准）。

</details>

---

## 5 · Cookie 与存储

---

### 5.1 问题引入

一个"偶发丢登录"的车祸现场：用户在原生页登录成功，切进 H5 支付页，接口**有时 401、有时正常**；刷新一下又好了。这种"时好时坏"几乎每次都是 **Cookie 写入时序**——原生把 token 写成 Cookie，但没等它落盘就 `loadRequest`，首跳请求恰好没带上。这一篇从"三藏经"讲起，把 iOS Cookie 的存储边界、同步时机和 302 竞态一次性说清。

### 5.2 先破误区

> • 误区 一："Cookie 全局共享，Safari / App / JS 是同一个罐子。"
> • 事实：iOS 上是多套。Safari 与 App 的 WebKit 会话相互隔离（虽有能力互补，但非天然同步，细节以实测为准）；App 内又按 `WKWebsiteDataStore` 分账。per-WebsiteDataStore 才是 App 内 WebView 的归属边界。

> • 误区 二："原生写 Cookie 是同步的，写完立即 load 就行。"
> • 事实：`WKHTTPCookieStore.setCookie` 是异步的，回调 completionHandler 完成后才可靠。不等 completion 就 load，等价于赌一局谁先到——这就是"偶发丢登录"的温床。

> • 误区 三："依赖 302 重定向种 Cookie 很稳。"
> • 事实：重定向链上自动种下的 Cookie，写入存储的时机可能晚于紧随其后的下一个请求，导致"偶发丢登录"一样的表现，且随响应顺序抖动（细节以实测为准）。

### 5.3 原理讲解

#### 5.3.1 Cookie 三藏经：三个罐子谁管谁

| 维度 | process 层 `HTTPCookieStorage` | per-DataStore `WKHTTPCookieStore` | JS 层 `document.cookie` |
|---|---|---|---|
| 归属 | URLSession 那一侧的网络栈 | 当前 `WKWebsiteDataStore`（默认/隔离） | 页面同源 |
| 谁写 | 原生 URLSession 请求落进去 | 原生显式 setCookie / WebKit 网络栈收到 Set-Cookie | 页面 JS 读写 |
| 何时与原生页打通 | 默认不打通 | 页面 H5 也看得见（同 DataStore） | —— |
| 风险点 | 写进去只有 URLSession 请求能带 | 与 WebKit 网络栈同步是异步的 | 页面会改它，别当只读 |

前端痛点集中在第二列：**App 内 WebView 的 Cookie 归属当前 DataStore**。`.default()` 对应持久目录，`.ephemeral()` 对应内存态。你原生注入的登录 Cookie，若写进了 `HTTPCookieStorage` 而 WebView 用 default DataStore，H5 肯定看不到——这是"原生登录了 H5 还 401"的另一半根因。

#### 5.3.2 setCookie 异步 + completion 后再 load：正确顺序

```swift
let store = WKWebsiteDataStore.default().httpCookieStore
let cookie = HTTPCookie(properties: [
    .domain: "api.example.com",      // 注意：按域生效，别乱给 .example.com
    .path:   "/",
    .name:   "session",
    .value:  token,
    .expires: Date().addingTimeInterval(7*86400),
])!
store.setCookie(cookie) {            // 异步！completion 后才可靠
    DispatchQueue.main.async {
        self.webView.load(URLRequest(url: url))   // 先同步完，再加载
    }
}
```

铁律：**先 `setCookie` 的 completion，再 `loadRequest` / 触发任何会发请求的动作**。不要先 load 再补 cookie，也不要在 completion 前 evaluateJavaScript 触发接口。

#### 5.3.3 已知 302 竞态：重定向链上的 Set-Cookie "晚到"

当登录/切换走的是"302 + Set-Cookie"（网关回跳种 cookie）而非第一时间给完整响应时，会出现：首跳的响应带 `302 + Set-Cookie`，WebKit **跟随重定向发出下一跳**，但那个 Set-Cookie 还**没写完存储**，于是"紧跟其后的请求"没带上它 → 401。多点重定向（如 A→B→A）时中间域种下的 Cookie 尤其容易出这问题。

![Cookie 同步正确顺序 vs 302 竞态](/images/webview-and-native/stage3-03-cookie-302.png)


**复现思路（以实测为准）**：抓包看是否走 `302`；在导航响应回调（`decidePolicyFor: navigationResponse` 与证书挑战回调 `didReceive: completionHandler`）打印 `Set-Cookie` 头与紧随下一次请求的时间差；或停在同一页面连续重试，观察 401 是否与"紧跟重定向的请求"一一对应。**稳妥做法**：
- ① 原生侧：用 `setCookie` + completion 后再 load（上面 3.2）；
- ② 别依赖 302 自动种 Cookie——**把登录 Cookie 放首个 200 响应**，请网关配合；
- ③ 必须走重定向：给 WebKit 足够时间消费 Set-Cookie，再发起真正的业务请求（中间加等待 / 手动二次导航）。

#### 5.3.4 localStorage / sessionStorage 的生命周期与清理

iOS WebKit 的 localStorage 会**持久跟随 default DataStore**；但历史上有过"卸载后又回来时 localStorage 被清"的偶发现象（与系统清理、存储容量有关，以实测为准）。别赌它永远在：**一定量级的关键数据别只放前端存储**——localStorage 适合缓存可重建的数据，不适合当唯一登录凭据。

**清理路径的适用性，说清楚边界**：iOS 设置 → Safari → 高级 → 网站数据，清的是 **Safari 自己的 WebKit 数据**，对**你的 App 内 WKWebView** 不生效——App 内数据在自己沙盒里，只能靠 `WKWebsiteDataStore.removeData(ofTypes:for:completionHandler:)` 这类原生 API 来清。所以：

```swift
let types = WKWebsiteDataStore.allWebsiteDataTypes()
WKWebsiteDataStore.default().removeData(ofTypes: types,
    modifiedSince: Date(timeIntervalSince1970: 0)) { }  // 全清（页面内同步触发）
```

#### 5.3.5 App 沙盒数据目录：per-App 隔离事实

每个 iOS App 有独立的沙盒目录，WKWebView 的持久站点数据（Cookie、localStorage、IndexedDB、Service Worker 缓存）默认存进**当前 App 的沙盒**。意味着：**删 App = 清掉这个 App 内所有 WebView 数据**；而另装一个 App 用同一个域名，是**另一个罐子**，cookie/localStorage 一概不相通。这解释了大量"换个 App 登录就没了"的疑问——不是丢了，是**生理上就不是同一个**。

### 5.4 代码验证

**平台 · iOS（Swift）** —— 完整可粘贴版在 `demo/stage-3-ios/CookieSync.swift`。核心（先同步再 load）：

```swift
import WebKit

final class CookieSync {
    static func sync(cookie: HTTPCookie, to webView: WKWebView, then load: URL) {
        let store = webView.configuration.websiteDataStore // 让"写"和"读"落在同一个 DataStore！
            .httpCookieStore
        store.setCookie(cookie) {
            DispatchQueue.main.async {
                webView.load(URLRequest(url: load))        // 先同步完，再加载
            }
        }
    }
}
```

配套的读取与清理（对齐 3.4/3.5）：

```swift
// 读（拿给原生网络库或调试）
let store = WKWebsiteDataStore.default().httpCookieStore
store.getAllCookies { cookies in print(cookies.compactMap { "\($0.name)=\($0.value)" }) }

// 清（沙盒内，作用域即本 App 的 WKWebView 数据）
let types = WKWebsiteDataStore.allWebsiteDataTypes()
WKWebsiteDataStore.default().removeData(ofTypes: types,
    modifiedSince: Date(timeIntervalSince1970: 0)) { print("cleared") }
```

### 5.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 原生登录 H5 也 401 | 页面接口 401，原生请求正常 | Cookie 写错罐子/时序 | 写进 WebView 的 DataStore，completion 后再 load |
| 偶发丢登录 | 401 时好时坏，刷新就好 | setCookie 异步未等 / 302 竞态 | 先同步再 load；避免依赖 302 种 Cookie |
| 依赖 302 种 Cookie | 重定向链偶发失败 | Set-Cookie 晚于后续请求 | 网关把 Cookie 放首个响应；或手动二次导航 |
| localStorage 偶发没了 | 刷新/重进丢失 | WebKit 存储生命周期/清理 | 只存可重建缓存，关键凭据别放前端存储 |
| 想清 App 内数据 | 设置里清了没反应 | 那是 Safari 的罐子 | 用沙盒内 `WKWebsiteDataStore.removeData` |
| 换 App 登录态消失 | "同一个域名"却要重登 | per-App 沙盒隔离 | 认知上接受：不同 App 是不同罐子 |

### 5.6 自测题

1. iOS 上"原生写 Cookie → H5 生效"的正确顺序是什么？不等 completion 会有什么后果？
2. `HTTPCookieStorage`、`WKHTTPCookieStore`、`document.cookie` 三个分别归谁管？哪个是 App 内 WebView 的归属？
3. 依赖 302 重定向种 Cookie 到底为什么"偶发"？给出一个稳妥替代。
4. localStorage 关键登录态放在前端存储有哪些风险？iOS 清理 Safari 数据会不会清到你的 App？
5. `WKWebsiteDataStore.ephemeral()` 里数据何时消失？适合什么业务？
6. 想清掉"App 内 WebView 的所有 Cookie/localStorage"，API 是什么？

<details>
<summary>参考答案（思考后再点开）</summary>

1. `setCookie` → 等 completionHandler → 再 `loadRequest`/触发请求。不等 completion 首跳请求可能没带上 Cookie → 偶发 401。
2. `HTTPCookieStorage` = process 层（URLSession 侧）；`WKHTTPCookieStore` = per-DataStore（App 内 WebView 归属，正确抓手）；`document.cookie` = JS 同源层。三者非天然同步。
3. 重定向跟随自动写入的 Cookie，存储时机可能晚于紧随的请求，故"偶发"。稳妥替代：网关把登录 Cookie 放首个 200 响应；或多跳之间手动留等待/二次导航。
4. 前端存储生命周期不保证；iOS 设置里的 Safari 网站数据只清 Safari 罐子，**清不到 App 内**——App 内数据在自己沙盒。关键凭据别只放前端存储。
5. 随会话/WebView 销毁而消失（不落盘）。适合"阅后即焚"、免污染正式 DataStore 的临时预览。
6. `WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: ..., completionHandler:)`（作用域为本 App）。

</details>

---

## 6 · 视口 / 键盘 / 崩溃白屏自愈

---

### 6.1 问题引入

安卓调得好好的 H5 页面，在 iOS 上首屏底部被刘海/胶囊挡住、`100vh` 多出一截、滚动时底部按钮躲进键盘下、偶尔整个页面白掉。前三个是**视口与键盘**，最后一个是**进程死亡**——iOS 容器侧的四个高频观感差异，本节一次收掉并给出"客户端该做什么 / 前端该配合什么"的分工表。

### 6.2 先破误区

> • 误区 一："`100vh` 就是可视高度，iOS/安卓一致。"
> • 事实：iOS Safari（及 WKWebView）的 URL 栏/工具栏会收展，`100vh` 跟随的是那个会变化的 viewport（有时指向"最大潜在视口"），导致与安卓的可视高度不一致，不是简单差一个状态栏。

> • 误区 二："iOS 出问题就怪它，反正没有安全区 API。"
> • 事实：有标准 CSS——`env(safe-area-inset-*)`。问题只在于：a) 它只在 `viewport-fit=cover` 时才有值；b) 深度藏在被容器改坏的 viewport 背后时前端才摸不到。

> • 误区 三："白屏一定是加载慢或前端 bug。"
> • 事实：也可能是 WebContent 进程被系统回收（01 篇），前端打再多日志也收不到一帧——页面进程已经陪葬了（可用 01 篇探针区分）。

### 6.3 原理讲解

#### 6.3.1 安全区：safe-area-inset 与 viewport-fit=cover

iOS 的刘海/胶囊/圆角占据的空间叫**安全区（safe area）**。你若要 H5 内容做到"贴满但不被遮挡"，必须三件事同时成立：

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

然后 CSS 里读系统注入的四个变量：

```css
/* 底部安全区（淘宝/支付宝式"全屏沉浸页"的标准写法） */
.safe-bottom { padding-bottom: max(env(safe-area-inset-bottom), 12px); }
.island-wrap { padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
```

前提：容器让 WebView 内容真正铺到屏幕边缘（`safeAreaLayoutGuide` 之上满屏），CSS 才有东西可补。**前端别写死 `padding: 34px`**——不同机型的 inset-left/right/bottom 不一样（横竖屏切换更明显），用 `env()` 是唯一正确解。

#### 6.3.2 100vh 问题与 visualViewport

iOS 动态工具栏伸缩时，`100vh` 的值会**动态变化**——你需要"恰好可见那部分"的高度，`100vh` 给的不是它。前端侧有两个正确抓手：

```js
// visualViewport：真实可见区域。监听它，比拿 100vh 稳定
window.visualViewport.addEventListener('resize', () => {
  const t = document.getElementById('toolbar');
  const vv = window.visualViewport;
  t.style.top    = vv.offsetTop + 'px';
  t.style.height = vv.height + 'px';   // 真实可视高度（键盘弹出/收展都跟住）
});
```

**注意边界**：`100vh` 的"指向最大潜在视口"在 iOS 的细节顺序、以及`visualViewport` 在部分内嵌容器（尤其被二次改造的 WKWebView 滚动区）里的表现，**以实测为准**。稳妥做法是"容器固定滚动区 + 前端用 visualViewport 或 safe-area 兜底"，而不是在 H5 里赌某条 vh。

#### 6.3.3 输入聚焦遮挡与容器侧通用做法

iOS 弹键盘时，`visualViewport` 缩小但滚动区不缩，输入框可能被键盘盖住。前端能自救（`scrollIntoView` + 已知 insets），但**容器侧才是稳定解**。给出**容器侧通用做法**（不依赖任何不确定 API）：

- 做法 A：**contentInset 补偿**——监听键盘上下（`UIKeyboardWillShow/WillHide`，Swift 侧 `Notification`），拿到键盘高度后：
  ```swift
  // scrollView 是 WKWebView.scrollView：把键盘高度垫进 contentInset 即是全部原理
  webView.scrollView.contentInset.bottom = keyboardHeight
  webView.scrollView.verticalScrollIndicatorInsets.bottom = keyboardHeight
  ```
- 做法 B：**桥指令回滚**——前端在 `focus` 后 `.postMessage({action:'scrollToKeyboard'})`，容器把 `visualViewport` 底对齐到输入框（`scrollIntoView` 的桥版）。

> 谨慎提示：iOS 上的键盘 API 存在版本差与"系统层已帮你滚动"的情况，`contentInset` 补偿 / 桥指令两条都能用，**效果以实测为准**。前端配合的万能姿势：输入框下方留白、整页用 `100dvh` 或 vv 高度而不是 `100vh`。

#### 6.3.4 橡皮筋滚动：scrollView.bounces

iOS 全局的"过界回弹"交互（橡皮筋）来自 WKWebView 内的 `UIScrollView`。H5 页面经常会发现"顶部下拉多一截灰色"，是因为容器没关 bounces：

```swift
webView.scrollView.bounces = false      // 关掉橡皮筋；页面滚动到底/顶不再回弹
webView.scrollView.alwaysBounceVertical = true  // 常规页面通常开着，保证手感
```

取舍：`bounces=false` 适合"整页自定义滚动 + 不希望系统过界反馈"的 H5（地图、画布、长列表分页）；保持 true 更贴近 Safari 手感。**别因为 JS 侧读不到这个属性就放弃**——它就是纯容器侧的开关。

#### 6.3.5 崩溃自愈：WebContent 回收 → 表现 → 重建

链路在 01 篇打底，这里给恢复策略。WebContent 被回收后的**表现**：白屏/冻结、`webViewWebContentProcessDidTerminate` 触发、或 `didFailProvisionalNavigation` 冒 `NSError`（domain/code 以实测为准）。**客户端该做的恢复**：

```swift
func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // 1) 记现场：url、scroll 位置、可选的页面状态快照(restoreState)
    let url = webView.url
    // 2) 最短路径：重 load；有 restoreState 则恢复（滚动/表单内存化为 JS state 并重放）
    if let url { webView.load(URLRequest(url: url)) }
}
```

**原则**：`URL/restoreState` 一起恢复。光 reload URL 会丢滚动与输入，重玩一次交互；好一点的容器会**自建恢复快照**：把"URL + 滚动 offset + 必要的内存态"存成一份容器自定义的状态（WebKit 没有公开的"恢复状态"API，快照结构由容器自己设计），恢复时先 reload 再重放状态；页面侧也可用状态重放指令配合。地图/直播这类"恢复 URL 不够"的页面，走 bridge 重新初始化。

#### 6.3.6 分工表：客户端该做什么 / 前端该配合什么

| 场景 | 客户端（容器）该做 | 前端该配合 |
|---|---|---|
| 安全区 | 让内容铺满屏、别吞 inset | `viewport-fit=cover` + `env(safe-area-*)` |
| 100vh 不一致 | 固定滚动区、别二次改 vh | 用 `visualViewport` / `100dvh`，监听 resize |
| 键盘遮挡 | 键盘高度 contentInset 补偿 / 桥 scrollIntoView | 输入框留白、焦点后通知容器 |
| 橡皮筋 | 按页面类型开关 `scrollView.bounces` | ——（纯容器配置） |
| 白屏自愈 | `webViewWebContentProcessDidTerminate` 重建 | 页面暴露可重放的状态入口（restoreState） |

### 6.4 代码验证

**平台 · iOS（Swift）** —— 键盘补偿 + 自愈最小集合（并入 `WKNavigationDelegate`）：

```swift
// 键盘补偿：iOS 的键盘通知把 inset 顶上去
NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification,
                                       object: nil, queue: .main) { [weak self] n in
    guard let self = self else { return }
    let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.height ?? 0
    self.webView.scrollView.contentInset.bottom = end
    self.webView.scrollView.verticalScrollIndicatorInsets.bottom = end
}

// 自愈：WebContent 回收即重载入口（restoreState 可自行扩展）
func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    if let url = webView.url { webView.load(URLRequest(url: url)) }  // 回到入口
}
```

**平台 · H5（JS）** —— 前端兜底安全区 + 键盘 & vh 打的真值观测：

```js
const pad = () => document.documentElement.style.setProperty(
  '--safe-b', `env(safe-area-inset-bottom, 0px)`);
addEventListener('resize', pad); pad();          // resize 每帧都可被 visualViewport 驱动

// 把"真实可视高"暴露给容器/调试
window.visualViewport?.addEventListener('resize', () => {
  document.getElementById('vv') && (document.getElementById('vv').textContent =
    `${window.visualViewport.height}`);           // 打点看 vh vs vv 差异
});
```

### 6.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 底部被刘海挡 | 按钮/胶囊被盖住 | 没 `viewport-fit=cover` / 没 env() | 上 cover + `env(safe-area-inset-bottom)` |
| 100vh 多一截 | 首屏比安卓高/矮 | iOS 动态工具栏视口变化 | `100dvh` / `visualViewport`，监听 resize |
| 键盘盖住输入框 | 聚焦后看不到输入 | 滚动区不随键盘缩 | 容器 contentInset 补偿或桥 scrollIntoView |
| 顶部下拉一道灰 | 过界回弹 | `scrollView.bounces=true` | 按页面类型关 bounces |
| 白屏偶发 | 无 JS 报错地白掉 | WebContent 进程回收 | 自愈：reload + restoreState；归因在 01 篇 |

### 6.6 自测题

1. `env(safe-area-inset-bottom)` 在什么前提下才有值？忘了写哪条 meta 就永远 0？
2. 为什么 `100vh` 在 iOS 上"不一致"？正确抓手是什么？
3. 键盘弹起时 `visualViewport` 发生什么？容器侧 contentInset 补偿的原理是什么？
4. `webViewWebContentProcessDidTerminate` 里，光 reload URL 会丢什么？restoreState 应恢复哪些？
5. 橡皮筋滚动是前端能关的吗？归哪个组件管？
6. "白屏"下一条自愈的完整链路（从回调到恢复）应该包含哪几步？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 前提是 `viewport-fit=cover`；不写它（默认 contain/auto）时 `env()` 可能取不到，甚至为 0。CSS 里给 fallback 值更稳。
2. iOS 工具栏随滚动收展，`100vh` 跟随会变的"潜在最大视口"，与安卓的可视高不同。改用 `100dvh` / `visualViewport.height`；在二次改造的容器里细节以实测为准。
3. 键盘弹起使 `visualViewport` 缩小，滚动区高度不受影响 → 底层输入框被盖。补偿原理：拿键盘高度填 `scrollView` 的 `contentInset.bottom`，把内容撑离键盘。
4. 只 reload URL 会丢滚动位置与未提交输入。restoreState 至少恢复：URL、scroll offset、可序列化的页面状态（表单/筛选/分流参数），重放重初始化。
5. 前端管不到，是容器侧 `WKWebView.scrollView.bounces`（UIScrollView 交互特性）。
6. 捕获 `webViewWebContentProcessDidTerminate`/NSError → 记现场（url/scroll/state）→ reload（URL + restoreState）→ 页面暴露重放入口 → 重初始化 bridge 相关状态。

</details>

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| WKWebView | iOS 上用来内嵌网页的容器组件（相当于安卓的 WebView），你的 H5 就跑在它里面。 |
| WebContent 进程 | 真正负责解析、渲染、执行 JS 的独立进程；它死掉只会白屏，不会连累 App 崩掉。 |
| WKProcessPool | 一个不带公开属性的"进程分组标记"，早年靠共享它来让多个 WebView 复用同一个渲染进程。 |
| WKWebsiteDataStore | 管理 Cookie 与站点存储归属的"储物柜"；`.default()` 持久落盘，`.ephemeral()` 用完即焚。 |
| WKHTTPCookieStore | 挂在 DataStore 上的 Cookie 读写口，是写/读 App 内 WebView Cookie 的正确抓手。 |
| jetsam | iOS 在内存紧张时杀掉后台/吃内存进程的系统行为，白屏的常见肇事者之一。 |
| WKNavigationDelegate | 监听导航生命周期（开始、失败、被回收等）的协议，容器判错、自愈都靠它。 |
| WKUIDelegate | 负责弹窗、新窗口等 UI 层面的协议，弹出面板的效果与否由它决定。 |
| SFSafariViewController | 满屏打开一条外部链接的小 Safari，无法注入 JS 或装桥，适合纯协议页。 |
| ASWebAuthenticationSession | 专为 OAuth 授权回跳设计的整屏页面，与 Safari 联动 Cookie，无注入面。 |
| evaluateJavaScript | 原生主动往页面里执行 JS 并取回结果的接口，本文件用于读"心跳探针"。 |
| 进程隔离 | 把页面放进独立进程，页面崩了不影响 App 主进程，是"白屏但 App 活"的根源。 |
| Memory Graph | Xcode 的可视化内存分析视图，用来数 WebContent 进程数和排查对象泄漏。 |
| JIT | 即时编译，靠进程隔离解禁后 JS 引擎才能大幅提速。 |
| WKWebViewConfiguration | 创建 WKWebView 前要配好的"说明书"，注入、存储、进程池等大都在这一刻生效。 |
| WKUserScript | 注入到页面里的脚本对象，可按"文档开始/结束"两个时机打进页面。 |
| atDocumentStart | 文档元素刚建好、页面脚本还没跑时注入，适合垫环境补丁、装桥兼容层。 |
| atDocumentEnd | DOM 就绪后、`load` 之前注入；官方只承诺这个区间，不保证等价于 DOMContentLoaded。 |
| WKPreferences | 渲染偏好设置，比如最小字号；JS 开关注册在另一处。 |
| WKUserContentController | 管注入与消息的枢纽：`addUserScript` 加脚本、`addScriptMessageHandler` 注册通道。 |
| WKWebpagePreferences | 按单次导航设渲染偏好（如 `allowsContentJavaScript`），比全局开关更精细。 |
| injectionTime | 指定 UserScript 的注入时机（文档开始 or 结束）的参数。 |
| forMainFrameOnly | 该脚本是否只在主 frame 注入，子 iframe 里要不要也跑由它控制。 |
| ContentWorld | 脚本运行在的"世界"，`.page` 与页面共享，其它世界与页面隔离。 |
| synchronously | 让注入脚本在页面脚本前同步跑完的开关，代价是阻塞、拖慢首帧。 |
| DOMContentLoaded | 浏览器标准事件：DOM 解析完成；它并不等于 atDocumentEnd。 |
| ephemeral | 内存态数据存储，永不下盘，WebView/会话关了就没了。 |
| popstate / hashchange | SPA 路由切换时浏览器触发的事件，UserScript 不随路由重放，页面要自己挂监听。 |
| decidePolicyFor | 导航进入 WebKit 前让你"裁决放行还是取消"的回调，只拦导航、拦不到 fetch 等子资源。 |
| WKNavigationAction | 描述一次导航动作的对象，附带 URL、触发方式（navigationType）、目标 frame。 |
| decisionHandler | 必须恰好调用一次的"投票器"；漏调 App 违约、调两次直接崩溃。 |
| navigationType | 标明这次导航从哪来的枚举（点链接、表单提交、前进后退、JS 跳转等）。 |
| targetFrame | 导航要落到哪个 frame；用 isMainFrame 区分主文档跳转还是 iframe 跳转。 |
| createWebViewWith | WKUIDelegate 里的回调，决定 `target=_blank` / `window.open` 该怎么处理。 |
| alert / confirm / prompt | 浏览器弹窗三件套，在 WKWebView 里都要原生面板才显示。 |
| WKURLSchemeHandler | 自定义 scheme 的请求拦截口，可类比安卓的 shouldInterceptRequest，但仅限自定义 scheme。 |
| didFailProvisionalNavigation | 导航还没提交就失败（如断网、DNS 失败），页面仍保留旧内容。 |
| didFail | 导航已提交之后中途失败，页面世界多半已经半死。 |
| URLAuthenticationChallenge | 证书层面的挑战回调，用于信任自签证书、客户端证书等。 |
| completionHandler | WebKit 要求每个回调"恰好调用一次"的完成句柄，一次都不能少。 |
| WKWindowFeatures | `window.open` 传进来的新窗口特性参数。 |
| WKScriptMessageHandler | H5 主动调原生的"通道协议"，前端通过它把消息发给原生。 |
| postMessage | H5 侧发消息的入口：`window.webkit.messageHandlers.<名>.postMessage(数据)`。 |
| addScriptMessageHandler | 注册消息通道的方法；它会把传进去的对象 strong 强持有，不清理就泄漏。 |
| removeScriptMessageHandler | 退出页面前把通道摘掉的清理动作，保护对象不被永久持有。 |
| dealloc | 对象被释放的时机；宿主对象被回收时，已注册的桥回调会跟着一起丢。 |
| WKScriptMessage | 前端发来的消息体对象，`.body` 里就是 H5 传递的数据。 |
| JSONSerialization | 把 JS 返回的 JSON 字符串反序列化成 Swift 字典/数组的本地解析工具。 |
| strong 持有 | 强引用，add 进去的 self 会因通道一直活到 remove 为止，"时有时无"的根因之一。 |
| [weak self] | 弱引用写法，配合 remove 一起用，避免闭包里把 webview 死死抓住。 |
| JavaBridge | 安卓侧互调消息跑在的后台线程名，用来和 iOS 主线程形成对比。 |
| HTTPCookieStorage | process 层 URLSession 那侧的网络栈 Cookie 罐子，和 WebView 不一定互通。 |
| document.cookie | 页面 JS 里读写当前同源 Cookie 的标准入口，页面会改它，别当只读。 |
| setCookie | 原生写 Cookie 的方法，**异步**：不等 completion 就 load，首跳请求可能没带上。 |
| 302竞态 | 重定向响应里给的 Set-Cookie 还没写进存储，紧随的下一跳请求却没带上它导致的偶发 401。 |
| Set-Cookie | 服务器在响应头里下发的种 Cookie 指令。 |
| localStorage | 持久跟随 default DataStore 的前端存储，生命周期不保证，别存唯一登录凭据。 |
| sessionStorage | 页面会话期内的临时存储，关页即清。 |
| removeData | 原生清数据的 API，作用域只在本 App 沙盒里，清不到 Safari 罐子。 |
| HTTPCookie | Cookie 的 Swift 对象模型，用 domain/path/name/value 等属性构造。 |
| per-App 沙盒隔离 | 每个 App 各有一个存 WebView 数据的沙盒，换 App 登录态消失是生理上的不同罐子。 |
| 安全区（safe area） | 屏幕里不被刘海、胶囊、圆角挡住的可用区域，系统用 inset 把数值暴露出来。 |
| env(safe-area-inset-*) | 读安全区数值的标准 CSS 函数，注意必须配合 `viewport-fit=cover` 才有值。 |
| viewport-fit=cover | meta viewport 里的值，让 H5 内容真正铺满到屏幕边缘，安全区布局的前提。 |
| visualViewport | 真实可见区域对象，键盘弹出、工具栏收展时高度都会跟着变，比 `100vh` 稳。 |
| 100vh | 视口高度单位，iOS 上跟随"会变化的潜在最大视口"，和安卓的可视高度不一致。 |
| 100dvh | 动态视口高度单位，比 `100vh` 更贴近"此刻真实可见"的高度。 |
| contentInset | UIScrollView 的内容内边距，容器用键盘高度补它是防遮挡的通用做法。 |
| scrollView.bounces | 控制"过界回弹"（橡皮筋）的开关，这是纯容器侧属性，前端管不到。 |
| webViewWebContentProcessDidTerminate | WebContent 进程被回收时触发的回调，是白屏自愈的入口信号。 |
| restoreState | 记录并恢复页面状态（URL、滚动位置、可序列化内存态），让 reload 后不丢交互。 |
| UIScrollView | WKWebView 内部负责滚动的滚动容器，键盘补偿和橡皮筋都落在它身上。 |
| 橡皮筋滚动 | iOS 上滚动到边界还会弹一下的交互，来自 UIScrollView 的默认 bounces。 |
