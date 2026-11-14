---
title: WebView 本质：内核与架构
date: 2026-11-14
excerpt: "用户点击一个 URL 之后，客户端容器和网络库两条主线同时展开。用三层世界和双网络管道，把 WebView 的内核与架构一次看清。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 2
lang: zh
draft: false
ogImage: /images/webview-and-native/stage1-01-three-layer-dual-pipe.png
---

> 📖 本章由 5 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 0 · 总章：用户点击一个 URL 后，到底发生了什么
- 1 · 内核谱系：为什么 iOS 上没有"第三方内核"，Android 上有
- 2 · 多进程与渲染进程崩溃：为什么"白屏但 App 没死"
- 3 · 三套生命周期对照：网页、Android Activity、iOS ViewController
- 4 · 浏览器 vs Android WebView vs iOS WKWebView 速查表
- 本章术语表

---
## 0 · 总章：用户点击一个 URL 后，到底发生了什么

> 本节是全系列的**上帝视角总览**。目的不是让一条命令一个 API 地学，而是先用一张连贯的图景，把「客户端容器」和「网络库」这两条主线，在"用户点击一个 URL"这个普通不能再普通的事件里，全部串起来。读完全篇，你会暂时拥有一份"心智地图"，后面的章节都是在把这些地点逐个放大、挖深。

---

### 0.1 先抛出问题：四个不同的"点击"

同样是"点了一个链接"，在下面四种场景里，**后续发生的事完全不同**：

| 场景 | 打开方式 | 走路 | 你会直觉地以为 |
|---|---|---|---|
| A | 在手机**系统浏览器**里点 | 浏览器自己开新标签页 | 浏览器全程负责 |
| B | 在**原生 App** 里点一个 H5 链接 | 容器（WebView）接管 | 也以为浏览器全程负责 |
| C | 在原生 App 里点一个**原生按钮** | 原生代码发一个网络请求 | 网络库全程负责 |
| D | 在原生 App 的 H5 页里点一个按钮，去调**原生能力**（相机/登录/取 token） | 先走 WebView 内的 JS，再跨到原生 | 说不清 |

本节把 B 和 C 讲透——**因为绝大多数前端疑惑都出在"我没分清 B 和 C"**：
- B 里的 H5 请求，走的是 **WebView 内置网络栈**；
- C 里的原生请求，走的是 **客户端网络库**；
- 它们是**两条完全独立的管道**。这正是前端最常踩的坑，也是本系列第 6 阶段的主题。

我们从"点击一个在 App 里打开的 H5 链接"开始，把整个过程一层层拆开。

---

### 0.2 三层世界：System / Container / Web

在往下读之前，先在脑里放好这个三层模型。之后所有章节，都是这三层之间的接口和博弈：

![三层世界模型与双网络管道](/images/webview-and-native/stage1-01-three-layer-dual-pipe.png)


关键认知：**用户点击的那个"链接"，对 System 层来说，只是"一次触摸"；对 Container 层来说，是"要不要交给 WebView，以及交给哪个 WebView"；对 Web 层来说，才是一次"网页导航"。** 三层各自解读，各自行动。

---

### 0.3 时间线：一条链接从点击到首屏

我们把"点进一个 H5"拆成 8 大步。这 8 步，每一步都有"归因问题"：**如果这一步慢了/挂了，该查前端、查客户端、还是查网络库？** 这是贯穿全系列的本领。

```
① 触摸                  System 层：手指 Down/Up → 系统判定"这是一个点击"
② 事件分发              Container 层：这个点击落在原生控件上，还是落在 WebView 上？
③ 容器决策              Container 层：判断 URL scheme / 路由表 → 决定用哪个 WebView、开新页面还是复用
④ WebView 创建/复用      Container 层：预热池有现成 WebView 吗？还是要新建内核实例？
⑤ 导航发起              Web 层入口：loadUrl / loadRequest 交给内核
⑥ 网络请求              WebView 内置网络栈：DNS → TCP → TLS → HTTP → 网关 → 响应
⑦ 渲染                  Web 层：HTML 解析 → CSS → JS 执行 → 合成 → 上屏
⑧ 首屏完成              Container 层：页面可交互，埋点/监控上报
```

**注意第⑤步和第⑥步之间**：从"前端发请求"到"拿到响应"，看起来只是一行 `axios.get()`，但内核在网络栈里做的事，和原生网络库是两套东西。第 6 阶段我们会把这层拆到拦截器源码级。

---

### 0.4 第一条主线：Container 层发生了什么

#### 0.4.1 "容器"到底是谁

很多前端把"容器"当成一个抽象概念。准确地说，容器 = **宿主 App 进程里，管理 WebView、桥接原生能力、提供公共基础设施的那一层代码**。它不是一个组件，是一套体系：

- **WebView 组件本身**：Android 的 `android.webkit.WebView`、iOS 的 `WKWebView`（阶段 2、3 展开）
- **WebViewClient / WKUIDelegate 等代理**：决定导航、弹窗、JS 弹窗的行为（阶段 2、3）
- **JSBridge**：注入 `window.xxxBridge`，让 H5 能调原生（阶段 4）
- **容器配置**：UA、Cookie 同步、离线包映射、长列表滚动优化（阶段 5、7）

#### 0.4.2 容器在这个事件里的 4 个动作

**动作 1：URL scheme 路由。** 容器先看链接的协议。如果是 `https://` 或 `http://`，交给 WebView；如果是自定义 scheme（如 `myapp://page/detail?id=1` 或 `weixin://`），可能是"拉起原生页"或"让别的 App 打开"，需要路由表裁决（阶段 2、3、6 都会触及）。

**动作 2：WebView 的复用或新建。** 容器维护一个"WebView 池"。如果只是新开一个普通页面，可能复用；如果是重要页面，可能预热（阶段 7 讲性能）。

**动作 3：注入与初始化。** 在加载前，容器把 JSBridge、公共 JS 脚本、UA 注入进去（阶段 4、6），保证页面一运行就有 `window.xxxBridge` 可用。

**动作 4：生命周期绑定。** WebView 的生命周期跟宿主的 Activity / ViewController 绑定，App 退后台/被杀，WebView 进程状态会变（阶段 1、3）。

> 💡 **一句话记住**：Container 层负责"页面怎么跑起来、能调用哪些原生能力、什么时候被销毁"。**它不管网页的网络请求走哪条路**——那个由 WebView 内置网络栈管。

---

### 0.5 第二条主线：网络库发生了什么

这是前端最容易搞错的部分，单独拎出来重点讲。

#### 0.5.1 两条管道，必须先分清

回看 0.2 节的总图右下部分（[fig/01](/images/webview-and-native/stage1-01-three-layer-dual-pipe.png)）：App 里有**两条并行的网络管道**：

| | 管道一 · 客户端网络库 | 管道二 · WebView 内置网络栈 |
|---|---|---|
| 发起方 | 原生代码 | 网页里的 JS |
| Android | OkHttp（+ 网关封装 / Retrofit / 自研） | Chromium 网络栈（netstack） |
| iOS | URLSession（NSURLSession） | WebKit / CFNetwork |
| 管什么 | 原生页面的接口、上传下载、原生能力调用的后端 | H5 里的 `fetch` / `XHR` / 图片 / CSS / JS 资源 |

**核心事实**：你的 `fetch()` / `axios` / `<img>` 在 H5 里发起的所有网络请求，**全部走管道二**，由 WebView 内核的网络栈完成。**它们默认不会经过客户端的 OkHttp / URLSession，也就不享受统一签名、HTTPDNS、连接池、弱网优化、统一监控这些能力。**

这是本系列最重要的认知之一。记住它，能解释一大堆线上疑难：
- "原生接口都正常，H5 接口偶发 401" → 很可能是 H5 请求没带客户端签名，网关不认。
- "为什么 H5 请求抓不到包 / 不在客户端的网络监控大盘里" → 因为走的是另一条栈。
- "加了 HTTPDNS 怎么 H5 没提速" → HTTPDNS 是加在客户端网络库的，WebView 网络栈默认没接。

