---
title: Cookie / 存储 / 缓存
date: 2026-11-14
excerpt: "Cookie 三套体系、localStorage 在 WebView 里怎么活、HTTP 缓存为何让用户看到旧 H5，以及为什么有的请求抓不到。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 6
lang: zh
draft: false
ogImage: /images/webview-and-native/stage5-01-cookie-systems.png
---

> 📖 本章由 5 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · Cookie 三套体系与同步——"原生登录了，进 H5 接口却 401"
- 2 · 前端存储的真相——localStorage/IndexedDB 在 WebView 里到底怎么活
- 3 · HTTP 缓存与强缓存——"开发看得到新版本,线上用户却看到旧 H5"
- 4 · Service Worker 与离线——容器里能让它给你兜底吗
- 5 · 抓包与网络代理——为什么 H5 的请求"抓不到"
- 本章术语表

---
## 1 · Cookie 三套体系与同步——"原生登录了，进 H5 接口却 401"

---

### 1.1 问题引入

用户在原生登录页输完密码，接口返回 200，登录态写进客户端的 Cookie 存储了。可一进 H5 页面，里面的业务接口全部 `401`。后端说"没带登录态 Cookie"，前端说"我页面里 `document.cookie` 明明是空的"。

双方都没错。错的只有一件事：**你们俩以为 Cookie 是"一个"东西，实际上在移动端容器里，Cookie 至少有三套。**

---

### 1.2 先破误区

> • 误区 A：`document.cookie` 就是 App 里唯一的 Cookie 存储。
> • 事实：WebView 里的 `document.cookie` 只是"JS 视角的那一套"，它和客户端原生写入/读取的 Cookie 存储，不是天然的同一份。

> • 误区 B：原生登录写进了"系统 Cookie"，H5 就一定能读到。
> • 事实：Android 端没把 Cookie 写进正确的那份存储（或者写早了），JS 就可能读不到；iOS 端 `WKHTTPCookieStore` 是异步写库且按 `WebsiteDataStore` 隔离，时序和归属不对就会丢。

> • 误区 C：'Cookie 同步不上'是 H5 的锅。
> • 事实：登录态同步是一条宿主 → 文档的链路，前端只能"被同步"，主动权几乎全在容器（宿主）那边。你要做的是看懂链路、给出正确时机要求，而不是在自己页面里疯狂 `document.cookie = ...`。

---

### 1.3 原理讲解：三套 Cookie，三个视角

#### 1.3.1 Android：系统 `CookieManager` 是总仓库，文档是"投影"

Android 的 WebView 背后是 Chromium，Cookie 的**权威存储**是系统的 `android.webkit.CookieManager`——它是**全局、进程级**的，跨 WebView 实例共享（Android 5.0（Lollipop）起废弃 CookieSyncManager、新增 flush()，同进程内的多个 WebView 实例都共享这套系统 CookieManager（注意：这只限定在 App 进程内，与系统浏览器 App 的 Cookie 互不相通））。

关键的两个细节：

- **default vs per-instance**：`CookieManager.getInstance()` 拿到的是全局默认单例。你也可以给单个 WebView 配**独立的 Cookie 存储**（`CookieSyncManager`/`CookieManager` 的某些 API 支持 per-instance 的 `CookieStore`），一旦走了 per-instance，这个 WebView 看到的 Cookie 就**和系统仓库脱钩**。前端看到的"这个 WebView 里能读到、另一个读不到"，十有八九是容器把它们的 Cookie 存储给隔离了。
- **影响 JS 可见性**：Cookie 是否对 JS 可见，取决于属性。`HttpOnly` 的 Cookie **不会出现在 `document.cookie`**，但仍会随请求自动带上。所以"`document.cookie` 是空的" ≠ "登录态丢了"——可能只是那条 `HttpOnly` 登录 Cookie 不给你看，但照样放行接口。

**WebView 里文档与仓库的同步**：渲染进程发请求时，WebView 网络栈会从系统 `CookieManager` 读匹配该域名主机名的 Cookie 并放进请求头；响应里的 `Set-Cookie` 也会写回 `CookieManager`。这部分是**内核自动做的**，不需要前端参与。

**Java 侧写 Cookie 的正确时机**：最关键的一条金规是——**一定在 `loadUrl` 之前、把 Cookie 通过 `CookieManager.setCookie()` 写到目标 domain，再发起加载**。写在之后，首次页面请求（HTML 本身）就可能已经不含登录态，进而整条会话链路都不对。

```kotlin
// 伪代码：先写、后 load
CookieManager.getInstance().setCookie("https://h5.example.com", "session=abc123; Max-Age=86400")
CookieManager.getInstance().flush()
webView.loadUrl("https://h5.example.com/")   // 这次请求就会带上 session
```

> 注意：`setCookie` 在 Android 是**异步入队**的，`flush()` 才是把队列落库的同步点。稳妥做法是 flush 之后、第一个请求之前留一个很小的间隔，或直接用带回调的 API（各版本能力见 demo）。

#### 1.3.2 iOS：`HTTPCookieStorage` 是一套，`WKHTTPCookieStore` 是另一套

iOS 上最容易踩的坑，是以为**进程内只有一个 Cookie 仓库**。实际上：

- **`HTTPCookieStorage.shared`**：进程级的共享 Cookie 仓库，管的是**非 WKWebView** 的 URLSession 请求、以及系统层的 Cookie。
- **`WKHTTPCookieStore`**：挂在 **WKWebsiteDataStore** 下面（`webView.configuration.websiteDataStore.httpCookieStore`）——WKWebView 的文档走的是**这一套**。它**不自动**等于 `HTTPCookieStorage.shared`。

也就是说 iOS 的原生网络栈（URLSession，管道一）和 WKWebView 的文档（管道二）**默认不共享 Cookie**。你往 `HTTPCookieStorage.shared` 里写，WKWebView 里的 JS 不一定读得到。

**`WKHTTPCookieStore` 是异步的**（红线 §1.6）：`setCookie(_:completionHandler:)` 写库是异步完成的。如果你 `setCookie` 之后**立即** `loadRequest`，首帧 HTML 请求极可能赶不上这份 Cookie 落地——这就是"偶发丢 Cookie"的头号来源，和 Android 的 302 竞态同源（302 竞态完整展开在阶段 3 iOS 篇，此处聚焦登录态同步链路）。

