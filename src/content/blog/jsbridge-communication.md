---
title: JSBridge：通信原理与自研
date: 2026-11-14
excerpt: "H5 与 Native 的四条通道和回传三式，从一次 getLocation 走完时序，再落到就绪竞态、SPA 路由和能力协商。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 5
lang: zh
draft: false
ogImage: /images/webview-and-native/stage4-01-jsbridge-sequence.png
---

> 📖 本章由 5 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · H5 ⇄ Native 四通道与回传三式全对比
- 2 · 一次调用的完整时序：从 getLocation 到 {lat,lng}
- 3 · 自研 MiniJsb：100 行写透 Promise 版 JSBridge
- 4 · 就绪竞态与 SPA 路由："页面一到，桥在不在"
- 5 · 能力协商与版本兼容：新前端配旧壳不炸
- 本章术语表

---
## 1 · H5 ⇄ Native 四通道与回传三式全对比

### 1.1 问题引入

值班群两条消息前后脚进来：测试在安卓机上反馈"点定位没反应，控制台报 `window.NativeBridge.getLocation is not a function`"；同一份 H5 在 iOS 上报"`undefined is not an object (evaluating 'window.webkit.messageHandlers.NativeBridge.postMessage')`"。前端把 UA、权限、抓包排查了一圈，最后发现根本是两个问题——两家容器选的"过桥通道"不一样，桥在 window 上长得也不一样。

先把心智模型立准：**桥（JSBridge）= 通道 + 协议**。通道由系统 API 决定（Android 和 iOS 各自提供什么"过河的船"），协议才是容器（壳）自己定义的（消息信封怎么拼、回调怎么对上、错误怎么上抛）。本节穷举 H5→Native 的四条通道、Native→H5 的三种方式，并给出"现代项目选哪条"的结论。一次调用怎么走完时序看 02 篇，代码级自研看 03 篇。

### 1.2 先破误区

> • 误区：桥是一个双端统一的 window 对象，长短不一样是某端"没写好"。
> • 事实：差异来自通道本身——Android 提供"对象注入 / URL 拦截 / 弹窗拦截"三条路，iOS 现代方案只有 WKScriptMessageHandler。能统一的只有协议层（信封、回调池、超时），这正是 03 篇自研要干的事。

> • 误区：桥调用和本地函数一样，是同步的。
> • 事实：Android 注入对象的方法是同步 Java 调用（但跑在名为 JavaBridge 的后台线程），iOS postMessage 是异步消息；且无论哪种，"能力执行 + 结果回传"整体必然异步。把消息当函数用，是"回调丢失""并发串包"一类问题的思想根源。

### 1.3 原理讲解

#### 1.3.1 H5 → Native：四条通道总览

回看总章图里的 Container 层：桥就住在容器里（[总章 fig/01](/images/webview-and-native/stage1-01-three-layer-dual-pipe.png)）。四条通道的完整对比如下：

| 通道 | 平台 | JS 侧写法 | 原生回调线程 | 吞吐 | 丢消息面 | 注入就绪时序 | 依赖 WebView 版本 |
|---|---|---|---|---|---|---|---|
| `addJavascriptInterface` | 仅 Android | `window.MiniJsb.post(JSON.stringify(msg))` | 名为 JavaBridge 的**后台线程** | 高（对象方法直调） | 小（同步调用不丢） | 注册必须在第一次 loadUrl 之前 | 强：API 17 起必须 `@JavascriptInterface` 注解；17 之前有反射漏洞 |
| URL Scheme + iframe src | 双端（历史通用） | `iframe.src='jsb://getLocation?…'` | 主线程（`shouldOverrideUrlLoading` / `decidePolicyFor`） | 低 | 大（连发合并、部分场景不回调） | 无注入依赖，任何时候能发导航就行 | 弱（古老 API） |
| onJsPrompt 弹窗拦截 | 仅 Android（历史通用） | `prompt('jsb://…')` | 主线程 | 低 | 中（没实现 WebChromeClient 时 prompt 静默吞） | 无注入依赖 | 弱（老 API 就有） |
| `WKScriptMessageHandler` | 仅 iOS（现代主选） | `window.webkit.messageHandlers.MiniJsb.postMessage(msg)` | **主线程** | 较高 | 小 | handler 注册后对后续 postMessage 立即生效；真正卡就绪的是"脚本注入"（WKUserScript 时机） | 属 WebKit 系统 API，无 Android 式内核碎片化 |

下面逐条讲"它是什么、为什么活着/为什么死了"。

#### 1.3.2 Android · addJavascriptInterface：现代主选

```kotlin
// 平台：Android · Kotlin · 用途：注入桥对象（必须在 loadUrl 之前调用）
class NativeApi(private val context: Context) {
    // 注解是 API 17+ 的硬约束：没有它，方法不会出现在 JS 侧的方法表里
    @JavascriptInterface
    fun post(message: String): Unit { /* 收；实现见 03 篇 */ }
}
webView.addJavascriptInterface(NativeApi(this), "MiniJsb")
webView.loadUrl("https://example.com")   // 晚于注册，页面才能拿到 window.MiniJsb
```

四个关键事实：

1. **方法表是怎么来的**：页面拿到的 `window.MiniJsb` 只暴露带 `@JavascriptInterface` 注解的 public 方法，扫描发生在文档加载时——所以加载完再补注册，对当前页不保证生效（以实测为准）。
2. **参数类型**：注入方法签名只支持 Java 原始类型与 String，复杂对象必须 JS 侧 `JSON.stringify` 后传字符串、原生再解析——协议"平均包在 JSON 里"的物理原因之一。
3. **线程**：方法体运行在名为 **JavaBridge 的后台线程**（本系列红线）。它不占主线程是个优点（IO 随便做），但碰 UI 必须 post 回主线程。
4. **历史包袱**：API 17 之前，注入对象经反射暴露 `getClass` 等公共入口，恶意页面可反射到内部类执行命令（老 WebView 漏洞的著名来源）；API 17 起改为注解白名单管制。这也是上表"依赖 WebView 版本：强"的注脚。

#### 1.3.3 URL Scheme + iframe src：历史方案为什么被淘汰

原理：JS 把消息编码成自定义 scheme 的 URL，用一个**隐藏 iframe** 触发"伪导航"（不直接改 `location.href`，避免真把当前页面送走或写进 history），原生在导航裁决里 decode：

```js
// 平台：H5 · 用途：scheme 通道的历史形态（理解代码，不是让你用）
const iframe = document.createElement('iframe');
iframe.style.display = 'none';
document.body.appendChild(iframe);
iframe.src = 'jsb://getLocation?id=1&callbackId=cb1';
document.body.removeChild(iframe); // 用完即弃，下一次调用再造一个
```

淘汰理由：

1. **容量**：URL 长度受内核限制（各家实测值不一，以实测为准），中文参数 `encodeURIComponent` 后体积膨胀约 3 倍；大对象、二进制根本不划算。
2. **丢消息**：快速连发时连续改 src 的导航可能被合并或被下一次顶掉；页面跳转、卸载瞬间也不保证回调；本系列阶段 2 锚点：`shouldOverrideUrlLoading` 对 POST 及部分 iframe/window.open 场景不回调。
3. **协议脆弱**：参数全靠拼 query，编码/解码规则双端各写一份，极易漂移。

它的历史价值要说清楚：在 `evaluateJavascript`（API 19）与 WKScriptMessageHandler 普及之前，scheme 是**唯一双端通用**的 H5→Native 通道。WebViewJavascriptBridge 一类协议因此在它之上补了"单 iframe + 消息队列攒批发送"来缓解丢失——缓解，而非根治。

#### 1.3.4 Android · onJsPrompt：老式通用桥的真相

原理：JS 调 `prompt('jsb://getLocation?id=1')`，进入 `WebChromeClient.onJsPrompt(view, url, message, defaultValue, JsPromptResult)`，原生 decode 后 `result.confirm(ret)` 把返回串带回。

```kotlin
// 平台：Android · Kotlin · 用途：老式桥的通道层骨架（理解用）
webView.webChromeClient = object : WebChromeClient() {
    override fun onJsPrompt(v: WebView, url: String, message: String, dv: String, r: JsPromptResult): Boolean {
        if (!message.startsWith("jsb://")) { r.cancel(); return true } // 前缀区分：业务弹窗放弃 prompt 语义
        r.confirm(dispatchSync(message)) // 返回串直接作为 prompt() 的返回值
        return true
    }
}
```

关键事实：**JS 线程会挂起等 confirm**——这条通道天生"同步形状"。想要"真异步"（定位要 800ms 才回），必须在 onJsPrompt 里立刻 confirm 一个占位串，把结果改道 `evaluateJavascript` 送回去。"同步入口 + 改道异步出口"的双通道结构，就是老式通用桥的内在形状。其余代价：占用了 prompt 语义（业务要约定前缀避让）；容器没实现 WebChromeClient 时 prompt 被静默吞掉，桥失联——排障时先查这一层。今天它活在极老内核与"必须同步拿结果"的遗留协议里。