（凭什么说"几乎永远走管道二"、有没有例外、怎么让 H5 也走客户端网络库——第 6 阶段完整展开到拦截器源码级。）

#### 0.5.2 一次"管道一"请求的完整链路（提前给个印象）

以 Android OkHttp 为例，一次原生网络请求会依次经过**一连串拦截器**（一个"洋葱"）：

![OkHttp拦截器洋葱模型](/images/webview-and-native/stage1-03-okhttp-onion.png)


第 6 阶段会把 OkHttp 和 URLSession 的这个"洋葱"模型逐层剥开（到源码级），让你能看懂"一条请求到底在客户端网络库内部怎么旋转的"。**现在只要建立印象：这是管道一的地盘。**

#### 0.5.3 这两条管道会不会汇合？会，在"代理"处

两条管道看似井水不犯河水，但在两种位置会汇合：

1. **系统代理 / VPN**：走 Charles/代理抓包时，两条管道都可能被系统代理捕获（但能看到的东西、能解密的程度不同，阶段 5/6 讲）。
2. **容器主动接管 H5 请求**：有的容器用 shouldInterceptRequest（Android）/ WKURLSchemeHandler（iOS）把 H5 请求拦下来，**交给客户端网络库发**，从而让 H5 也享受 HttpClient/网关能力。第 6 阶段讲这个"偷天换日"的方案。

---

### 0.6 一张总图：把两条线合成一张图

![点击URL总流程图](/images/webview-and-native/stage1-02-url-click-flow.png)


这张图记住三件事：
1. **导航由 WebView 内核执行**，网络由 **WebView 内置网络栈**执行；
2. **原生能力（Bridge）**和 **原生网络（管道一）**是两回事，都在 Container 侧，但独立；
3. 前端负责 Web 层，但**决定 H5 能否带签名、能否享受网络优化的是网络栈归属**——归因问题要看它走哪条管道。

---

### 0.7 这套系列会如何带你走完这张图

| 阶段 | 聚焦 | 对应总图位置 |
|---|---|---|
| 0 装备与认知校准 | 搭环境、先自测暴露误解 | — |
| 1 WebView 本质：内核与架构 | 内核谱系、多进程、生命周期 | WebView 内核 |
| 2 Android WebView | 配置、导航、JS↔Native | Container + 内核（Android） |
| 3 iOS WKWebView | 代理、注入、Cookie、进程 | Container + 内核（iOS） |
| 4 JSBridge | H5↔原生通信原理、自研 | 桥接层 |
| 5 Cookie/存储/缓存 | 三套 Cookie、缓存、SW | WebView 网络栈 + 存储 |
| 6 **网络库与真实路径** | **双网络栈、拦截器源码** | **管道一 + 管道二** |
| 7 离线包与容器化 | 请求拦截、预加载、容器能力 | Container 高级 |
| 8 性能 | 启动/白屏/渲染/内存 | 全链路归因 |
| 9 安全与权限 | JSBridge 安全、权限 | 桥接层 + 网络栈 |
| 10 调试与 SOP | 联合调试、排障树 | 全链路定位 |
| 11 拓展与趋势 | 小程序/RN/Electron、Web 演进 | 横向扩展 |

---

### 0.8 动手实验 & 自测题

#### 0.8.1 动手实验（第 0 章 · 建立"归因"直觉）
1. **抓包区分两管道**：准备一个 App（或小程序），分别触发一个「原生页请求」和一个「H5 内 fetch」。用 Charles 看两条请求的 header、User-Agent、发起方，试着分辨哪条是原生发的、哪条是 WebView 发的。
2. **观察导航类型**：在 H5 里打印 `document.referrer` 和 URL，对比「从原生进入」和「WebView 内跳转」时的差异。
3. **找到你的容器 WebView**：在 Android 手机 `chrome://inspect`、iOS Safari 开发者工具里，看看能不能连上你 App 里的 WebView（第 10 阶段会详细教，这里先建立概念）。

#### 0.8.2 自测题
1. 「点了一个 H5 链接后，这个页面的所有网络请求都走客户端网络库 OkHttp/URLSession」——这句话对吗？为什么？
2. 容器（Container）层主要负责哪几件事？它管不管网页的网络请求走哪条路？
3. 判断：下面哪句话暴露了"没分清管道一和管道二"——A"我给客户端网络库加了 HTTPDNS，H5 应该也提速了"；B"我要调相机关原生能力，得走 JSBridge"。
4. 用户点了一个 `myapp://` 开头的链接，容器层第一件事会做什么？
5. "后端要求带签名，否则 401"。你在 H5 里 `fetch` 调后端，默认能带上客户端网络库自动加的签名吗？如果不能，你能想到哪些办法（在阶段 6 之前，先写想法，后面验证）？

<details>
<summary>参考答案（思考后再点开）</summary>

1. **错**。H5 内的 fetch/XHR/图片默认走 **WebView 内置网络栈（管道二）**，不经过客户端 OkHttp/URLSession（管道一）。这是本系列最重要的认知。
2. 容器管：scheme 路由、WebView 池、JSBridge 注入、生命周期绑定、离线包等。**不管**网页请求走哪条路——那由 WebView 内核的网络栈决定。
3. **A**。B 是对的（调原生能力确实走 JSBridge）。A 误以为 H5 请求享受了客户端网络库的 HTTPDNS。
4. 做 **URL scheme 路由**：识别这个 scheme 是"拉原生页/调原生能力/交给另一个 App"，还是"按 http 处理"，然后决定交不交给 WebView。
5. 默认**不能**。可行方向（阶段 6 验证）：容器注入公共 header；H5 请求被 shouldInterceptRequest/WKURLSchemeHandler 拦截后转交客户端网络库补签名；或在 JS 层统一带业务 token。各方案取舍阶段 6 详述。

</details>

---

### 0.9 小结

读完总章，你应该能在脑里把"点击一个 URL"拆成：**System 触摸 → Container 路由与准备 → WebView 内核导航 → WebView 网络栈请求 → Web 渲染首屏**，并且牢牢记住**原生网络库（管道一）和 WebView 网络栈（管道二）是两条独立管道**。

这份心智地图就是后面所有章节的骨架。接下来，我们会先做阶段 0 的环境与认知准备，然后从"内核谱系"开始，把这张图上的每个概念逐个补齐。

---

---

## 1 · 内核谱系：为什么 iOS 上没有"第三方内核"，Android 上有

---

### 1.1 问题引入

线上 H5 出问题时，运营给到一串"安卓机打开白屏、iPhone 正常"。你查了代码没毛病，最后发现是**安卓上的内核不一样**。还有更日常的：同一个 H5，在微信里和在某容器 App 里 `alert` 的样式、`100vh` 的表现完全不同——因为跑的内核根本不同。

这背后的原因是三个字：**内核谱系**。iOS 是"系统内核唯一、随版本走"；安卓是"System WebView + 厂商/第三方内核并存"。要把这个差异讲清，得从 WebKit 的家史讲起。

---

### 1.2 先破误区

> • 误区：Android 和 iOS 都用同一个"浏览器内核"，顶多版本不同。
> • 事实：iOS 只有 WebKit 系独苗（受 App Store 审核指引约束）；Android 上同一个 App 里的 H5，可能跑在 System WebView、X5/XWeb、U4 或厂商自研内核上，且彼此版本差好几个大版本。

> • 误区：WebView 里的 H5 就是"套了个浏览器的页面"。
> • 事实：WebView 是宿主 App 里的一个系统级组件，内核由"系统/厂商/宿主 App 策略"三方共同决定，能力边界由宿主 App 决定，根本不是"浏览器"那么整齐。

---

### 1.3 原理讲解

#### 1.3.1 WebKit 家史：KHTML → WebKit → Blink

内核的分叉史，一句话概括：

```
KHTML（KDE 桌面，开源的 HTML 排版引擎）
   │  2003 年 Apple 从 KHTML 分叉，加入自己的 Cocoa/渲染栈
   ▼
WebKit
   │  2008 Google Chrome 诞生，初期用的就是 WebKit
   ▼  2013 Google 又分叉出 Blink（Chrome 28+ 起）
Blink  ────────────────────► Android 系统 WebView 用它
```

