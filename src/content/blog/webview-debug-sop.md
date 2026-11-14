---
title: 联合调试与线上问题 SOP
date: 2026-11-14
excerpt: "线上 H5 出问题先选对工具。六类 WebView 故障用决策树走到动作，再用三则推演把 SOP 跑通。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 11
lang: zh
draft: false
ogImage: /images/webview-and-native/stage10-01-debug-matrix.png
---

> 📖 本章由 3 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · 双端调试工具矩阵：线上 H5 出问题，先用哪把刀
- 2 · 排障决策树：六类线上 WebView 问题，"现象→先看X→分支→动作"
- 3 · 三个实战推演：把决策树跑一遍的线上故障（可作面试素材）
- 本章术语表

---
## 1 · 双端调试工具矩阵：线上 H5 出问题，先用哪把刀

### 1.1 问题引入

线上客服转来一条："H5 页面新版本点了没反应，部分用户白屏。" 谁都说不清该前端查还是客户端查——因为连"怎么连到你 App 里的 WebView 看 console"都还没搞定。本节先解决最基础、也最决定效率的一件：**工具矩阵**。把每把刀的"能看哪层、在哪一步能用、前提条件"拉成一张表，排障时直接对号入座。

### 1.2 工具矩阵总表

> • 误区：一把 `chrome://inspect` 就能包打 Android + iOS + 全生命周期。
> • 事实：`chrome://inspect` 只能连 Android 且开了调试开关 的 WebView；iOS 要用 Safari 开发菜单；工具在不同阶段（开发联调 / 预发 / 线上灰度）的可用性完全不同。线上灰度版不开调试开关，它就是黑的——这时只能靠"任何容器都能跑"的 vConsole/eruda 与日志兜底。

| 工具 | 平台 | 能看哪层 | 前提条件 | 适用阶段 |
|---|---|---|---|---|
| **chrome://inspect** | Android | DOM / 网络 / Console / 性能 / 内存 / 崩溃 | USB 调试 + 真机开发者选项；目标 WebView 需可调试（见§1.3） | 开发联调 / 预发（开了调试开关） |
| **Safari 开发菜单** | iOS | DOM / 网络 / Console / 性能 / 内存 | Mac 端先在 Safari 设置→高级→勾选"显示'开发'菜单"；真机另需 USB 连接 + iOS 设置→Safari→高级→Web Inspector | 开发联调 / 预发 |
| **Xcode Devices** | iOS | 真机系统日志 / 崩溃报告 / 常用沙盒与偏好 | Mac + USB 连真机 / 模拟器 | 开发联调 / 崩溃溯源 |
| **Android Studio Layout Inspector** | Android | 原生层控件树（WebView 宿主布局、遮挡关系） | Android Studio + 已 debug 的 App | 开发联调（查"原生层导致 H5 被盖住/键盘遮挡"） |
| **Charles / Proxyman** | 双端 | 网络层（请求头 / 响应体 / 302 / header） | 代理连通 + HTTPS 证书安装 + 系统代理生效 | 开发 / 预发 / 线上（能抓多少由容器策略决定） |
| **vConsole / eruda** | 双端任何容器 | console / network / element / storage | 页面里装了脚本（线上灰度靠灰度开关注入） | **线上灰度兜底主力** |
| **双端崩溃日志** | 双端 | 进程级崩溃（App 崩 / WebContent 被杀 / 内存阈值） | 接入了崩溃采集（能看到 renderer_process 这类崩溃点） | 线上（归因进程被杀类白屏） |
| **容器侧日志** | 双端 | 导航、注入、Cookie 同步、Bridge 被调、离线包命中 | 容器有上报埋点 | 线上（前端看不到的"壳"动作） |

> 一句话记：**开发联调靠 chrome://inspect + Safari；预发看是否开调试开关；线上灰度基本只能靠 vConsole/eruda + 崩溃日志 + 容器日志三者合成。**

![双端调试工具矩阵](/images/webview-and-native/stage10-01-debug-matrix.png)


### 1.3 Android 实操：从 USB 到 inspect 一台 WebView

1. **开开发者选项**：设置→关于手机→连点版本号 7 次，进开发者选项打开 **USB 调试**。
2. **开 WebView 调试开关（关键）**：`chrome://inspect` 只能连"声明可调试"的 WebView。debug 构建默认可调；**release 构建必须显式调 `setWebContentsDebuggingEnabled(true)`**，否则设备列表里能看到设备、但 WebView 一栏是空的。

```kotlin
// Android · 工程里任意位置（release 也要生效，须放在 load 之前）
WebView.setWebContentsDebuggingEnabled(true)   // 全进程生效；线上灰度一般靠调试构建/灰度开关打开
```

注意这个开关只开"被调试能力"，**远程调试本身走 USB ADB 通道**。手机只开了开发者选项但没连 USB、或连了没授权"允许 USB 调试"，`chrome://inspect` 里设备可能显示 offline。归因"设备在但 WebView 空 / 设备不断离线"时先查 ADB 连接与授权弹窗，别误判成容器问题。

> **安全提示**：`setWebContentsDebuggingEnabled(true)` 等于给页面开放完整调试能力，**只应在 debug/预发构建或明确的白名单灰度里打开**，绝不默认全开后再上生产——这正对应阶段 9 安全篇"调试后门即攻击面"的约束。