#### 1.3.5 iOS · WKScriptMessageHandler：现代主选

```js
// 平台：H5（iOS 容器内）· 用途：标准收发
window.webkit.messageHandlers.MiniJsb.postMessage({ id: 1, action: 'getLocation' });
```

```swift
// 平台：iOS · Swift · 用途：注册与接收（回调在主线程——红线）
webView.configuration.userContentController.add(self, name: "MiniJsb")
func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    // message.body: 数字/字符串/数组/字典/NSNull 直达，不必先 JSON.stringify
}
```

要点：**回调在主线程**（红线之一）；body 是结构化数据，NSDictionary 直达，但函数与循环引用传不过去，协议上约定"只传普通对象"最稳；每条 postMessage 一次跨进程消息，"要不要攒批"由协议层决定（03 篇会给答案）。另注意区分两件事：**handler 注册**（一般注册后即可收消息；个别版本对已加载页面的行为有差异，以实测为准）与**往页面送桥 SDK**（受 WKUserScript 注入时机支配，见本节 1.3.6（3））——后者才是就绪竞态的来源。

#### 1.3.6 Native → H5：三种方式

**（1）evaluateJavascript / evaluateJavaScript —— 双端主选。** Android：`webView.evaluateJavascript(js, ValueCallback<String>)`，必须在**主线程**调用、ValueCallback 回调也在**主线程**（红线）；结果字符串是"所执行脚本最后一条语句的值"的 JSON 文本。iOS：`evaluateJavaScript(_:completionHandler:)` 同语义。执行模型是"往页面塞一行脚本"，所以协议把回包封成一行 `window.MiniBridge._onCallback(id, payload)`（见 01.2、03 篇实现）。

**（2）loadUrl("javascript: …") —— 已弃用。** API 19 之前是 Android 唯一手段。弃用原因：① 拿不到脚本执行结果（无回调）；② 与正常导航共用加载管线，时序互相挤兑；③ 脚本当 URL 拼、长度与转义全要自己兜；④ evaluateJavascript 异步不占加载管线还有结果回调，全面替代。今天只在老容器兼容代码里见到。

**（3）WKUserScript —— 仅 iOS，注入时机专用。** 不是"回包"通道，而是"把桥 SDK 送进页面"的通道：每次导航在 DocumentStart / DocumentEnd 时机注入一段 JS 源码（`atDocumentStart` = 文档元素已创建、后续内容与脚本尚未执行，本系列红线）。它让"桥 SDK 从页面第一行业务脚本之前就就位"。Android 没有 WKUserScript 等价物，只能在加载早期 `evaluateJavascript`——时机天然弱一拍，这正是 04 篇就绪竞态的主要来源。

### 1.4 代码验证

```js
// 平台：H5 · 用途：双端通道探测（打印你能用哪条船）——可贴进任意 WebView 页面的 console
function probeChannels() {
  return {
    androidInterface: typeof window.MiniJsb?.post === 'function',                       // 对象注入（Android）
    iosMessage: typeof window.webkit?.messageHandlers?.MiniJsb?.postMessage === 'function', // 消息通道（iOS）
    prompt: typeof window.prompt === 'function',                                        // 弹窗通道（是否被桥占用要另测）
  };
}
console.table(probeChannels());
```

在 Android/iOS 各跑一遍，对照本节 1.3.1 的表逐项打钩；再在真机 console 里执行 `prompt('hello')`，观察是否弹出（弹窗通道未被桥占用）或被吞（被桥/未实现客户端占用）——两条"以实测为准"的疑点即可自行验证。

### 1.5 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| 注入方法没注解 | JS 侧 `is not a function` | API 17+ 无 `@JavascriptInterface` 不暴露 | 方法上加注解；对齐 03 篇实现 |
| 注入方法里直接碰 UI | `CalledFromWrongThreadException` | JavaBridge 是后台线程 | `runOnUiThread` 包裹（红线） |
| scheme 桥偶发丢调用 | 连点按钮偶发"没反应" | 导航合并/部分场景不回调 | 换现代通道，或协议层攒批 |
| prompt 桥全断 | 桥静默失联 | 容器没实现 WebChromeClient / 业务占用 prompt | 归因容器配置与协议前缀 |
| postMessage 传函数 | iOS 侧收不到/报错 | body 只能是 JSON 兼容值 | 协议约束只传普通对象 |
| evaluateJavascript 在子线程调 | 直接 crash | 必须主线程调用（红线） | UI 线程/主线程提交 |
| 仍用 loadUrl("javascript:") 传大对象 | 偶发截断/异常 | 转义与长度不可控 | 迁移 evaluateJavascript |

### 1.6 现代主流选哪条（结论）

| 场景 | 选型 | 理由 |
|---|---|---|
| H5→Native（Android） | `addJavascriptInterface` + `@JavascriptInterface` + JSON 信封 | 吞吐高、不丢消息、后台线程白送异步执行位 |
| H5→Native（iOS） | `WKScriptMessageHandler` | 结构化、低丢失、线程模型明确 |
| Native→H5 | `evaluateJavascript` / `evaluateJavaScript` | 有结果回调、无转义地狱、双端同构 |
| 桥引导/注入 | iOS `WKUserScript` + Android 早期 `evaluateJavascript` + JS 队列兜底 | 就绪竞态的完整方案见 04 篇 |

现成方案一句带过：WebViewJavascriptBridge、lzyzsd/JsBridge、Capacitor、Cordova 在这些通道之上补的都是**工程层**——回调池、超时清理、双端协议版本协商、安全域校验。本阶段按评审决定不精读源码（延伸阅读可对照这四家），03 篇自研一个最小可用版。

### 1.7 自测题

1. 四条 H5→Native 通道里，哪条的原生回调**不在主线程**？在哪个线程？碰 UI 怎么办？
2. `@JavascriptInterface` 是什么 API 级别的硬约束？没有它会发生什么？API 17 之前这条通道出了什么著名问题？
3. 为什么老方案用**隐藏 iframe** 改 src 而不是直接 `location.href`？这条通道被淘汰的三个理由？
4. onJsPrompt 通道里 `r.confirm("xxx")` 什么时候必须立刻调？"改道异步出口"是哪条 API？
5. 动手：把 3.6 的 `probeChannels()` 贴进你们 App 的任一 WebView 页面，报告哪条通道是活的。

<details>
<summary>参考答案（思考后再点开）</summary>

1. `addJavascriptInterface`——运行在名为 **JavaBridge 的后台线程**；碰 UI 必须 `runOnUiThread`/主线程 Handler 转投（红线）。
2. **API 17**（Android 4.2）。没有注解的方法不出现在 JS 方法表里，JS 侧表现为 `is not a function`；API 17 之前注入对象可被反射利用执行命令，是 WebView 的经典漏洞面。
3. 直接改 `location.href` 会把**当前页面**真的导航走（可能重载、进 history）；iframe 伪导航对页面无感。淘汰理由：URL 容量受限、快速连发合并/卸载丢消息、部分场景 `shouldOverrideUrlLoading` 不回调。
4. 任何需要"JS 不挂起"的场景都必须立刻 confirm 占位串——JS 线程阻塞在 prompt 上，confirm 延迟一次，整页 JS 卡一次；结果改走 `evaluateJavascript` 回传。
5. 略。典型结果：Android 容器 `androidInterface=true`、iOS 容器 `iosMessage=true`；两者同时为 false 说明页面根本没进容器或桥没注入（进 04 篇）。

</details>

---

### 1.8 小结

桥 = **通道 + 协议**。今天的新项目：Android 走对象注入、iOS 走 WKScriptMessageHandler、回程一律 evaluateJavascript(\*)，通道只解决"消息怎么过去"；回调怎么对上、超时怎么办、并发怎么不串，是协议层的活——下一节以 `getLocation` 为例，走完一次调用的完整时序。

---

---

## 2 · 一次调用的完整时序：从 getLocation 到 {lat,lng}

### 2.1 问题引入

前端一行 `bridge.getLocation()` 看起来像同步函数调用，真实链路却是：页面 → JS 拼信封 → 跨过进程边界到原生 → 原生起定位（可能 800ms）→ 原生把结果塞回 JS → JS 按回调号找到当初的 resolve → resolve。任何一环掉链子，用户侧就是"点定位转圈，然后报错或没反应"。本节以 `H5 调 getLocation → 原生返回 {lat,lng}` 为例，把标准 JSBridge 的**全时序**走到代码级：就绪、排队、分发、回包、防抖、超时、并发、异常，一个不漏。

![一次 JSBridge 调用的完整时序](/images/webview-and-native/stage4-01-jsbridge-sequence.png)


### 2.2 先破误区