```swift
// 伪代码：先等 setCookie 完成，再 load
let cookie = HTTPCookie(properties: [
    .domain: "h5.example.com",
    .path: "/",
    .name: "session",
    .value: "abc123",
    .expires: Date().addingTimeInterval(86400),
])!
webView.configuration.websiteDataStore.httpCookieStore
    .setCookie(cookie) {
        // completion 里再 load，Cookie 才确定在库
        webView.load(URLRequest(url: URL(string: "https://h5.example.com/")!))
    }
```

**JS 的 `document.cookie` 又一层**：即便 `WKHTTPCookieStore` 里有了 Cookie，`HttpOnly` 的不给 JS 读；非 HttpOnly 的会以 `; ` 拼接暴露。前端能改的只限非 HttpOnly 且未锁定为只读会话的项。

#### 1.3.3 三套 vs 一个文档：关系一张图

![Cookie 三套体系与同步](/images/webview-and-native/stage5-01-cookie-systems.png)


---

### 1.4 跨端对比表 + 同步时机金规

| | Android | iOS | JS 视角 |
|---|---|---|---|
| 权威存储 | 系统 `CookieManager`（全局进程级） | `WKHTTPCookieStore`（挂在 WebsiteDataStore） | `document.cookie`（读非 HttpOnly） |
| 是否跨 WebView 共享 | default 单例共享；per-instance 隔离 | 同 WebsiteDataStore 实例内共享；新实例不共享 | 取决于容器配了哪个 store |
| 写入是否异步 | `setCookie` 异步入队 + `flush` 落库 | `setCookie` 异步 completion | `document.cookie=` 同步改文档，落库由内核 |
| 与原生网络库共享？ | 非 WebView 的 OkHttp 自管 Cookie，默认不共享 | URLSession 走 `HTTPCookieStorage.shared`，**不共享** | — |
| 写登录态最佳时机 | loadUrl **之前** setCookie→flush | setCookie completion **之后** 再 loadRequest | 无 |

**同步时机"金规"（记死它）**：

> **Native 永远先完成"把 Cookie 写进目标存储"（Android `flush()`、iOS `setCookie` 的 completion），再发起 `loadUrl`/`loadRequest`。先 load 后写 Cookie，必丢首帧登录态。**

---

### 1.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| HTTPOnly 看不见 | `document.cookie` 空，但接口其实带上了 | Cookie 带 HttpOnly 不向 JS 暴露 | 别用 `document.cookie` 判断登录态，用一次真实请求验证 |
| 写晚了 | 首帧 HTML 401，刷新才 200 | 先 loadRequest 后 setCookie | 黄金律：先写库、后 load |
| iOS 偶发丢 | 时好时坏，随机 401 | `setCookie` 异步未完成就 load | completion 后再 load；不依赖"立即" |
| 新实例串台/不串台 | 这个页有、那个页没有 | per-instance / 不同 WebsiteDataStore | 确认容器用的是 default 仓库还是隔离了 |
| Cookie 被清 | 重启 App 后登录态没了 | App 进程被系统回收/清站点数据 | 走桥拿容器持久化 token，别只靠 Cookie |

---

### 1.6 demo

最小可跑示例见 `demo/stage-5-storage-cookie-cache/`：`CookieSync.java`、`CookieSync.swift`（登录态从宿主导到 H5 生效的正确顺序，Java 先 flush 再 loadUrl，Swift 等 completion 再 loadRequest）。

---

### 1.7 自测题

1. iOS 上 `HTTPCookieStorage.shared` 和 `WKHTTPCookieStore` 是一回事吗？为什么原生登录态常常"原生的能带、H5 带不上"？
2. `document.cookie` 是空字符串，能断定"登录态丢了"吗？为什么？
3. Android 写 Cookie 后为什么要 `flush()`？
4. 动手：跑通 `demo/stage-5-storage-cookie-cache/CookieSync.java`，把 Java 侧的 setCookie 放到 loadUrl **之后**，观察首帧请求头是否还带 Cookie。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 不是。`HTTPCookieStorage.shared` 给 URLSession（管道一），WKWebView 文档走 `websiteDataStore.httpCookieStore`（管道二），两者默认不共享。所以原生登录态要显式同步进 `WKHTTPCookieStore` 才行。
2. 不能。HttpOnly 的登录 Cookie 不进 `document.cookie`，但仍随请求自动带上。用一次真实请求看 header 判断。
3. `setCookie` 是异步入队，`flush()` 才是同步落库点。不 flush 就 loadUrl，首帧很可能还没写到。
4. 把 setCookie 放 loadUrl 后面时，首次页面请求（HTML 级）不带 Cookie，刷新后才带——复现 401 的经典路径。
</details>

---

## 2 · 前端存储的真相——localStorage/IndexedDB 在 WebView 里到底怎么活

---

### 2.1 问题引入

前端在浏览器里习惯了 localStorage：写入、隔天还在、刷新页面永续。到了 WebView 里却经常"白纸一张"——同一套代码，安卓上重进页面数据还在，iOS 上新开一个 WebView 就读不到了。更玄的是，手机"清一下缓存"，登录过的偏好设置就没了。

这些都不是你代码的 bug，是**前端存储的持久性就归宿主 App 管，不归你的 H5 管**。

---

### 2.2 先破误区

> • 误区：localStorage 是"页面自己的"存储，浏览器怎么存，WebView 就怎么存。
> • 事实：在 WebView 里，localStorage/IndexedDB 的落盘位置在宿主的 App 数据目录里。App 卸载即清；系统/Junk 清理 App 数据也可能清掉；存储的"共享"边界由 WebView 的网站数据源（iOS）或 WebView 实例（sessionStorage）决定——这一切都由宿主决定，不在你手里。

> • 误区：localStorage 和 sessionStorage 都"跟着页面走"。
> • 事实：sessionStorage 按 WebView 实例隔离（语义上每个"new 出来的 WebView"像一个独立标签页）。在同一个实例内跳转，sessionStorage 留着；新开 WebView 实例加载新页面，旧实例的 sessionStorage 就是空的。

---

### 2.3 原理讲解

#### 2.3.1 持久性归谁管：Host App 数据目录

浏览器里，localStorage 存在浏览器自己的用户数据目录，卸载浏览器才清。WebView 里没有"浏览器"，只有**宿主 App**。所以：

