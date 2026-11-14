---
title: Android WebView 深入
date: 2026-11-14
excerpt: "Android WebView 的配置、导航拦截、JS 互调、弹窗权限和销毁，加上国产内核 X5 / U4 的公开脉络。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 3
lang: zh
draft: false
ogImage: /images/webview-and-native/stage2-01-android-architecture.png
---

> 📖 本章由 5 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · WebView 配置全景：本体、设置、回调代理
- 2 · 导航控制与 URL 拦截：shouldOverrideUrlLoading 深讲
- 3 · JS 与 Native 互调：两座桥的原材料
- 4 · 弹窗 · 文件选择 · 权限 · WebView 销毁
- 5 · 国产内核：X5（TBS→XWeb）与 U4
- 本章术语表

---
## 1 · WebView 配置全景：本体、设置、回调代理

### 1.1 问题引入

线上事故：同一个 H5 页面，在你们 App 里 `alert()` 不弹、`localStorage` 第二天就丢、图片炸掉、字体忽大忽小、视频要点两下才播。前端排查了一圈没毛病——因为**这些行为不是你页面的代码决定的，是 Android WebView 的"配置"决定的**。你在浏览器里看到的一切"默认行为"，进了 WebView 之后全部变成**可开关的开关**，宿主 App（容器）不拨开，页面就拿不到。

本节给你一个心智模型：**WebView 本体（组件）+ WebSettings（配置）+ 两个回调代理（行为裁决）**，并把 `WebSettings` 里每一项，翻译成"前端视角为什么关心"。

---

### 1.2 先破误区

> • 误区："WebView 就是手机里内置的浏览器内核，行为跟 Chrome 一样，开箱即用。"
> • 事实：WebView 是一个组件，默认配置极保守——JS 可能没开、存储可能没开、JavascriptInterface 没注入时前端调了直接报 `ReferenceError`。绝大多数"怎么在浏览器里好好的，进 App 就坏了"都源于容器没配置。

> • 误区："配置是客户端的事，前端不用懂。"
> • 事实：前端看到的每一个异常，最终都要归因到"这是容器没开某个开关，还是我代码问题"。学会读客户端配置，线上问题能立刻分清责任边界。

---

### 1.3 三大件心智模型

![Android WebView 架构分层](/images/webview-and-native/stage2-01-android-architecture.png)


一个 Android WebView 在 App 进程里，由三样东西组成：

| 部件 | 是什么 | 管什么 | 前端视角 |
|---|---|---|---|
| **WebView 本体** | `android.webkit.WebView` View 组件 | 生命周期、加载行为、缩放、返回 | 组件的"骨架"，绑定在 Activity 的布局里 |
| **WebSettings（settings）** | `webView.settings` 拿到的一组开关 | 能力开关：JS、存储、缓存、MixedContent、UA、字体 | 决定"页面进了壳之后能干什么"——**最常被前端忽略** |
| **WebViewClient / WebChromeClient** | 两个回调代理（接口） | 导航裁决、页面事件、JS 弹窗、文件、权限、全屏 | 决定"页面导航/弹窗/权限走没走，走了多久" |

一句话：**WebView 本体是"引擎"，WebSettings 是"钥匙"，两个 Client 是"裁判"**。本章 02 篇讲两个裁判里的 WebViewClient（导航），本节只把 WebSettings 的钥匙捋清楚。

---

### 1.4 WebSettings 关键项逐类过（前端视角）

> 全国产搞清楚了：这些开关是**容器层打开**的。你拿不到 `WebSettings`，但你**必须知道每个开关缺了会发生什么**，才能向客户端同学准确提需求 / 归因。

```kotlin
// 注意：WebSettings 必须在 loadUrl 之前就配好，加载后再改有的不生效
val s = webView.settings
```

#### 1.4.1 JavaScript / DOM storage / 网络存储

| 项 | 默认 | 不开会怎样 | 前端视角 |
|---|---|---|---|
| `javaScriptEnabled` | **false** | `window.xxx` 全没、页面基本不动 | 所有基于 JS 的页面全废。**第一签名项**，看线上"H5 空白但不报错"先查它 |
| `domStorageEnabled` | false | `localStorage/sessionStorage` 抛异常/空 | localStorage 读取为 null，登录态/主题/埋点全断 |
| `databaseEnabled` | false | WebSQL 不可用（已废弃，忽略） | 基本不用管 |
| `setAppCacheEnabled` | false | 离线缓存（ApplicationCache）不可用 | 已被 Service Worker 取代，忽略 |
| `JavaScriptCanOpenWindowsAutomatically` | false | `window.open()` 无效 / `target=_blank` 不响应 | 全新窗口、第三方跳转受影响 |

**前端视角为什么关心**：控件 90% 的"本来好好的，进 App 全没"就是前四行的开关没开。`javaScriptEnabled` 默认 false 尤其致命——**你以为是"容器"，其实容器连 JS 都默认不给你**。

#### 1.4.2 cacheMode：四种缓存模式

`setCacheMode(int)`，决定**每个请求走缓存还是走网络**：

| 模式 | 含义 | 前端体验 |
|---|---|---|
| `LOAD_DEFAULT` | 默认，按响应头 Cache-Control | 最正常，走 HTTP 缓存语义 |
| `LOAD_CACHE_ELSE_NETWORK` | 有缓存用缓存，没缓存才联网 | 打开快，但**线上版本更新就可能不是最新的**（经典"H5 灰度不更新"来源） |
| `LOAD_NO_CACHE` | 每次强制网络，不读缓存 | 永远最新，但慢、废流量 |
| `LOAD_CACHE_ONLY` | 只用缓存，不联网 | 离线包场景偶尔用 |

**前端视角**：遇到"你们 App 里 H5 一直显示旧版本，清了缓存就好"，第一时间怀疑容器用了 `LOAD_CACHE_ELSE_NETWORK`。改到这一项归因即可，不必先动你自己代码。细节、与 HTTP 缓存/Service Worker 的叠加关系，阶段 5 展开。

#### 1.4.3 mixedContentMode：混合内容（http 混在 https 页）

`setMixedContentMode(int)` 三个取值：

| 值 | 行为 | 说明 |
|---|---|---|
| `MIXED_CONTENT_NEVER_ALLOW` | 不加载 http 子资源 | 最安全，页面里的 http 图片/接口全挂 |
| `MIXED_CONTENT_ALWAYS_ALLOW` | 全部允许 | 默认导致 SSL 降级，**安全红线** |
| `MIXED_CONTENT_COMPATIBILITY_MODE` | 兼容模式，只允许部分 | 折中 |

**前端视角**：H5 页是 https，但 JS/CSS/图片/接口走 http，在手机浏览器可能能加载，在 WebView 里**可能被 Mixed Content 拦掉**。排"为什么图片不显示、接口报 Mixed Content"时，看这里。

#### 1.4.4 allowFileAccess / allowFileAccessFromFileURLs：安全红线

`setAllowFileAccess(boolean)`：是否允许从 `file://` 读文件（默认在 API≤15 true，之后 false）。
`setAllowFileAccessFromFileURLs(boolean)`：是否允许**file 域页面**里用 JS 跨 file 访问其他文件（默认 false）。

**前端视角**：这两项是**安全红线**。`allowFileAccessFromFileURLs=true` 后，一个被注入到 file 域的恶意页面能读 App 内其他文件 → 经典 WebView 漏洞面。阶段 9 会展开，你现在只要记住：**容器开着这两个，一旦你的页面/注入的 JS 被篡改，代价是 App 数据被读走**。正常生产环境建议都关。

#### 1.4.5 userAgentString / textZoom / dark 模式

| 项 | 前端视角 |
|---|---|
| `setUserAgentString` | UA 会被容器**追加或篡改**成 `App/版本 ... Chrome/... WebView/...`。你的 UA 判断（`isAndroid`/`isIOS`）必须建立在会给容器改写这一点上。别用 UA 当唯一判据，优先特性检测（阶段 1 讲过）。调试时用 UA 看"这条请求是不是 WebView 发的"（阶段 6 归因第一手线索） |
| `setTextZoom` | 控制**正文文本缩放**（0~300），跟 CSS `font-size`、`text-size-adjust` 叠加。你写死像素的字体，在用户开了系统字体放大后可能被撑爆——容器可在此处做限制 |
| dark 模式 | `setForceDark(WebSettings.FORCE_DARK_ON/OFF/AUTO)`（Android Q+）。页面用 `prefers-color-scheme` 时，要确认容器有没有强制 dark——**你页面在端上突然变黑，可能不是浏览器 dark-mode 适配问题，而是容器把 ForceDark 拨开了** |

#### 1.4.6 mediaPlaybackRequiresUserGesture

`setMediaPlaybackRequiresUserGesture(boolean)`，默认 **true**：**视频/audio 必须要用户手势（点击）才能 autoplay/播放**。