> • 误区：回调 ID（callbackId）怎么生成都行，用时间戳还带业务信息，更"高级"。
> • 事实：callbackId 的唯一职责是让双端对上同一笔调用。用递增 id 而非时间戳：同毫秒并发时时间戳可能撞 key（两次调用同 id，回调互相覆盖）；日志里 `id=17` 比 `1740000000123` 可读、可排序、可核对"丢了第几笔"。递增号单调唯一，是谁生成不重要，谁生成谁负责唯一，Native 只需原样带回。

> • 误区：桥调用是同步的，`const p = bridge.getLocation(); p.lng` 应该直接有值。
> • 事实：通道整体异步（01 篇），API 只能返回 Promise 或收回调函数。把原生调用包装成"同步等结果"的实现（如长时间占住 onJsPrompt）会让整条 JS 线程冻结，页面全部卡死。

### 2.3 原理讲解：七个节点走完全程

#### 2.3.1 节点① · 注册与就绪：谁先注入？

问题原型：原生还没把桥送进页面，JS 的首屏脚本已经在跑了。两种传统姿势：

- **A · JS 轮询 ready**：`setInterval` 探测 `typeof window.MiniJsb?.post === 'function'`。缺点：轮询是时间驱动的赌博——太密浪费，太疏就绪延迟，且把"桥对象在不在"这个一次性事实变成了一张循环表。
- **B · 注入 ready 回调（正确姿势）**：原生在"注入桥"这件事完成的同一时机，主动调用一次 JS：`window.__MiniJsbReady()`。JS 不轮询，回调即真相，顺序天然正确——两条 `evaluateJavascript` 按**提交顺序执行**，"桥对象注入"必然先于"就绪通知"落地，JS 就绪回调里读 `window` 上的桥必然非空。

原生侧（Android 示意，iOS 同构见 03 篇）：

```kotlin
// 平台：Android · Kotlin · 用途：注入桥对象后立刻派发 ready（顺序即正确性）
fun injectBridge(webView: WebView) {
    webView.addJavascriptInterface(MiniJsBridgeClient, "MiniJsb")    // 1. 桥对象先落位
    webView.evaluateJavascript("window.__MiniJsbReady && window.__MiniJsbReady()", null) // 2. 再派发就绪
}
```

JS 侧的正确等待姿势（事件优先、轮询只作兜底、超时兜住"桥永远不会来"）：

```js
// 平台：H5 · 用途：等桥就绪——不赌博，有事件收事件，没事件再轮询
function whenBridgeReady(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (window.MiniJsb) return resolve();                       // 已就位，直接过
    window.addEventListener('MiniJsbReady', () => resolve(), { once: true }); // 事件：原生派发
    const poll = setInterval(() => window.MiniJsb && (clearInterval(poll), resolve()), 50); // 兜底
    setTimeout(() => { clearInterval(poll); reject(new Error('bridge not ready')); }, timeoutMs);
  });
}
```

上一段的 `MiniJsbReady` DOM 事件由原生用 evaluateJavascript 派发（Android `onPageFinished` 后、iOS 在注入脚本末尾派发），这正是 04 篇就绪竞态的三层解法之一，本节先立住"ready 怎么给"。

#### 2.3.2 节点② · JS 拼信封入队：{id, action, params}

```js
// 平台：H5 · 用途：标准请求信封（协议最小集）
{ id: seq, action: 'getLocation', params: { accuracy: 'fine' } }
```

三件事 Accompany 这个信封发生：

1. **生成递增 id**：`const id = ++seq`（模块级计数器从 1 开始）。为什么不用时间戳，见"二、先破误区"第一条。
2. **回调池登记**：`pending.set(id, { resolve, reject, timer })`——把这次调用的"善后方式"先存好，"发出去"是下一行，"回来"是未来的某一刻。**先登记、后发送**，避免极端情况下回包先于登记到达（先登记、后发送，是防"首笔回包早于登记"这类 bug 的关键细节）。
3. **经通道发出**：Android 走 `window.MiniJsb.post(JSON.stringify(信封))`，iOS 走 `window.webkit.messageHandlers.MiniJsb.postMessage(信封)`。**未就绪时不发**——入队缓冲，就绪后按 FIFO 刷出（04 篇）。

#### 2.3.3 节点③ · 原生接收 → 分发 → 异步完成 → eval 回调

Native 侧把信封解码，按 action 查路由表，交给具体 handler；handler 是异步的（定位要起硬件），所以"接收"和"完成"之间没有同步关系：

```kotlin
// 平台：Android · Kotlin · 用途：接收→分发→异步完成（超精简，完整见 demo）
@JavascriptInterface
fun post(message: String) {
    // ★ 此方法运行在名为 JavaBridge 的后台线程（红线）：不能碰 UI，可以直接做 IO
    val msg = JSONObject(message)
    val id = msg.optInt("id")
    when (msg.optString("action")) {
        "getLocation" -> locationClient.getCurrent { ok, lat, lng ->   // ④ 节点：异步 IO
            val payload = JSONObject().put("lat", lat).put("lng", lng)
            mainHandler.post {                                          // evaluateJavascript 必须主线程（红线）
                webView.evaluateJavascript(
                    "window.MiniBridge && window.MiniBridge._onCallback($id, '${payload}')", null
                )
            }
        }
        else -> { /* 兜底分支：未知 action → 回 err，JS 侧 reject（对照下文"异常上抛汇总"） */ }
    }
}
```

注意两处线程红线同时在场：**入口**在 JavaBridge 后台线程（所以方法里别碰 UI），**回程** `evaluateJavascript` 必须在主线程调（所以包了 `mainHandler.post`）。iOS 侧则相反：`WKScriptMessageHandler` 回调本来就在主线程（红线），只关心别做重活。

#### 2.3.4 节点⑤ · 回包合并（merge）与重复回调防抖

回包到达 JS，`_onCallback` 按 id 从回调池取回当初的 resolve：

```js
// 平台：H5 · 用途：Native→JS 唯一入口：按 id 结算
window.MiniBridge._onCallback = function (id, json) {
  const slot = pending.get(String(id));
  if (!slot) return console.warn('[bridge] 迟到回包，已丢弃', id);   // 超时后/重放的第 N 次回包
  if (slot.done)  return console.warn('[bridge] 重复回调，已防抖', id); // 防抖：同一 id 只结算一次
  slot.done = true;                         // merge：先改状态，再触发回调
  clearTimeout(slot.timer); pending.delete(String(id));            // 出池防内存增长
  slot.resolve(JSON.parse(json));                                  // 信封回程常是 JSON 串，约定在此统一 parse
};
```

两层防叠：**结算级**——`slot.done` 保证一个 Promise 只 settle 一次（原生意外重发不会二次 resolve，也不会报"Promise 已 settled"的噪音）；**池级**——先 delete 再 resolve，迟到回包因查无此 slot 被自然吞掉，不需要任何"黑名单"。合起来就是"回调 merge 与重复回调防抖"的完整机制。

#### 2.3.5 节点⑥ · 超时：setTimeout 上抛 "timeout"

每笔调用登记时同时挂定时器：

```js
// 平台：H5 · 用途：给每笔调用挂超时兜底
const timer = setTimeout(() => {
  const slot = pending.get(String(id));
  if (!slot || slot.done) return;                 // 已结算，超时器是残余
  slot.done = true; pending.delete(String(id));   // 出池
  slot.reject(new Error('bridge timeout: ' + action));  // 上抛，由业务 finally 复位 UI
}, 8000);                                          // 8s 示例，按能力定
```

超时与迟到回包的接力：超时先出池 → 原生 9 秒后才回 → `_onCallback` 查无 slot → 仅 warn，**不会二次 reject**（避免 unhandled rejection 噪音）。用户看到的是：8 秒时收到 `timeout` 业务做降级；9 秒时系统层面默默记录一条"迟到回包"，排障时有据可查（03 篇的日志挂点就在这里）。

#### 2.3.6 节点⑦ · 并发多请求不串：靠 id，不靠顺序

同时发三条：`getLocation`（id=1）、`getUserInfo`（id=2）、`getNetType`（id=3）。原生快慢不定，可能 2 先回、1 后回、3 丢了。**回调池按 id 建索引，谁回谁结算，与发送顺序、返回顺序都无关**——这就是"并发不串"的全部技术含义：不要做任何"按顺序对号"的全局记账（如"第 N 个回包对应第 N 次调用"），一旦有丢包或乱序就整体错位。记住：**id 是桥世界里唯一可靠的关联键**。

#### 2.3.7 异常上抛汇总

| 异常来源 | 谁发现 | JS 侧表现 | 处置 |
|---|---|---|---|
| action 路由不到 | 上文 2.3.3 的 else 分支 | 原生回 err | `reject(new Error('no such action: xxx'))` |
| 能力执行失败（拒权限/定位失败） | 原生 handler | 原生回 err(带 code) | reject，业务降级 |
| 超时 | 上文 2.3.5 的定时器 | `bridge timeout` | reject + finally 复位 UI |
| 通道未就绪 | JS 发送前检查 | 入队缓冲或直接抛 | 见 04 篇 |
| 回程解析失败 | `_onCallback` | JSON.parse 抛 | try/catch 后走 reject，防 JS 异常反噬 |