- localStorage / IndexedDB 的落盘，落在 **App 的 data 目录**（Android `data/data/<包名>`、iOS App 沙盒）里，由 WebView 内核管理。
- **卸载 App = 数据目录没了 = localStorage/IndexedDB 全清**。这是最确定的"会清"节点。
- **被系统"清缓存"会清掉吗？** 取决于系统的清理策略和内核版本——有的系统清的是"缓存"目录（`cache`、`Caches`），localStorage 落盘位置是否属于被清范围，**各版本/机型不一致，以实测为准**。
- 结论先行：**localStorage/IndexedDB 在容器里是"弱持久"存储**，绝不能当"可靠的持久化"用；登录态、加密 token 这种丢不起的东西，不要全压在这里（见第 5 节决策表）。

#### 2.3.2 iOS 的共享问题：WKWebsiteDataStore 是分水岭

iOS 上 localStorage 是否共享、是否持久，取决于 WebView 用的 **`WKWebsiteDataStore`**：

- 用同一个 **`WKWebsiteDataStore.default()`**（容器默认配置），**同一实例的页面之间** localStorage 共享；
- **新开一个 WebView 用不同配置 / 不同 WebsiteDataStore（如 non-persistent data store），localStorage 就不共享**——这就是"iOS 上同一个 H5，A 窗口写完 B 窗口读不到"的历史坑（红线 §2.6 提到过 iOS 存储"历史 bug"，这里讲归属）。

> 换句话说：**iOS 的 localStorage"共享域"是 WebsiteDataStore，不是"域名"**。两个 WebView 即使同域，只要 store 不同，就是两套 localStorage。

验证代码（Swift）：单独拉一个 WebView，配置里不指定 store（走默认），和指定了自建 non-persistent store 的对比，分别写入同 key 观察。

#### 2.3.3 sessionStorage：按 WebView 实例隔离

- 同一个 WebView 实例内 **导航跳转（同实例 `location` 变更/SPA 内部跳转）**，sessionStorage **保留**；
- **新实例 + 新页面**（重新 new 一个 WebView 再 loadUrl），sessionStorage **即丢**；
- 追问"WebView 里跳转后 sessionStorage 还在吗"：**在，只要没换实例；换实例就没了**。浏览器"多标签也隔离"的语义在容器里被放大成了"多实例隔离"。

#### 2.3.4 IndexedDB 容量与清理

- **容量**：IndexedDB 在移动端 WebView 里是「软配额 + 逐出」模式——有上限但不像浏览器 `navigator.storage.estimate()` 展示得那么直观，具体阈值**以实测为准**（内核版本相关）。
- **清理**：和 localStorage 一样，属于 App 数据。被系统清 / App 卸载，一起没。
- **quota 用完的表现**：写入请求 **reject**（`QuotaExceededError`）或静默失败——**不是抛异常让你一眼看懂**。所以写入要包 try/catch，并用 `navigator.storage.estimate()` 主动探测余量。

---

### 2.4 代码验证（最小可跑）

前端 JS（在 WebView 里）：

```js
// 探测余量
if (navigator.storage?.estimate) {
  const { usage, quota } = await navigator.storage.estimate();
  console.log('IndexedDB 用量/配额', usage, quota);
}

export function safeSet(key, val) {
  try {
    localStorage.setItem(key, val);   // 配额满/被禁时可能直接抛错
  } catch (e) {
    console.error('localStorage 写入失败，走兜底', e);
    // 兜底：改走 容器存储（桥）或 IndexedDB
  }
}
```

Android/Kotlin 判断用的是不是默认存储、以及清站点数据的入口（容器侧）：

```kotlin
// 清除该 WebView 的网站数据（会连带清 localStorage/IndexedDB/HTTP缓存）
WebStorage.getInstance().deleteAllData()   // 清 localStorage 等
WebView(this).apply {
    clearCache(true)                        // 清 HTTP 缓存
    clearHistory()
}
```

iOS 侧等价（容器侧）：

```swift
let store = WKWebsiteDataStore.default()
let types = WKWebsiteDataStore.allWebsiteDataTypes()
store.removeData(ofTypes: types, modifiedSince: .distantPast) { }
```

> 注意：这些是**容器的清理能力**，前端没有权限。当线上用户"清缓存"出现存储消失，归因方向是容器侧。

---

### 2.5 决策表：localStorage 还是容器存储（桥）？

| 数据 | 建议存储 | 理由 |
|---|---|---|
| 登录态 / 加密 token / 会话凭证 | **容器存储（桥）**，让原生持久化 | 登录态丢不起，必须受容器安全策略保护、随 App 生命周期管理 |
| 长文本 / 多媒体 / 离线数据块 | **IndexedDB** | 容量更大、支持结构化/大对象，适合内容缓存 |
| 简单偏好（主题、静音、列表排序） | **localStorage** | 够用、简单、丢一份也无所谓 |
| 单次会话内临时状态（页面间传值） | **sessionStorage** 或内存态 | 换 WebView 实例就丢，别依赖 |

**一句话**：能用 localStorage 就用 localStorage，但要接受它是弱持久；存不了/丢不起的用 `IndexedDB`；真正要紧的凭证一定走**桥**去拿容器持久化的 token，而不是自己塞进前端存储。

---

### 2.6 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 卸载即没 | 重装 App 登录偏好全丢 | 存储归 App 数据目录 | 勿当可靠持久化，凭证走桥 |
| iOS 新窗口读不到 | A 写完 B 读空 | localStorage 按 WebsiteDataStore 隔离 | 确认容器统一用 default store |
| sessionStorage 丢 | 从列表页跳详情页后 key 没了 | 换了个 WebView 实例 | 用桥/IndexedDB 做跨页状态 |
| quota 静默失败 | 写入看起来成功但读回空 | IndexedDB 配额满 reject 被吞 | try/catch + estimate() 探测 |
| 清缓存被连带 | 偏好被清 | localStorage 落在可能被清的区域 | 按宿主清理策略设计，别存敏感数据 |

---

### 2.7 自测题

1. localStorage 在 WebView 里，卸载 App 会不会没？被系统"清缓存"会不会没？
2. iOS 两个同域 WebView，localStorage 一定共享吗？由什么决定？
3. 在同一个 WebView 实例内跳转，sessionStorage 还在吗？换新实例呢？
4. 动手：在两个不同配置的 WebView 里写同一个 key，对比 iOS 的读回行为。
5. 你项目里的登录 token 现在存在哪？如果换成容器存储（桥）要动哪些地方？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 卸载 App 一定没（数据目录没了）；被系统清缓存**视机型/内核清理策略而定，以实测为准**。
2. 不一定。由 `WKWebsiteDataStore` 决定——同 default store 才共享，不同 store 不共享。
3. 同实例内跳转保留；换新 WebView 实例即丢。
4. （动手题）观察：default store 的共享，non-persistent store 的独立。
5. token 应在容器侧持久化并通过桥下发；前端存储只放非敏感的弱持久数据。
</details>