**前端视角**：你要做"进入页面自动播视频/音频背景音"，在手机浏览器可能要 web-audio unlock；在 WebView 里还多一道——**容器默认（true）要求用户先点一下**，你没点之前 `play()` 会被拒。这就是"为什么我 `video.play()` 一直 failed，点一下屏幕就好了"的根因。需要首屏自动播放，得让客户端把它设成 false。

---

### 1.5 WebViewClient 与 WebChromeClient：职责分界表

| 关注点 | WebViewClient | WebChromeClient |
|---|---|---|
| 导航/加载裁决 | ✅ `shouldOverrideUrlLoading`、`shouldInterceptRequest` | — |
| 页面生命周期回调 | ✅ `onPageStarted` / `onPageCommitVisible` / `onPageFinished` | — |
| 页面错误（加载失败、WebResourceError） | ✅ `onReceivedError` 等 | — |
| **JS 弹窗** alert/confirm/prompt | — | ✅ `onJsAlert` / `onJsConfirm` / `onJsPrompt` |
| **网页 JS 调权限**（相机/录音/定位） | — | ✅ `onPermissionRequest`、`onGeolocationPermissionsShowPrompt` |
| **文件选择** `<input type=file>` | — | ✅ `onShowFileChooser` |
| **全屏视频** requestFullscreen | — | ✅ `onShowCustomView` / `onHideCustomView` |
| JS 控制台日志、JS 错误 | — | ✅ `onConsoleMessage` / `onJsError` |

**记忆口诀**：**凡跟"导航/页面内容"走 WebViewClient，凡跟"浏览器 UI 能力和用户交互"走 WebChromeClient**。前端的 `window.alert`、`input[type=file]`、`getUserMedia`、`requestFullscreen` 这些"浏览器窗口级"的东西，全落在 WebChromeClient。

---

### 1.6 推荐初始化基线代码

> 平台：Android / Kotlin。粘贴进最小工程（Activity 里 onCreate）。注释标注**每一行为什么**。

```kotlin
// 平台：Android · Kotlin · 用途：WebView 初始化基线（在 loadUrl 之前调用）
private fun initWebView(webView: WebView) {
    // —— 1. WebSettings：一切能力开关，必须在 loadUrl 前配 ——
    val s = webView.settings
    s.javaScriptEnabled = true                 // JS 默认关！不开你的页面全线废——第一签名项
    s.domStorageEnabled = true                 // localStorage/sessionStorage 需要，否则为空——登录态丢失
    s.javaScriptCanOpenWindowsAutomatically = true  // 允许 target=_blank / window.open
    s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW // 安全红线：绝不 http 混入 https 页
    s.allowFileAccess = false                  // 安全红线：关掉 file:// 文件访问
    s.allowFileAccessFromFileURLs = false      // 安全红线：禁止 file 域恶意跨文件读
    s.cacheMode = WebSettings.LOAD_DEFAULT     // 走 HTTP 标准缓存，避免"H5 不更新"
    s.mediaPlaybackRequiresUserGesture = false // 允许首屏自动播放，不强制用户先点一下
    // s.setUserAgentString("myapp/1.0 " + s.userAgentString) // 需要带上 App 标识时追加，别覆盖

    // —— 2. 回调代理：统治导航 & 权限/弹窗 ——
    webView.webViewClient = object : WebViewClient() { }   // 此处不重写 = 全部走默认（02 篇深讲）
    webView.webChromeClient = object : WebChromeClient() {
        // onJsAlert/onJsPrompt/onShowFileChooser/onPermissionRequest 等，04 篇覆盖
    }
}
```

> 💡 读这段代码的要点：**你 90% 的"端上行为怪异"都能对回到上面某一行的开关**。看到 `javaScriptEnabled`、`domStorageEnabled` 没显式开，就知道为什么页面是死的；看到 `MIXED_CONTENT_ALWAYS_ALLOW`、`allowFileAccessFromFileURLs=true`，就明白是容器在裸奔（安全）。

---

### 1.7 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| JS 忘记开 | H5 全白 + 控制台无输出 | `javaScriptEnabled` 默认 false | 让容器在 loadUrl 前打开 |
| localStorage 空 | 登录态/主题丢失 | `domStorageEnabled` 默认 false | 打开 domStorageEnabled（阶段 5 还有生命周期坑） |
| H5 永远旧版 | 清了缓存就好 | `cacheMode=LOAD_CACHE_ELSE_NETWORK` | 归因到容器缓存策略 |
| 自动播放失败 | `video.play()` rejected | `mediaPlaybackRequiresUserGesture` 默认 true | 容器关掉此手势要求 |
| 图片 http 不显示 | 页面稳定复现 | `MIXED_CONTENT_*` 拦截 | 归因到 mixedContentMode |
| 页面临时变黑 | 跟随系统 dark | 容器 ForceDark 拨开 | 归因到 ForceDark 设置 |
| 字体忽大忽小 | 跟随系统字体缩放 | `textZoom`/`text-size-adjust` 叠加 | 归因到容器 textZoom |

---

### 1.8 自测题

1. `javaScriptEnabled` 默认值是什么？一个"白屏但不报错"的 H5，你会第一个查哪个开关？
2. `cacheMode=LOAD_CACHE_ELSE_NETWORK` 会造成什么前端可见现象？怎么在不动自己代码的情况下归因？
3. `mixedContentMode` 有哪三个取值？`MIXED_CONTENT_ALWAYS_ALLOW` 为什么是安全红线？
4. `setMediaPlaybackRequiresUserGesture(true)` 默认代表什么？你要自动播视频该怎么让客户端配合？
5. `WebViewClient` 和 `WebChromeClient` 分界的一句话口诀是什么？`onJsPrompt` 属于哪边？

<details>
<summary>参考答案（思考后再点开）</summary>

1. `false`。所以**默认 WebView 不执行网页 JS**，页面基本是死的。白屏无报错时先怀疑 `javaScriptEnabled` 没开（其次看 02 的导航 / 03 的桥注入时机）。
2. 有缓存优先用缓存 → 线上发新版 H5，端上仍显示旧内容，清缓存才恢复。不动自己代码，先查容器 `cacheMode` 是不是 `LOAD_CACHE_ELSE_NETWORK`。
3. `NEVER_ALLOW` / `ALWAYS_ALLOW` / `COMPATIBILITY_MODE`。`ALWAYS_ALLOW` 允许 https 页加载 http 子资源 → SSL 降级、中间人风险，生产必须避免。
4. 默认要求"用户先产生一次点按手势"才允许 autoplay/播放。要自动播，让客户端把它设为 `false`（同时确认播放策略与 Web Audio unlock）。
5. 跟"导航/页面内容"走 WebViewClient；跟"浏览器 UI 能力和用户交互（弹窗/权限/文件/全屏）"走 WebChromeClient。`onJsPrompt` 属于 **WebChromeClient**（04 篇讲它还是老式桥的通道）。

</details>

---

### 1.9 小结

Android WebView = **本体 + WebSettings + 两个 Client**。WebSettings 里 `javaScriptEnabled` / `domStorageEnabled` / `cacheMode` / `mixedContentMode` / `allowFileAccess*` / `mediaPlaybackRequiresUserGesture` 逐项都对应着你线上能看到的异常。下一节进"裁判"：点击一个链接后，`shouldOverrideUrlLoading` 怎么裁决导航、拦截 scheme、以及返回键怎么和网页 history 抢活。

---

---

## 2 · 导航控制与 URL 拦截：shouldOverrideUrlLoading 深讲

### 2.1 问题引入

线上事故：用户点了一个 `toast://冒烟` 或 `myapp://detail` 链接，希望弹出自定义 UI / 拉起原生页，结果页面却直接跳到了 404；返回键一按，不是退出页面，而是 WebView 的网页历史一直往回退，退无可退了才退出；更玄的是——**明明在链接里做了拦截处理，POST 的请求却绕过拦截直接加载了**。

这一切都归「导航控制」管：点链接后到底由谁来加载、谁来决定，以及返回键和网页历史怎么抢活。

---

### 2.2 先破误区

> • 误区："`shouldOverrideUrlLoading` 会在每次导航前都回调一次，我一律拦截判断它准没错。"
> • 事实：它不会在每次导航都回调。GET 主文档导航大多数会走，但 POST、部分 iframe、`window.open` 等场景不一定回调（`以实测为准`）。你把它当成"所有请求的总闸"就是事故根因。

> • 误区："返回键一定会退出整个 WebView 页面。"
> • 事实：返回键默认确实退出，但接入容器如果不主动接管 `onBackPressed`，点了返回键 WebView 不会自动回退网页历史——要你自己调 `goBack()`。行为因容器写法而异。

---

### 2.3 shouldOverrideUrlLoading：返回值与触发范围

#### 2.3.1 返回值语义

在 `WebViewClient` 里重写这个方法，返回值只有两种：