### 2.4 代码验证：断点还原真实调用（浏览器即可跑通）

> 平台：H5（普通浏览器即可，无需真机）。策略：**手动注入 `window.__bridgeDelegator` 模拟原生**——它替原生收信封、延时后替原生调 `_onCallback`，把双端时序压缩成一个可单步跟进的脚本。心智通了再上真机。完整可执行文件在 demo/page.html（示例代码详见 demo 包），下面是该文件的核心段。

```html
<!-- 平台：H5 · 用途：以假原生完成一次 getLocation 的全时序（可整段贴进 console 复跑） -->
<script>
  // —— 第 1 步：模拟"原生"（真机上这段不存在，由容器注入替代） ——
  window.__bridgeDelegator = function (payload, params) {   // 前端侧假原生入口（与真机通道同构）
    const { id, action } = payload;
    if (action === 'getLocation') {
      setTimeout(() => {                                     // 模拟定位 500ms 异步完成
        window.MiniBridge._onCallback(id, JSON.stringify({ lat: 31.2304, lng: 121.4737, ok: true }));
      }, 500);
    } else {
      setTimeout(() => window.MiniBridge._onCallback(id, null), 500); // 未知 action 走 err
    }
  };
</script>
<script src="./miniBridge.js"></script>  <!-- 引入本章 03 篇实现的 JS 侧桥 -->
<script>
  // —— 第 2 步：按真实姿势调用，断点四处：拼信封 → 入队 → __bridgeDelegator → _onCallback ——
  window.MiniBridge.call('getLocation', { accuracy: 'fine' })
    .then((pos) => console.log('定位成功', pos.lat, pos.lng))
    .catch((e)  => console.error('定位失败', e.message));
</script>
```

把 debugger 打在四处：`call` 入口（看信封 `{id:1, action, params}` 是怎么"先登记后发送"的）→ `__bridgeDelegator`（看假原生怎么解析）→ `_onCallback`（看 slot 怎么 done/delete/resolve）→ `then`。再并发 `Promise.all([call('getLocation'), call('getUserInfo')])`，观察两条不同 id 各自 resolve 不串（图 01 里两色的并行箭头即是它）。

### 2.5 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| 就绪竞态 | 首屏偶发调用丢失 | 轮询式 ready 有窗口 | 原生注入 ready 回调 + JS 队列缓冲（04 篇） |
| 回调永久挂起 | Promise 一直没有 settle | 忘挂超时器 / 超时后没出池 | 每笔必挂 timer；timeout 按上述出池 |
| 二次结算报错 | console 出现 unhandled rejection | 重复 reject（迟到回包二次触发） | 先 delete 再 reject，`!slot` 直接 return |
| 并发串包 | A 拿到 B 的结果 | 按"第 N 个回包"对账 | 回包只认 id，不建顺序记账 |
| 回包不来也不超时 | 转圈到底 | JS 侧结算了但没接 `_onCallback`；或原生 eval 的 JS 名对不上 | 双端约定唯一回包入口名（03 篇 `MiniBridge._onCallback`） |
| 原生回包 JS 报错被吞 | 排障没有任何日志 | eval 的脚本无 try/catch | 回包脚本包 try/catch，异常打到 console（03 篇实现） |

### 2.6 自测题

1. callbackId 为什么用"递增 id"而不是时间戳？谁生成重要吗？
2. 为什么信封要"**先登记、后发送**"？颠倒会发生什么极端 bug？
3. 原生 iOS 实现 `userContentController(_:didReceive:)` 里直接起定位、再在回调里 UIKit 刷新水面板，线程上有没有问题？Android 呢？（两个红线各考一次）
4. 超时已 `delete(id)`，原生 9 秒后回包，`_onCallback` 会走哪个分支？为什么这样设计是稳的？
5. 动手：在 demo/page.html（示例代码详见 demo 包） 里并发三次 `call('getLocation')`，观察三次 id 各自结算；再把 `__bridgeDelegator` 延时改成 9s，复现超时上抛与"迟到回包被丢弃"两条日志。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 同毫秒并发时间戳撞 key 会覆盖回调；递增号单调唯一、可读可排序，日志可核对丢失节点。谁生成都行，但**谁生成谁保证唯一，Native 只需原样带回**——双端对账的关联键。
2. `pending.set(id…)` 先做，`post()` 后做：极端时序下原生极快回包时，先登记保证 `_onCallback` 能查到 slot；颠倒则首笔回包可能查无此 slot 被当作"迟到"吞掉，表现为"首调用必丢"。
3. iOS：回调在主线程（红线），起定位/重活应派发到后台队列，UI 刷新留在主线程没问题。Android：`post` 在 **JavaBridge 后台线程**，可以直接跑 IO，但 `evaluateJavascript` 与任何 UI 操作都必须 `runOnUiThread`/主线程 Handler 转投。
4. 走"查无 slot → warn 迟到回包"分支，直接 return。因为超时已承诺 reject Promise 且删除登记，二次结算要么报错要么造成幽灵 resolve；把迟到包降级成一条日志，状态机最稳。
5. 略。观察点：三条不同 id 均独立 resolve；9s 场景先见 `bridge timeout`、再见 `[bridge] 迟到回包，已丢弃`。

</details>

---

### 2.7 小结

一次 getLocation 的全时序可以压成一句话：**先登记后发送的单调 id 信封 → 原生分发异步完成 → evaluateJavascript 原样带回 id → 回调池防抖结算 → 超时兜底迟到回包**。下一章把这套协议用 100 行落成一个可运行的 Promise 版实现（register / queue / callback / timeout / 并发五件套），每一行都注释"为什么"。

---

---

## 3 · 自研 MiniJsb：100 行写透 Promise 版 JSBridge

### 3.1 问题引入

联调群里最常见的死循环：前端说"回调没回来，你们桥有 bug"，客户端说"日志显示发了，你们前端没接住"。双方手里的桥都是黑盒——没人说得清信封长什么样、回调池谁在管、超时挂在哪。本节按评审决定**不精读现成库源码**，反过来自己写一个 100 行级别的 Promise 版 JSBridge（JS / Android / iOS 各一份），把 02 篇的七个节点全部落成代码。写完再去看 WebViewJavascriptBridge、Capacitor、Cordova，只是看到"同一套协议 + 更厚的工程层"（安全域校验、协议版本协商、离线包联动），不再有未知。

### 3.2 先破误区

> • 误区：自研桥要精通客户端开发，前端只能等封装。
> • 事实：桥的难点在协议设计（信封、id、防抖、超时），而非客户端语法。每端核心都是"注册入口 → 收信封 → 查路由 → eval 回包"四步，30~80 行能写完；读者照抄本文即可跑通。

> • 误区：现成库做了什么神秘魔法。
> • 事实：它们与本节同一套骨架，多出来的是工程件——回调池复用、双端协议版本、安全域白名单、批量协议。这些是"加法"，读源码时按图索骥即可。

### 3.3 原理讲解：五个协议件与分工

| 协议件 | 存在于 | 职责 | 关键决策（02 篇依据） |
|---|---|---|---|
| 通道 transport | 双端各一 | 消息过河 | Android 对象注入 / iOS messageHandler；实现差异封在 JS 侧探测层 |
| 信封 envelope | 协议层确立 | 描述一次调用 | `{id, action, params}`；id 单调递增 |
| 回调池 pending | JS 侧 | id→resolve/reject 对账 | 先登记后发送；防抖靠 `slot.done` |
| 就绪队列 readyQueue | JS 侧 | 未 ready 的信封缓冲 | 原生派发 `__MiniJsbReady` 后 FIFO 刷出（04 篇） |
| 反向注册 register | 双端 | Native 主动调 H5（推送 token/生命周期） | HTML 侧覆盖式注册，防重入叠加 |

### 3.4 代码验证

完整可运行文件在 demo/stage-4-jsbridge/（示例代码详见 demo 包），与 stage-2/3 宿主直接对接。以下为全文与逐方法注释，注释行以"为什么"开头。

#### 3.4.1 JS 端 · miniBridge.js（协议层全部在这里）