3. **打开 chrome://inspect**：电脑 Chrome 访问 `chrome://inspect`，勾选 **Discover USB devices**，USB 连手机。页面列表会列出该设备所有可调试 WebView，点 **inspect** 即得完整 DevTools。
4. **README 级注意**：`chrome://inspect` 中"URL 能打开但没有任何请求"时，多半是命中**离线包**（见阶段 7）。URL 仍是线上域名并不代表走了线上。

**X5 / XWeb 内核的差异**：接入 X5/XWeb/U4 的 WebView 调试入口可能**不走标准 chrome://inspect**，或需要各自的专门调试工具/开关，且随内核与 App 版本变化。**遇到无法 inspect，先确认设备跑的是哪个内核（看 UA 特征，见阶段 2·05），再按其调试通道走；具体到你们容器怎么开，以实测为准。**

### 1.4 iOS 实操：Safari 开发菜单连上 WKWebView

1. **模拟器**：Mac 开 Safari→偏好设置→**高级→显示"开发"菜单**；用 Safari 打开 `开发→[模拟器]→[h5.example.com WebView]` 即得 WebKit 检查器。
2. **真机**：除了 Mac 侧开 Safari 开发菜单，**手机上也要开**：设置→Safari→高级→**Web Inspector** 打开；再用 USB 把 iPhone 连 Mac，Safari 开发菜单里才出现设备。
3. 进入后右上角"检查器"就是完整 DOM/网络/Console，网络面板还能看 **302 重定向的时序**——这正是排查 Cookie 竞态的关键视图（见阶段 5）。

> iOS 16.4 起，检查 App 内 WKWebView 还需原生侧设 `webView.isInspectable = true`（此前版本默认可查）；连不上先确认这一项与容器是否关掉了检查能力，以实测为准。

> 提示：host 用 USB 直连即可，不必与代理冲突；但用 Charles 抓 HTTPS 时，设备与 Mac 需在同一局域网并装证书（见阶段 5·05 抓包篇）。

#### 1.4.1 Android Studio 兜底视角：Layout Inspector 什么时候用得到

大多数 H5 问题用 inspect / Safari 就够了；但有一种"怎么都查不出来"值得单独点名——**原生层控件把 H5 局部挡住了**（比如 Toast、浮层、键盘占位、全屏遮罩），DevTools 里 DOM 完全正常、交互却点不动。这时要用 **Android Studio 的 Layout Inspector** 看原生控件树：找到那个 WebView 节点，看它上面/前面有没有别的高 `z` 的 View 盖住，或它自身的 `measure` 尺寸被约束成 0/被裁切。"是原生盖住、不是 H5 白屏"这个归因，只有 Layout Inspector 能给你证据（iOS 侧对应 Xcode 的 View Hierarchy，但 App 内能力要看容器是否暴露）。

### 1.5 vConsole / eruda：任何容器都能跑的兜底

线上灰度的 WebView **通常没开调试开关**，chrome://inspect 和 Safari 都连不上。这时 vConsole/eruda 是唯一"还在页里"的检查器：

- **能力**：console / network（含请求耗时与状态码）/ element / storage / system 信息。
- **注入方式**：线上灰度靠**灰度开关 + 容器注入**。最稳的是让容器在所有页面加载前注入脚本（对应 iOS `WKUserScript.atDocumentStart`），H5 侧预先埋 `console` 与 `window.onerror` 上报，这样**不依赖远程调试，也能看线上 console 与 network**。

```js
// 前端 · 灰度兜底：动态注入 eruda（rd 域/调试开关下才加载）
if (window.__DEBUG__ || /eruda-demo/.test(location.search)) {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = () => window.eruda && window.eruda.init();
  document.head.appendChild(s);
}
```

**局限（诚实交代）**：vConsole/eruda 注入前的早期报错看不到，也看不见**上传到容器侧**的导航/注入日志；它对**性能/内存**只有大概参考，没有 WebKit 面板精确；`target=_blank`、进程被杀这类"壳级"行为它也无能为力。所以它定位"页面内问题"强，「壳的问题」要交给崩溃日志 + 容器日志。

### 1.6 联调 setup：双端同一份 H5、两侧工具同时连

排疑难时常见做法是 **Android / iOS 各一台设备，Android 用 inspect、iOS 用 Safari，同时盯着同一份 H5**：

- **host / 端口**：两台设备指向**同一套联调服务器**（同一域名 + 端口 + 同一分支），避免"我这边好了你那没更新"。
- **HTTPS 一致**：两侧都用同一个 https 域名，避免 ATS / 明文流量差异导致的误判（阶段 5·05）。
- **时间戳对齐**：给 H5 加一个只对调试域生效的 `?ts=` 与 `console.timeStamp`，两侧日志能对上同一时刻。
- **别把 Mock 当实测**：两台设备要**同时直连同一后端**或用同一份 mock，别一台直连、一台 mock，否则 Bridge/Cookie 行为无法对齐。
- **数据归口**：联调期建议把 `console` 的 `info/warn/error` 统一前缀（如 `[H5联调]`），方便两台设备的控制台一起 grep、也便于回头看录屏/日志对时间线。
- **容器侧怎么看**：Android `adb logcat | grep -iE "webview|chromium|cr_"` 能看到内核导航/崩溃/注入的容器日志；iOS 用 Xcode Devices 的设备控制台（或 `log stream`）按进程名过滤。容器日志是你判断"壳干了什么"的唯一现场（导航、注入、Cookie 同步、离线包命中），与 vConsole 互补，别互相替代。