| 返回值 | 含义 |
|---|---|
| `false` | 让 **WebView 自己加载**这个 URL（继续本次导航） |
| `true` | **宿主接管**：WebView 不再加载这个 URL，把控制权交给你的代码（打开外部 App / 拦截 / 弹 toast） |

```kotlin
override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
    // true ⇒ 我自己处理，不让 WebView 加载；false ⇒ 放行 WebView 加载
    return handleOverride(url)  // 返回 '我是否接管了'
}
```

> ⚠️ 版本锚点：`shouldOverrideUrlLoading(WebView, String)` 在 API24+ 会被更新过的 `(WebView, WebResourceRequest)` 版本调用（后者能拿到 method/isRedirect）。重写时**两个都重写**并写 `@TargetApi(24)`，否则新版本号会走你没处理的旧逻辑。

#### 2.3.2 触发范围：别当"总闸"

关键事实（`以实测为准`，以下为常用场景，非穷尽）：

| 场景 | shouldOverrideUrlLoading 是否回调 |
|---|---|
| 点击 `<a href>`（GET 主文档导航） | 大多数回调 |
| `window.location.href = xxx` | 多数回调 |
| 页内 `<meta refresh>` / JS 重定向 | 可能回调 |
| **表单 POST 提交** | **通常不回调**（旧的 String 重载不触发，交由 `WebResourceRequest`/底层处理） |
| **iframe 内部的导航** | **不一定回调**（取决于内核/版本） |
| **`window.open()`** | 走 `onCreateWindow`，**不回调 shouldOverrideUrlLoading** |
| 页面内资源（img/script） | 不回调，走 `shouldInterceptRequest` |

**为什么要知道**：你想"把所有经过的请求拦下来审核"——scheme 白名单、安全过滤——如果只依赖 `shouldOverrideUrlLoading`，POST / iframe / window.open 的链路会**漏网**。拦截是手段不是目的，真正的安全/审核边界在阶段 9，那要靠 `shouldInterceptRequest`（资源级，阶段 7 离线包也用它）。

#### 2.3.3 验证代码思路（为什么"以实测为准"）

做个最小实验，现场确认你设备/内核的触发范围：

```kotlin
// 平台：Android · Kotlin · 请在页面上按顺序触发：点a、location跳转、表单POST、iframe、window.open
override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
    Log.e("NAV", "override(method=${request?.method}, url=${request?.url})")
    return false // 一律放行，看日志数出来多少个没进来的
}
```

配合 H5 在每种点击前后打印自己 URL，把所有"URL 变了但 override 没打印"的导航标记出来，就是你的内核下真实的不回调集合。**换内核/换版本必须重测**（见 05 篇 X5/U4）。

整棵决策树长这样：

![导航决策流程图](/images/webview-and-native/stage2-02-navigation-flow.png)


#### 2.3.4 scheme 分类处理：路由表

在 override 里做 scheme 路由：

```kotlin
override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
    val u = url ?: return false
    return when {
        u.startsWith("http://") || u.startsWith("https://") -> false       // 主文档，放行 WebView
        u.startsWith("about:") -> false                                     // about:blank 兜底，放内容
        u.startsWith("tel:") || u.startsWith("mailto:") -> tryOpenExternal(u) // 交给系统 Intent
        u.startsWith("myapp://") -> routeInApp(u)                            // 自定义 scheme → 路由表
        else -> true                                                          // 未知 scheme，接管兜底
    }
}
```

- **http/https**：默认放行（`false`）。
- **about:blank**：很多空页面/初始化用，别拦截成"异常"。
- **tel/mailto/sms**：推荐用系统 Intent 打开，而不是塞给 WebView（WebView 处理不了这类 scheme）。
- **自定义 scheme**（`myapp://page/detail?id=1`、`weixin://`）：进**路由表**，决定"拉原生页 / 让别的 App 打开 / 调原生能力"，返回 `true` 表示你接管了。

> 同一个 scheme，不同容器策略不同：有的容器把所有 `myapp://` 都拉原生；有的只认白名单里的。**这就是"容器动作 1·URL scheme 路由"的落地**。

---

### 2.4 返回键接管：onBackPressedDispatcher + canGoBack/goBack

网页有自己的 history。想让"返回键先回网页、回无可回了再退出 Activity"，必须在宿主 Activity 里接管返回键：

```kotlin
// 平台：Android · Kotlin · Activity 里接管返回键
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(binding.root)
    // new API（androidx）：onBackPressedDispatcher 是推荐姿势
    onBackPressedDispatcher.addCallback(this) {
        if (webView.canGoBack()) { webView.goBack() }  // 网页历史还有 → 回退网页
        else isEnabled = false                          // 没得回了 → 放行给默认行为（退 Activity）
    }
}
```

> 细节：单次 `goBack()` 只回退**一层** history（等于浏览器按一次"后退"）。用户从 A → B → C，回来要 `B`，再按退 `A`，再按才退出。监控里"H5 页面返回键不退出/响应慢"要分清楚是"多层 history 没退完"还是"接管没生效"。

`canGoBack()` 是"当前 history 有没有上一页"的真值，靠它决定是 `goBack()` 还是放手不 `isEnabled=false`（让返回键默认退出）。

---

### 2.5 导航时序：onPageStarted / onPageCommitVisible / onPageFinished

这三个回调的顺序大致是：

```
onPageStarted(url)          ← 页面开始加载（导航发出）
   ↓ 网络请求 / 解析
onPageCommitVisible(url)    ← 首帧内容即将上屏（可交互前的关键节点，API23+）
   ↓
onPageFinished(url)         ← 页面加载完，window.onload 触发之后
```

**与前端 `window.onload` 谁先？——以实测为准，且不同内核有差异。** 一个需要 `onPageFinished` 里注入 JS / 拿 DOM 的做法，如果时机差一个变化，桥初始化就竞态了（03 篇展开"注入时机 vs 页面 ready"）。

- 这三个回调**都不可靠地精确**：JS 重定向、服务端 302、页面崩溃、iframe 加载都会让时序偏移；`onPageFinished` 可能**每帧触发多次**或**在页面自己又 navigate 一次后重置**。
- 不要把"业务逻辑完成"绑定在 `onPageFinished` 上；它只表示"本次导航的主文档加载完"。

验证代码（记下时序，别再猜）：

```kotlin
// 平台：Android · Kotlin · demo 里在 H5 的 window.onload 里 poke 一个时间戳
override fun onPageStarted(view: WebView?, url: String?)  { Log.e("TIMING", "pageStarted  $url") }
override fun onPageCommitVisible(view: WebView?, url: String?) { Log.e("TIMING", "commitVisible $url") }
override fun onPageFinished(view: WebView?, url: String?) { Log.e("TIMING", "pageFinished  $url") }
```

配合前端 `performance.timing`/onload 时间戳，对比两端打印就知先后。

---

### 2.6 初步安全观念：拦截是"入口看守"

你可能会想："既然我可以直接读 URL，那就把所有进来的 URL 都做个判断——不在我的白名单就拦下。"

思路对，但要知道边界：

- **白名单判断在 override 里只是"导航入口"的一道闸**。真正持守资源级的安全（`shouldInterceptRequest`、Mixed Content、file 域、JSBridge 白名单），落在阶段 9。这里你先建立"导航要过白名单"的动机——比如只允许 `https://your-domain.com/*` 放行，其余 scheme 一律进路由表/接管，防止被反向打开任意地址（钓鱼/外跳）。
- 别忘了第二节的触发范围局限：override 拦不到 POST/iframe/window.open，所以"白名单只靠 override"是**不完整**的。

```kotlin
// 白名单片段（阶段 9 会系统化，这里只给"入口看守"的雏形）
override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
    if (url != null && url.startsWith("https://your-domain.com/")) return false // 放行信任域
    // 其余：拦截或路由，别把它喂给 WebView
    return true
}
```

---

### 2.7 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| POST 绕过拦截 | override 没被调但页面变了 | shouldOverrideUrlLoading 对 POST/部分场景不回调 | 用 `shouldInterceptRequest`（阶段 7/9）做资源级拦截 |
| window.open 兜不住 | 新窗口没拦截 | `window.open` 走 `onCreateWindow`，不走 `shouldOverrideUrlLoading` | 在 `WebChromeClient` 重写 `onCreateWindow` |
| 返回键不回退 | 一按返回就退出 | 容器没接管 onBackPressed | `canGoBack()`+`goBack()`，回无可回再退出 |
| 多层 history | 返回要点很多次 | 一次 goBack 只退一层 | 跟业务确认返回层级策略 |
| 只重写旧方法 | 新版 URL 检测不到 | 版本差异，旧重载在 API24+ 不覆盖 | 重写 `(WebView, WebResourceRequest)` 版本 |
| onPageFinished 当完成信号 | 业务逻辑时机错乱 | 时序受重定向/iframe 影响不可靠 | 以实测为准，别绑定业务 |