---

## 3 · HTTP 缓存与强缓存——"开发看得到新版本,线上用户却看到旧 H5"

> 所属:阶段 5 · Cookie / 存储 / 缓存 ｜ 上一节:前端存储的真相 ｜ 下一节:ServiceWorker 与离线 ｜ 返回总目录

---

### 3.1 问题引入

灰度发布上线新版本,前端本地和测试环境刷新几遍都是新 UI。上线后用户群里炸了:"怎么还是旧页面?"更诡异的是,同一台手机,杀掉 App 重进是旧版,过十几分钟又自己变新了。

这是 WebView 场景里最经典的版本不一致问题,根因几乎都在**缓存**。

---

### 3.2 先破误区

> • 误区 A：H5 的缓存策略都是前端在 HTML 里 `<meta http-equiv="Cache-Control">` 写的。
> • 事实：`<meta>` 里写 Cache-Control 对 HTTP 缓存基本无效(那是给老 IE 的遗产)。真正起作用的是响应头——而响应头是谁发的,谁就有控制权。静态资源托管在 CDN/网关,头是服务端配的;可 WebView 这边,容器还能再叠一层 `cacheMode`(Android)。

> • 误区 B：清掉 App 缓存 = 清掉 WebView 缓存 = 清掉 Service Worker 缓存。
> • 事实：三个缓存、三个清理入口,不是一回事:
> 1. **WebView 自身的 HTTP 缓存**(Android 是 Chromium 内核的磁盘缓存;iOS 是 `WKWebsiteDataStore` 管的网站数据 + `NSURLCache`);
> 2. **H5 页面里的 Service Worker 缓存**(Cache Storage,归页面/内核);
> 3. **离线包**——它根本不是缓存,是打进 App 的静态资源 + Native 拦截映射(术语红线:离线包 ≠ 缓存 ≠ Service Worker)。
> 清一个不清另一个,用户看到的"旧版本"可能来自其中任何一个。

---

### 3.3 原理讲解:两个缓存交互面

#### 3.3.1 WebView 自己的 HTTP 缓存

你的 H5 里所有 `fetch/XHR/<img>/<script>` 都走 **WebView 内置网络栈**(管道二,阶段 6 详述)。这条栈自带 HTTP 缓存:

| 端 | 缓存宿主 | 容器侧控制入口 |
|---|---|---|
| Android | Chromium 网络栈的磁盘缓存 | `WebSettings.cacheMode`(`LOAD_DEFAULT` / `LOAD_CACHE_ELSE_NETWORK` / `LOAD_NO_CACHE` 等) |
| iOS | WebKit / `WKWebsiteDataStore` 网站数据 + NSURLCache | **没有公开的"按请求设置 cacheMode"API**;清理走 `WKWebsiteDataStore.removeData(ofTypes:)`;**iOS 11.3+ 起** WKWebView 的 HTTP 缓存也纳入网站数据统一清理 |

**强缓存与协商缓存的头由谁控制在"容器"里**——澄清一下这句:

- `Cache-Control: max-age / no-cache / no-store`、`ETag / If-None-Match`、`Last-Modified / If-Modified-Since` 这套语义,**是 HTTP 协议层定的,生效于 WebView 网络栈内**;
- 但**决定发什么头的**是**静态资源服务器/CDN**(谁部署 H5,谁配头);
- 容器侧能做的是**干预缓存行为本身**:Android 换 `cacheMode`、iOS 清 WebsiteDataStore。容器改不了协议语义,只能改"这条 WebView 往不往缓存里翻"。

#### 3.3.2 H5 的缓存:浏览器语义 + Service Worker

页面上,标准 HTTP 缓存语义和 Service Worker(第 4 节详讲)一起构成"H5 侧缓存"。SW 一旦注册成功并有 `fetch` 拦截,**它可以完全接管请求**,返回自己 Cache Storage 里的旧资源——此时即使你把 WebView 缓存清了,SW 还能继续吐旧文件。

#### 3.3.3 "开发看得到新版,线上看到旧版"——归因树

![H5 版本不更新的归因树](/images/webview-and-native/stage5-02-cache-tree.png)


两层归因:

- **根**:用户打开的 H5 不是最新版。
- **第 1 层分支**(4 个常见成因):
  1. **强缓存未失效**——`index.html` 被 `Cache-Control: max-age=31536000` 缓存了一年,期间 WebView 直接读本地不回源;
  2. **Service Worker cache-first**——SW 拦住了请求,优先回 Cache Storage 里的旧文件;
  3. **离线包版本未更新**——Native 拦截到本地旧版资源,但离线包没发新版;
  4. **WebView 缓存未清**——容器侧 cacheMode 设了激进策略(如 `LOAD_CACHE_ELSE_NETWORK`)或长期未清。

**为什么"开发时能看到新版"**？开发时往往：改了文件名(hash query)、devtools 开了 Disable cache、或者开发者手机/测试机上手动清过数据。线上用户三样都没有——所以"我这里是好的"不能作为归因证据(红线 §3.6:吃不准写以实测为准)。

---

### 3.4 前端如何让 WebView 里的版本可更新:3 种正确姿势

#### 3.4.1 姿势 1:缓存破坏 query(最小改动)

HTML **不缓存**(`no-cache` / `max-age=0, must-revalidate`),静态资源用**内容 hash 文件名**或 **`?v=<hash>`**:

```html
<!-- index.html 响应头: Cache-Control: no-cache -->
<script src="/app.3f9c1b.js"></script>      <!-- 内容变 → 文件名变 -->
<link href="/app.7a2e0d.css">
```

只解决"HTML 是新的、资源跟着新",前提是 HTML 本身没被强缓存。

#### 3.4.2 姿势 2:离线包版本下发(容器能力,阶段 7 详讲)

H5 静态资源打进 App,请求被 Native 拦截映射到本地;灰度/强更靠**版本号下发**驱动——前端只管把新版本发到容器平台,更新节奏归容器管。它是"用户看到旧版"最强力的解法,但**别和缓存混为一谈**(它是资源替换,不是 HTTP 缓存)。

#### 3.4.3 姿势 3:watch bundle 版本下发 / 接口驱动刷新

容器侧维护"H5 bundle 当前版本",通过**版本接口**下发;前端启动/进入页面时对比版本,发现新版本**主动触发重建/重载**。适合和离线包配合,也可独立使用。