### 1.7 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| release Inspect 不到 | chrome://inspect 看不到 WebView | release 没开 `setWebContentsDebuggingEnabled` | 显式打开（或用调试构建） |
| Safari 连不上真机 | 开发菜单里没设备 | 手机端 Web Inspector 没开 | 设置→Safari→高级→Web Inspector |
| URL 正常却无请求 | inspect 里 Network 空 | 命中离线包（阶段 7） | 看容器离线包日志/版本清单 |
| X5/U4 连不上 | inspect 无 WebView | 内核调试入口不同 | 确认内核→换调试通道；以实测为准 |
| 线上没调试开关 | 工具全黑 | 灰度 WebView 不放开调试 | vConsole/eruda + 崩溃日志 + 容器日志 |
| 双端时间对不上 | 两侧日志难比对 | host/环境/时间戳不一致 | 统一 host + `?ts=` 对齐 |

### 1.8 自测题

1. `chrome://inspect` 为什么管不了 iOS？线上灰度为什么常常连不上？
2. release 构建要不要显式调 `setWebContentsDebuggingEnabled(true)`？放在哪个时机？
3. Safari 连**真机**与连**模拟器**，手机端各要做哪一步？
4. 线上灰度连不上调试、又没装 vConsole，你还能靠哪两类数据定位？

<details>
<summary>参考答案（思考后再点开）</summary>

1. `chrome://inspect` 只认 Android 上声明可调试的 WebView（Chromium 系）；iOS 用 Safari 开发菜单（WebKit）。线上灰度 WebView 通常不开调试开关，工具就断连。
2. 需要。且放在 `loadUrl` 之前、对全进程生效；debug 构建默认已开。线上灰度一般靠调试构建/灰度开关打开。
3. 连真机：Mac 开 Safari 开发菜单 + 手机设置→Safari→高级→Web Inspector 打开 + USB 连接。连模拟器：Mac Safari 开开发菜单即可。
4. 双端崩溃日志（进程被杀）+ 容器侧日志（导航/注入/Cookie 同步/Bridge 被调），必要时灰度下发 vConsole/eruda。

</details>

---

## 2 · 排障决策树：六类线上 WebView 问题，"现象→先看X→分支→动作"

### 2.1 怎么读这棵树

每棵树的固定格式：**现象 → 先看 X（最该先查的一层）→ 是 / 否 两个分支 → 各给动作**。命中哪层就停在哪个动作。末尾是一行"常见根因 Top3"。先把六类问题的入口口诀记住：**白屏看网络 → 401 看管道 → Cookie 丢看时序 → Bridge 不通看就绪 → 返回键看 history → 键盘看 viewport**。

![六类 WebView 问题排障总树](/images/webview-and-native/stage10-02-troubleshooting-tree.png)


### 2.2 树① 白屏（先分"网络层有没有 HTML"）

> **先看**：网络层，HTML 文档到底到没到——不是先盯 JS。

- **问**：抓包 / 容器网络日志里，HTML 请求发出且返回了吗？
  - **是（200，HTML 到了）** → 看 JS：`chrome://inspect`/Safari console 里入口脚本是否一跑就崩。
    - 首帧前抛错 → **JS 早期异常**：看最早异常栈；上报 `window.onerror`/`unhandledrejection`；按阶段 8 白屏篇对入口脚本做隔离/兜底渲染。
    - 没报错但空白 → 看 DOM：`document.body` 是否一直空 → 渲染被异常中断，或**空态被误当白屏**（接口 200 但空数据）。
  - **否（没到 / 404 / 超时 / 空文档）** → 分清是"请求没发出去"还是"发了没回"：
    - 请求没发出 → **离线包拦截/内核网络栈问题**：看容器导航日志、离线包是否命中、`shouldInterceptRequest` 是否把请求拦丢了（阶段 7）。
    - 发出但 404/403/断网 → **资源没上线**：CDN 版本、白名单、域名；在线直连同一 URL 验证。
    - 发了但"看起来一切正常却空白"且 App 没崩 → **渲染进程被回收（WebContent 被杀）**：看崩溃报告是 WebContent 进程还是 App 进程；压内存复现；容器做进程被杀后自动 reload 自愈（阶段 8）。

> **常见根因 Top3**：① 离线包增量未覆盖 + 强缓存导致老版本首帧拉到坏资源；② JS 入口脚本线上构建崩溃（`window.onerror` 首现）；③ 渲染进程被杀（iOS WebContent / Android 内核回收）。

### 2.3 树② 接口 401/403（H5 与原生表现不同）

> **先看**：管道归属——这条请求走的是客户端网络库（管道一）还是 WebView 网络栈（管道二）。同一接口原生页正常、H5 偶发 401，几乎总是管道归属问题（阶段 6）。