```js
/** 平台：H5（WebView 内 / 浏览器 demo 亦可）· 用途：Promise 版最小 JSBridge（阶段 4 教学） */
(function (global) {
  'use strict';
  const NAME = 'MiniJsb';          // Android 注入对象名 == iOS messageHandlers 名（容器统一约定）
  let seq = 0;                     // 为什么递增 id：同毫秒并发会撞时间戳（02 篇），单调号唯一可对账
  const pending = new Map();       // 回调池：id → {resolve,reject,timer,done}，桥世界的对账台账
  const readyQueue = [];           // 就绪队列：未 ready 的信封先缓冲（04 篇），FIFO 保序
  const handlers = Object.create(null); // 反向注册表：Native 主动调用 H5 用
  const TIMEOUT = 8000;            // 默认超时，单一可调

  /** 通道探测：把三平台差异全部压进这一层，上层只见"send(信封)" */
  function transport() {
    if (global.MiniJsb && typeof global.MiniJsb.post === 'function')
      return (m) => global.MiniJsb.post(JSON.stringify(m));            // Android：注入对象，参数必须是字符串
    if (global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers[NAME])
      return (m) => global.webkit.messageHandlers[NAME].postMessage(m); // iOS：结构化数据直达，无需 stringify
    if (typeof global.__bridgeDelegator === 'function')
      return (m) => global.__bridgeDelegator(m);                       // 浏览器 demo 的假原生（02 篇）
    return null;                                                       // 没通道 → 送就绪队列排队
  }

  /** 就绪回调：原生注入完成后主动调用（顺序正确性见 02 篇节点①） */
  global.__MiniJsbReady = function () {
    readyQueue.splice(0).forEach(sendEnvelope);     // 为什么 splice 取空：一次刷出、保持 FIFO，且防刷出期间再入队死循环
  };

  /** 发送：有通道直发，没通道入就绪队列（绝不静默丢） */
  function sendEnvelope(envelope) {
    const send = transport();
    if (!send) { readyQueue.push(envelope); return; }
    send(envelope);
  }

  /** 对外门面 1：call(action, params, timeoutMs) → Promise */
  function call(action, params, timeoutMs) {
    timeoutMs = timeoutMs || TIMEOUT;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const slot = { resolve: resolve, reject: reject, done: false };
      slot.timer = setTimeout(function () {          // 为什么先挂超时再发送：慢原生必须有兜底，且超时要能出池
        if (slot.done) return;
        slot.done = true; pending.delete(String(id));
        reject(new Error('bridge timeout: ' + action));   // 上抛 timeout，业务 finally 复位 UI
      }, timeoutMs);
      pending.set(String(id), slot);                 // 为什么先登记后发送：回包极快时也不至于查无此 slot
      sendEnvelope({ id: id, action: action, params: params || {} });
    });
  }

  /** 对外门面 2：Native→JS 唯一回包入口（Android/iOS 的 eval 都调它） */
  function _onCallback(id, jsonPayload, errMsg) {
    const slot = pending.get(String(id));
    if (!slot)   return console.warn('[MiniJsb] 迟到回包，已丢弃 id=' + id);   // 超时后的回包自然吞掉
    if (slot.done) return console.warn('[MiniJsb] 重复回调已防抖 id=' + id);   // 防抖：一个 Promise 只 settle 一次
    slot.done = true;                              // 为什么先置标志再触发：回调里再触发同笔也能被拦
    clearTimeout(slot.timer);
    pending.delete(String(id));                    // 为什么即删：回调池不清理会随页面生命周期无限涨
    try {
      errMsg ? slot.reject(new Error(errMsg))
             : slot.resolve(jsonPayload == null ? null : JSON.parse(jsonPayload));
    } catch (e) { slot.reject(e); }                // 为什么 try/catch：坏回包也不能把它变成 unhandled 无声崩溃之外的噪音
  }

  /** 对外门面 3：register —— Native 主动推送时调用（token/生命周期事件） */
  function register(name, fn) {
    handlers[name] = fn;                           // 为什么覆盖式：SPA 重入时同 handler 重复注册会 cumulate 回调（04 篇）
  }

  /** Native→JS 主动推送的唯一入口 */
  function _invokeHandler(name, jsonPayload) {
    const fn = handlers[name];
    if (!fn) return console.warn('[MiniJsb] no handler: ' + name);
    try { fn(jsonPayload == null ? null : JSON.parse(jsonPayload)); }
    catch (e) { console.error('[MiniJsb] handler error: ' + name, e); } // 为什么隔离 try：一个坏 handler 不能拖垮消息循环
  }

  global.MiniBridge = { call: call, register: register, _onCallback: _onCallback, _invokeHandler: _invokeHandler, version: 'mini-1.0' };
})(window);
```

约 70 行，含四个协议件：transport（通道）、pending（回调池）、readyQueue（就绪队列）、handlers（反向注册）。调用侧：`window.MiniBridge.call('getLocation', {accuracy:'fine'}).then(pos => ...)`。

#### 3.4.2 Android 端 · MiniJsBridgeClient.kt（通道最简：对象注入）

```kotlin
/** 平台：Android（Kotlin）· 用途：MiniJsb 原生侧最简实现 · 粘贴进含 WebView 的 Activity 工程 */
class MiniJsBridgeClient(private val activity: Activity, private val webView: WebView) {
    private val mainHandler = Handler(Looper.getMainLooper())          // 为什么持有主线程 Handler：回包 eval 必须主线程（红线）
    private val handlers = mutableMapOf<String, (JSONObject, (JSONObject?, String?) -> Unit) -> Unit>()

    /** 容器注册能力：action → handler。handler 第二参是回包闭包，支持异步能力跑完再回 */
    fun register(action: String, handler: (JSONObject, (JSONObject?, String?) -> Unit) -> Unit) {
        handlers[action] = handler
    }

    /** 注入：必须在第一次 loadUrl 之前；晚了页面拿不到 window.MiniJsb */
    fun attach() { webView.addJavascriptInterface(Inner(), "MiniJsb") }

    inner class Inner {
        @JavascriptInterface                       // 为什么必须注解：API 17+ 方法表按注解暴露，漏了 JS 侧 is not a function
        fun post(message: String) {
            // ★ 运行在名为 JavaBridge 的后台线程（红线）：不碰 UI、可直接跑 IO
            val msg = try { JSONObject(message) } catch (e: JSONException) { return }
            val id = msg.optInt("id", -1); val action = msg.optString("action")
            val handler = handlers[action] ?: run {
                reply(id, null, "no such action: $action"); return   // 为什么未知 action 也要回：不回 JS 侧只能等超时
            }
            val params = msg.optJSONObject("params") ?: JSONObject()
            try { handler(params) { r, err -> reply(id, r, err) } }     // 分发交由注册方；多数能力是异步完成后才回包
            catch (e: Exception) { reply(id, null, e.message ?: "handler failed") }
        }
    }

    /** 回包：拼一行 JS，调用 window.MiniBridge._onCallback(id, json, err) */
    private fun reply(id: Int, result: JSONObject?, error: String?) {
        mainHandler.post {                                              // 为什么 post 主线程：evaluateJavascript 红线
            val js = try {
                if (error != null) "null,'$error'"
                else "'${result ?: "null"}',null"                       // JSON 串形式回传，与 iOS/JS 协议一致
            } catch (e: Exception) { "null,'serialize failed'" }
            webView.evaluateJavascript(
                "try{window.MiniBridge&&window.MiniBridge._onCallback($id,$js)}catch(e){console.error(e)}", null
            )   // 为什么包 try/catch：JS 侧异常不得反噬原生线程
        }
    }
    // 用法：register("getLocation") { _, reply -> 定位成功后 reply(JSONObject {"lat":..,"lng":..}, null) }
}
```

#### 3.4.3 iOS 端 · MiniJsBridge.swift（extension WKScriptMessageHandler）

```swift
/** 平台：iOS（Swift5, WKWebView）· 用途：MiniJsb 原生侧最简实现 · 粘贴进含 WKWebView 的工程 */
typealias JSONObject = [String: Any]
final class MiniJsBridge: NSObject, WKScriptMessageHandler {
    static let scriptName = "MiniJsb"                        // 与 miniBridge.js 探测名一致（容器约定）
    private var handlers: [String: (MiniJsRequest, @escaping (JSONObject?, String?) -> Void) -> Void] = [:]
    private weak var webView: WKWebView?                     // 为什么 weak：userContentController 已强持有本对象

    struct MiniJsRequest { let id: Int; let action: String; let params: JSONObject }
    func register(_ action: String, _ h: @escaping (MiniJsRequest, @escaping (JSONObject?, String?) -> Void) -> Void) { handlers[action] = h }

    /** 注入：load 之前调用；注意 add 是强引用，销毁时必须 remove（防 WebView 泄漏） */
    func attach(to webView: WKWebView) {
        self.webView = webView
        webView.configuration.userContentController.add(self, name: Self.scriptName)
    }
    deinit { webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.scriptName) }

    /** ★ 回调在主线程（红线）：不要在这里做重活，异步能力在 handler 内派发后台队列 */
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any],
              let id = dict["id"] as? Int, let action = dict["action"] as? String else { return }
        let req = MiniJsRequest(id: id, action: action, params: dict["params"] as? JSONObject ?? [:])
        guard let h = handlers[action] else { reply(id: id, result: nil, error: "no such action: \(action)"); return }
        h(req) { [weak self] result, error in self?.reply(id: id, result: result, error: error) }
    }

    /** 回包：统一序列化为 JSON 字符串、单引号安全转义后 eval（与 Android/JS 协议一致） */
    private func reply(id: Int, result: JSONObject?, error: String?) {
        guard let webView = webView else { return }
        var arg = "null, null"
        if let e = error { arg = "null, \"\(e)\"" }
        if let r = result, let data = try? JSONSerialization.data(withJSONObject: r, options: []),
           let s = String(data: data, encoding: .utf8) { arg = "\"\(s.replacingOccurrences(of: "'", with: "\\'"))\", null" }
        let js = "try{window.MiniBridge&&window.MiniBridge._onCallback(\(id),\(arg))}catch(e){console.error(e)}"
        DispatchQueue.main.async { webView.evaluateJavaScript(js, completionHandler: nil) }  // 显式主线程习惯
    }
}
```