---

### 3.5 容器侧缓存清理入口(前端要知道,方便给客户端提需求)

Android(Kotlin):

```kotlin
// 每次进入时强制走网络(调试用,线上慎用,会牺牲首屏速度)
webView.settings.cacheMode = WebSettings.LOAD_DEFAULT  // 生产默认
// webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE  // 调试切换

// 清理入口(容器调用)
webView.clearCache(true)
```

iOS(Swift):

```swift
// 清理网站数据(含 HTTP 缓存、localStorage 等——注意会连带清存储)
let types = WKWebsiteDataStore.allWebsiteDataTypes()
WKWebsiteDataStore.default().removeData(ofTypes: types,
    modifiedSince: .distantPast) { /* 清理完成 */ }
```

> 注意 iOS **没有** Android 那种"只清 HTTP 缓存、不动 localStorage"的精细入口——清就是**整套 WebsiteDataStore**连存储一起清。给客户端提需求时要说清楚这个副作用,避免出现"清缓存把用户偏好也清了"的次生事故。

---

### 3.6 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| index.html 被强缓存 | 发版后用户刷不出新版 | CDN/网关配了 `max-age=大值` | HTML 用 `no-cache`,资源用 contenthash 文件名 |
| SW 吐旧文件 | 清了 App 缓存还是旧版 | SW cache-first 拦住请求 | SW 版本号策略 + `skipWaiting`/版本切换(第 4 节) |
| 离线包没发新版 | 走 Native 拦截永远旧 | 离线包发布流程问题 | 走容器版本下发 & 灰度(阶段 7) |
| iOS 清缓存连带 | 清完缓存用户偏好也丢 | WebsiteDataStore 一套整体清 | 提前沟通清理范围,敏感数据走桥 |
| `<meta>` 当挡箭牌 | HTML 里写了 no-cache 没用 | meta 对 HTTP 缓存基本无效 | 头必须在服务端/CDN 配 |

---

### 3.7 自测题

1. 简答:WebView 里哪个 API 能"只清 HTTP 缓存、不动 localStorage"?Android 和 iOS 答案一样吗?
2. 简答:`<meta http-equiv="Cache-Control" content="no-cache">` 为什么救不了你?
3. 简答:容器侧(Host)在 HTTP 缓存语义里能干预什么、不能干预什么?
4. 动手:打开你负责的 H5,Charles 里看 `index.html` 的响应头,如果 `max-age` 很大,算一算"最坏的更新延迟"多久。
5. 动手:给你项目里"用户看到旧版"写一份两层的归因树(强缓存/SW/离线包/WebView 缓存,哪个是根因)。

<details>
<summary>参考答案(思考后再点开)</summary>

1. Android 有 `webView.clearCache(true)`;**iOS 没有单独"只清 HTTP 缓存"的公开 API**,只能清整套 WebsiteDataStore(会连存储一起清)。答案不一样。
2. `<meta>` 里的缓存指令对现代 HTTP 缓存**基本无效**(历史遗留,主要老 IE 认)。缓存语义看响应头。
3. 能干预:缓存**行为**(Android `cacheMode`、iOS 清 WebsiteDataStore);不能干预:缓存**语义**(`Cache-Control/ETag` 等头的定义,由静态资源服务端/CDN 决定)。
4. (动手) max-age=31536000 意味着最坏一年内这个 WebView 可能不再请求该文件。
5. (动手)按本节归因树套:最强缓存/SW/离线包/容器缓存逐层排查。
</details>

---

## 4 · Service Worker 与离线——容器里能让它给你兜底吗

> 所属:阶段 5 · Cookie / 存储 / 缓存 ｜ 上一节:HTTP 缓存与强缓存问题 ｜ 下一节:抓包与网络代理 ｜ 返回总目录

---

### 4.1 问题引入

前端在 H5 里注册了一个 Service Worker,想给弱网加个"离线兜底"。在桌面浏览器验证得完美。塞进 App 的 WebView 后,要么注册失败、要么缓存了却读不出来、要么在 iOS 上奇奇怪怪地失效。

SW 是 Web 标准没错,但在**容器环境**里,它的受支持程度和可用范围都打折扣。

---

### 4.2 先破误区

> • 误区："我项目里装了 Service Worker,所以 H5 在 App 里能离线。"
> • 事实：SW 在 Android 走系统 WebView(Chromium 内核)时是否真的触发、iOS WKWebView 是否支持、以及 App 是否放行,都受系统/内核/策略影响,以实测为准。更重要的是,"SW 离线"和"离线包"根本不是一回事——SW 是页面在 WebView 内的网络代理;离线包是容器在 Native 拦截把本地资源交给请求(术语红线:离线包 ≠ 缓存 ≠ Service Worker)。

> • 误区："SW 能离线,那我用它做 App 内容离线最合适。"
> • 事实：SW 适合做弱网兜底的小场景;主流 App 的离线更新/秒开方案是离线包(阶段 7),不是 SW。

---

### 4.3 原理讲解

#### 4.3.1 SW 在容器里的现状

- **Android**:SW 走系统 **WebView(Chromium)** 内核,**支持能力随内核版本滚动**(chromium 内核版本决定 fetch/缓存/推送支持)。老设备/厂商自研内核(如 X5 但不完全)支持情况打折,**必须以真机实测为准**。Android 8/9 的老系统 WebView 上,SW 表现比新版 Chromium 差很多是常见情况。
- **iOS**:WKWebView **自 iOS 支持以来逐步放开 SW**,但受 WebKit 实现与**容器策略(如 App-Bound Domains)**约束。SW 需要 `https`(或 `localhost`)的**安全上下文**才能注册;对域名的白名单、同域名限制以实测为准(红线 §4.6:吃不准写实测)。

**安全前提(红线 §4.6)**:

- SW 只能注册在 **`https`**(或 `localhost`)安全上下文中;
- **HTTP 域名注册不了 SW**。所以容器里"我用的都是 http 内网"则 SW 直接不可用;
- 演示时用 `localhost` 起一个本地服务即可跑通,生产必须 `https`。

#### 4.3.2 SW 与"离线包"的本质区别