- **问**：能抓到包 / 看 header 吗？抓到的 UA 是否带 wv 特征 / 走的是 WebView 那条栈？
  - **能区分出是 H5 发的** → 看 header 三件：**带没带签名头 / 带没带登录 Cookie / 有没有统一网关下发头**。
    - 没有 → H5 请求默认不带客户端签名（阶段 6）；两选：JS 层统一带业务 token，或容器用 shouldInterceptRequest/WKURLSchemeHandler 把 H5 请求转交客户端网络库补签名。
    - 有签名却仍 401 → 看**签名内容**（时间戳过期/参数漏字段/设备标识不符），多半是签名拼接与鉴权端不一致。
  - **看不出管道 / 原生与 H5 都有问题** → 可能是后端鉴权网关问题：去后端查该 URL 的鉴权记录（304/签名库/UA 明细），别在前端空转。
- **问**：是"偶发"吗？
  - 是 → 候选：Cookie 同步竞态（未 `flush`/`setCookie` 没 completion 就 load，阶段 5）、`401 后没重试`、弱网下请求被网关丢弃。用 `performance.getEntriesByType('resource')` 看这次 401 的 initiatorType 与耗时。
  - 不是（稳定 401） → 偏配置问题：域名白名单、HttpOnly 误判为空、或容器没同步登录态。

> **常见根因 Top3**：① H5 请求走了管道二、没带客户端统一签名；② 登录 Cookie 没在 `load` 前落库（时序）；③ 签名参数拼接与网关校验不一致。

### 2.4 树③ Cookie 丢失（三套 Cookie 视角 + 302 竞态）

> **先看**：先分清"是哪一份 Cookie"——JS 的 `document.cookie` / 容器的 WKHTTPCookieStore / 客户端 CookieManager 是三套（阶段 5），丢的可能只是其中一套。

- **问**：是 `document.cookie` 空，还是接口实际没带上？
  - 只是 `document.cookie` 空 → **可能是 HttpOnly**：登录 Cookie 常 HttpOnly，不给 JS 看但也正常随请求带上。用一次真实请求看响应/请求头判断，别用 `document.cookie` 判登录态。
  - 接口确实没带 → 看是"首次打开就丢"还是"中途掉"：
    - 首次打开就丢 → **同步时机错**：Android 没在 `loadUrl` 前 `flush()`；iOS `setCookie` 是异步，没等 `completionHandler` 就 `loadRequest`（阶段 5 金规）。
    - 中途掉 / 偶发 → **302 竞态**：重定向响应里 `Set-Cookie` 没及时进存储，下一次请求就带不上（阶段 3·05 / 5）。修：容器在 response 落库后再放行后续请求，或 H5 重触发一次带 Cookie 的请求。
    - 关了 App 再开就丢 → **进程被杀 / supervisor 清理站点数据**：走桥拿容器持久化 token 重建登录态，别只依赖 Cookie。

> **常见根因 Top3**：① `load` 前没写完 Cookie（时序）；② 被 302 竞态吃掉了重定向 Cookie；③ 把 HttpOnly 误判为"丢"。

### 2.5 树④ Bridge 不通（就绪竞态 / 对象未注入 / 队列堆叠）

> **先看**：`window.xxxBridge`（你们容器的桥对象名）到底在不在。三步自检脚本可直接粘到 console（见 demo）：

```js
// 三步自检（终端/console 粘贴）
// ① 桥对象是否存在
typeof window.xxxBridge                                  // 'object' 就绪；'undefined' 未注入/还没就绪
// ② 手动注入一条测试消息（对象存在时才走这步）
window.xxxBridge && window.xxxBridge.sendTestMessage && window.xxxBridge.sendTestMessage('ping')
// ③ 看容器日志：这条测试消息有没有被原生收到、回调有没有回来
```

- **问**：第①步 `typeof window.xxxBridge`？
  - `'undefined'`（对象不在） → **对象未注入 / 注入时机晚于你的 JS**：容器在 `atDocumentStart` 之后才注入，而你的脚本在 start 就跑；或容器只在特定 scheme/域名注入。查容器注入时机（阶段 4）；H5 侧加 ready 轮询/`window.addEventListener('bridgeReady')`。
  - `'object'`（对象在） → 走第②步发一条测试消息。
    - 没收到 / 没回调 → **回调节点被吞**：iOS 未实现 `WKScriptMessageHandler` 或回调异步时序（阶段 4）；Android 回调可能只在主线程；查容器 side 是否处理了这条消息。**有时是桥工作线程忙碌，追着发导致队列堆叠**——加调用并发上限与超时重试。
    - 收到但业务参数丢了 → **参数序列化 / 回调 ID 冲突**：序列化 JSON 里的字段被原生端 schema 校验过滤，或 callbackId 被并发复用（阶段 4 时序）。
    - 回调时通时不通、偶发超时 → **就绪竞态 + 队列堆叠叠加**：H5 在 `bridgeReady` 前就发了一批调用，回调挤在同一批里排队超时；排障时先在 console 打印 `window['cb_xxx']` 残留节点数和每次调用的 elapsed，判断是"没发出去"还是"回不来"。

> **常见根因 Top3**：① 桥对象注入晚于页面脚本（就绪竞态）；② 容器没实现对应 handler / 回调被吞；③ 回调 ID 重复或调用风暴堆叠超时。

### 2.6 树⑤ 返回键失效（canGoBack / history 长度）