---

### 2.8 自测题

1. `shouldOverrideUrlLoading` 返回 `true` 和 `false` 分别代表什么？
2. 它会不会在"表单 POST 提交"时回调？会的话/不会的话，你要拦 POST 该用谁？
3. `window.open()` 会走 shouldOverrideUrlLoading 吗？该重写哪个回调？
4. 返回键为什么需要容器接管？`canGoBack()`/`goBack()` 各自干什么？
5. `onPageFinished` 和前端 `window.onload` 谁先？为什么不能把业务逻辑绑定在它上面？（给验证思路）

<details>
<summary>参考答案（思考后再点开）</summary>

1. `true` = 宿主接管，WebView 不加载这个 URL；`false` = 放行让 WebView 自己加载。
2. 旧 String 重载通常**不回调** POST；要拦网络/资源级阻止请用 `shouldInterceptRequest`（阶段 7/9），并**以实测为准**。
3. 不回调。`window.open()` 走 `onCreateWindow`（打开新窗口的 WebChromeClient 回调）。
4. 返回键默认退出 Activity，不回退网页。容器接入后自己调 `onBackPressedDispatcher.addCallback`，`canGoBack()` 判断"history 有没有上一页"，`goBack()` 真正回退一层。
5. 顺序有差异且受重定向/iframe 影响，**以实测为准**（记两端口的时间戳对比）。它只表示"本次导航主文档加载完"，不代表业务就绪，所以别绑定。

</details>

---

### 2.9 小结

`shouldOverrideUrlLoading` 是导航入口的第一道裁决：返回值语义、scheme 路由表、返回键接管、四个时序回调都要认清。更关键的是**别把它当总闸**——POST/iframe/window.open 会绕过属常见情形，资源级真正安全的边界在阶段 9。下一节：既然导航能进页面了，前面的 JS 到底怎么和原生互相通信。

---

---

## 3 · JS 与 Native 互调：两座桥的原材料

### 3.1 问题引入

线上事故：H5 里调 `window.xxxBridge.getToken()`，一端上就报 `ReferenceError: xxxBridge is not defined`；另一个 App 里同一个页面，`getToken` 不报错但**回调一直不回来**——接口没走，日志也没有。俩都是"桥"。这章把 Android 端**互调的两座桥**讲清楚：Native→JS（`evaluateJavascript`）和 JS→Native（`addJavascriptInterface`）。这套是最底层的"原材料"，完整的 JSBridge 在阶段 4 拼装。

---

### 3.2 先破误区

> • 误区："H5 调 Native，就是调一个全局函数就行，跟调自己页面函数一样。"
> • 事实：它运行在后台线程 `JavaBridge`，返回给 JS 的还是一个异步回调，时序/线程全不一样。你按"同步函数"写，就得上当。

> • 误区："Native 往页面塞 JS，只有 `loadUrl("javascript:...")` 一种。"
> • 事实：现代正确姿势是 `evaluateJavascript`，`loadUrl("javascript:")` 是历史遗留，且塞长串/带引号容易翻车。

---

### 3.3 桥一：Native → JS，用 evaluateJavascript

#### 3.3.1 它是什么

```kotlin
// 平台：Android · Kotlin
webView.evaluateJavascript("window.updateUI('你好')") { result ->
    // 回调也在主线程，且 JS 的【返回值】以 JSON 字符串形式传回来
    Log.e("JS->", "JS 返回: $result")   // 注意：这里是 JSON 串，可能带引号！
}
```

关键点：

1. **必须在主线程调用**（UI 线程），否则抛异常。
2. **回调也在主线程**——你不用再切线程，直接更新 UI 即可。
3. 回调拿到的 `result` 是 **JS 表达式的返回值，且被 JSON 序列化**。经典坑：如果 JS 返回一个字符串 `"hi"`，你拿到的是 `"\"hi\""`（带引号的 JSON 串），需要 `JSON.parse` 剥壳；如果返回对象，你拿到的也是 **JSON 文本**，要 `JSON.parse` 成对象——这就是"JSON 串需解析"的双层/单层细节：**返回字符串要 parse 一次剥引号，返回对象要 parse 一次成对象**。
4. **无返回值时**（JS 是副作用调用），回调里 `result` 可能是字符串 `"null"`。

```kotlin
webView.evaluateJavascript("1 + 1") { r -> Log.e("R", r) }                      // "2"
webView.evaluateJavascript("'hi'") { r -> Log.e("R", r) }                     // "\"hi\"" —— 带引号
webView.evaluateJavascript("({a:1})") { r -> Log.e("R", r) }                  // "{\"a\":1}" —— JSON 文本
webView.evaluateJavascript("void 0") { r -> Log.e("R", r) }                   // "null"
```

> 红线锚点：`evaluateJavascript` 主线程调用 / 回调主线程 / 结果是 JSON 串需解析——三件套必须写对。

#### 3.3.2 为什么淘汰 `loadUrl("javascript:...")`

老办法：`webView.loadUrl("javascript:window.updateUI('hi')")`。

- **长度陷阱**：JavaScript 过长时 `loadUrl` 的 URL 有长度/编码限制，超长串会被截断或解析失败。
- **转义灾难**：你要塞的 JS 里面带 `'`、`"`、`\n`、`%`，得一层层转义，极易出错；`evaluateJavascript` 传的是**原生 JS 源码字符串**，不需要 URL 编码。
- `evaluateJavascript` 还能拿到返回值回调，`loadUrl` 不能。

所以：**新代码一律用 `evaluateJavascript`**。`loadUrl("javascript:")` 只用于极老内核的兜底（`以实测为准`）。

---

### 3.4 桥二：JS → Native，用 addJavascriptInterface

#### 3.4.1 注入一个对象

```kotlin
// 平台：Android · Kotlin · 把 ("AndroidBridge", bridge) 注册到 window.AndroidBridge
webView.addJavascriptInterface(object {
    @JavascriptInterface   // ← API 17+ 必须加！否则方法默认不暴露给 JS
    fun showToast(msg: String) { ... }

    @JavascriptInterface
    fun getToken(callback: String) { ... }   // 回调名设计见下/阶段4
}, "AndroidBridge")
```

注入后，页面里就是 `window.AndroidBridge.showToast("你好")`。

#### 3.4.2 三个你必须知道的细节（红线）

1. **`@JavascriptInterface` 注解必需（API 17+）**：API 17 之前 `addJavascriptInterface` 有个反射漏洞（任意页面能通过反射调用 App 里任何 Java 方法，这就是著名的 4.2 漏洞史）。修复方式之一就是只把**显式标了 `@JavascriptInterface` 的方法**暴露给 JS。你**必须**给每个要暴露的方法加这个注解，否则那方法对 JS 就"不存在"（不报方法不存在，直接 undefined）。

2. **方法运行在名为 `JavaBridge` 的后台线程**：JS 调用你注入的方法时，它跑在**非 UI 的 `JavaBridge` 线程**。所以——任何要动 UI 的操作**必须先切回主线程**：

```kotlin
@JavascriptInterface
fun showToast(msg: String) {
    // 当前在 JavaBridge 后台线程！不能直接碰 View
    runOnUiThread {
        Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
    }
}
```

   "回调再切主线程"是必修课：**不在 JavaBridge 线程里直接更新 UI / 直接阻塞主线程**。

3. **注入时机 vs 页面 ready 的竞争**：如果你已经 `loadUrl`，页面脚本跑起来之后 `window.AndroidBridge` 都还**没有定义**，前端 `if (window.AndroidBridge)` 判断失败、直接调用就 `ReferenceError`。正确姿势：**加载前就注入**（`addJavascriptInterface` 必须在 `loadUrl` 之前调用），并在前端做好 ready 判断。如果在同一 Activity 里 new WebView + 注入 + loadUrl，顺序调换就是事故。阶段 4 会把"注册 vs ready、SPA 路由切换后 Bridge 还在不在"讲透。

#### 3.4.3 JS 侧怎么调

```js
// 平台：H5 / JS —— 方式A：同步空返回；方式B：回调
if (window.AndroidBridge) {
  window.AndroidBridge.showToast("hello")          // 扔给 Native，不等结果
  window.AndroidBridge.getToken(cbName)            // 传回调名，Native call 回来（结构见下 demo）
}
```

真正的"让 JS 拿到返回值"要跨线程 + 回调名协议——那就是阶段 4 的 `callbackId` 设计。这里先给你能跑的最小双向 Demo。

---

### 3.5 最小可跑的双向互调 Demo

> 平台：H5 + Android / Kotlin。Native 调页面 `updateUI`，页面调 Native `showToast` 并返回 Promise 结果。