- **WebKit（Apple）**：Safari 的内核。后来 iOS 的各种浏览器不管叫什么名字，内核都是 WebKit 系。
- **Blink（Google）**：从 WebKit 分叉，Chrome 从 28 版起用 Blink；Chromium 内核就是 Blink + V8 引擎的组合。
- **Safari/WebKit** 与 **Chromium/Blink** 由此成为两大家族，虽然同源，但各自演进多年，行为差异越来越大（JS 引擎 V8 vs JavaScriptCore、渲染合成、Cookie/存储策略都不同）。

![WebKit 到 Blink 的分叉史与 Android/iOS 两条内核演化线](/images/webview-and-native/stage1-01-kernel-lineage.png)


> 关键：**"分叉"不只是换了个名字**。2013 年的分叉意味着 Google 从 WebKit 代码库独立出去，之后的渲染、网络、存储实现各自演进，到今天就演成了两条完全不同的技术树。

#### 1.3.2 Android WebView 内核沿革：从"捆绑旧 WebKit"到"可更新的系统组件"

安卓上 WebView 内核的历史，是"内存碎片化"的根源，拆成三个台阶：

| 阶段 | 内核情况 | 后果 |
|---|---|---|
| **4.3 及更早** | 用较老的 WebKit，内核随系统 ROM 捆绑 | 系统不升级，内核就停在旧版 |
| **Android 4.4（KitKat）** | 换用 Chromium/Blink，但是**版本冻结在系统里**，不能单独更新 | 4.4 的 WebView 停留在较旧的 Chromium 版 |
| **Android 5.0+** | **Android System WebView 独立成系统组件**，可经 Google Play 更新 | 系统 WebView 能像 App 一样更新，不再被 ROM 锁死 |

从 5.0 起，事情开始变好：System WebView 能独立更新，较新的版本上它和 Chrome **往往是同代内核**（Chromium），所以"装个 Chrome 顺便把 WebView 也升了"是有道理的。

但这里有个巨大的分岔点——**国内没有 GMS（Google 移动服务）的安卓机**：

- 没有 Play，System WebView **无法通过官方渠道更新**，内核很可能停在出厂或厂商自带的某个旧版本。
- 于是厂商和第三方开始"自己动手"：把另一个内核接进 App，绕开系统 WebView。

这就是「内核碎片化」的完整来由：**同一段 H5，在系统 WebView、X5、U4、厂商内核之间，可能差了好几个大版本**，行为当然对不齐。

#### 1.3.3 国产第三方/厂商内核：X5 → XWeb、U4、厂商自研

| 名称 | 来源 | 说明 |
|---|---|---|
| **腾讯 X5** | 腾讯 | 接入后替掉系统 WebView，曾广泛用于微信生态内的 WebView 业务；统一了大量安卓碎片化问题 |
| **腾讯 XWeb** | 腾讯 | X5 之后演进出的自研内核路线（公开保持住"腾讯在研究替换内核"的表述，内部机制不虚构） |
| **UC U4** | 阿里/UC | 出自 UC 浏览器的自研内核 |
| **华为等厂商自研** | 各手机厂商 | 在 ROM/系统层面提供自己的内核与 WebView 策略 |

（大厂做法这里只讲公开脉络。**不虚构内部机制**：具体接入了哪个内核、能救哪些问题，都要在你自己的 App 里实测确认。）

#### 1.3.4 一句话把三线串起来：内核决定行为，容器决定能力

把三条演化线收拢到本系列的**三层模型**上，你会立刻明白排障该往哪看：

- **System 层**：决定"内核是谁"。iOS 只有系统 WebKit；Android 由系统 WebView / 厂商 ROM 决定，且随更新而变化。
- **Container 层**：决定"页面能用什么能力"。同样的内核，在 A App 里有离线包、有 JSBridge，在 B App 里可能什么都没有——这是容器（壳）在管的。
- **Web 层**：你写的 H5。它**既受内核行为约束，又受容器能力约束**。

所以"这个 H5 为什么在两个 App 里不一样"可能有两种答案：**换内核了**（System 层）或**容器能力不同**（Container 层）。这就是上一章总章的映射：中国 app 里 H5 的差异，一半是 "内核谱系"，一半是 "容器能力"。

> ⚠️ 对前端最重要的实操推论：**写 H5 时不要假设"所有安卓都是一个内核"**。同一个 JS API（比如某个存储配额、某个 CSS 特性）在 A 机上可用、B 机上没有，很可能就是内核不同导致的，不是你的代码错。

#### 1.3.5 iOS：为什么 App 里没有第三方内核

iOS 上之所以没有"第三方内核"之说，根子上是 **App Store 审核指引**要求：浏览器类 App、以及 App 内用于展示网页内容的 WebView，都必须使用系统的 WebKit（WKWebView），不允许自带其他渲染内核。

于是 iOS 的彩蛋只有一个：

- **WKWebView 是 iOS 上唯一的内核入口**；
- 它的内核**随系统版本走**：iOS 升到哪个版本，WKWebView 就是那个版本对应的 WebKit，App 无法自行替换。

这也让 iOS 上的 H5 行为"可预期"得多：你只要对齐"最低支持 iOS 版本"，基本就能锁定行为。2024 年欧盟《数字市场法》（DMA）落地后，浏览器内核的限制政策有松动迹象，但那是另一条战线（关于浏览器 App 能否自带内核），**本系列不展开、也不编细节**——它不改变"in-app WebView 用系统 WebKit"这条主线的现状。

---

### 1.4 代码验证：如何查运行时内核版本

前端排查时经常想知道"这台机器上的 WebView 到底是谁"。两种手段：

#### 1.4.1 Android：看 UA + System WebView 版本

Android 的 UA 里通常会带内核标识。在页面里打印 `navigator.userAgent`：

```javascript
// 前端：打印当前 UA，做初步判断
console.log(navigator.userAgent);
// 常看到的形态示例（不同内核差异明显，仅示意）：
// Android 系统 WebView: Mozilla/5.0 (Linux; Android 13; ...) AppleWebKit/537.36 ... Version/4.0 Chrome/... Mobile Safari/537.36
// 接入 X5 后可能带 V1_ANDROID/... 等特征
// U4 可能带 UCBrowser/... 或 U4/... 特征
```

想要更精确的 System WebView 版本，得看系统设置：`设置 → 应用 → Android System WebView → 版本`。运行时想拿版本，原生侧可以读包信息（System WebView 是一个独立包 `com.google.android.webview`），前端拿不到准确版本号。

#### 1.4.2 iOS：看 UA 里的 Safari/xxx

iOS 的 UA 里能读到对应的 WebKit/JavaScriptCore 版本号，形如：

```
Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1
```

其中 `AppleWebKit/605.1.15` 是 iOS 17 时代的 WebKit 版本标识（各 iOS 大版本不同），`Version/17.4` 对应系统版本。

```javascript
// 前端：解析 UA 看属于哪个内核家族的线索
const ua = navigator.userAgent;
const isiOS = /iphone|ipad|ipod/i.test(ua);
const isAndroid = /android/i.test(ua);
const hasChrome = /chrome|crios/i.test(ua);
const hasUC = /ucbrowser|u4/i.test(ua);
console.log({ isiOS, isAndroid, hasChrome, hasUC });
```

#### 1.4.3 为什么特性检测优于 UA 嗅探

UA 嗅探是"猜内核"，特性检测（feature detection）是"直接问能力"：

```javascript
// 特性检测：直接问"这个特性在不在"，而不是猜是谁
const support = {
  asyncFn: typeof Promise !== 'undefined' && typeof fetch === 'function',
  passive: (function () { let support = false; try {
      document.addEventListener('x', null, Object.defineProperty({}, 'passive',
        { get: () => (support = true) })); } catch (e) {} return support; })(),
  cryptoRandom: typeof crypto?.getRandomValues === 'function',
};
console.log(support);
```