> **先看**：H5 自身的 `history` 到底有几个 entry——是"没有可回退的前进栈"，还是"有栈但被容器吞了返回键"。

```js
// 自检（console 粘贴，≤5 行）
history.length                        // 有几个 entry；SPA 里 history.pushState 会增加
const g = performance.getEntriesByType('navigation')[0];
g && g.type                          // 'reload'/'navigate'/'back_forward'——回退串没串起来时常是 'navigate'
window.addEventListener('popstate', () => console.log('popstate fired', location.href));
```

- **问**：`history.length > 1` 且页面曾 pushState 过？
  - **是（有前进栈）但返回键没反应** → 是**容器没把返回键事件交给 H5**（没走 `history.back()`/`onBackPressed` 转发），或拦截 scheme 把页面 return 吞了。查容器导航拦截（Android `onBackPressed` / `decidePolicyFor`，阶段 2/3）。
  - **否（`history.length` 很小 / type 是 'navigate'）** → 是 **H5 路由本身没入栈**：SPA 首屏用 `pushState` 但没 push 裸 URL / 或整页用 `location.assign` 反复 reload，返回栈被清。H5 该用 hash/路由 history 保证 entry，或返回键自己走自定义历史栈。
  - 复核：真退出还是假退出——**App 没退、只是页面没回退**，重点查返回键在容器侧被 handle 的时机。

> **常见根因 Top3**：① 容器没把返回键转发给网页 history；② SPA 路由没正确入栈（反复 navigate）；③ 拦截器把返回当作 scheme 吞掉。

### 2.7 树⑥ 输入法遮挡 / 键盘后白块

> **先看**：`visualViewport` 在键盘弹起时的值——这是 WebView 里判断"键盘把可视区顶成多高"最靠谱的 API（CSS `100vh` 在 iOS 上常偏大）。

```js
// 自检（console 粘贴）：键盘弹起时看这里
window.visualViewport && window.visualViewport.addEventListener('resize', () => {
  console.log('viewport', {
    h: visualViewport.height,        // 键盘弹起会变小
    offsetTop: visualViewport.offsetTop
  });
});
```

- **问**：键盘弹起时 `visualViewport.height` 是否变小、输入框是否刚好在可视区外？
  - **是（可滚动/可跟随）** → 是**布局没跟随键盘**：用 `visualViewport.resize` 时把输入框 `scrollIntoView` 或重算 fixed 定位；别依赖 `100vh`。
  - **是（有遮挡/白块）**：① iOS 键盘弹起时 fixed 定位元素可能突跳/白块——用 `visualViewport` 高度重算 fixed 元素 top；② Android 部分容器默认 `adjustResize`/`adjustPan` 行为不同，iOS 与 Android 的键盘行为**以实测为准**（阶段 3·06 安全区/视口）。
  - 否（没明显问题却报遮挡） → 可能不是键盘问题，是**原生层某控件盖住了 H5 局部**（用 Android Studio Layout Inspector 看宿主层控件树）。

> **常见根因 Top3**：① iOS fixed 定位独占 viewport、键盘弹起后错位；② CSS `100vh` 在键盘下不缩（iOS 通病）而没走 visualViewport；③ Android/iOS 键盘 resize 模式差异未按容器实测适配。

### 2.8 给读者的最小 SOP（背下来）

1. 线上问题永远先判定**管道归属**（这个请求是 H5 发、原生发、还是桥发）。
2. 能用调试工具的用调试工具；线上没开开关就切换 **vConsole/eruda + 崩溃日志 + 容器日志** 三合一。这十类自检脚本已收进 demo，可整段粘进 console（见 `demo/stage-10-debug-sop/debug-console-snippets.md`）。
3. 每棵树都从"先看那一层"入手，命中的分支就停，不要连查三层；查完留档：把现象、命中分支、证据截图、结论归到该树的 Top 记录里，同一问题第二次出现时应能在几分钟内闭环。

### 2.9 自测题

1. 白屏先查网络层还是 JS？为什么？
2. 同一接口原生正常、H5 偶发 401，第一时间该看什么？
3. `document.cookie` 是空的就一定是"Cookie 丢了"吗？
4. Bridge 三步自检依次是什么？
5. 返回键失效最该先确认 H5 的 `history` 是否有 entry，对吗？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 先查网络层（HTML 到没到）。因为"容器在但内容空"往往先于 JS 崩，先把"资源/进程/离线包"排掉再盯 JS，顺序错了会在 JS 上白绕一圈。
2. 看管道归属 + header 三件（签名头 / 登录 Cookie / 网关下发头）。原生走的管道一、H5 走管道二，缺签名/Cookie 就 401。
3. 不一定。HttpOnly 的登录 Cookie 不进 `document.cookie` 但仍随请求带上，用真实请求头判断。
4. `typeof window.xxxBridge` → 手动注入一条测试消息 → 看容器日志有没有收到/回调。
5. 对。先确认 H5 有没有可回退的 entry（`history.length`/navigation.type），再决定是 H5 路由问题还是容器没转发返回键。

</details>

---

## 3 · 三个实战推演：把决策树跑一遍的线上故障（可作面试素材）