```html
<!-- demo.html（H5 侧） -->
<script>
  // 页面暴露给 Native 调
  window.__updateUI = function (text) {
    document.getElementById('tip').innerText = text;
  };

  // JS → Native：先定义"回调"，再让 Native 执行
  window.__cb = {};
  window.__id = 0;
  function callNativeShowToast() {
    const id = '__cb' + (++window.__id);
    window.__cb[id] = (r) => document.getElementById('ret').innerText = 'Native说: ' + r;
    window.AndroidBridge.showToastWithResult(id);   // Native 端见下
  }
  // Native 回来调这个：把 JSON 结果剥开再 resolve
  window.__nativeReturn = function (id, json) {
    window.__cb[id] && window.__cb[id](JSON.parse(json));
  };
</script>
```

```kotlin
// 平台：Android · Kotlin（与上方 H5 配对）
class MainActivity : AppCompatActivity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val webView = WebView(this)
        setContentView(webView)

        // ① 先注入（必须在 loadUrl 之前！）
        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun showToastWithResult(cbId: String) {
                // 此刻在 JavaBridge 后台线程；动 UI 前先切主线程
                runOnUiThread { Toast.makeText(this@MainActivity, "JS 叫我啦", Toast.LENGTH_SHORT).show() }
                // 通过桥一回调：把结果 JSON.stringify 后传回页面，页面 __nativeReturn 解析
                webView.evaluateJavascript(
                    "window.__nativeReturn('$cbId', JSON.stringify('收到'))",
                    null
                )
            }
        }, "AndroidBridge")

        // ② 配置 + 加载
        webView.settings.javaScriptEnabled = true
        webView.loadUrl("file:///android_asset/demo.html")  // 提前把 demo.html 放进 assets
    }
}
```

跑起来：页面里先点"Native 调 updateUI"（用 `evaluateJavascript("window.__updateUI('来自 Native')")`），再点"JS 调 showToast"——JS 侧 Promise 结果回来了，Toast 也弹了 → 双向打通。要点全在这段里：`@JavascriptInterface`、主线程、回调经 `evaluateJavascript` 回流、`JSON.stringify`/`JSON.parse` 剥壳。

---

### 3.6 伏笔：这就是"桥"的原材料

`evaluateJavascript`（Native→JS）+ `addJavascriptInterface`（JS→Native）加在一起，正好构成阶段 4 自研 **JSBridge（桥）** 的两座桥：

- 统一封装成 Promise：JS 调 `bridge.call('getToken')`，内部记 `callbackId`，Native 返回时用回调配对 resolve——就是我们上面 demo 的 `__nativeReturn` 手动版。
- 参数序列化（JSON）、超时、并发去重、异常上抛都是在这一层做。
- Android 四个通信通道（这章两个 + URL Scheme 拦截 + 弹窗拦截）里，`addJavascriptInterface` 是最通用的一款，但也有安全包袱（反射/白名单），阶段 4 和阶段 9 分别讲原理和安全。

现在你只需记住：**这章每一行都是桥的原材料**，阶段 4 会用它们组装出完整的 JSBridge。

---

### 3.7 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| 忘加注解 | JS 调方法得 undefined | API17+ 没 `@JavascriptInterface` 不暴露 | 每个暴露方法都加注解 |
| 后台线程动 UI | 崩溃 / 画面异常 | `JavaBridge` 线程非主线程 | 回调内 `runOnUiThread` 切主线程 |
| result 带引号 | 字符串判断永远不等 | `evaluateJavascript` 返回 JSON 串 | `JSON.parse` 剥壳后再用 |
| 桥未就绪 | `xxxBridge is not defined` | 注入晚于页面脚本运行 | `loadUrl` 前注入 + 前端 ready 判断 |
| 长串 loadUrl | 回调收不到/截断 | `loadUrl("javascript:")` 长度/转义坑 | 改用 `evaluateJavascript` |

---

### 3.8 自测题

1. `evaluateJavascript` 有几个强制前提？回调里拿到的 `"hi"` 实际长什么样，为什么要解析？
2. `addJavascriptInterface` 的方法为什么要加 `@JavascriptInterface`？哪个 API 版本开始必需？
3. 注入的方法运行在什么线程？为什么动 UI 前要先切主线程？
4. `loadUrl("javascript:...")` 相比 `evaluateJavascript` 有什么坑？
5. "注入时机 vs 页面 ready" 为什么是事故高发点？正确顺序是什么？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 必须在**主线程**调用；回调也在主线程。返回值是 JSON 序列化文本，字符串 `"hi"` 会变成 `"\"hi\""`，要 `JSON.parse` 剥引号、对象要 parse 成对象、无返回值是 `"null"`。
2. `@JavascriptInterface` 是 **API 17+ 必需**注解，不加的方法不暴露给 JS（这也是 4.2 反射漏洞修复后的安全要求）。
3. 运行在名为 **`JavaBridge` 的后台线程**。直接动 UI 会崩/异常，所以回调内要 `runOnUiThread` 把操作切回主线程。
4. 长度/转义坑（URL 会截断、`'` `"` `\n` `%` 要层层转义），且拿不到返回值；`evaluateJavascript` 传原生 JS 源码、支持回调。
5. 如果 loadUrl 后脚本先跑，`window.AndroidBridge` 尚未定义就 `ReferenceError`。正确顺序：**在 loadUrl 之前 `addJavascriptInterface`**，前端再做 ready 判断。

</details>

---

### 3.9 小结

Android 互调 = **`evaluateJavascript`（Native→JS，主线程 + JSON 串解析）+ `addJavascriptInterface`（JS→Native，`@JavascriptInterface` + `JavaBridge` 后台线程 + 注入时机）**。这两座桥只是原材料，阶段 4 会把它封成带 Promise、callbackId、超时去重的完整 JSBridge。下一节讲浏览器级 UI：JS 弹窗、文件选择、权限、全屏，以及最容易被忽略的——WebView 销毁与内存。

---

---

## 4 · 弹窗 · 文件选择 · 权限 · WebView 销毁

### 4.1 问题引入

线上事故：页面里 `alert()` 干脆不弹、`input[type=file]` 点了没反应、`getUserMedia` 权限弹不出来、点全屏看视频结果整个画面错乱——这些"浏览器窗口级"能力，全归 **WebChromeClient** 管。不实现对应回调，它们要么被**静默吞掉**，要么**没后续**。再往后是很多人没人管的事：**WebView 销毁姿势不对，直接内存泄漏**。

---

### 4.2 先破误区

> • 误区："页面里的 alert / confirm / prompt，WebView 会自动弹一个系统对话框吧？"
> • 事实：默认只是一个极简单的纯文本提示，见下；而且 `onJsPrompt` 需要专门重写，否则 prompt 的输入根本收不到。更关键的是——不实现这些回调时，不同内核的行为以实测为准，别默认"会弹漂亮框"。

> • 误区："Activity 关掉了，WebView 自己就被回收了。"
> • 事实：WebView 持了一堆引用/监听，不先 remove + destroy 就退出，会造成 Activity 泄漏。销毁是显式动作。

---

### 4.3 WebChromeClient 三件套：JS 弹窗

页面里 `window.alert / confirm / prompt` 对应：

| JS API | 回调 | 不重写/默认行为 |
|---|---|---|
| `window.alert(msg)` | `onJsAlert` | 系统弹一个**简单纯文本框**（应用名+OK），没有标题定制 |
| `window.confirm(msg)` | `onJsConfirm` | 系统弹"确定/取消"框，返回布尔 |
| `window.prompt(msg, def)` | `onJsPrompt` | 系统会弹带输入框的框（如果你希望自绘/走桥，就重写它） |

**不重写时**：默认由 WebView 调系统的 AlertDialog 结构，表现是"很丑的原生框"。很多容器为了 UI 统一会**全部接管重绘**（这就是"为什么微信里 alert 长得不一样"——容器把 WebChromeClient 的弹窗代理成自己的样式）。

#### 4.3.1 事实铺垫：onJsPrompt 是老式桥的通道

在 `addJavascriptInterface` 不普及/要兼容的老年代，有一种**用 `onJsPrompt` 当桥**的通信方式：JS 调用 `window.prompt(url, payload)`，Native 在 `onJsPrompt` 里解析第二个参数（payload）拿到"我想调什么原生能力"，然后 `confirm()` 返回结果。它不需要额外注入对象、跨线程简单，所以**在没有 addJavascriptInterface 或想避免反射风险**的容器里，`onJsPrompt` 一直是被用做"桥"的一种通道。阶段 4 对比四种通道时你会再见它。**现在记住**：`onJsPrompt` 是 WebChromeClient 的，且它能当桥——这是你后面理解兼容层的一把钥匙。

---

### 4.4 文件选择：onShowFileChooser

页面 `<input type=file>` 触发。要真正打开系统文件选择器，你**必须**自己拉一个 `Intent` 并把结果喂回去：