- **UA 嗅探**的问题：UA 可被伪装、可被内核自定义、随版本漂移，而且 Chrome 早已把真实安卓 Chrome 的 UA 统一得像 Safari。靠 UA 判断"能不能用某 API"很容易误判。
- **特性检测**：直接测能力本身，与内核是谁无关，更符合"同一份 H5 多内核兼容"的需求。

**结论**：UA 留作"定位是哪个壳/哪个内核"的排查手段，**别再拿 UA 当"功能要不要降级"的依据**——那该用特性检测。

---

### 1.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 高估内核一致性 | 安卓上同一个 JS/CSS 特性时有时无 | 碎片化内核版本差异 | 用特性检测代替 UA 判断 |
| 误以为 4.4=Chromium 新 | WebView 行为老旧 | 4.4 的 Chromium 版本被冻结 | 以实测为准，别想当然 |
| 无 GMS 机的更新盲区 | System WebView 永远停在旧版 | 没有 Play、无法更新 | 走厂商升级/自建内核方案前先确认目标机型 |
| 把 iOS UA 当三端都适用 | 同一 UA 逻辑在 iOS 表现怪 | iOS UA 与安卓差异大 | 单独处理 iOS 的 WebKit 分支 |

---

### 1.6 自测题

1. WebKit 到 Blink 的分叉发生在哪个时间点、由谁发起？分叉后两条线各自代表谁？
2. Android 4.4 之前用什么内核、4.4 换成什么、为什么 5.0 是个转折点？
3. "国内安卓没有 GMS"和"内核碎片化"是什么因果关系？
4. 为什么 iOS 上几乎没有第三方内核？前端排查时可以怎么利用这一点？
5. 动手题：在你的手机浏览器和某个 App 的 H5 里分别打印 `navigator.userAgent`，对比差异，试着判断各是什么内核家族。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 2013 年，Google 从 WebKit 分叉出 Blink，Chrome 28+ 起使用。WebKit 代表 Apple/Safari/iOS 系；Blink 代表 Google Chrome/Chromium/安卓 System WebView 系。
2. 4.4 之前用旧 WebKit；4.4 换成 Chromium 但版本冻在系统里；5.0 开始 Android System WebView 独立成可经 Play 更新的系统组件，内核开始能跟进。
3. 没有 GMS → System WebView 无法经 Play 更新 → 系统内核停在旧版 → 厂商/第三方自建内核（X5/XWeb、U4 等）分流 → 同一 H5 在不同 App 里内核版本不一致 = 碎片化。
4. App Store 审核指引要求浏览器类/in-app 浏览用系统 WebKit，WKWebView 内核随 iOS 版本走、App 不可替换。所以 iOS 上 H5 只需对齐最低支持 iOS 版本即可预期。
5. 观察 `AppleWebKit/`、`Version/`（iOS）、`Chrome/`、`V1_ANDROID`（X5）、`UCBrowser/U4` 等特征。

</details>

---

## 2 · 多进程与渲染进程崩溃：为什么"白屏但 App 没死"

---

### 2.1 问题引入

用户反馈"进你们那个 H5 活动页，屏幕全白，只能杀掉 App 重开"。客户端同学查了崩溃平台：**没有崩溃记录**。前端查了错误监控：**页面 JS 没报错**。最后水落石出：是 WebView 的 **WebContent 进程被系统回收**了——页面没死、App 没死、什么监控都没报警，但内容没了。

### 2.2 先破误区

> • 误区：WebView 里的页面是"App 的一部分"，页面出事 = App 出事。
> • 事实：主流 WebView 的页面内容跑在独立进程里。内容进程崩了/被杀，表现是白屏——App 主进程不知道自己受伤了，所以崩溃平台无感、JS 错误监控也无感。

> • 误区："白屏"就是"加载失败"或"App 闪退"，反正都一样处理。
> • 事实：这是三种不同的故障。三分法记好：进程被杀 ≠ App 闪退 ≠ 加载失败，归因方向完全不同（见本节 2.4 节的归因对照表）。

### 2.3 原理讲解

#### 2.3.1 铺垫：浏览器的多进程模型

现代手机浏览器（Chrome/Safari 系）普遍采用多进程架构，目的是**隔离**：一个标签页失控不要拖垮整个浏览器：

| 进程 | 职责 |
|---|---|
| **浏览器主进程** | 管理 UI（地址栏/标签页）、下载、权限弹窗；调度其他进程 |
| **渲染进程** | 跑每个标签页的 HTML/CSS/JS，产出到位图/合成层 |
| **GPU 进程** | 合成与上屏 |
| **网络进程** | HTTP 栈、Cookie、缓存 |

一个标签页的渲染进程崩了，浏览器显示"哎呀崩溃了"并允许重载，其他标签不受影响。

#### 2.3.2 WebView 的进程表现：iOS WKWebView

WKWebView 不是"塞进 App 里的迷你浏览器"，它的架构是**进程外**的：

- 你的 App 进程里只有 WKWebView 这个"外壳控件"和代理回调；
- 真正解析和执行网页的 **WebContent 进程**是独立的 WebKit 进程，由系统统一调度；
- GPU、网络等辅助进程也由系统 WebKit 统一管理。

```
你的 App 进程                          系统 WebKit 侧
┌──────────────────┐                ┌──────────────────────┐
│ ViewController   │                │ WebContent 进程       │
│  └ WKWebView控件  │ ◄── 消息/IPC ──►│  （跑你的 HTML/JS）   │
│  └ 容器/Bridge   │                │ GPU / 网络等辅助进程   │
└──────────────────┘                └──────────────────────┘
     App 没死                          这里挂了 = 白屏
```

![手机浏览器多进程结构 vs WKWebView 的进程结构与崩溃影响面](/images/webview-and-native/stage1-02-process-model.png)


要点：

- **WebContent 进程崩溃/被杀 → 白屏，但 App 没死**。这正是"用户说白屏、崩溃平台干净"的原因。
- **较新的系统版本**上，iOS 对**每个 App 同时可用的 WebContent 进程数有上限**，并使用**进程池复用**（同一 App 里多个 WKWebView 可能共用 WebContent 进程）——一个页面把进程搞挂，可能殃及同 App 其他 WKWebView。具体阈值随系统版本演进，**以实测为准**，但"进程有上限、会被复用"这条认知是稳定的。

#### 2.3.3 WebView 的进程表现：Android

Android 侧的进程模型因**内核碎片化**（上一节）而复杂：

| 内核 | 进程表现 |
|---|---|
| System WebView（Chromium 系） | 多进程架构，渲染进程与宿主 App 分离；较新系统版本起渲染进程与浏览器类似 |
| 老版本/某些定制 ROM | 可能运行在宿主 App 进程内（单进程模式），行为差异很大 |
| X5 / XWeb / U4 等第三方内核 | 各自实现，进程策略由内核决定，公开资料不说细节 |

**吃不准就别硬写**：不同内核版本在"渲染进程是否独立、崩溃是否牵连 App、崩溃后能否自动恢复"上行为不一，结论一律**以实测为准**。下面给一个验证思路。

再补充一个镜像有助于建立直觉：**既然"内容死 ≠ App 死"，反过来"App 崩 ≠ 页面错"也成立**。有些线上 case 看着像 H5 挂了，其实是宿主 Activity 被重建、容器把 WebView 一起销毁重建了——页面本身没崩，是"宿主换了一次壳"。要分清"谁先倒的"，就得同时看宿主日志和渲染进程日志，别只盯前端。

#### 2.3.4 代码验证（实验性质，别带上线）

> 以下代码**仅用于本地实验**验证进程独立性，目的是"亲手触发一次白屏、观察 App 是否还活着"。思路是借一个可控崩溃点让内核自杀。

**Android（Kotlin）· 验证"渲染出事 ≠ App 崩"：**

```kotlin
// 平台：Android（实验代码）。粘贴进带 WebView 的最小工程。
// 思路：在 H5 里触发一次"内存暴涨"，观察 WebView 白屏而宿主 Activity 仍在。
webView.webViewClient = object : WebViewClient() {
    override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        // 较新的 System WebView：渲染进程阵亡会走到这里
        Log.e("ProcTest", "render process gone, didCrash=${detail?.didCrash()}")
        // 返回 true 表示宿主自行处理（重建 WebView），false 可能导致 App 也崩
        return true
    }
}
```