> 三则仿真故障，均为**合成示例**（不引用真实公司日志），用于把第 1、2 节的工具矩阵与决策树完整跑一遍。每则固定结构：**背景 / 现象 / 已知信息 / 推演笔记（证据链）/ 最终根因 / 复盘改进**。建议先自己推演，再看笔记。

---

### 3.1 案例 A：新版本 H5 上线后部分用户白屏

**背景**：某 App 内一个 H5 首页点了"版本 v8"更新离线包并发线上。全量后，客服陆续收到反馈：**部分老设备一打开首页就白屏**，刷新有时能好。

**现象**：白屏的只有部分（老系统/老机型居多）；同一台设备有时白、刷新后正常；原生页正常。

**已知信息（合成示例日志）**：

```
容器导航日志（某老设备）：
[09:14:01] 下发离线包 v8 完成  bundle=v8  fileHash=7f3a…  size=1.2MB
[09:14:02] scheme=https://app.example/h5/home  →  命中离线包 v8
[09:14:03] shouldInterceptRequest  →  映射到本地 assets/home/index.html
容器崩溃日志：无 WebContent 被杀的记录
H5 JS 上报：window.onerror 无；unhandledrejection 偶见
```

**推演笔记（证据链）**：

1. 白屏但"刷新能好"→ 优先排除"渲染进程被杀"（崩溃日志没有该记录），先按决策树①走**网络层：HTML 到没到**。
2. 命中离线包 v8，本地映射 `home/index.html` → 首帧 HTML 是**本地包内的旧或坏文件**。已知包更新是"增量差分包"，而离线包机制常见坑：**差分包只覆盖有变化的文件，老设备若没下载全量、或在 CDN 上只下发增量**，映射到的 `index.html` 可能仍是 v7 骨架、却引用了 v8 的 JS 路径 → 404 → 白屏。
3. 为什么"部分老设备"：老设备网络差，增量/全量更新失败概率高，停留在"v7 骨架 + v8 资源引用"这个**中间态**；新机型大概率更新完整，正常。
   （已知信息里 `unhandledrejection 偶见` 在此归因：v8 的 JS 路径 404，模块加载失败抛出未捕获 rejection，与中间态吻合。）
4. 再叠加**强缓存**（HTTP 缓存 / 离线包本地缓存）：即使 CDN 已修好，已被缓存的老资源不会自动回源拉新 → "刷新有时好、有时坏"。

**最终根因**：离线包增量未覆盖（老设备停在中间态）+ 强缓存，导致首帧 `index.html` 引用到不存在的 JS 资源而白屏。归因：**离线包更新策略 + 缓存版本一致性**（联动阶段 7·03 更新增量与灰度、阶段 5·03 强缓存）。

**复盘改进**：

- 离线包更新加**版本强校验**：映射前校验 `fileHash` 与页面引用是否一致，不一致回源线上。
- 增量更新失败要有**兜底**（下载全量 / 回退上一份稳定包）。
- JS 资源引用带 **content-hash 文件名** + 首页 HTML 用 `no-cache`，避免新旧资源混用。
- 上线走**分段灰度**（先小流量观察白屏率再放全量）。

---

### 3.2 案例 B：某机型 H5 表单提交偶发丢参数

**背景**：一个"提交订单"页面用 Bridge 把表单数据交给原生提交（业务走客户端的提交流程）。上线后某机型反馈**提交偶发失败，报"参数缺失"**；不是每次，压测复现率约 5%。

**现象**：表单填完点提交，偶发提示缺某个字段；重试一次往往成功。仅特定机型/低端机明显。

**已知信息（合成示例日志）**：

```
window.xxxBridge 桥上报：
[15:02:11.3] call:submitOrder callbackId=10007 params={"sku":"A1","qty":1,"note":"快"}
[15:02:11.7] bridge 收到消息，params 已解析
[15:02:11.7] 引擎要提交时：note 字段为空 → "参数缺失"
H5 侧：表单提交 onClick 同时触发了 页面跳转（location 到支付成功页）
```

**推演笔记（证据链）**：

1. 偶发且**特定机型/低端机** → 排除纯前端常量写死；先按决策树④的思路看**页面是否在提交瞬间发生卸载（unload）**。日志里"onClick 同时触发页面跳转"是头号嫌疑：**页面 unload 时，正在进行的 Bridge 回调被回收**。
2. `callbackId=10007` 已发、bridge 也收到且解析了 params → 说明**发送端没丢参数**，是"回调在 unload 途中丢失/回传的 params 被部分清掉"——低端机渲染线程与桥线程竞争更激烈，回调丢失更明显（阶段 4 时序）。
3. 为什么重试就好：重试时页面已稳定、unload 未干扰，回调完整回来。
4. 为什么报"note 字段为空"而非整单丢：序列化快照在跳转瞬间被回收，部分类型（字符串长字段）写盘/传递时序被截断。

**最终根因**：桥梁回调与页面 `unload` 竞态——表单提交触发页面跳转的瞬间，Bridge 回调被回收而丢参数。归因：**回调生命周期 + 页面卸载时机**（联动阶段 4·02 调用时序）。

**复盘改进**：