```kotlin
// 平台：Android · Kotlin · 示例结构，完整可粘贴见 demo
private var filePathCallback: ValueCallback<Array<Uri>>? = null

override fun onShowFileChooser(
    webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>?, fileChooserParams: FileChooserParams?
): Boolean {
    this.filePathCallback?.onReceiveValue(null)  // 先清上次残留，避免回调泄漏
    this.filePathCallback = filePathCallback
    // 用 ContentValues + ACTION_GET_CONTENT 拉起系统文件选择器
    val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
    }
    startActivityForResult(intent, REQUEST_FILE)
    return true   // 返回 true = 由你接管文件选择
}

// onActivityResult 里回传：
private fun onFilePicked(resultCode: Int, intent: Intent?) {
    val uris = intent?.clipData?.let { (0 until it.itemCount).map { i -> it.getItemAt(i).uri }.toTypedArray() }
        ?: intent?.data?.let { arrayOf(it) }
    filePathCallback?.onReceiveValue(uris)
    filePathCallback = null
}
```

要点：`onShowFileChooser` **返回 true 表示"你接管"**，不接管就什么都不弹；回调对象要**显式 onReceiveValue(null) 收尾**，否则 WebView 等不到结果会一直挂着。

---

### 4.5 权限回调：相机 / 录音 / 定位

#### 4.5.1 onPermissionRequest（相机 / 录音 / 麦克风等）

页面调 `getUserMedia` / 其它 WebRTC 权限时：

```kotlin
override fun onPermissionRequest(request: WebChromeClient.PermissionRequest?) {
    // request.resources   → e.g. ["android.webkit.resource.VIDEO_CAPTURE", "android.webkit.resource.AUDIO_CAPTURE"]
    val granted = request?.resources?.all { it in ALLOWED_RESOURCES } == true  // 白名单过滤，别照单全收
    if (granted) request?.grant(request.resources)   // 授予哪些资源
    else request?.deny()
}
```

> 安全提示：不要 `grant()` 全部资源，只按白名单 `ALLOWED_RESOURCES` 给——这是阶段 9 的前置安全观。

#### 4.5.2 与 `mediaPlaybackRequiresUserGesture` 的关系

`onPermissionRequest` 管的是"网页能否**申请**相机/录音权限"；`settings.mediaPlaybackRequiresUserGesture` 管的是"音视频**播放**要不要先点一下"。两者不冲突：

- 权限**申请**（getUserMedia）→ onPermissionRequest；
- 播放/自动播放 → mediaPlaybackRequiresUserGesture（01 篇讲过）。
- 联调顺序：先保证页面能申请到权限（onPermissionRequest + 系统相机授权），再谈自动播放是不是还差用户手势。

#### 4.5.3 onGeolocationPermissionsShowPrompt（HTML5 定位）

`navigator.geolocation` 走的是**另一个回调**（不是 onPermissionRequest）：

```kotlin
override fun onGeolocationPermissionsShowPrompt(
    origin: String?, callback: GeolocationPermissions.Callback?
) {
    callback?.invoke(origin, true /*allow*/, false)   // 记得也需 Manifest + 运行时定位权限
}
```

> 细节：`navigator.geolocation` 与 `getUserMedia` 分属两套权限模型（一个 onGeolocationPermissionsShowPrompt、一个 onPermissionRequest），容器要分别处理（`以实测为准`，不同内核略有差异）。

#### 4.5.4 全屏视频：onShowCustomView / onHideCustomView

页面 `requestFullscreen()`（常见于视频播放器全屏）：

```kotlin
override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
    // 把 view 加到全屏容器（通常是 FrameLayout），隐藏 WebView
}
override fun onHideCustomView() {
    // 移除全屏 view 并恢复
}
```

不实现 → 全屏点不动 / 全屏假死。

---

### 4.6 生命周期与内存：WebView 挂在哪、怎么销毁、为什么泄漏

#### 4.6.1 WebView 挂在哪

WebView 是一个普通 View，**要放进一个 Activity 的布局**（`setContentView(webView)` 或塞进 `FrameLayout`），并随 Activity 生命周期走。它没有"自己独立进程"——**默认和 App 共享一个进程**（多进程话题见阶段 1 · 多进程与渲染进程崩溃）。

#### 4.6.2 Activity 销毁时正确销毁姿势

```kotlin
override fun onDestroy() {
    // 顺序：先从父布局移除 → 再 destroy，防残留引用
    (webView.parent as? ViewGroup)?.removeView(webView)
    webView.stopLoading()
    webView.settings.javaScriptEnabled = false
    webView.removeAllViews()
    webView.destroy()          // 一定要调，释放内核资源
    super.onDestroy()
}
```

`destroy()` 前先 `removeView`，是因为 WebView 内部持着与父容器/回调的引用，不先摘掉会留钩子。

#### 4.6.3 为什么持 Activity context 会泄漏

WebView 内部注册了系统级监听/绑定，且它持有的 context 若指向 Activity，一旦 Activity 声称"我要销毁"却仍被 WebView 引用着（例如 WebView 没 destroy、没从 Activity 摘除，或者你偷偷把 `this` Activity 传进了回调/单例），Activity 就**无法被 GC** → 泄漏。一句话：**WebView 该随 Activity 死，别让任何东西还拽着 Activity 不放**（包括 `onShowFileChooser` 的 callback、JS 接口对象里持有的 Activity context）。这也是为什么很多容器把 WebView 放在**独立进程**或**复用的池**里统一管理。

#### 4.6.4 onPause / onResume 与 pauseTimers 的区别

| API | 作用 |
|---|---|
| `webView.onPause()` / `onResume()` | 只暂停**这个 WebView**：JS、动画、视频渲染暂停/恢复 |
| `webView.pauseTimers()` | 暂停**全局所有 WebView 的 JS/定时器**（App 全退到后台时常用），恢复用 `resumeTimers()` |

前端视角：App 退后台，如果容器只调了 `onPause()` 归档，可能只停当前页；要整体停 JS 定时器用 `pauseTimers()`。它们配套 `Activity.onPause/onResume` 调用。

#### 4.6.5 多进程与 onTrimMemory 对 H5 的含义

- **多进程**：容器可以把 WebView 放**独立进程**（如 `:webview`），好处是渲染/JS 崩溃不拖垮主进程。代价是**跨进程通信成本**、生命周期、取数都要单独设计（`以实测为准`）。
- **onTrimMemory**：系统内存吃紧时回调（`TRIM_MEMORY_*`）。当一个页面被系统**回收其渲染/WebContent 进程**，但壳 Activity 还在 → H5 就变**白屏**。
- 这与阶段 8「白屏精准诊断」直接连上：**白屏 ≠ 加载慢，可能是渲染进程被杀**（归因到进程回收，而不是你代码）。

---

### 4.7 Demo：三个文件落盘

可整体粘贴的三份文件在 demo 目录，见 `demo/stage-2-android/`：`WebViewDemoActivity.kt`（初始化基线+生命周期）、`MyWebViewClient.kt`（scheme 路由骨架）、`MyWebChromeClient.kt`（alert/prompt/file/权限最简实现）。README.md 说明拼装方式（<100 字）。把三份文件放进一个 Android 最小工程的对应位置即可跑通。

---

### 4.8 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| alert 样式丑 | 弹出丑的原生框 | 容器没接管 onJsAlert | 重写 onJsAlert 自绘统一样式 |
| 文件选择器不出 | input=file 点了没反应 | 没实现/没返回 true | 实现 onShowFileChooser 并返回 true + 收尾回调 |
| 相机权限卡 | getUserMedia 失败 | onPermissionRequest 没授 grant | 按白名单 grant 资源 |
| 全屏视频假死 | 全屏点不动 | 没 onShowCustomView | 实现全屏容器管理 |
| Activity 内存泄漏 | 反复进出涨内存 | WebView 没摘除没 destroy / 持 context | removeView后 destroy，别传 Activity 出去 |
| 后台白屏 | 切回来 H5 白屏 | 渲染进程被 onTrimMemory 回收 | 归因到进程回收，不是前端代码 |
| 退后台定时器不停 | JS 定时器还在跑 | 只 onPause 全局没停 | pauseTimers 恢复 resumeTimers |

---

### 4.9 自测题

1. `onJsPrompt` 为什么可以被用作"桥"的老式通道？它属于哪个 Client？
2. `onShowFileChooser` 返回 true/false 各代表什么？为什么不返回 true 导致<u>input=file</u>无反应？
3. `onPermissionRequest` 和 `onGeolocationPermissionsShowPrompt` 分别管什么？和 `mediaPlaybackRequiresUserGesture` 的关系？
4. Activity 销毁 WebView 的标准顺序是什么？为什么持 Activity context 会泄漏？
5. `onPause()/onResume()` 与 `pauseTimers()/resumeTimers()` 的区别？
6. 后台回来 H5 白屏，可能是什么？（归因到哪，不是前端代码）

<details>
<summary>参考答案（思考后再点开）</summary>