```javascript
// 配套 H5（实验代码）：按钮点击后猛分配内存，模拟渲染进程被压垮
document.getElementById('boom').onclick = () => {
  const junk = [];
  setInterval(() => { junk.push(new Array(1e6).fill('x')); }, 50); // 快速耗尽内存
};
```

装上后点按钮，观察：白屏了但 Activity 还能点返回、log 里打出了 `render process gone`，就验证了"内容进程死、App 活"。

**iOS（Swift）· 验证 WebContent 进程被杀：**

```swift
// 平台：iOS（实验代码）。粘贴进带 WKWebView 的最小工程。
class VCV: UIViewController, WKNavigationDelegate {
    var webView: WKWebView!
    override func viewDidLoad() {
        super.viewDidLoad()
        webView = WKWebView(frame: view.frame)
        webView.navigationDelegate = self
        view.addSubview(webView)
        // WebContent 进程终止时回调（不同系统版本行为有差异，以实测为准）
        // 常见的验证方式：在 H5 里制造崩溃/被系统回收，观察此处是否回调，以及页面是否白屏
        webView.addObserver(self, forKeyPath: "title", options: [], context: nil)
    }
    // 白屏自愈的思路（阶段 3/8 展开）：检测到进程终止后重建 WKWebView 并重载
}
```

（iOS 侧更完整的进程终止检测回调与自动重载实现，属于阶段 3「崩溃与恢复」的正文，本节不展开，只立"白屏 ≠ App 崩"这个认知。）

**验证核对清单：**

- [ ] Android：H5 触发内存暴涨 → 白屏 → App 未闪退、可返回
- [ ] Android：Logcat 出现渲染进程退出日志
- [ ] iOS：WebContent 被杀 → 白屏 → App 仍在前台、无崩溃日志
- [ ] 两端：进程恢复后页面**不会自己好**——要么白屏到底，要么容器代码重载

### 2.4 归因对照表：三分法

| 故障 | 现象 | 崩溃平台 | 前端 JS 监控 | 典型根因 | 归因 |
|---|---|---|---|---|---|
| **进程被杀**（WebContent/渲染进程回收） | 白屏、容器还在、能交互 | **无记录** | **无记录** | 内存压力、系统回收、内容异常 | 容器/系统侧 |
| **App 闪退**（宿主进程崩） | App 直接退到桌面 | **有记录** | 帧中断 | 客户端代码 bug、OOM 杀 whole App | 客户端侧 |
| **加载失败** | 白屏/错误页，网络或状态错误 | 无 | 可能有 | URL 404、DNS 失败、JS 首屏报错 | 前端/网络侧 |

记住这个口诀：**崩溃平台干净 + 用户说白屏 → 先怀疑进程被杀，而不是线上代码崩了**。

### 2.5 白屏自愈（点到为止）

思路一句话：容器代码检测到渲染进程终止（或定时探测"DOM 是否真的画出来了"），**重建 WebView 并重载**当前 URL；配合预热池让重载体验尽量无感。完整方案（探测时机、重载次数上限、上报、休眠恢复），**阶段 3 / 阶段 8 展开**。

### 2.6 前端能感知什么

想在前端代码里感知"我的进程是不是出事了"？能力非常有限：

- `visibilitychange` / `pageshow`：只能区分"前台/后台/回到前台"，**无法区分"正常回前台"和"进程死后全新启动"**——被杀后重启加载的页面也会触发一遍正常加载事件序列。
- `window.onerror`：进程被杀时，你的 JS **整个都死了**，压根来不及上报。

也就是说：**前端在"进程级故障"面前几乎是盲的**，靠页面内代码保自己，是保不住的。真正的白屏自愈必须由容器（客户端代码）承担。下一节讲生命周期时，会把这个局限讲得更具体。

### 2.7 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 只信崩溃平台 | 用户反馈白屏但平台无记录 | 进程被杀不算"App 崩溃" | 白屏要独立埋点，别指望崩溃平台 |
| 把白屏当加载慢 | 加 loading 转圈，无尽头 | 内容进程已死，永远等不到 | 容器侧做白屏探测与重载自愈 |
| 前端想自保 | 页面里加 try/catch 想兜底 | 进程死了 JS 没了 | 认清局限，推动容器侧自愈 |
| Android 实现一刀切 | 以为所有机型行为一致 | 内核碎片化 | 按"以实测为准"验证目标机型 |

### 2.8 自测题

1. 现代浏览器的四种典型进程分别管什么？为什么隔离？
2. iOS WKWebView 的 WebContent 进程被杀，用户看到什么？崩溃平台上有记录吗？
3. "进程被杀 ≠ App 闪退 ≠ 加载失败"三分法，各自归因方向是什么？
4. 为什么前端 `window.onerror` 在"进程被杀"这种故障里发挥不了作用？
5. 动手题：在 Android 最小工程里运行本节 2.3.4 的实验代码，亲手触发一次白屏，观察 Logcat 与崩溃平台记录，写一句结论。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 浏览器主进程管 UI/下载/权限，渲染进程跑各标签页的 HTML/CSS/JS，GPU 进程负责合成与上屏，网络进程管 HTTP 栈/Cookie/缓存。隔离是为了一个标签页失控不拖垮整个浏览器。
2. 白屏；崩溃平台无记录（App 主进程没死，不产生崩溃上报）。
3. 进程被杀 → 容器/系统侧，看进程状态与容器日志；App 闪退 → 客户端侧，看崩溃平台；加载失败 → 前端/网络侧，看请求与 JS 错误。
4. 进程被杀时该页面里的 JS 运行环境整个没了，任何页面内代码（包括错误上报）都不再执行。
5. 结论应类似："渲染进程退出 → 白屏，宿主 Activity 仍在，Logcat 出现渲染进程退出日志，崩溃平台无记录"。

</details>

---

## 3 · 三套生命周期对照：网页、Android Activity、iOS ViewController

---

### 3.1 问题引入

H5 页被切到后台一会儿，回来时用户看到的却是**从头重新加载**——你以为"回到前台"就只是 `visibilitychange`，结果整个页面都变了。这类"状态丢失"问题，根子在于：**你的页面生命周期是宿主生命周期的投影**，而前后台切换、进程被杀、宿主销毁，对页面是三种完全不同的命运。

### 3.2 先破误区

> • 误区：页面只要在前台，就一直是同一个"活着"的页面。
> • 事实：被切后台时，页面可能还在（挂在后台进程），也可能直接被系统杀了（回收内存），回来后是个全新文档。`visibilitychange` 只会跟你解释"我切走了/回来了"，不会告诉你"我死了又重生的"。

> • 误区：返回键/手势返回就是页面里的 `history.goBack()`。
> • 事实：容器有自己的返回机制（Android 的 `canGoBack`、iOS 的边缘滑动），走的是"回到上一个 WebView 历史条目"，跟浏览器 history 是两个层面。不处理好，会出现"按返回想退出 App 却一直退网页"或反过来。

### 3.3 三套"生命周期"对照表

前端的花样最多，最容易和客户端对齐错位。下表"三泳道"对上：

#### 3.3.1 网页生命周期 ↔ Android ↔ iOS

| 时序 | **网页（Web）** | **Android（Activity）** | **iOS（ViewController）** |
|---|---|---|---|
| 准备/创建 | `DOMContentLoaded`→`load` | `onCreate` | `viewDidLoad` |
| 可见/可交互 | `pageshow` + `visibilitychange(visible)` | `onResume` | `viewWillAppear` |
| 失去前台/离开 | `visibilitychange(hidden)` → `pagehide` | `onPause` | `viewDidDisappear` |
| 内存吃紧 | ——（无明显事件） | `onTrimMemory` | `didReceiveMemoryWarning` |
| 销毁 | `pagehide`（被卸载时） | `onDestroy` | 视图被释放 |

![网页/Android/iOS 三泳道生命周期状态机与对齐时机](/images/webview-and-native/stage1-03-lifecycle.png)