- 表单提交时**阻止默认跳转**，等 Bridge 回调成功后再 `location` 跳转（串行化，不让 unload 打断回调）。
- 需要跳转时给回调留出时间：回调回来才路由，否则不要同时发起。
- H5 侧对 Bridge 调用做**超时重试 + 幂等**，回调未回时自动重发一次。
- 客户端对回调参数做**快照完整校验**，缺字段返回明确错误码而非静默空。
- 面试谈法："丢的不是发送，是回传途中的 unload 竞态"——这句话能把你和只会"重试一下"的人区分开。

---

### 3.3 案例 C：客服反馈"登录后页面还是未登录"

**背景**：用户先在 App 原生登录页完成登录，再进 H5 某个需要登录的页面，页面却一直显示"未登录/请重新登录"，H5 接口全 401。

**现象**：原生登录成功、原生页接口正常；**进 H5 就 401**；刷新一次偶尔变正常。

**已知信息（合成示例日志）**：

```
原生登录成功后：
[20:41:09.2] 登录接口 200，重定向到 https://app.example/login?code=xx&redirect=/h5/cart
[20:41:09.4] 容器 loadRequest https://app.example/h5/cart
H5 页面请求链：
[20:41:09.4] GET /h5/cart  → 302 Location: /h5/cart?token=yy
[20:41:09.5] GET /h5/cart?token=yy  → 401（触发重登）
刷新后：
[20:41:11.0] GET /h5/cart → 200（带上了 Cookie）
```

**推演笔记（证据链）**：

1. 原生页正常、H5 401 → 按决策树②先判**管道**：H5 走 WebView 网络栈，登录态 Cookie 是否同步到 WebView 的 Cookie 存储？原生 `HTTPCookieStorage.shared`（管道一）与 WKWebView 的 `WKHTTPCookieStore`（管道二）**不共享**（阶段 5）。
2. 再看时序：`loadRequest` 在登录后立即发起，但 **`setCookie` 到 `WKHTTPCookieStore` 是异步**的——"先 load 后落库"导致首帧不带 Cookie，或**302 竞态**：重定向响应里的 `token=yy` 落地前，后续 `/cart?token=yy` 已发出 → 401（阶段 3·05 / 5）。
3. 日志特征完全吻合：`09.4` load → 302 → `09.5` 401，三连全在同一个 100ms 内，Cookie 根本没来得及同步；刷新后 Cookie 已就位 → 200。
4. 为什么"偶发/刷新才好"：竞态是概率性的，取决于同步线程与请求线程谁先完。

**最终根因**：Cookie 同步时序 + 302 竞态——登录态未在 `load` 前落库到 WebView 的 Cookie 存储，重定向链路又叠加 302 竞态吞了 `token` Cookie。归因：**Cookie 三套 + 同步时机**（联动阶段 3·05、阶段 5·01）。

**复盘改进**：

- 遵循金规：**等 `setCookie` 的 completionHandler / `flush()` 完成后再 `loadRequest`**（阶段 5）。
- 对 302 竞态：容器在响应落库后再放行后续请求，或用一次带 Cookie 的 request 触发重试。
- H5 侧 401 拦截一次后自动携带已同步 Cookie 重试一次，而非直接跳到"请重新登录"。
- 用 Safari 开发菜单的 Network 面板直接看 302 时序，作为回归验证。

---

### 3.4 小结

| 案例 | 现象入口 | 决策树 | 第一手证据 | 根因一类 |
|---|---|---|---|---|
| A · 上线白屏 | 部分老设备白、刷新时好时坏 | 树① 白屏 | 命中离线包 v8 + 崩溃无记录 | 离线包增量 + 强缓存 |
| B · 表单丢参 | 特定机型偶发缺字段、重试即好 | 树④ Bridge | `callbackId=10007` 已发、字段半空 | 桥回调 × unload |
| C · 登录后 401 | 原生正常、H5 401、刷新偶好 | 树② 401 | `load→302→401` 挤在 100ms 内 | Cookie 时序 + 302 竞态 |

三个案例分别踩中三张树：**白屏→离线包与缓存（树①）**、**表单丢参数→桥回调与 unload（树④）**、**登录后 401→Cookie 时序与 302 竞态（树②）**。共性是：**都不是一句"重试/清缓存"能解释的，都要靠"留证据→归因到正确的那一层→给出可复盘的永久修法"**。面试时能把这套"证据链→根因→复盘"讲清楚，比直接报结论有说服力得多——尤其是你能主动指出"刷新生效"这个头号迷惑点。

### 3.5 自测题

1. 案例 A 为什么"老设备/老机型"更容易白屏？
2. 案例 B 的修复为什么要把"跳转"放到 Bridge 回调成功之后？
3. 案例 C 日志里 `09.4` load → `09.5` 401，说明了什么时序问题？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 老设备网络差，离线包增量/全量更新失败率高，容易停在"旧骨架引新资源"的中间态；再叠加强缓存，坏版本被缓存住不清。
2. 提交跳转的瞬间会触发页面 unload，把正在进行的 Bridge 回调回收掉导致参数丢失；串行化（回调成功再跳）就避免竞态。
3. 说明 Cookie 未在 `load` 前落库到 WebView 存储，且重定向里的 `token` 又被 302 竞态吞掉，导致首帧请求 401；刷新后 Cookie 就绪才 200。