> 逐行对照：Android 的 `post`/iOS 的 `didReceive` 就是 02 篇节点③；`reply` 就是节点⑤；两端的"未知 action 也要回包"是防 JS 侧挂死等超时的最小善意。

### 3.5 坑点清单

| 坑 | 现象 | 根因 | 解法（对应本文位置） |
|---|---|---|---|
| 漏 `@JavascriptInterface` | `window.MiniJsb.post is not a function` | 注解暴露制 | 补注解（本节 3.4.2 的 Inner 实现） |
| 回包主线程违规 | eval 必须在主线程调用 crash | 在 JavaBridge 线程直接 eval | `mainHandler.post` 包裹（4.2 reply） |
| handler 双倍触发 | 一个推送回调打两次 | SPA 重入重复 `register` | 覆盖式注册（本节 3.4.1 的 register 覆盖写法，另见 04 篇） |
| 回包池无限增长 | 长页面越来越卡 | 结算后不 delete | `_onCallback` 即删（4.1） |
| iOS WebView 泄漏 | 退出页面 WebView 不释放 | userContentController 强持有 handler | `deinit` 里 remove（4.3） |
| 未知 action 挂死 | JS 等到超时才有反应 | 原生没回 err | 路由 miss 也 reply（4.2/4.3） |

### 3.6 自省题（阶段 4 末尾自测，先自答再展开）

1. 把 `@JavascriptInterface` 注解删掉，`attach()` 还会成功吗？JS 侧第一现场报什么错？
2. `_onCallback` 里为什么是 `pending.delete(id)` **之后**才 resolve？如果先 resolve 再 delete，会有什么后果？
3. Android `reply` 里若去掉 `mainHandler.post` 直接调 `evaluateJavascript`，会怎样？对应哪条红线？
4. 为什么未知 action 必须回包（哪怕只回 error）？不回的话用户侧表现为哪种现象、日志侧哪一支？
5. `MiniJsBridge` 为何声明 `weak var webView`，且 `deinit` 必须 `removeScriptMessageHandler`？两个动作各防什么泄漏？
6. 动手自省：把 demo 在浏览器跑通后，将 `timeoutMs` 改成 200ms 再调 getLocation，你应该看到哪两条日志？说明哪个机制在兜底？

<details>
<summary>参考答案（先自答再点开）</summary>

1. attach 本身不报错（注入成功）；但 JS 侧探测 `window.MiniJsb.post` 得 `undefined`，miniBridge 落到"无通道→就绪队列"一直排到超时。第一现象是**静默排队**，不是抛错——排障时先探测通道。
2. 先 delete 再 resolve：若先 resolve，业务回调里同步再调一次桥（或出现异常）会重入回调池操作；先删保证结算结果与池状态原子一致，且重复回包天然走"无 slot"分支。
3. 抛线程异常（WebView 方法只能在创建它的线程调用），轻则异常、重则崩溃；对应红线"evaluateJavascript 必须在主线程调用、回调也在主线程"。
4. 不回包，JS 侧只能等超时上抛，用户侧表现为"转圈 8 秒才报错"；路由 miss 回 err 后，reject 立刻把错误带到业务层，日志里是 `no such action` 而非一条 timeout，归因快得多。
5. `weak webView` 防"webview 持 handler、handler 持 webview"的环；`removeScriptMessageHandler` 解除 userContentController 对 handler 的强持有，否则 handler 所在页面退出也不释放，WebView 整个泄漏。
6. 两条日志：`bridge timeout: getLocation`（`_onCallback` 的 reject 上抛）与 `[MiniJsb] 迟到回包，已丢弃 id=N`（原生真回包落空）。说明超时兜底 + 迟到防抖在工作。

</details>

---

### 3.7 小结

MiniJsb 把 02 篇的七个节点压成三个门面（`call` / `register` / `_onCallback`）加一张路由表。看懂这 100 行，再去读任何容器桥或开源实现，都是在找"它把哪个协议件做厚了"——回调池复用、协议版本、安全白名单。下一节解决这套桥在真实工程里的第一杀手：**就绪竞态与 SPA 路由**下"bridge 在不在"的问题。

---

---

## 4 · 就绪竞态与 SPA 路由："页面一到，桥在不在"

### 4.1 问题引入

灰度报障：H5 首页"分享到微信"按钮偶发点了没反应，刷新一次就好；埋点里这条路径的 `call('share')` **一次都没出现**——说明 JS 压根没把信封发出去。十有八九是全系列最经典的翻车点：**页面脚本跑起来的时候，桥还没就位**。本节把它讲成"两台钟的赛跑"，并给出三层解法与一套规范动作表。

![就绪与重入处理流程](/images/webview-and-native/stage4-02-ready-reentry.png)


### 4.2 先破误区

> • 误区：`window.onload` 触发等于"桥可用了"。
> • 事实：这是两台独立的钟——"桥什么时候被注入"由容器驱动，"页面脚本什么时候执行"由内核驱动。iOS 用 `WKUserScript(atDocumentStart)` 注入能保证桥先于页面脚本就位；Android 没有等价机制（`onPageStarted`/`onPageFinished` 里的 evaluateJavascript 都是异步跨线投递），首帧脚本完全可能跑在桥前面。

> • 误区：SPA 每次路由切换都要"重新拿一次桥"。
> • 事实：pushState / hash 路由不换文档，注入的桥对象、回调池、消息循环都活着（渲染进程没死）。要防的不是"桥没了"，而是重复注册导致回调叠加。

### 4.3 原理讲解

#### 4.3.1 竞态从哪来：注入方式的"生效时刻"表

| 注入方式 | 生效时刻 | 能否保证先于页面脚本 |
|---|---|---|
| Android `addJavascriptInterface`（loadUrl 前） | 文档加载时对象方法表随页生效 | 基本能（这是 01 篇把它选为主选的原因之一） |
| Android `evaluateJavascript` 注入桥 SDK（onPageStarted/Finished 里） | 回调异步投递，晚于提交时刻 | **不能**——首帧脚本可能先跑 |
| iOS `WKUserScript(atDocumentStart)` | 文档元素已建、脚本未执行（红线锚点） | **能**（iOS 桥"一直都在"的根基） |
| iOS `WKUserScript(atDocumentEnd)` | 等价 DOMContentLoaded 附近 | 不能——晚于大部分业务脚本 |

结论：通道对象（`window.MiniJsb` / messageHandlers）与**协议层 SDK**（`MiniBridge.call` 等）是两个东西，谁先到取决于容器用哪种注入方式。前端唯一正确的姿势是：**不要赌，代码里把两种情况都接住**。

#### 4.3.2 三层解法（对应图 02）

1. **发起端先 `_ready` 判断**：调用前探测 `transport() !== null`（miniBridge 里通道探测函数即判据），未就绪的调用**不丢弃、不入 Promise 黑洞**。
2. **队列缓冲 pendingActions**：未就绪信封进 FIFO 队列（03 篇 `readyQueue`），保序不丢——先点的先发。注意"队列缓冲"解决的是**不丢**，不解决"什么时候发"，发出去靠第 3 层。
3. **原生侧统一派发 ready**：注入动作完成的同一时机，原生主动调用 `window.__MiniJsbReady()`（iOS 直接把这句拼在 WKUserScript 脚本尾部；Android 放在 `onPageFinished` 里 evaluateJavascript）。就绪回调把队列**一次取空、FIFO 刷出**，幂等可重复调用。

```kotlin
// 平台：Android · Kotlin · 用途：容器侧派发 ready 的标准时机
webView.webViewClient = object : WebViewClient() {
    override fun onPageFinished(view: WebView, url: String) {
        view.evaluateJavascript("window.__MiniJsbReady && window.__MiniJsbReady()", null)
    }
}
```

> 为什么选 `onPageFinished` 而不是"更早"：早了 `__MiniJsbReady` 本身可能没送达（首帧脚本未跑、`window` 上还没有监听者）；这时 02 篇的"先登记后发送 + 队列缓冲"已经把调用兜住，不损失什么。** 宁晚派发不丢队列**

#### 4.3.3 SPA 路由切换后，桥还在吗？