**最关键的对应**：

- Android `onResume` ⇌ 页面 `pageshow + visibilitychange(visible)` —— 每次回到前台都会对齐一次；
- iOS `viewWillAppear` ≈ "回到前台"，`viewDidDisappear` ≈ "离开前台"；
- `onTrimMemory` / `didReceiveMemoryWarning` 是内存压力的信号，**前端没有直接对应事件**——这往往是"后台被杀"的预警。

为什么要专门记住 `onTrimMemory` / `didReceiveMemoryWarning` 这一行？因为它和上一节的"进程被杀"直接相连：宿主收到内存压力，往往是系统开始回收后台进程、回收 WebContent 进程的前兆。前端收不到这一行事件，所以当内存紧张导致你的页面被后台回收时，**没有任何前端日志**能提前告诉你——你只能靠结果（回来时 `pageshow.persisted=false`）反推。这也再次印证：内存高压之下的"复活史"，页面代码自己是看不见的，得靠容器/系统侧去打点。

### 3.4 返回键 / 手势返回：`history.goBack()` vs 容器返回

#### 3.4.1 Android：onBackPressedDispatcher + canGoBack

返回键默认行为是"退出当前页面"，在 WebView 场景通常期望是"先回退网页"。经典写法：

```kotlin
// 平台：Android（Kotlin）。粘贴进 onCreate，接管返回键交给 WebView 历史。
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // webView 是需要注入过 WebViewClient 的 WebView
    onBackPressedDispatcher.addCallback(this) {
        if (webView.canGoBack()) {
            webView.goBack()            // 回退到 WebView 历史里上一条
        } else {
            isEnabled = false           // 没有网页历史了，放行给默认行为（退 Activity）
            onBackPressedDispatcher.onBackPressed()
        }
    }
}
```

理解：`webView.canGoBack()` 问的是 **WebView 内部的历史栈**（这个 WebView 加载过的导航链），和 Html 里 `window.history` 不是同一粒度，但都能"回上一页"。前端调 `history.goBack()` 走的是页面内部；容器调 `canGoBack()/goBack()` 走的是容器对 WebView 状态的控制——**两者要区分**。

#### 3.4.2 iOS：边缘滑动 = 系统手势，WebView 有 backForwardList

iOS 的"返回"主要是**右缘左滑**的系统手势，它退的是导航控制器的栈。WKWebView 自身维护 `backForwardList`（backList/forwardList），前端页内 `history.goBack()` 对应 WebView 的内部历史；容器的边缘滑动退的是"VC 栈"——先退哪个，取决于这条手势交给了导航控制器还是 WebView。

**结论**：不要假设"用户按返回 = 我页面 history 里退了一条"。要不要监听/干涉返回，属于容器策略，前端更多是**被动感知**（收到 `pagehide`/切后台）。

### 3.5 App 切后台/切回、进程被杀后恢复

#### 3.5.1 Android：Activity recreate 的现实与坑

- 系统回收内存时可能**杀掉整个（后台）App 进程**。用户再回来，Android 用记录的 `SavedState` 把 Activity **重新 create**——但注意：
  - Activity 会重建，**但 WebView 是不保证把各个 H5 状态都还原的**；
  - WebView 若想让导航状态存活到进程重启，要靠 `saveState/restoreState`（但**在单独进程/新进程里经常不完全可靠**），很多坑也源于此。
- 所以"进程被杀后回来是新文档"并不罕见——**这就是开头那个"回到前台从头加载"的真身**。

#### 3.5.2 iOS：系统决定，App 难以完全掌控

iOS 进程中状态由系统管理，被挂起后系统可能回收 App 的内存或直接终止。iOS 的恢复机制（`application:didFinishLaunching` 时根据 `stateRestorationIdentifier` 尝试恢复 UI）对 WKWebView 的状态还原支持也**有限**——文章里读完你要建立的认知：**无论两端，进程级死亡后"原地续命"都不该指望，前端要主动做状态保存**。

#### 3.5.3 对 H5 状态保存意味着什么

- 前端不能赌"切后台再回来，我还活着、我还是我"。
- 实用实践：
  - 用 `sessionStorage` 保存"本次会话里的临时状态"（切后台被杀了 sessionStorage 在进程重建后不保证还在，所以关键数据要尽早落 `localStorage` 或进服务端）；
  - 在 `pageshow` 里判断 `event.persisted`：`true` 表示这次是 bfcache 恢复（文档还是旧的那个）；`false` 表示**全新加载**（我在前台的上一版可能已被杀）。

```javascript
// 前端：pageshow 恢复实践的关键判断
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    // bfcache 恢复：同一个文档、状态应该还在
    restoreLocalUI();
  } else {
    // 全新加载：我在后台可能死过，重新拉状态
    console.log('这是新加载，persisted=false');
    rebuildState(); // 从 localStorage / 接口恢复
  }
});
```

- `visibilitychange` 适合做"切后台时保存草稿、回来时恢复"的轻量响应，但**救不了进程死亡**——那必须依赖持久化。

#### 3.5.4 前端到底能感知多少：粒度对照

把上面的讨论收成一张"前端可感知度"的小表，排障时对照用：

| 事件 | 表示什么 | 能区分"进程死了重新加载"吗 |
|---|---|---|
| `visibilitychange` | 前台/后台切换 | 不能 |
| `pageshow` | 一次显示开始 | 部分是（看 `persisted`） |
| `pagehide` | 一次显示结束/被卸载 | 不能（后台被杀往往来不及 fire） |
| `DOMContentLoaded`/`load` | 文档解析/资源加载 | 不能（进程重建后也会正常触发） |
| `window.onerror`/unhandledrejection | JS 运行期异常 | 不能（进程死了整套 JS 都停了） |

所以一句话贯穿本系列：**前端的生命周期事件是"宿主/系统状态的一面镜子"，但镜子上有一段"看不清的死区"**——进程被杀不在这面镜子里。凡涉及"进程级"生命周期，都要到客户端（容器）层去挂检测与自愈，而不是指望页面代码。

### 3.6 手把手代码验证：把宿主生命周期打到页面上

下面双端各给一个"生命周期注入页"的最小思路，让你在一张 H5 里直接看到宿主事件何时来、对齐关系是否如 §3.3 所示。完整可贴文件放在 demo（见文末）。

**Android（Kotlin）· 宿主事件 → evaluateJavascript 上报页面：**

```kotlin
// 平台：Android（Kotlin）。在 WebView 的宿主 Activity 里，把生命周期事件发进页面。
// 依赖注入：webView.settings.javaScriptEnabled = true

override fun onResume() {
    super.onResume(); webView?.onResume()
    // 用 evaluateJavascript 调用页面预设的全局函数
    webView?.evaluateJavascript("window.__lifeOnHost && window.__lifeOnHost('Android onResume')", null)
}
override fun onPause() {
    super.onPause(); webView?.onPause()
    webView?.evaluateJavascript("window.__lifeOnHost && window.__lifeOnHost('Android onPause')", null)
}
override fun onDestroy() {
    super.onDestroy()
    webView?.destroy() // 记得销毁，避免泄漏
}
override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    webView?.evaluateJavascript("window.__lifeOnHost && window.__lifeOnHost('onTrimMemory level=$level')", null)
}
```

**iOS（Swift）· 宿主事件 → evaluateJavaScript 上报页面：**

```swift
// 平台：iOS（Swift）。在持有 WKWebView 的 ViewController 里发送生命周期事件。
import UIKit
import WebKit

class LifecycleVC: UIViewController {
    var webView: WKWebView!
    override func viewDidLoad() {
        super.viewDidLoad()
        webView = WKWebView(frame: view.frame)
        view.addSubview(webView)
        webView.load(URLRequest(url: URL(string: "https://example.com/lifecycle-probe.html")!))
        // 初次加载完成后再调用 JS，见 demo 里的 ready 处理
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        callJS("iOS viewWillAppear")
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        callJS("iOS viewDidDisappear")
    }
    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        callJS("iOS didReceiveMemoryWarning")
    }
    private func callJS(_ msg: String) {
        let js = "window.__lifeOnHost && window.__lifeOnHost('\(msg)')"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}
```