</details>

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| chrome://inspect | 电脑 Chrome 里的一个入口地址，能用电脑看安卓手机里 WebView 页面的 DevTools |
| Safari 开发菜单 | Mac 上 Safari 顶部"开发"菜单，调 iOS 里 WebView 的页面就是从这连进去 |
| Web Inspector | Safari 连上页面后弹出的检查器，相当于 Safari 版的 DevTools |
| USB 调试 | 安卓开发者选项里的开关，打开后电脑才能通过数据线接管手机上的页面 |
| 远程调试 | 页面在手机上跑、调试面板在电脑上看的工作方式，靠 USB 通道串起来 |
| setWebContentsDebuggingEnabled(true) | 安卓 WebView 的"允许被调试"开关，release 包不开它连 inspect 都连不上 |
| vConsole | 注入到页面里的悬浮调试面板，不连电脑也能在手机上看 console 和 network |
| eruda | 和 vConsole 同类的前端调试面板，动态加一个 script 标签就能用 |
| Charles / Proxyman | 电脑上的抓包工具，能看请求头、响应体和 302，抓 HTTPS 得先装证书 |
| ADB | 安卓与电脑通信的命令行工具，设备一直显示 offline 先查它和授权弹窗 |
| Layout Inspector | Android Studio 里看原生控件树的工具，能证明"H5 是被原生 View 盖住的" |
| X5 / XWeb / U4 内核 | 国产 App 常替换系统自带的 WebView 内核，调试入口可能不走标准 chrome://inspect |
| 离线包 | App 提前下载到本地的页面资源包，URL 正常却抓不到请求多半是命中了它 |
| 灰度开关 | 服务端可配、只对部分用户或版本生效的开关，线上 vConsole/eruda 常靠它注入 |
| 容器侧日志 | 原生"壳"自己的动作记录（导航、注入、Cookie 同步），前端看不到的壳行为全在这里 |
| 决策树 | 线上出问题后"先看哪层、再看哪层"的判断流程，命中哪个分支就停在哪 |
| 管道一 | 客户端网络库那条通道：原生 OkHttp/URLSession + 网关封装，统一签名/HTTPDNS/监控都长在这 |
| 管道二 | WebView 内置网络栈：H5 的 fetch/XHR/图片默认从它直发，享受不到管道一的网关能力 |
| 排障 SOP | 把排障套路固定成的标准动作，同一问题第二次几分钟内就能闭环 |
| 白屏 | 页面加载完却一片空白，第一件事是看 HTML 到没到，不是先盯 JS |
| 管道归属 | 判断这条请求是 H5 发的还是客户端网络库发的，H5 偶发 401 十有八九卡在这 |
| 网关 401 | 统一网关校验签名或登录态不过关时返回的"未授权"，接口直接 401 |
| 签名头 | 客户端网络库给请求加的防伪参数，H5 默认不带，缺了网关就拒收 |
| Cookie | 服务器要求浏览器随请求带上的登录凭证，WebView 里存有多套、可能只有一套有值 |
| HttpOnly | Cookie 上"不给 JS 读"的标志，document.cookie 看不见但它照样随请求发出 |
| 302 竞态 | 重定向响应里刚下发的 Set-Cookie 还没存好，下一个请求就发出去了，于是带不上 |
| 就绪竞态 | 页面脚本跑得比容器注入桥对象还早，早发的那批 Bridge 调用全落空 |
| 桥对象（xxxBridge） | 原生注入给 H5 的 JS 对象，页面调用 App 能力全靠它 |
| 队列堆叠 | 桥没回完上一个回调又压进新调用，越积越多最后集体超时 |
| history / pushState | SPA 用 JS 手动塞出来的浏览记录，塞得不对返回键就没东西可退 |
| popstate | 用户按返回、浏览器历史变化时 H5 收到的事件，不响说明事件没交到 H5 手里 |
| visualViewport | "真正可视区域"的实时数据，键盘弹起时按它算布局，别相信 100vh |
| 推演 | 不急着改代码，先拿日志当证据一步步推出根因的过程 |
| 证据链 | 从现象到根因每一环都有日志或截图撑着，结论才立得住 |
| 归因 | 把问题判到正确的层（资源层/壳层/时序层），判错了修什么都白修 |
| 离线包增量更新 | 只下发有变化的文件，老设备下载不全就会停在"旧骨架引新资源"的中间态 |
| 强缓存 | 指着浏览器继续用本地存的旧资源不回源，CDN 修好了线上也可能不生效 |
| content-hash 文件名 | 文件名里带内容哈希，内容一变名字就变，天然避免新旧资源混用 |
| 分段灰度 | 先放一小部分用户观察指标再全量，出问题不至于全网翻车 |
| 渲染进程被杀 | 系统内存吃紧时 WebView 渲染进程被回收，App 没崩但页面挂了或白掉 |
| Bridge 回调 | H5 喊原生办事后等原生回话的机制，回话没回来参数发了也白发 |
| callbackId | 每次桥调用的编号，靠它把"发出去的调用"和"回来的回调"对上号 |
| unload 竞态 | 页面跳转瞬间正在收尾，进行中的 Bridge 回调被回收，参数就丢在半路 |
| 幂等 | 同一操作执行多次结果都一样，是"超时自动重试"的安全前提 |
| Cookie 三套 | document.cookie、iOS 的 WKHTTPCookieStore、安卓的 CookieManager 各存各的，丢的可能只是其中一套 |