分三种情况回答，对应图右侧分支：

- **pushState / hash 路由（React/Vue Router 默认）**：文档没换 → 桥对象、回调池、消息循环全部健在，**照常可用**。
- **路由守卫/组件重挂载里重复 `register`**：同一 handler 注册两次——若实现是数组 push 就是**回调 cumulate**（推送一次、回调翻倍）；miniBridge 用**覆盖式注册**（同名后写覆盖先写），组件卸载时 `register(name, null)` 或换成noop 主动清理。
- **整页跳转 / 容器另开 WebView**：新文档重新走一遍 3.1–3.2 的就绪竞态，ready 会再次派发，**不需要前端做任何事**；但上一页的回调池与新页无关（Promise 随文档销毁），想"跨页带结果"必须走 storage 或让原生中转，那是另一个话题。

#### 4.3.4 规范动作表

| # | 时机 | 动作 | 负责 |
|---|---|---|---|
| 1 | 发送前 | 前端一律走 `MiniBridge.call`（内置 ready 判断+队列缓冲），**禁止裸调** `window.MiniJsb.post` | 前端 |
| 2 | 注入完成 | 容器在注入 SDK 同一时刻派发 `__MiniJsbReady`（幂等） | 容器 |
| 3 | 页面首帧 | 所有路由级初始化的桥调用挂 `whenBridgeReady().then(...)`，不在模块顶层立即调 | 前端 |
| 4 | 组件卸载 | `register` 过的 handler 反注册（覆盖 null），防 cumulate | 前端 |

### 4.4 代码验证

```js
// 平台：H5 · 用途：SPA 组件里的规范用法（覆盖式 register + 卸载清理）
function useOnShow(fn) {                       // 伪 React hook 示意
  window.MiniBridge.register('onPageShow', fn);
  return () => window.MiniBridge.register('onPageShow', null);  // 卸载时反注册，防 cumulate
}
// 模块顶层（危险示范）：document 一加载就 call——遇到"慢桥"容器直接进队列也 OK（不丢），
// 但如果桥永不就绪会一致等到业务超时——所以首屏关键路径显式走 whenBridgeReady()。
```

在浏览器 demo（demo/page.html（示例代码详见 demo 包））验证：**先连点"ready 前连发 ×3"**，日志显示 3 笔已入就绪队列；再点"注入桥 + 派发 ready"，3 笔按 FIFO 顺序刷出并各自结算——队列缓冲与 ready 刷出一次看清。

### 4.5 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| 首屏偶发无反应 | 刷新就好 | 页面脚本早于桥注入 | ready 回调 + 队列缓冲（本节 4.3.2） |
| 刷新前丢调用 | 退出页面时点击无效 | 桥就绪前用户已交互且未缓冲 | 一律走 `MiniBridge.call`，禁裸调通道 |
| 推送回调重复 | 一次推送触发两次 handler | SPA 重挂载重复 register | 覆盖式注册 + 卸载反注册 |
| 只有 iOS 正常 | Android 首屏丢 | 容器只在 iOS 用了 WKUserScript | Android 补 onPageFinished 派发 ready |
| ready 前缓存爆掉 | 队列越积越多 | 桥永不就绪（低版本壳没注入） | 就绪队列设上限 + reject 兜底（见 05 篇能力协商） |

### 4.6 自测题

1. `window.onload` 与"桥可用"为什么是两台钟？哪一种注入方式能保证桥先于页面脚本？
2. 未就绪队列缓冲解决"不丢"，但"什么时候发"由谁决定？
3. SPA pushState 路由后需要"重新注入桥"吗？真正要防的是什么？
4. 动手：在 demo/page.html 复现"ready 前连发 3 笔 → 注入桥 → FIFO 刷出"的完整过程，把日志贴进你的笔记。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 桥注入由容器驱动、脚本执行由内核驱动，二者无同步关系；只有 iOS 的 `WKUserScript(atDocumentStart)`（文档元素已建、脚本未执行的时机）能保证先于页面脚本。Android 的对象注入也基本能，但 evaluateJavascript 注入 SDK 不能。
2. 由**原生侧统一派发的 ready** 决定：注入完成即派发 `__MiniJsbReady`，就绪回调把队列一次取空、FIFO 刷出。
3. 不需要——文档没换，桥与消息循环健在；要防的是组件重挂载导致**重复注册 cumulate 回调**（覆盖式注册 + 卸载反注册）。
4. 略。观察点：3 笔 id 连续（FIFO 保序）、注入后日志里以相同顺序出现"收到 → id=1/2/3"。

</details>

---

### 4.7 小结

"页面一到，桥在不在"的答案不该靠运气：**前端永远走 `MiniBridge.call`（自带 ready 判断与队列缓冲），容器在注入完成时派发 ready**，SPA 记住"桥常在、注册要防重"。这套约定的另一面是"桥在但没这个能力"——旧壳遇上新前端怎么办，下一节讲能力协商与版本兼容。

---

---

## 5 · 能力协商与版本兼容：新前端配旧壳不炸

### 5.1 问题引入

发版日报：新前端用了新 action `getSystemInfo`，测试机装在旧壳 5.2.0 上"点了没反应"。查日志：原生回 `no such action: getSystemInfo`，reject 被 `.catch` 吞了，UI 层毫无感知。反向也会发生：新壳上线加了一堆能力，旧前端一个都不知道，白白浪费了壳的能力升级。这是 H5 与壳**发版节奏不同步**的必然结果——本章给一套让"新前端配旧壳 / 新壳配旧前端"都健壮的协商机制。

### 5.2 先破误区

> • 误区：用容器版本号做比较——`if (containerVersion >= '6.3.0')` 就安全了。
> • 事实：双端版本节奏不同（Android 6.3.1 时 iOS 才 6.2.0），字符串比较还要处理 `6.10.0 < 6.9.0` 这类字典序陷阱；更糟的是版本号说"壳多新"，不说"这台壳到底开了哪些 API"（同一版本可有不同灰度开关）。版本号只适合排障与灰度定位，判断该不该调，用能力探测。

> • 误区：别名：探测=`if (bridge) `。
> • 事实：`window.bridge` 存在只说明桥在，不说明某个 action 已注册。探测粒度必须到 action 级：`typeof MiniBridge.getLocation === 'function'`，或容器直接下发能力清单。

### 5.3 原理讲解

#### 5.3.1 能力探测 vs 版本号（选型表）

| 维度 | 能力探测（首选） | 版本号比较（辅助） |
|---|---|---|
| 判断依据 | `typeof` 检查 / 容器下发的能力清单 | `containerVersion` 字符串比较 |
| 粒度 | 精确到单个 action | 只到"这一版壳" |
| 双端一致性 | 天然一致（都在 JS 层探测） | 双端语义需各写一遍，易漂移 |
| 风险 | 无（探测不到就走降级） | 字典序陷阱、灰度开关不可见 |
| 工程用法 | **运行时判决** | **排障/埋点/灰度定位** |

#### 5.3.2 容器该暴露什么：containerVersion + 能力清单

容器在注入桥时顺带注入一段静态描述（UA 里也追加一份，抓包排障时看得见）：

```js
// 平台：H5 视角 · 容器注入的静态描述（示意）
window.__CONTAINER__ = {
  platform: 'android',            // 'android' | 'ios'
  version: '6.3.1',               // containerVersion：排障与灰度用，不做逻辑判断
  apis: ['getLocation', 'share', 'pay', 'getSystemInfo'],  // 本壳注册过的 action 全集
};
```

有了 `apis`，"探测"不用再猜：运行时优先查清单，清单不在（老壳）再退化到 `typeof` 探测。

#### 5.3.3 feature 白名单下发：把"哪些能用"从猜题变读题

更进一步的容器做法：**能力开关由服务端下发**（壳启动时拉配置），同一个壳不同用户拿到的 `apis` 可以不同（灰度、合规、AB）。对前端的含义：**任何 action 调用前查一遍能力表，查不到就走降级**——降级是常态路径，不是异常路径。"新壳配旧前端"也不浪费：旧前端不认识新 action 就不调，坏了白坏不炸。

#### 5.3.4 双端一致性的工作流建议

前端同学维护一张**能力矩阵表**（模板如下，加进你的 README），新能力上线先补表再写代码；客户端新 action 合入时由容器同学在表里打钩——表就是双端契约：

| action | Android 壳 | iOS 壳 | 微信/外部浏览器 | 降级方案 |
|---|---|---|---|---|
| getLocation | ≥6.0 ✔ | ≥6.0 ✔ | ❌ | IP 定位接口 |
| share | ≥5.2 ✔ | ≥5.2 ✔ | ❌ | 引导右上角菜单 |
| pay | ≥6.1 ✔ | ≥6.2 ✔ | ❌ | 收银台页 |
| getSystemInfo | ≥6.3 ✔ | ❌ 计划中 | ❌ | UA + vp 解析 |