**H5（JavaScript）· 一个能"接住"宿主事件的探针页顶栏：**

```javascript
// Web 侧：全局函数 + 把网页生命周期也画上去，两条线一起看对齐
window.__lifeOnHost = (msg) => append(`[HOST] ${new Date().toLocaleTimeString()} · ${msg}`);
window.addEventListener('pageshow', () => append('[WEB] pageshow'));
window.addEventListener('pagehide', () => append('[WEB] pagehide'));
window.addEventListener('visibilitychange',
  () => append(`[WEB] visibilitychange → ${document.visibilityState}`));
document.addEventListener('DOMContentLoaded', () => append('[WEB] DOMContentLoaded'));
function append(text) {
  const el = document.getElementById('log');
  el && (el.innerHTML += `<div>${text}</div>`);
}
```

切后台/切回、多开几个页面来回进，日志会诚实地把"三条泳道怎么对齐"画出来——**这就是上一节说的：`pageshow(persisted=false)` 会在进程重建时出现，而你不会在页面上看到任何"我被杀了"的日志**。

---

> 📦 **可与本节配套运行**：`demo/stage-1-essence/` 下有最小可跑的 `LifecycleLoggerAndroid.kt`、`LifecycleLoggerIOS.swift`、`web/lifecycle-probe.html`。照 README 拼装即可复现上面的对齐日志（见本节 3.8 动手题）。

### 3.7 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 把 lifecycle 当"内存回收协议" | 后台回来从头加载 | 进程被杀+重建 | `pageshow.persisted` 判断 + 持久化 |
| 返回键乱象 | 一直退网页退不出 App | 那把 `canGoBack` 默认交给了 WebView | 按本节 3.4.1 分流 |
| 只存 sessionStorage | 后台被杀回来数据没 | sessionStorage 随会话/进程 | 关键数据落 localStorage/服务端 |
| 以为 iOS 能恢复 WebView 状态 | 恢复后页面不对 | 系统恢复对 WKWebView 支持有限 | 前端自保存、容器重建重载 |

### 3.8 自测题

1. 网页的 `pageshow` 与 Android `onResume`、iOS `viewWillAppear` 的大致对应关系是什么？
2. `event.persisted === true` 和 `false` 分别代表什么？
3. Android 返回键想"先回退网页再退 Activity"，应该怎么判断和分流？
4. 进程被杀后回来，前端靠 `visibilitychange` 能发现吗？为什么？
5. 动手题：用 `demo/stage-1-essence/` 的双端探针，切后台/切回各 3 次，把 H5 首页日志截图，标出"哪几次是 bfcache 恢复、哪几次是全新加载"。

<details>
<summary>参考答案（思考后再点开）</summary>

1. Android `onResume` / iOS `viewWillAppear` ⇌ 页面回到前台时的 `pageshow + visibilitychange(visible)`，大致同时发生，都是"回到前台"的对齐点。
2. `true` = bfcache 恢复，还是同一个文档、状态应还在；`false` = 全新加载（很可能我在后台死过或被销毁重建）。
3. 用 `onBackPressedDispatcher` 拦截,`if (webView.canGoBack()) webView.goBack()` 否则放行让 Activity 退栈。
4. 发现不了——页面还没轮到执行 JS 时进程已经没了，回来是全新文档会正常触发一次 `pageshow`，页内无从知晓自己"死过"。
5. 观察 `pageshow` 的 `persisted` 值与是否出现同步的宿主事件即可归类。

</details>

---

## 4 · 浏览器 vs Android WebView vs iOS WKWebView 速查表

---

### 4.1 问题引入

面试或排障时总会卡在"浏览器和 WebView 到底差在哪"——答案散落前几篇，本文浓缩成一张表，方便收藏备忘。

### 4.2 先破误区

> • 误区：WebView 就是"裁剪版浏览器"。
> • 事实：WebView 是系统级组件，由宿主 App 决定行为边界，没有地址栏、标签、书签这些"浏览器产品能力"，但保有完整的内核和网络栈。

### 4.3 大速查表

| 维度 | 手机浏览器 | Android WebView | iOS WKWebView |
|---|---|---|---|
| 定位 | 独立 App，产品形态 | 系统/第三方内核组件 | 系统 WebKit 组件 |
| 地址栏 | 有 | 无（宿主决定 UI） | 无（宿主决定 UI） |
| 多标签 | 有 | 无自带标签概念，一 View 一内容 | 同左 |
| 书签 | 有 | 无 | 无 |
| 扩展 | 部分支持 | 无 | 无 |
| 密码自动填充 | 自带账号体系 | 跟随系统输入法/宿主集成度 | 系统级自动填充，宿主控制 |
| 下载管理 | 自带 | 无，需容器接管（下载回调） | 无，靠宿主处理 |
| 打开新窗口 `target=_blank` | 开新标签 | 默认不响应，需 `WebChromeClient.onCreateWindow` 处理 | 默认不响应，需实现 `WKUIDelegate` 的 `createWebViewWith` |
| HTTPS 指示与证书错误页 | 有 UI 与"继续访问" | 无 UI，走 `WebViewClient.onReceivedSslError` 自定义 | 无指示页，走 `decidePolicyFor` / `didFailProvisionalNavigation` |
| 权限弹窗样式 | 浏览器自己的弹窗 | 系统权限弹窗 + `WebChromeClient.onPermissionRequest` | 系统权限弹窗 + `WKUIDelegate` 相关代理 |
| 自动播放策略 | 有限制（可配置） | 跟内核，默认音频/视频需手势 | 默认需手势，`mediaTypesRequiringUserAction` 可调 |
| 自动更新节奏 | 应用商店随浏览器更新 | System WebView 可 Play 更新（无 GMS 困难）；第三方内核随 App 发版 | 随 iOS 系统版本，不可独立更新 |
| 多进程与崩溃面 | 主/渲染/GPU/网络多进程，标签互不影响 | 因内核而异，System WebView 较新版本多进程 | WebContent 独立进程，崩溃=白屏，App 没死 |
| Cookie 与存储共享 | 浏览器内部隔离自己管 | 跟随 CookieManager；跨宿主互不相通 | `WKHTTPCookieStore`，进程间有同步时序 |
| UA 特征 | 明确的浏览器 UA | 可被容器重写，`Chrome/xxx` 等特征 | `AppleWebKit`+`Version/`，容器可加后缀 |
| 调试方式 | 远程调试本浏览器 | `chrome://inspect`（X5/U4 有各自方案） | Safari 开发菜单远程检查 |
| 缓存清空入口 | 浏览器设置里 | `WebView.clearCache()` 系统设置清 App 数据 | `WKWebsiteDataStore` API / 删 App |
| 内核可替换 | 无 | 有（X5/XWeb、U4 等可接入） | 无（审核指引限定系统 WebKit） |

### 4.4 怎么用这张表

1. **归因**：排查问题时先问"现在这个页面跑在三列里的哪一列？"——同一行不同列的答案就是行为差异的来由（例如 `target=_blank` 在浏览器、安卓 WebView、iOS WKWebView 中的三种不同下场）。
2. **沟通**：和客户端同学提需求时，直接点"哪一列"对应的能力（如"iOS 上需要你实现 `WKUIDelegate`，否则 `target=_blank` 没反应"），能做到精确对齐。
3. **自检**：写兼容代码前，对照"自动播放策略""新窗口""HTTPS 错误页"这些差异行做特性检测，而不是 UA 猜测——尤其是能被容器重写的 UA。

### 4.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 按浏览器想象 WebView | 以为有地址栏、多标签 | 形态完全不同 | 一切以宿主实现为准 |
| `target=_blank` 没反应 | 点了没动静 | 双端默认都不响应 | 补容器处理 |
| 期待证书错误页 | 出错只白屏 | WebView 无 UI 层 | 监听对应回调自行处理 |
| 期望系统管密码/下载 | 用户填不了/没反应 | 浏览器才有独立管理 | 由容器对接系统能力 |