1. JS 用 `prompt(url, payload)`，Native 从 `onJsPrompt` 第二参解析——不需要注入对象、跨线程简单。属 **WebChromeClient**。
2. `true` = 你接管文件选择；不 true（默认/不实现）就没有后续 → input 点了没反应。还要显式 `onReceiveValue` 收尾。
3. `onPermissionRequest` 管 getUserMedia 相机/录音；`onGeolocationPermissionsShowPrompt` 管 `navigator.geolocation`。前者管"能不能申请"，后者管"能不能定位"，都与 `mediaPlaybackRequiresUserGesture`（播放手势）不同维度。
4. `removeView` → `stopLoading` → `destroy`（先摘除再销毁）。WebView 若仍被回调/单例拽住 Activity context，Activity 无法 GC → 泄漏。
5. `onPause/onResume` 只暂停当前 WebView；`pauseTimers/resumeTimers` 全局暂停/恢复所有 WebView 的 JS 定时器。
6. 可能是 **onTrimMemory 把渲染进程回收**，壳还在、内容没了 → 白屏。归因到进程回收，而非前端代码（阶段 8 展开）。

</details>

---

### 4.10 小结

弹窗、文件、权限、全屏全套浏览器级 UI 都在 **WebChromeClient**；销毁（removeView→destroy）、`pauseTimers`、多进程回收导致的后台白屏都是生命周期/内存问题。这些"没人爱管"的部分，恰恰是最常见的泄漏与白屏来源。下一节离开默认 Android WebView，看国产容器里常见的 X5/U4 内核。

---

---

## 5 · 国产内核：X5（TBS→XWeb）与 U4

### 5.1 问题引入

线上事故：同一个 H5，在你们 App 里 `localStorage` 跟系统 WebView 里**行为不一样**，`console` 打不出来、调 `evaluateJavascript` 返回值解析错了、甚至 `window.AndroidBridge` 时通时不通。归因时客户端说"我们是 X5 内核"，前端就懵了：**X5 是什么？跟系统 WebView 差在哪？要不要为它单独适配？**

---

### 5.2 先破误区

> • 误区："国内 App 里的安卓 H5，都是系统 WebView。"
> • 事实：很多国内 App（微信、QQ 等）默认走自家/第三方内核（X5、U4），系统 WebView 只是整体的一支。你"在浏览器里好的"原型，不代表进这些壳就好。

> • 误区："国产内核就是换个壳，行为跟系统 WebView 差不多。"
> • 事实：X5（腾讯）与 U4（UC）都有自主内核，渲染/JS/缓存/回调实现与系统 WebView 有差异，而且同样版本内也有碎片化。

---

### 5.3 为什么会有它们

Android 上"内核选择"是自由市场（不像 iOS 强制 WebKit）。几种动机：

1. **无 GMS / 系统 WebView 不可控**：国产中低端/无 Google 服务的手机，系统 WebView（System WebView，靠 Play 更新）**更新不到或不及时**，内核版本被锁死在系统带的那一版——前端新 API 用不了、渲染 bug 修不到。
2. **更新自主权**：App 内置/引导下载一套**自己可控的内核**，可随 App 版本升级、统一补丁，不依赖系统厂商。
3. **统一性**：给所有机型一个**一致的渲染基线**，减少"同一份代码在不同手机上表现不同"的碎片化（虽然内核自身体版也有碎片）。

---

### 5.4 X5 与 U4 的公开事实

> 只写公开、通用事实，不虚构内部机制；具体 API 行为与版本以实测为准。

**腾讯 X5（TBS → XWeb）**
- 腾讯一直在演进：**TBS（Tencent Browser Service，X5 内核载体）→ 自研 XWeb 内核**。对外叫"腾讯 X5 / XWeb"提供的 WebView 内核能力，广泛接入在微信等腾讯系及大量第三方 App。
- 卖点：内核更新随 App，支持 WebView 部分系统 API 的兼容替换（对外提供 `com.tencent.smtt.sdk.WebView`），含较多 webgl/性能优化与文件/缓存能力。
- 带来的一堆"边界行为差异"：缓存目录、UA 特征、`evaluateJavascript` 兼容层、`console` 调试入口等，见第五节。

**阿里 UC / U4**
- **U4 来自 UC**（阿里系）。UC 浏览器团队多年的 WebKit→自研内核积累，U4 是其中的网页渲染内核，被大量阿里系 App 与部分第三方接入。
- 卖点：移动端渲染/WKWebView 式新特性兼容、省流/弱网优化、banner 广告等 UC 生态能力（接入才谈）。同样有自己的 UA 特征与内核 API 行为。

**共性**：都不是"系统 WebView 换个壳"这么简单，都维护各自内核的 bug、能力、缓存、调试路径——所以"系统 WebView 能跑，X5/U4 不一定"。

---

### 5.5 UA 特征识别：以实测为准的探测

**不要**只靠 UA 字段写死分支——UA 既可能被容器改写，也可能没进。**以实测为准**：先用特征串探测，再**能力探测兜底**。

```js
// 平台：H5 / JS —— 探测代码：特征串 + 能力兜底
const ua = navigator.userAgent || '';
const probe = {
  isX5: /MQQBrowser|TBS\//i.test(ua) || /x5\//i.test(ua),       // 腾讯 X5 常见特征串（实测校准）
  isU4: /UCBrowser|U4_|UCWEB/i.test(ua),                         // UC/U4 常见特征串（实测校准）
  isAppWebView: /(<你App的UA标记>)/.test(ua),                     // 容器自定义标记，让他自己注入
};
// 能力探测兜底（比 UA 更可靠）：能用就用，UA 只当辅助信号
probe.hasEvaluateJS = typeof window.myBridge !== 'undefined'; // 按需写真实探测，这里仅做能力探测思想演示
console.log('内核UA探测', probe, 'UA全串=', ua);
```

要点：
- ⚠️ U A提示：**UA 会被容器改写**，报"为什么 UA 里没有 X5"先问容器加没加。
- **能力探测优于 UA 判断**（阶段 1 讲过）：能跑就以跑为准，UA 只用于归因/打点标记。
- 把上面 `navigator.userAgent` 打印出来放 `console`，一比就知道该设备是什么内核——**这就是"以实测为准"**。

---

### 5.6 接入对前端的影响面

| 影响面 | 系统 WebView | X5 / U4 常见差异（实测为准） |
|---|---|---|
| 渲染差异 | 统一基线相对一致 | 个别 CSS/字体/混合内容表现不同；老内核新特性缺 |
| console | 看 chrome://inspect | 调试入口可能不同，或需 X5 专门调试工具 |
| 缓存目录 | Chromium 标准缓存 | 可能走自家缓存目录/离线包策略 |
| evaluateJavascript 兼容 | 标准 | 返回值/回调可能走兼容层，JSON 解析要重测 |
| JS→Native | addJavascriptInterface 标准 | X5 提供 `com.tencent.smtt.sdk` 的兼容对象，注入姿势要按其 API |
| localStorage | 标准生命周期 | U4/X5 生命周期/清除时机可能不同 |

前端实际影响：**同一份 H5，在系统 WebView、X5、U4 里可能表现不同**。归因步骤固定为：先确认手机上跑的是哪个内核（看 UA/调试工具），再决定是不是"内核差异"而非"你代码问题"。

---

### 5.7 选型权衡表

（这是给"你们的容器/你沟通的客户端同学"看的决策表，前端理解即可，不必自己决策。）

| 维度 | 系统 WebView | X5/XWeb | U4 |
|---|---|---|---|
| 更新来源 | 系统/Play | 随 App | 随 App |
| 一致性 | 依赖系统版本 | 较好（随 App） | 较好（随 App） |
| 兼容替换 | — | 近似系统 API | 近似系统 API |
| 调试入口 | chrome://inspect | 专门工具 | 专门工具 |
| 弱网/省流/CDN | 标准 | 有优化 | 有优化 |
| 生态 | 系统级最稳 | 腾讯系偏多 | 阿里/UC 生态 |
| 对前端透明度 | 相对透明 | 有差异需适配 | 有差异需适配 |

---

### 5.8 坑点清单

| 坑 | 现象 | 根因 | 解法/归因 |
|---|---|---|---|
| 新特性缺失 | CSS/JS 报不支持 | 老内核版本旧 | 看 UA/内核版本，降级或特性检测 |
| localStorage 行为不同 | 存储时而空 | 自家缓存/生命周期差异 | 以实测为准，阶段 5 展开 |
| console 打不出 | 端上日志空 | 调试入口不同 | 用对应内核调试工具 |
| evaluateJavascript 返回值怪 | JSON 解析错误 | 兼容层差异 | 重测返回值，别照系统语义 |
| 桥时通时不通 | window.xxx 偶发 | 注入/兼容姿势不同 | 按其 SDK 注入，前端 ready 判断 |

---

### 5.9 自测题