### 5.4 代码验证

```js
// 平台：H5 · 用途：能力探测工具函数（与 03 篇 miniBridge 搭配）
const Capability = {
  /** 探测：容器能力清单优先；老壳无清单时只确认"桥在" */
  has(action) {
    const c = window.__CONTAINER__;
    if (c && Array.isArray(c.apis)) return c.apis.indexOf(action) !== -1;
    return !!window.MiniBridge;   // 老壳无法静态探测到 action 级 → 交给运行时 err 兜底（见 call）
  },
  /** 标准姿势：能力不在或运行时报 unknown，一律走 fallback，永不"静默无响应" */
  call(action, params, fallback) {
    if (!this.has(action)) return fallback ? fallback() : Promise.reject(new Error('unsupported: ' + action));
    return window.MiniBridge.call(action, params).catch((e) => {
      if (/no such action/.test(String(e.message)) && fallback) return fallback(); // 老壳运行时兜底
      throw e;
    });
  },
};

// 用法：壳能定位就桥定位，否则退 H5 IP 定位，永不白屏
Capability.call('getLocation', { accuracy: 'fine' }, () => fetch('/ip-loc').then((r) => r.json()))
  .then(showPos)
  .catch((e) => toast('定位不可用：' + e.message));
```

配合 03 篇 bridge 的 `未知 action 回 err`，双层保险：探测漏了、运行时还有 reject 兜着，但**reject 必须有人接**（本文开头事故的真凶）。

### 5.5 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| 字符串比版本 | `6.10.0` 被判"小于" `6.9.0` | 字典序比较 | 版本比较走数值化 split；或干脆改能力探测 |
| `.catch` 被吞 | 点了没反应、无报错 | reject 无人接 | 规范：业务层 catch 必须出 UI 反馈 |
| 只探测 bridge 存在 | 首个新 action 挂了 | 粒度不够 | 探测到 action 级 / 读 apis 清单 |
| 能力不一致 | 同版本 Android 能 iOS 不能 | 双端节奏不同 | 能力矩阵表当契约，随发版更新 |
| 滥用 UA 判能力 | 壳换 UA 后全判错 | UA 是展示层信息 | UA 只排障，不参与逻辑判断 |

### 5.6 自测题

1. 为什么"判断该不该调用一个 action"用能力探测而不是版本号？版本号留着干什么？
2. `window.__CONTAINER__.apis` 和 `typeof MiniBridge.action` 两种探测，各自的适用场景？
3. "新壳配旧前端"浪费了什么？"旧壳配新前端"炸在哪一层？分别如何避免？
4. 动手：为你们容器整理一张类似 04 篇 3.4 的能力矩阵表（至少 3 个 action），并给其中 2 个写 fallback。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 能力探测（action 级清单或 typeof）直接反映"这台壳现在能不能干这件事"，且天然双端一致；版本号存在字典序陷阱且看不见灰度开关，只用于排障、埋点、灰度定位。
2. `apis` 清单：新壳注入，权威可静态判定；`window.MiniBridge` 存在性探测：老壳无清单时用，但只看"桥在不在"——action 级是否可用要靠**运行时 `no such action` 的 err 回包**兜底（02/03 篇原生对未知 action 回 err，不挂着）。
3. 新壳配旧前端：新能力没人用（浪费，但无害）；旧壳配新前端：新 action 原生回 `no such action`，若 reject 无人接则表现为"静默无响应"。避免方式：前者功能门控/灰度推送更新，后者探测+降级+保证每个 reject 被接。
4. 略。检查点：每行都有"降级方案"列，且降级方案是可运行代码而非注释。

</details>

---

### 5.7 小结

能力协商一句话：**运行时要能力探测（action 级），版本号只做排障；容器暴露 `containerVersion`+apis、服务端下发白名单；每个 reject 必须被接住**。至此阶段 4 完整闭环：通道（01）→ 时序（02）→ 自研实现（03）→ 就绪与重入（04）→ 能力协商（05）。下一阶段进入前端最常踩坑的 Cookie / 存储 / 缓存。

---

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| JSBridge | H5 与原生之间用来互相调用的那条"桥"，本质是通道 + 协议两层 |
| addJavascriptInterface | Android 专属通道，把原生对象注入成 `window` 上的成员，JS 直调其方法 |
| @JavascriptInterface | 原生方法上的注解，标了它 JS 才能调用，API 17 起是硬要求 |
| JavaBridge 线程 | 注入对象方法实际运行的后台线程，不是主线程，碰 UI 要转投 |
| evaluateJavascript | 原生往页面塞一行 JS 的通道，回程和回执都在主线程 |
| WKScriptMessageHandler | iOS 专属通道，页面通过它 postMessage 把消息投给原生 |
| messageHandler | iOS 上页面可见的 `messageHandlers` 名字空间，按注册名取通道 |
| URL Scheme 拦截 | 老通道，JS 把消息拼成自定义 scheme 的链接走 iframe 触发导航让原生拦截 |
| onJsPrompt 通道 | 老通道，JS 调 prompt() 让原生在 onJsPrompt 里收消息，同步形状 |
| 注入时机 | 桥 SDK/对象什么时候进页面，决定页面首帧能不能立刻用桥 |
| 信封 | JS 拼给原生的一次调用描述 `{id, action, params}`，双方按它对上号 |
| callbackId | 一笔调用的唯一编号，让 JS 和原生能对着同一次调用结算 |
| 回调池 | JS 侧按 id 暂存 resolve/reject 的表，回包到了就取出来结算 |
| 先登记后发送 | 先把回调登记进池再发消息，避免回包极快时查无此号 |
| _onCallback | 原生回包必须调的唯一 JS 入口，按 id 从池里取 resolve |
| 防抖 | 同一笔回包只结算一次，重复回包直接跳过 |
| 超时兜底 | 每笔调用挂定时器，超时不回就 reject，避免无限转圈 |
| 迟到回包 | 超时出池后才回来的回包，查无 slot 只记一条日志不再结算 |
| 就绪派发 | 原生注入完成后主动调 ready 通知，JS 不用轮询 |
| FIFO | 队列先入先出，未就绪的调用按点击顺序刷出 |
| 协议件 | 桥拆开后的最小组成部分，如通道、信封、回调池、就绪队列 |
| transport | JS 侧把三平台差异压掉的那层，统一对外提供 send(信封) |
| 回调池 pending | 按 id 存这次调用 resolve/reject 的表，回包来结算 |
| readyQueue | 桥没就绪时先把信封排队缓冲的队列，就绪后 FIFO 刷出 |
| register | 反向注册，让原生能主动来找 H5（推送/生命周期回调） |
| 覆盖式注册 | 同名 handler 后写覆盖先写，防止 SPA 重入时回调叠加 |
| 回包 | 原生把结果塞回 JS 的一次动作，统一走 _onCallback |
| 单引号转义 | 拼 JS 回包字符串时对单引号做转义，防止注入/语法错 |
| 红线 | 本系列反复强调、踩了必出事的线程/时序约定 |
| 就绪竞态 | 页面脚本跑起来时桥还没就位导致的偶发丢调用 |
| 生效时刻 | 某注入方式真正"能用"的时刻，与页面脚本执行无同步关系 |
| ready 队列 | 未就绪的调用先排队缓冲，就绪后再刷出，保证不丢 |
| __MiniJsbReady | 原生注入完成后主动调的 JS 函数，通知 JS 桥已就位 |
| 队列缓冲 | 把未就绪的信封暂时排队，解决"不丢"而不是"何时发" |
| FIFO 刷出 | 就绪后按入队顺序把缓冲的信封一一发出 |
| 幂等 | ready 重复调用也不会造成重复，安全可重复执行 |
| pushState/hash 路由 | 不换文档的路由切换，桥与回调池仍然健在 |
| cumulate | 重复注册同一 handler 导致回调叠加翻倍 |
| 反注册 | 组件卸载时把 handler 清掉，避免路径切换后残留 |
| whenBridgeReady | 首屏关键路径显式等桥就绪的封装 Promise |
| 能力协商 | H5 与壳约定"哪些能力能用"，判断不清就降级 |
| 能力探测 | 运行时判断某个 action 在不在，而不是用版本号猜 |
| containerVersion | 壳的版本号，只用于排障/埋点，不做逻辑判断 |
| 能力清单 apis | 容器注入的 action 全集，前端查它决定该不该调 |
| 白名单 | 服务端下发的"哪些能力可用"列表，灰度/合规可动态变 |
| no such action | 原生对未知 action 回的错误串，前端据此走降级 |
| 降级 | 能力不可用时退到备用方案（如 IP 定位），不是异常路径 |
| 能力矩阵表 | 双端共享的能力支持清单文档，当契约维护 |
| 字典序陷阱 | `6.10.0 < 6.9.0` 这类按字符串比较版本会判错的坑 |
| fallback | 探测失败或运行时 err 时执行的备用函数 |