| | Service Worker | 离线包 |
|---|---|---|
| 运行位置 | WebView 内,页面自己的 JS | 容器的 Native 拦截层 |
| 干什么 | 拦截页面自身的 fetch,返回 Cache Storage 资源 | Native 拦截请求 → 映射到打进 App 的本地资源 |
| 谁来管 | 前端自己 | 容器(版本/灰度/增量) |
| 触发时机 | 页面跑起来后才生效 | 请求发出前就被拦截 |
| 优劣 | 灵活但慢一拍、受内核支持限制 | 可控、秒开,但依赖容器能力 |

一句话:**SW 是页面帮自己"抄近道";离线包是容器在页面前面先挡一手**。前者前端可控,后者容器可控、更接近"离线体验"的真需求。

---

### 4.4 一个"只在本地演示能跑"的最小 SW(cache-first)

`www/sw.js`:

```js
const CACHE = 'demo-v1';
self.addEventListener('install', (e) => {
  // 预缓存首页
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])));
  self.skipWaiting();           // 演示用:立刻接管控制
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  e.waitUntil(clients.claim());
});
self.addEventListener('fetch', (e) => {
  // cache-first:有缓存回缓存,没有再去网络
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
    )
  );
});
```

注册入口(`index.html`):

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => {
    console.log('SW 注册成功(本地 demo)');
  });
}
```

> **重要**:这是**缓存优先**的 demo,只适合本地演示。生产绝不能无脑 cache-first 缓存一切——否则就是你"用户看到旧 H5"的头号来源(见第 3 节)。

#### 4.4.1 生产注意事项(写进代码注释也行,这里讲清)

1. **缓存策略分类**:HTML 用`network-first`(先网络、网络挂用缓存),静态资源用 `cache-first`+hash 文件名;别全 cache-first。
2. **版本号**:SW 文件内容变 → 浏览器重下并激活;用 `CACHE` 版本前缀 + 清理旧缓存,配合 `self.skipWaiting()`。
3. **别缓存带登录态/token 的接口**(敏感数据不能进 Cache Storage)。
4. **实时性**:SW 更新有"旧缓存仍可被用一段时间"的窗口,发布新版本要处理。
5. **容器策略**:确认容器不拦截、不放行域名、不开 SW(有的容器出于安全/一致性会主动禁用)。

---

### 4.5 结论:什么时候用 SW

SW 在容器里适合做**弱网兜底**(网络挂了,先用缓存里的壳/壳数据顶住),它能截住页面自身的 fetch。但**主流 App 的"离线更新/整包离线/秒开"方案是离线包(阶段 7)**,因为:

- 离线包在 Native 拦截层,比 JS 更早、更可控;
- 离线包有版本/灰度/增量/强更体系,前端不用管网络栈;
- SW 受内核/系统策略限制、且天然有"旧资源仍可被读到"的实时性窗口。

**结论**:SW 可以用,但定位是"弱网兜底",不是"离线解决方案"。别在容器里过度依赖 SW。

---

### 4.6 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 注册失败 | iOS/老安卓 register 不 resolve | 非安全上下文 or 内核/策略不支持 | 用 `https`/`localhost`;真机实测支持度 |
| cache-first 吐旧 | 发版后一直旧版 | 缓存优先策略 + SW 没做版本号 | HTML network-first + 版本号 + skipWaiting |
| 和清缓存脱钩 | 清了 App 缓存还旧 | 清了 WebView 缓存,SW 的 Cache Storage 还在 | SW 缓存要单独失效;生产用离线包管版本 |
| 缓存了登录态 | 敏感接口数据进了 Cache Storage | fetch 全缓存 | 接口不缓存;静态资源才缓存 |
| http 内网想用 | 完全注册不了 | 非安全上下文 | 容器网络/跨域要 https |

---

### 4.7 自测题

1. SW 注册的**安全上下文**要求是什么?http 能注册吗?
2. 容器里"离线包"和"Service Worker"本质区别是什么?
3. cache-first 策略什么场景下会直接导致"用户看到旧版"?
4. 动手:用 `localhost:8080` 起一个静态服务,把上面的 sw.js 塞进去,断网后刷新看缓存是否兜底。
5. 问自己:你项目里"离线/秒开"到底该用 SW 还是离线包?为什么?

<details>
<summary>参考答案(思考后再点开)</summary>

1. `https`(或 `localhost`)。http 注册不了 SW。
2. SW 是页面内的网络代理(前端可控、慢一拍、受内核支持);离线包是容器 Native 拦截映射本地资源(更早、版本/灰度可控)。
3. 所有资源一刀切 cache-first,又没做版本号 + skipWaiting,发版后旧缓存一直优先,用户永远看到旧版。
4. (动手)断网后 cache-first 命中缓存即可兜底。
5. 取决于你的目标——只做弱网兜底可用 SW;要整包离线/秒开/灰度走离线包(阶段 7)。
</details>

---

## 5 · 抓包与网络代理——为什么 H5 的请求"抓不到"

> 所属:阶段 5 · Cookie / 存储 / 缓存 ｜ 上一节:ServiceWorker 与离线 ｜ 下一节:阶段 6 · 网络库与 H5 请求的真实路径 ｜ 返回总目录

---

### 5.1 问题引入

前端在电脑上配好 Charles,把手机代理到电脑,浏览器里的请求看得清清楚楚。一进 App 的 H5,只见 `CONNECT` 隧道一条,底下全是乱码;有的干脆断连。抓原生 App 的请求和抓 WebView 里的 H5 请求,根本不是一套玩法。

---

### 5.2 先破误区

> • 误区 A：设了系统代理,HTTPS 就能解密看到明文。
> • 事实：系统代理只是把流量转发给 Charles。HTTPS 的应用层内容被 TLS 加密,Charles 要"解密成明文"必须给 App 安装并信任 Charles 的根证书,否则只能看到 `CONNECT` 隧道和密文。装了证但 App 不信任,一样解不开。

> • 误区 B：只要装了证书就通吃所有请求。
> • 事实：还要过三道关——①操作系统信任该证书(Android 7+ 用户证书默认不信原生栈的 / iOS 需手动"完全信任");②目标 App 若是调试包/允许用户 CA,WebView 才会走;③如果 App 或服务端做了 certificate pinning,直接让 Charles 失效。

> • 误区 C：抓不到 = 前端代码问题。
> • 事实：抓不到多半是证书信任/栈归属/pinning问题,不是你的请求没发。归因先放容器侧,别急着改代码(红线 §5.6:Android 7+ CA、pinning 影响的是谁,必须准确)。

---

### 5.3 原理讲解

#### 5.3.1 HTTPS 明文/证书问题

Charles 是**中间人代理(MITM)**:它用自己的证书和客户端握手、用真实证书去访问服务端,从而解密双向明文。前提是**客户端信任 Charles 的根证书**。

#### 5.3.2 Android:Android 7+(API 24+)用户证书默认不信任

- Android 从 **7.0(API 24)** 开始,**默认不信任"用户 CA(user CA)"证书**用于 TLS——只信任系统证书。你往"证书安装"里装的 Charles 证书落在**用户证书区**,原生网络栈(OkHttp)默认不认。
- WebView 走的 Chromium 栈同样受影响。
- **解法**:
  1. **调试包**:给 App 配 `network_security_config.xml`,把 Charles 的 user CA 加入信任域(常见做法:只在 debug 布搞)。
  2. **抓系统 CA**:把 Charles 证书装进**系统证书区**(需 root,或模拟器 `-writable-system`)。
  - 下面给 debug 用 `network_security_config` 示例。

`app/src/debug/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system"/>
      <!-- 仅调试包:信任用户 CA,Charles 才能解密 H5 -->
      <certificates src="user"/>
    </trust-anchors>
  </base-config>