1. 为什么国内 App 要用 X5/U4 而不是系统 WebView？
2. X5 和 U4 分别是哪家？各自演进到自研内核的名字？
3. 为什么要"以实测为准"来识别内核？UA 判断的局限是什么？
4. 同样的 H5 在 X5 报"localStorage 空"，你会怎么归因？
5. 解释"能力探测优于 UA 判断"。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 无 GMS/系统 WebView 更新不可控、想要更新自主权与统一渲染基线（减少机型碎片化）。
2. X5 是腾讯（TBS→自研 XWeb）；U4 来自 UC（阿里系）。
3. 内核碎片化 + UA 可被容器改写，特征串/行为都要在具体设备上实测，不能照抄文档。
4. 先确认该设备是不是 X5/U4、版本多少，再查其缓存/localStorage 生命周期差异与容器注入；别默认系统 WebView 语义（阶段 5 展开）。
5. 特性能力能跑就以跑为准，UA 只作辅助信号/打点，因为它可被改写且不总能反映真实能力。

</details>

---

### 5.10 小结

国产内核（X5/XWeb、U4）因"无 GMS、更新自主权、统一性"而存在，带来自家渲染/缓存/调试/evaluateJavascript 的差异。识别内核要**以实测为准**，能力探测兜底，别靠 UA 写死分支。至此 Android 侧 Configuration/导航/互调/权限销毁/内核差异五篇收尾，下一阶段进入 iOS WKWebView。

---

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| WebView | Android 里用来渲染网页的组件，相当于"嵌在 App 里的一个浏览器" |
| WebSettings | 一组能力开关，决定页面进壳后 JS、缓存、字体这些到底能不能用 |
| WebViewClient | 管导航和加载的回调代理，页面开始/结束时给你报信 |
| WebChromeClient | 管弹窗、权限、文件选择、全屏等"浏览器窗口级"能力的回调代理 |
| javaScriptEnabled | 是否执行网页 JS 的开关，默认关，不开页面基本是死的 |
| domStorageEnabled | 是否开 localStorage/sessionStorage 的开关，默认关，不开登录态会丢 |
| cacheMode | 指定每次请求走缓存还是走网络的模式开关 |
| LOAD_CACHE_ELSE_NETWORK | "有缓存用缓存"的缓存模式，常导致线上 H5 一直显示旧版本 |
| mixedContentMode | 决定 https 页面里能否加载 http 子资源（图片/接口）的开关 |
| MIXED_CONTENT_ALWAYS_ALLOW | 全盘允许 http 混入 https，引起 SSL 降级的安全红线配置 |
| allowFileAccessFromFileURLs | 是否允许 file 域页面用 JS 跨读其他文件，开了有数据泄露风险 |
| UserAgent | 浏览器上报的身份串，进 App 常被容器追加/篡改，别拿它当唯一判据 |
| textZoom | 只针对正文文本的缩放设置，会和 CSS 字体大小叠加影响 |
| mediaPlaybackRequiresUserGesture | 是否要求用户先点一下才允许音视频自动播放的开关 |
| shouldOverrideUrlLoading | WebViewClient 里的导航裁决回调：返回 false 让 WebView 自己加载，返回 true 表示宿主接管 |
| WebResourceRequest | 新版回调带进来的请求对象，能顺便看到 method（比如是不是 POST）和是否重定向 |
| POST | 表单提交一类带数据的请求，注意它常常绕过 shouldOverrideUrlLoading |
| iframe | 页面里内嵌的另一个网页框架，它内部的导航不一定触发拦截回调 |
| window.open | 开新窗口的 JS 能力，走 onCreateWindow 而不是本回调 |
| scheme | URL 开头的协议部分，比如 http、myapp、tel，用来做路由判断 |
| 白名单 | 提前放行的信任域名/地址清单，导航只允许名单内的通过 |
| onCreateWindow | WebChromeClient 里处理 window.open 新窗口的回调 |
| onBackPressedDispatcher | Activity 里接管"返回键"的入口，让你先处理网页后退 |
| canGoBack / goBack | 判断网页历史还有没有上一页 / 真正往前回退一层的两个方法 |
| history | 网页自己的前进后退历史，和浏览器/表现一致 |
| onPageStarted / onPageCommitVisible / onPageFinished | 页面开始加载、首帧即将上屏、加载完成三个阶段回调 |
| shouldInterceptRequest | 资源级拦截回调，能拦到图片/脚本等，是更完整的安全边界 |
| evaluateJavascript | 原生往页面执行一段 JS 并拿回执的通道，必须在主线程调，返回值是需解析的 JSON 串 |
| loadUrl("javascript:...") | 老办法往页面塞 JS，有长度/转义坑还拿不到返回值，新代码应弃用 |
| addJavascriptInterface | 把原生对象注入成 `window` 上的成员，页面 JS 就能直接调它的方法 |
| @JavascriptInterface | 注入对象方法上的注解，API 17 起必需，不标的方法对 JS 不可见 |
| JavaBridge 线程 | 注入对象方法实际运行的后台线程，不是主线程，碰 UI 要先切回主线程 |
| 主线程（UI 线程） | 负责界面渲染和触摸响应的线程，evaluateJavascript 收发都在这 |
| 注入时机 | addJavascriptInterface 必须在 loadUrl 之前注入，否则页面脚本先跑就拿不到桥 |
| window.AndroidBridge | 注入后页面里能直接调用的全局对象名 |
| ReferenceError | JS 里调用未定义变量时的报错，桥没注入时常看到 |
| JSON.parse | 把 JSON 文本解析成 JS 对象，evaluateJavascript 回执经常要先剥壳 |
| callbackId | 给每次调用编的唯一编号，用于"返回结果时配对到是哪一次调用" |
| JSBridge（桥） | 让 H5 和原生互相调用的整套机制，这篇文章的两座桥是它的原材料 |
| Promise | JS 的异步结果对象，JSBridge 常把它包装起来让调用像 await 一样顺手 |
| 反射漏洞 | 老版本 addJavascriptInterface 能被恶意页面反射调用原生方法的漏洞历史 |
| onJsAlert / onJsConfirm / onJsPrompt | 分别对应页面里 alert / confirm / prompt 三个弹窗的回调 |
| onJsPrompt | prompt 弹窗的回调，因为能传字符串当第二参数，老年代常拿它当"桥"用 |
| onShowFileChooser | 页面 `<input type=file>` 触发的回调，返回 true 才代表接管文件选择 |
| FileChooserParams | 文件选择参数对象，可据此生成拉起系统选择器的 Intent |
| onPermissionRequest | 页面 getUserMedia 申请相机/录音等权限时的回调，按白名单授权 |
| getUserMedia | 网页申请摄像头/麦克风的 JS API |
| onGeolocationPermissionsShowPrompt | 页面 navigator.geolocation 请求定位时的回调，和上者分属两套权限模型 |
| requestFullscreen | 页面请求全屏的 JS 能力，对应 onShowCustomView 处理 |
| destroy() | 主动销毁 WebView 释放内核资源的方法，不调会留引用 |
| removeView | 把 WebView 从父布局上先摘下来，是防泄漏的销毁前置动作 |
| 内存泄漏 | 对象该被回收却被一直拽住，内存越占越多的现象 |
| onTrimMemory | 系统内存吃紧时通知回调，渲染进程可能因此被回收导致白屏 |
| pauseTimers / resumeTimers | 全局暂停/恢复所有 WebView 的 JS 定时器 |
| 多进程 | 容器把 WebView 放到独立进程跑，渲染崩溃不至于拖垮整个 App |
| X5 | 腾讯提供的 WebView 内核，微信等腾讯系 App 常用 |
| U4 | UC（阿里系）的网页渲染内核，U4 是其中一代 |
| TBS | Tencent Browser Service，X5 内核的载体/旧对外名称 |
| XWeb | X5 后续自研的内核名字，对外仍常叫腾讯 X5 |
| 系统 WebView | 手机系统自带的 WebView（System WebView），靠系统/Play 更新 |
| GMS | 谷歌移动服务，无 GMS 的国产机系统 WebView 更新不到 |
| 内核 | 真正负责渲染网页 HTML/CSS/JS 的那套引擎，如 WebKit/Blink |
| 碎片化 | 同一份代码在不同机型/版本表现不一的现象 |
| UserAgent（UA） | 浏览器上报的身份串，可被容器改写，别拿去写死分支判断 |
| 能力探测 | 优先"这个能力能不能跑"来判定，比看 UA 字符更可靠 |
| navigator.userAgent | JS 里读取 UA 的接口，先把它打出来比对是哪个内核 |
| chrome://inspect | 系统 WebView 的调试入口，X5/U4 有各自专属调试工具 |
| MQQBrowser / UCBrowser | UA 里常见的特征串，分别用于识别 X5 和 UC/U4 |
| evaluateJavascript 兼容层 | X5 对浏览器级 JS 注入的兼容实现，返回值和 JSON 可能要重测 |