### 4.6 自测题

1. 浏览器、Android WebView、iOS WKWebView 三者在"打开 `target=_blank`"上的默认表现各是什么？
2. 为什么"缓存清空入口"在三种环境里完全不同？
3. 举一个"该差异来自系统权限弹窗 + 容器代理两层组合"的维度。
4. 动手题：挑一个你负责过的 H5 页，对照本表逐行体检一遍，标出有没有踩过"以为一样"的坑。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 浏览器开新标签；Android WebView 默认不响应（需 `onCreateWindow`）；iOS WKWebView 默认也不响应（需实现 `WKUIDelegate` 的 `createWebViewWith`）。
2. 因为三者的存储体系不同：浏览器有自己的设置入口；Android WebView 在 WebView 层用 `clearCache` 或清 App 数据；iOS 通过 `WKWebsiteDataStore` API 或卸载应用。
3. "权限弹窗样式"：系统级权限弹窗是三者共享的外观，但发起侧要分别通过 `WebChromeClient.onPermissionRequest`（Android）或 `WKUIDelegate` 相应代理（iOS）转接，浏览器则由自己发起。
4. 答案因人而异，典型发现如"没用过 `WebViewClient.onReceivedSslError`、一直以为系统会弹证书错误页"。

</details>

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| WebView | 嵌进 App 里、渲染网页并执行 H5 的系统组件，不是完整浏览器 |
| 容器（壳） | 管理 WebView、注入 JSBridge、提供路由/登录/离线包等公共设施的那层客户端代码 |
| 内核 | WebView 底层负责解析渲染的那套引擎（Android 多源、iOS 统一 WebKit） |
| 三层模型 | 一次"点击"经过的三层：System（OS/触摸）→ Container（壳）→ Web（网页） |
| 管道一 · 客户端网络库 | 原生请求走的网络栈：Android OkHttp / iOS URLSession + 网关封装 |
| 管道二 · WebView 内置网络栈 | H5 里 fetch/XHR/图片默认走的网络栈：Chromium netstack / WebKit |
| 桥（JSBridge） | H5 与原生互调能力的中介设施（阶段 4 深入） |
| URL scheme | 链接的协议段，如 `https://` 或 `myapp://`，容器据此决定交给谁 |
| 生命周期 | 页面/Activity/ViewController 各自"出生到销毁"的状态时序 |
| 渲染进程 | 负责把网页画出来的进程，被回收会"白屏但 App 没死" |
| 归因 | 判断某段卡/挂该查前端、容器、网络库还是后端 |
| 首屏 | 页面达到"可交互"的时点，常作加载快慢的度量 |
| WebKit | Apple 推出的渲染内核，Safari 和 iOS 上所有 WebView 的祖先 |
| KHTML | 早期开源排版引擎，Apple 2003 年基于它分叉出 WebKit |
| Blink | Google 2013 年从 WebKit 分叉出的内核，Chrome/Chromium 用它 |
| Chromium | Google 的开源浏览器项目，Blink + V8 引擎的组合，是 Android System WebView 的内核来源 |
| Android System WebView | 安卓 5.0+ 独立成系统组件、可经 Google Play 更新的 WebView，用的是 Chromium 内核 |
| X5 / XWeb | 腾讯的自研/演进内核，接入后替掉系统 WebView，服务于微信生态内的 WebView 业务 |
| U4 | 阿里/UC 出自 UC 浏览器的自研内核 |
| GMS | Google 移动服务，国内安卓机没有它导致 System WebView 无法经官方渠道更新 |
| WKWebView | iOS 上唯一的内核入口，内核随系统版本走、App 无法替换 |
| UA（User-Agent） | 请求里自报家门的字符串，可被伪装，只适合定位壳/内核，不该当功能降级依据 |
| 特性检测 | 直接问"某个能力在不在"而不是猜是谁，比 UA 嗅探更适合多内核兼容 |
| 浏览器主进程 | 管 UI（地址栏/标签页）、下载、权限弹窗，并调度其他进程的"总管" |
| GPU 进程 | 负责把渲染结果合成后画到屏幕上的进程 |
| 网络进程 | 负责 HTTP 请求、Cookie、缓存等网络活的进程 |
| 隔离 | 多进程架构的目的：一个标签页/进程失控不要拖垮整个浏览器 |
| WebContent 进程 | iOS 里 WebKit 真正解析执行网页内容的独立进程，被杀 = 白屏但 App 还活着 |
| 进程池复用 | 同一 App 里多个 WKWebView 可能共用 WebContent 进程，一个挂可能殃及其他 |
| 白屏 | 内容进程死了但容器还活着的典型表现，崩溃平台和 JS 监控都看不到 |
| App 闪退 | 宿主进程崩掉、直接退到桌面，崩溃平台有记录，跟页面白屏是两回事 |
| 渲染进程回收/被杀 | 系统因内存压力等把内容进程干掉，页面永远等不到内容恢复 |
| 加载失败 | 网络/URL/首屏 JS 报错导致的白屏或错误页，跟进程被杀归因方向完全不同 |
| onRenderProcessGone | Android 宿主侧感知"渲染进程阵亡"的回调，返回 true 表示容器自己接管 |
| Logcat | Android 的日志输出工具，可以在这里看到渲染进程退出的记录 |
| 白屏自愈 | 容器检测到进程终止后重建 WebView 并重载，让用户无感的恢复手段 |
| DOMContentLoaded / load | 网页的加载事件：前者是 HTML 解析完，后者是所有资源加载完 |
| pageshow / pagehide | 网页"开始显示/结束显示或被卸载"的事件，回到前台的统一对齐点 |
| visibilitychange | 网页切前台/后台的事件，但它分不清"正常回前台"还是"死后重生" |
| persisted | `pageshow` 事件的属性，`true`=bfcache 恢复还在旧文档，`false`=全新加载 |
| onResume / viewWillAppear | Android/iOS 宿主"回到前台"的生命周期事件，与网页回到前台对齐 |
| onTrimMemory / didReceiveMemoryWarning | 两端宿主的内存压力信号，往往是后台被杀的前兆，前端收不到 |
| canGoBack | Android WebView 问"有没有可回退的历史条目"，区分容器返回和页面 history |
| backForwardList | iOS WKWebView 维护的内部历史栈，容器的边缘滑动退的是它或 VC 栈 |
| history.goBack() | 页面内部的 JS 返回，与容器返回是两个层面 |
| bfcache | 浏览器把旧文档缓存下来、返回时能无损恢复的机制（persisted=true） |
| sessionStorage | 页面会话级存储，切后台被杀在进程重建后不保证还在 |
| localStorage | 持久化的键值存储，关键数据尽早落这里或进服务端，才能扛住"进程死亡" |
| evaluateJavascript / evaluateJavaScript | 双端宿主往页面里调用 JS 的通道，常用于把宿主生命周期事件打进页面探针 |
| 宿主 App | 承载 WebView 的那个 App，决定页面能用什么能力、走什么 UI |
| 容器 | 前端视角下负责把页面能力（离线包、Bridge 等）装给 WebView 的那一层宿主实现 |
| WebChromeClient | Android 侧接网页 UI 类事件（新窗口、权限请求）的回调代理 |
| WebViewClient | Android 侧接导航类事件（SSL 错误等）的回调代理 |
| WKUIDelegate | iOS 侧处理新窗口、权限弹窗等 UI 事件的协议 |
| decidePolicyFor | iOS 决定"这个导航放不放行"的回调 |
| target=_blank | HTML 里开新窗口的属性，两端 WebView 默认都不响应，需容器处理 |
| onReceivedSslError | Android 收到证书错误时的回调，容器可自定义处理 |
| CookieManager / WKHTTPCookieStore | 两端管理 WebView Cookie 的 API，跨宿主互不相通 |
| chrome://inspect | 用 Chrome 远程调试 Android WebView 的入口 |
| WKWebsiteDataStore | iOS 管理 WebView 缓存/存储数据的 API |
| 自动播放策略 | 音视频默认需用户手势才播放，两端都有限制，可由容器调整 |