</network-security-config>
```

Manifest 里(examinedebug 指向它):

```xml
<application android:networkSecurityConfig="@xml/network_security_config">
```

> ⚠️ 这**只**让网络栈信任用户的 Charles 证书,**不解决 certificate pinning**——若 H5/容器做了 pinning,下面 §5.3.4 说清影响。

#### 5.3.3 iOS:安装描述文件 + 手动"完全信任"

iOS 步骤比 Android 更繁琐但也更明确:

1. 把 Charles 证书(**der**)想办法装进 iPhone;
2. **设置 → 通用 → VPN 与设备管理 → 安装**证书描述文件;
3. **设置 → 通用 → 关于本机 → 证书信任设置 → 打开"完全信任"**(iOS 10.3+ 起,不在"证书信任设置"里开全信任,则不被认为可信)。

这三步缺一,`NSURLErrorDomain` 或请求直接失败。同样,这一步也不解决 pinning,只要 App/服务端 pin 了,仍抓不到。

#### 5.3.4 Charles SSL Proxying 对两条管道的差异(红线 §5.6)

回想总章:App 里 H5 请求走**管道二(WebView 内置网络栈)**,原生请求走**管道一(OkHttp/URLSession)**。

| 场景 | 管道一(原生) | 管道二(WebView 内 H5) |
|---|---|---|
| 系统代理转发 | 走 | 走 |
| 信任 user/自定义 CA 后解密 | 看网络配置(默认可能不信任 user CA) | 看 WebView/`network_security_config` |
| pinning 影响 | 有影响,直接失效 | 有影响(若 WebView/容器 pin 了) |

**Certificate pinning 影响的是谁**:pinning 是**客户端侧**校验——无论是 OkHttp 还是 WebView 内核,只要客户端(或其依赖)在握手时校验服务端证书指纹、且不信任 Charles 证书,那么 Charles 的 MITM 握手就会失败,请求失败/拒绝,**Charles 自然解密不了**。所以:不是 Charles 坏了,是**客户端 pin 了你访问的那个证书,Charles 不是它**。你抓不到 = pinning 让 Charles 失效了,不是前端代码问题。

> 有的 App 只在 WebView 里做 pin(保护 H5),有的在 OkHttp 全局 pin。**出现"原生抓得到、H5 抓不到 / 或反之",往往就是 pinning 只 pin 了某一边。**

---

### 5.4 前后端联合排查抓包 SOP(8 步)

1. **确认代理生效**:手机连上与电脑同一网络→代理设为电脑 IP:Charles 端口→浏览器/App 能看到 `CONNECT` 隧道。
2. **确认 HTTPS 跳转**:打开 Charles **Proxy → SSL Proxying → Enable**,并给目标域名勾选 SSL Proxying(不勾,HTTPS 只看到隧道)。
3. **确认证书装了**(双端差异):
   - Android 7+:确认是**调试包**(非 release),且 `network_security_config` 信任了 `user` CA;
   - iOS:证书描述文件已装 + **"完全信任"已开**。
4. **测一条最简单的请求**:原生 Open URL 或 H5 `fetch('/probe')`,先确保"能抓到一个明文请求"再继续。
5. **区分两条管道**:看这条 H5 请求的 **User-Agent / 发起方 / 是否带客户端公共 header**——判断它走的是管道二(WebView)还是管道一(原生库)(蹭阶段 6 的归因方法)。
6. **固定状态**:清掉强缓存/SW/离线包干扰(或临时关掉),避免抓到旧缓存糊弄自己。
7. **试 pinning**:如果只顾你能抓到"别家"、唯独你这套不行,八成是 pinning——临时白名单受害者证书或让后端开个实验域名证实。
8. **联合确认**:前后端看同一个抓包条目,确认**请求头/body/响应**,记录设备 UA、OS 版本、App 是否 debug、域名,归档给容器/网络负责人。

---

### 5.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 只见 CONNECT | 隧道多了,没有明文 | HTTPS 未解密 | 配 SSL Proxying + 装/信任 Charles 证书 |
| Android 全失败 | 装了证也失败/超时 | 7+ 默认不信用户 CA | 调试包 + `network_security_config` 信任 user CA |
| iOS 失败 | 装证后仍报 | 没开"完全信任" | 设置→证书信任设置→完全信任 |
| 抓不到各自 H5 | 原生 OK、H5 不行 | pinning 只 pin WebView | 归因给用户 CA 或 pinning,别改代码 |
| release 包抓不了 | 发了 release 包想抓 | 没 user CA 信任 | 用调试包调试;release 上始终抓不了(预期) |

---

### 5.6 自测题

1. 为什么设了系统代理,HTTPS 还是看不到明文?Charles 要走通需要哪两步?
2. Android 7.0 起为什么默认抓不了 HTTPS?调试包怎么信任 Charles?
3. **certificate pinning 影响的是谁**?为什么"原生抓得到、H5 抓不到"更像是 pinning 只 pin 了一边?
4. 动手:按 SOP 8 步给你的 App 配一次完整抓包,记下你卡在哪一步。
5. 简答:pinning 的东西如果你是前端,该找谁确认、怎么判断是 pinning?

<details>
<summary>参考答案(思考后再点开)</summary>

1. 系统代理只转发流量;HTTPS 应用层由 TLS 加密。要明文需:装 Charles 根证书 + 让客户端/网络栈**信任**它(Android user CA / iOS 描述文件)。
2. Android 7+ 默认不信任**用户 CA**;调试包通过 `network_security_config` 把 `user` CA 加入信任域即可。
3. pinning 影响的是**客户端**(OkHttp 或 WebView)校验服务端证书那一步。原生与 H5 分别 pin 时,只有被 pin 的那边失效——所以"原生 OK、H5 不行"指向 H5/WebView 侧 pin 了。
4. (动手)按 SOP 走一遍,大概率卡在 Android 7+/iOS 完全信任 or pinning。
5. 前端贡献:代码里有没有 `fetch` 时带自定义证书校验 / 服务端是否下发指纹。判定:临时关 pin 或开实验域名,能用 Charles 解开了就是 pinning。
</details>

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| CookieManager | Android 系统里管辖 Cookie 的"总仓库"，全局共享，WebView 的文档只是它的一份投影 |
| WKHTTPCookieStore | iOS 上挂在 WebsiteDataStore 下、管 WKWebView 文档 Cookie 的那一套，且写入是异步的 |
| HTTPCookieStorage | iOS 进程级共享的 Cookie 仓库，只管 URLSession 等非 WKWebView 请求，默认和 WKWebView 不共享 |
| WKWebsiteDataStore | iOS 上隔离网站数据（Cookie/存储/缓存）的容器，不同的 store 就是不同的"隔间" |
| document.cookie | 网页 JS 能读能写的那份 Cookie，只暴露非 HttpOnly 的项，并不等于全部登录态 |
| HttpOnly | 一种 Cookie 属性，标了它就不再暴露给 JS，但会随请求自动带上 |
| setCookie / flush | Android 写 Cookie 的 API：setCookie 异步入队，flush() 才是把队列真正落库的同步点 |
| 302 竞态 | 跳转过程里 Cookie 没及时跟上请求，导致首帧带不上登录态的一类时序问题 |
| per-instance | 给单个 WebView 配独立 Cookie 存储的做法，一旦用了就与系统仓库脱钩 |
| 登录态 | App/H5 用来识别"当前是哪个用户"的会话凭证，通常是 Cookie 里的一条 session |
| localStorage | 前端最常用的键值存储，落盘在宿主 App 数据目录里，属于"卸载即清"的弱持久存储 |
| sessionStorage | 会话级存储，同一 WebView 实例内跳转还在，新开实例就丢，按实例隔离 |
| IndexedDB | 浏览器标准的大容量结构化数据库，适合存长文本和大对象，配额满了写入会静默失败 |
| App 数据目录 | 存储真正落盘的位置（Android `data/data/<包名>`、iOS App 沙盒），卸载 App 就全没了 |
| 容器存储（桥） | 通过 JSBridge 让原生持久化数据的存储方式，登录态等丢不起的数据建议放这里 |
| `navigator.storage.estimate()` | 主动查询当前用量和配额的 JS API，用来提前发现存储快满 |
| `QuotaExceededError` | 存储配额用满时写入失败的报错，IndexedDB 里常被静默 reject，要 try/catch 兜住 |
| non-persistent store | iOS 上不落盘的临时数据仓，页面关掉数据就没了，用来验证存储共享边界 |
| `WebStorage.deleteAllData()` | Android 容器清空网站数据的 API，会连带清掉 localStorage/IndexedDB 等，前端无权限调用 |
| 强缓存 | 命中后直接读本地缓存、不再发请求访问网络的缓存方式,由 `Cache-Control` 等头控制 |
| 协商缓存 | 先发请求带上条件头问服务器"资源变了吗",没变才用本地缓存,由 `ETag`/`Last-Modified` 等头协作 |
| Cache-Control | HTTP 响应头,用 `max-age`/`no-cache`/`no-store` 指定缓存策略,决定资源能缓存多久 |
| ETag / If-None-Match | 协商缓存的一对头:服务器给资源盖章版本号,没变返回 304 |
| Last-Modified / If-Modified-Since | 协商缓存的另一对头:用资源最后修改时间来判断是否过期 |
| cacheMode | Android `WebSettings` 里的缓存模式(如 `LOAD_NO_CACHE`),决定这条 WebView 往不往缓存里翻 |
| Service Worker | 页面注册的一个脚本,可拦截网络请求,能自主决定回缓存还是回网络 |
| 离线包 | 把 H5 静态资源打进 App,由 Native 拦截映射本地资源,是资源替换,不是 HTTP 缓存 |
| 缓存破坏(query/hash) | 改文件名或加 `?v=<hash>`,让版本一变 URL 就变,从而绕开旧缓存的常用手法 |
| Cache Storage | 属于 SW 的缓存仓库,SW 用它存取资源,清 App 缓存时不会自动清掉它 |
| cache-first | 缓存策略:有缓存就先回缓存,没有才去网络,省流量但容易吐旧版 |
| network-first | 缓存策略:先走网络,网络挂了才用缓存,适合像 HTML 这样需要新鲜的内容 |
| skipWaiting() | 让新版本 SW 立刻接管、不等旧的"退役",配合发版更新使用 |
| 安全上下文 | 注册 SW 的前提:必须是 `https`(或 `localhost`),http 内网注册不了 |
| 弱网兜底 | 网络不好时先用缓存里的内容顶住,等网络恢复再更新的做法 |
| Charles | 一款常用的网络抓包代理工具,手机把流量转发给它,就能看到所有请求和响应 |
| SSL Proxying | Charles 对指定域名开启 HTTPS 解密的功能,不开启就只能看到加密的 CONNECT 隧道 |
| CONNECT 隧道 | HTTPS 走代理时的加密通路,没有证书合作关系时你只能看到它,看不到里面的内容 |
| MITM | 中间人代理,Charles 让自己冒充服务端跟客户端握手、再冒充客户端跟服务端握手,从而解密流量 |
| 根证书 | 需要装到手机系统里并被信任的 Charles 证书,是让 HTTPS 解密生效的关键一步 |
| 用户 CA / 系统 CA | Android 区分两类证书信任区:Android 7+ 默认只信系统 CA,不认用户装的 Charles 证书 |
| network_security_config | Android 的网络安全配置文件,调试包用它声明"信任 user CA",Charles 才能抓到原生栈流量 |
| 完全信任 | iOS 装完证书后还必须在"证书信任设置"里手动打开这一项,否则照样抓不到 HTTPS 明文 |
| certificate pinning | 客户端只认预置的服务端证书指纹,来自 Charles 的"不合格证书"会直接握手失败 |
| TLS | HTTPS 底下的加密层,用来保护应用层数据不被中间人读取 |
