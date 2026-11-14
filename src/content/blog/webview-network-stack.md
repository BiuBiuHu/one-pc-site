---
title: 网络库与 H5 请求的真实路径
date: 2026-11-14
excerpt: "H5 请求默认不走客户端网络库。分清两条网络栈，才能解释签名、HTTPDNS、连接池为什么只对原生生效。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 7
lang: zh
draft: false
ogImage: /images/webview-and-native/stage6-01-dual-network.png
---

> 📖 本章由 5 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · 两条网络栈的真相：你的 H5 请求默认不享受客户端能力
- 2 · 一次请求的网络栈内部：源码级看 OkHttp 洋葱与 URLSession 链路
- 3 · 让 H5 请求并入客户端网络库：三种方案与取舍
- 4 · 网关登录态与弱网剖析：管道二到底缺了什么
- 5 · 线上疑难分析 SOP：管道归属三步法 & 三个高频 case 走查
- 本章术语表

---
## 1 · 两条网络栈的真相：你的 H5 请求默认不享受客户端能力

---

### 1.1 问题引入

线上反馈：**"原生页接口全部正常，H5 页接口偶发 401 / 超时 / 抓不到包。"** 客户端同学明明说"我们网络库统一签名、加了 HTTPDNS、有链路监控"，可你的 H5 请求一项都没享受到。不是你"没配"，而是——**你的请求根本没走客户端网络库那条管道**。

---

### 1.2 先破误区

> • 误区 1：App 里只有一个网络通道，前端 fetch 和后端接口一样，都走客户端网络库。
> • 事实：App 进程里同时存在两条并行的网络栈，fetch 走的是另一条（WebView 内置），跟客户端网络库互不相干。

> • 误区 2：H5 请求没带签名，是"容器没给我配"。
> • 事实：在没被容器主动接管前，H5 请求默认由 WebView 内核的网络栈直发——它压根到不了 OkHttp 的拦截器，签名不是"漏配"，是架构性分路。

> • 误区 3："我加了 HTTPDNS，H5 应该也提速了。"
> • 事实：HTTPDNS 通常挂在客户端网络库（管道一）。H5 请求走管道二，默认不经过它。这是阶段 6 最重要的认知。

---

### 1.3 原理讲解：两条栈，各组成，各管什么

承接总章（stage-1 总章）的双管道模型，本阶段把两条栈的组成和归属一次讲全。

![双网络栈对照图](/images/webview-and-native/stage6-01-dual-network.png)


#### 1.3.1 管道一 · 客户端网络库

- **组成**：Android 为 **OkHttp**（常包一层网关/Retrofit/自研封装），iOS 为 **URLSession**（NSURLSession，同样常被封装）。这一层之上往往还有公司统一的安全、鉴权、埋点封装。
- **谁发起**：容器里**原生代码**主动调用（原生页面的接口、上传下载、原生能力触发的后端请求）。封装的统一 API 出口，才有可能挂上公共逻辑。
- **管什么**：统一签名鉴权、HTTPDNS、连接池、QUIC/HTTP3、弱网重试、链路监控、流量上报——**这些能力全部绑定在这条栈上**。

#### 1.3.2 管道二 · WebView 内置网络栈

- **组成**：Android 为 **Chromium 网络栈（netstack）**（System WebView/内核自带），iOS 为 **WebKit / CFNetwork**。
- **谁发起**：网页里的 **JS**——`fetch` / `XHR` / `<img>` / `<link>` / 字体 / Service Worker 等所有页面请求。
- **管什么**：管 H5 页面的一切网络。它**不是**你 App 自己写代码搭出来的，而是内核内置的、对 App 而言基本"黑盒"的独立栈。

#### 1.3.3 关键机制解释：为什么"没配"其实是"分路"

不是容器想省事不做，而是请求发起方决定了归属：

```text
JS 侧 fetch/XHR  → 渲染进程把这些请求交给「WebView 内核」的网络栈（管道二）发出
原生 Kotlin/Swift → 交给你封装的 OkHttp / URLSession（管道一）发出
```

两条栈的 **Cookie、缓存策略、连接池、代理、证书策略天然不同**，因为它们就是两套独立实现。要让 H5 请求走上管道一，必须由容器主动"接一条岔路"（方案见第 3 节），默认是不通的。这也是为什么总章反复强调：**不是不会，是默认不经过。**

#### 1.3.4 为什么 Cookie / 缓存 / 证书也不一样

既然两条栈是两套独立实现，它们的"锅"也是分开的，这一条经常是前端误会最深的：

- **Cookie**：管道二由 WebView 内核管理 Cookie（Android 走 CookieManager，iOS 走 WKHTTPCookieStore / shared HTTPCookieStorage）；管道一走的是 OkHttp 的 `CookieJar` / URLSession 的 `HTTPCookieStorage`。阶段 5 讲的"原生写入 H5 读不到/302 竞态"，本质就是**这两套 Cookie 存储没同步**。
- **HTTP 缓存**：管道二的强缓存由 WebView 内核的磁盘缓存管（`CacheMode`、WKWebView 缓存策略）；管道一由网络库自己的缓存策略管。**同一 URL 在两条栈里是否命中缓存、拿哪个副本，完全是两码事**——这也是"H5 改版不更新"和"原生请求不刷新"经常各说各话的原因。
- **证书策略**：管道二按内核/系统信任锚与 `sslError` 回调判断；管道一按 `OkHttpClient` 的 `SSLSocketFactory`/证书固定（Certificate Pinning）判断。两条栈对同一台中间代理（如公司抓包根证书）的接受度也可能不同。

一句话归因原则：**凡涉及 Cookie / 缓存 / 证书的"系统不一致"，先问这条请求走哪条栈，再谈同步或修复。**

#### 1.3.5 落地形态：各容器策略可能不一样

并不是所有 App 都让 H5 享受管道一能力。落到真实容器有两种典型策略：

| 容器策略 | 表现 | 你是否需要进一步接入 |
|---|---|---|
| **API 并入网关** | 容器用拦截代理/桥把 H5 的 API 请求并入客户端网络库，享受签名/HTTPDNS/监控；静态资源走离线包 | 是——你前端基本无需改，但要确认哪类请求被代理 |
| **H5 直连 + 注入公共头** | 容器不改网络栈，只注入公共 header / 登录态（token）；H5 请求仍走管道二 | 可能需要前端主动带 token / 自己重试降级（见第 03/04 篇） |

> 所以"你的 H5 请求缺不缺签名"——**先问你们容器是哪一种**，别默认它一定接管了网络栈。接入前读容器能力清单（第 3 节会给三种接入方案的取舍表）。

#### 1.3.6 一张对照表

| 维度 | 管道一 · 客户端网络库 | 管道二 · WebView 内置网络栈 |
|---|---|---|
| 谁发起 | 原生代码（OkHttp/URLSession 封装） | 网页 JS（fetch/XHR/img） |
| Android | OkHttp（+ 网关/Retrofit/自研） | Chromium 网络栈（netstack） |
| iOS | URLSession（+ 网关封装） | WebKit / CFNetwork |
| 可配置 DNS | ✅ 可接 HTTPDNS / 自建 DNS | ❌ 默认不可（走系统/内置解析） |
| 可挂拦截器 | ✅ OkHttp Interceptor 洋葱 | ❌ 内核封闭，需容器接管才可 |
| 可自定义 header | ✅ 统一签名 / token / 追踪 | ❌ 原则上否（除非容器注入/代理） |
| 可见于客户端监控 | ✅ 默认进大盘 / 链路追踪 | ❌ 默认查不到 |
| 受 Charles 影响 | ✅ 走系统代理 / TLS 可解 | ✅ 走系统代理 / TLS 可解 |

> 注意：**两条栈都受 Charles 影响**（都能拦到），这是很多人以为"我抓到了包，那它一定走的客户端网络库"的误判来源。抓到 ≠ 走管道一，要用 §1.4 的 UA 特征进一步分。

#### 1.3.7 自测锚点：“H5 请求为什么不带自动签名/不走 HTTPDNS/不进统一监控”

把本节收束成三句话，对应第 3、4 节会展开的三个方向：

1. **不带自动签名**：签名逻辑实现在客户端网络库封装（管道一的拦截器/公共头）。H5 fetch 走管道二，触达不了这个封装层 → 网关不认识它，鉴权 401。
2. **不走 HTTPDNS**：HTTPDNS 绑在管道一的 DNS 解析位置（如 OkHttp 的 `Dns` 实现）。管道二默认走系统解析 → 被运营商劫持/弱网抖动时 H5 更明显。
3. **不进统一监控**：客户端链路监控在管道一的请求出口埋点。H5 请求没进管道一，自然不在监控大盘里 → 这不是"数据丢了"，是"这条请求根本不在那条路"。

这三条不是偶发 bug，是**两条栈并行时天然的能力断层**；补齐方式就是"让 H5 请求走到管道一"或"由容器代理/桥接"，即第 3 节的三大方案。

---

### 1.4 代码验证：用 Charles 实锤"两条栈"

#### 1.4.1 双端搭一个最小场景

- **原生请求**：Android 里用 OkHttp 直接 GET 一次；iOS 用 `URLSession.dataTask(with:)`。
- **H5 请求**：在同一 App 内打开 WebView，页面里 `await fetch(sameUrl)`。

#### 1.4.2 在 Charles 里对照四个维度

| 观察项 | 原生请求（管道一） | H5 fetch（管道二） |
|---|---|---|
| User-Agent | 客户端自定义 UA 或 `okhttp/4.x` 字样 | 内核 UA，末尾常见 `; wv)`（Android） |
| 自定义 header | 有签名头 `X-Auth`/`X-Sign`、容器注入的公共头 | 通常没有（除非容器注入） |
| 证书链 | 客户端库信任策略 / 抓到的是你配的代理证书 | 内核信任策略 / 大概率也能解开 |
| 连接池特征 | 可看到 keep-alive 连接被复用 | 每次可能新建，或走内核缓存 |

#### 1.4.3 用 UA 特征快速判栈

```javascript
// 在 H5 里拿到当前页 UA（前端即可自测）
const ua = navigator.userAgent;
// Android System WebView 常见：Mozilla/5.0 ... Version/4.0 Chrome/... Mobile Safari/537.36 (Linux; ...; wv)
const isAndroidWebView = /; wv\)/.test(ua);
// 自己容器常注入的自定义标识，例如包含 appName/容器Version
const isContainerUA = /myapp\//.test(ua);
console.log(isAndroidWebView, isContainerUA);
```

> 关键：**UA 是"疑似"信号，不是定案**。容器可能改写 UA 伪装成浏览器，也可能把 `; wv)` 去掉。定案仍要回到"抓包看头 + 客户端监控维度"两步（第 5 节的判定三步法）。

---

### 1.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| "抓到了包就以为走客户端库" | Charles 两条栈都拦得到 | 系统代理对两条栈都生效 | 别用"抓不抓得到"判栈，用 UA+header |
| "加了 HTTPDNS H5 没提速" | 原生快、H5 仍直连/劫持 | HTTPDNS 只绑管道一 | 先判归属；让 H5 走管道一或前端自行 DNS-over-HTTPS |
| "签名必带"的错觉 | H5 接口 401 | H5 无统一签名头 | 容器拦截代理补签名，或 JS 层带 token（见第 4 节） |
| "H5 请求监控查不到" | 大盘里搜不到 | 请求没进管道一，不是数据丢失 | 引入前端监控，或让请求并入管道一 |
| 两条栈 Cookie 不一致 | 原生写入、H5 读不到 | Cookie 存储独立 | 阶段 5 的 Cookie 同步机制 |

---

### 1.6 自测题

1. 为什么"加到客户端网络库的 HTTPDNS"默认对 H5 fetch 不生效？这不是"没配"，是什么？
2. 在 Charles 里，抓到一个带 `okhttp/4.x` 的请求，能断定它走管道一吗？为什么？
3. 判断题："因为两条栈都受 Charles 影响，所以抓包能抓到 = 这条请求走了客户端网络库。" 错在哪里？
4. 动手题：在你 App 里分别触一个原生请求和一个 H5 fetch，用 Charles 对比 UA / header / 证书链，判断哪条像管道一、哪条像管道二。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 是**架构性分路**：H5 fetch 由 WebView 内核（管道二）直发，到不了 OkHttp 拦截器；HTTPDNS 是绑在管道一之上的能力，默认覆盖不到管道二。
2. **不能**。UA 只是疑似信号；且客户端也可能伪装 UA。要以"抓包看头 + 客户端监控维度"两层确认。
3. 错。系统代理/TLS 对两条栈都生效，都能被 Charles 拦到。**抓到 ≠ 走管道一**。
4. 原生命运带统一签名头 + 一个 UA；H5 fetch 多半是内核 UA、无签名头。对照 §1.4.2 表逐项勾。

</details>

---

---

## 2 · 一次请求的网络栈内部：源码级看 OkHttp 洋葱与 URLSession 链路

---

### 2.1 问题引入

上一节讲清了"两条栈"，你心里可能还有追问：**"客户端网络库内部到底怎么跑？签名、HTTPDNS、重试这些能力，具体挂在哪一层代码上？为什么 H5 的 fetch 就是享受不到？"** 本节追一条**管道一**的请求，从入口到真正的 Socket IO 逐层剥开。这一篇是全阶段的地基——只有看懂拦截器洋葱，才能理解第 3 节"并入方案"补的是什么、第 04~05 篇的归因为什么成立。

> ⭐ Android 侧以 **OkHttp 4.x**（Kotlin 源码）为主线给源码级注释：给**真实类名/方法名 + 概念行号**（OkHttp 4.x 各小版本行号会浮动，行号仅供定位，内容以对应版本源码为准）。iOS 侧 URLSession 不开源，我们讲**文档化的对象生命周期**等价链路，并明确注明"以 Apple 官方文档为准"。

---

### 2.2 先破误区

> • 误区：签名是容器"统一加的一道魔法"，任何请求（包括 H5 的 fetch）进网络层就自动带上。
> • 事实：签名是在管道一的某个拦截器里，被业务/封装代码显式插进 HTTP 头的。H5 的 fetch 走管道二，连 `okhttp3.Request` 这个对象都不存在，更不会进入这个拦截器列表。

> • 误区：OkHttp 的 Request 一进来就直连 TCP 发出去。
> • 事实：请求要先"旋转"过一串拦截器（进层下发、出层上收，即"洋葱"），真正的 Socket IO 只发生在最内层的 CallServerInterceptor。

---

### 2.3 原理讲解

#### 2.3.1 洋葱总览（复用总章图，不重画）

![OkHttp 拦截器洋葱模型](/images/webview-and-native/stage1-03-okhttp-onion.png)


OkHttp 4.x 的真实顺序（顺序写错会误导读者，务必按此背）：

```text
应用拦截器 → RetryAndFollowUp → Bridge → Cache → Connect → 网络拦截器 → CallServer（唯一真正 IO）
```

源头在 `okhttp3.internal.connection.RealCall` 的 `getResponseWithInterceptorChain()`：它把 `client.interceptors`（应用层）、四个内置拦截器、`client.networkInterceptors`（网络层）依次装进一个列表，末尾追一个 `CallServerInterceptor`，然后从第 0 个开始递归 `chain.proceed(request)`。

#### 2.3.2 源码级逐层注释：一次 GET 的实际行为

先立两个接口概念（真实类名，OkHttp 4.x 源码 `okhttp3/Interceptor.kt`）：

```kotlin
// OkHttp 4.x 把 Interceptor 声明成了 fun interface，所以 Kotlin 里可以直接传 lambda
fun interface Interceptor {
  fun intercept(chain: Interceptor.Chain): Response
}
// chain.proceed(request)：把（可能改过的）请求交给下一层；
// 返回值 Response 是"下层全部处理完"之后沿洋葱上收回来的结果。
```

**① 应用拦截器（Application Interceptor，最外层）**
- 自定义第一层：加公共 header、打日志、业务埋点。
- 关键语义：对一次 `newCall(...)` **只被调用一次**。中间的重定向、重试发生在更下层（RetryAndFollowUp），**中间响应它看不见**；但**最终响应会沿洋葱回到它手中**，它照样可以改。
- 所以想"统计本次呼叫发了几次网络"，挂这层数不准——要挂网络拦截器。

**② RetryAndFollowUpInterceptor（重试与跟随）**
- `intercept()` 里一个大 while 循环：捕获路由级异常决定是否换路重试；对响应码做跟随——3xx 构造新请求继续 `chain.proceed`，401 时用 `client.authenticator` 换带凭证的请求重发（源码常量 `MAX_FOLLOW_UPS = 20`，即跟随上限）。
- 失败信息按 `RealCall` 的调用栈逐层上抛，最终以 `IOException` 形式到外层。

**③ BridgeInterceptor（桥接：把用户请求补成完整 HTTP 报文）**
- 对你给的 Request 补默认头：`Host`、`Connection: Keep-Alive`、`Accept-Encoding: gzip`（并负责透明解压响应体）；从 `CookieJar` 读 Cookie 写进 `Cookie` 头；有 body 时补 `Content-Type`/`Content-Length`（或 `Transfer-Encoding: chunked`）、按需 `Expect: 100-continue`。
- 容易记错的一点：**OkHttp 默认不替你设 User-Agent**。抓包里常看到的 `okhttp/4.x`，多半是公司网络层或业务自己 `header("User-Agent", ...)` 加的（以实测为准：拿最小 demo 只发一个裸请求，抓包看有没有 UA）。
- 响应侧做对称清理：解 gzip、还原头，转成"业务可读"的 Response 往上传。

**④ CacheInterceptor（缓存命中判定）**
- 查 `client.cache`（OkHttp 的 Cache 是**磁盘缓存**，DiskLruCache 实现，**没有内存缓存**）。
- 策略判定在 `CacheStrategy`：命中强缓存（`Cache-Control: max-age` 未过期 / `Expires`）→ **直接短路返回缓存响应，下面的层一次都不走**；否则带条件请求头（`If-None-Match`/`If-Modified-Since`）下探，304 则把缓存的 body 拼回去。
- 推论：网络拦截器**看不到纯缓存响应**——路径根本没走到它那层。监控请求数时别忘了这个偏差。

**⑤ ConnectInterceptor（建连：连接池 / DNS / TLS）**
- 通过 `ExchangeFinder` 到 `RealConnectionPool` 找可复用连接；找不到才新建：
  - **DNS**：`routeSelector` 调用 `OkHttpClient.dns`（`Dns` 接口，默认 `Dns.SYSTEM`）——**这就是接 HTTPDNS 的源码位置**：换掉 `Dns` 实现，管道一全局生效。
  - 逐 Route 尝试：`Socket` 连接 → `SSLSocketFactory` 上的 TLS 握手 → 协议协商（HTTP/1.1 或 HTTP/2，`Protocol` 枚举）。
- 复用成功时这一步几乎零开销——原生请求"快"的最大功臣通常在这（连接复用 + TLS 会话复用），第 5 节 caseC 会对照 H5。

**⑥ 网络拦截器（Network Interceptor，位于 Connect 之后）**
- 对**每一次真正触网**都会被调用（含重试、重定向后的再次触网），看到的是"即将上线"的最终请求；响应直接来自缓存时**不经过它**。
- 公司统一签名、鉴权头注入、弱网埋点，大量实现选在这层——因为它语义上等价于"看到每一次真实网络行为"。

**⑦ CallServerInterceptor（真正 IO）**
- 唯一真正触网的一层：把请求头/body 经 `Exchange` 写进连接（HTTP/1.1 报文或 HTTP/2 帧），write 完读回状态行、响应头、再流式读 body，包成 `Response` 沿洋葱逐层向上返回。

一句话串起来：**请求"逐层下发"时被逐层补齐（Bridge 补头、Cache 截流、Connect 建连），真 IO 只在最底层；响应"逐层上收"时被逐层消费（解压、判缓存、跟随重定向），最后回到你的调用点。**

#### 2.3.3 拦截器与"给 H5 请求补签名"的关系：为什么默认到不了这里

把 3.2 的路径记住，答案不言自明：**任何拦截器生效的前提，是这条请求被构造成了 OkHttp 的 `Request` 并交给了 `RealCall`。**

```text
H5 fetch/XHR → WebView 内核（管道二）→ 服务器
              ↑ 从头到尾没有出现 okhttp3.Request / RealCall，
                应用拦截器/网络拦截器列表与它无关
```

- 它不是"差一步配置"，而是**跨了一个栈**：两套网络栈没有互相调用的接口。Chromium netstack / WebKit 内部如何连接、是否独立进程，随内核版本演进（Android 上 netstack 主体运行在宿主 App 进程，内核服务进程化程度因版本而异，**以实测为准**）——但无论在哪个进程，都不是你 App 里那个 OkHttpClient 实例。
- 所以"让 H5 请求带签名"只有两条正路：**①在拦截点把请求转成管道一的 Request 重发**（第 3 节方案 1）；**②签名所需材料经桥下发，JS 侧自己带**（第 3 节方案 2 / 第 4 节）。

#### 2.3.4 iOS URLSession 的等价链路（文档化对象生命周期，以 Apple 文档为准）

iOS 的 URL 加载系统不开源，**没有公开的拦截器列表**；但结构与 OkHttp 洋葱是**等深度**的：都是"一层层交给底层唤起，再逐层唤醒回来"，只是 iOS 把"层"组织成"对象 + Delegate 回调"。以下全部以 Apple 官方文档（URLSession / URLSessionTask / 各 Delegate 协议）为准，不硬编行号。

```swift
// 文档化的三段式：Configuration → Session → Task
let config = URLSessionConfiguration.default
config.requestCachePolicy = .useProtocolCachePolicy     // 等价 Cache 层：缓存策略交给 URLCache
config.httpMaximumConnectionsPerHost = 4                // 等价 Connect 层：并发/复用策略
config.tlsMinimumSupportedProtocolVersion = .TLSv12     // 等价 TLS 参数
config.httpAdditionalHeaders = ["X-Sign": "native-only"] // 统一头注入点（签名常见去处之一）
let session = URLSession(configuration: config, delegate: dlg, delegateQueue: nil)
let task = session.dataTask(with: url) { data, resp, err in /* completionHandler */ }
task.resume()   // task 默认挂起，必须 resume 才开始——"逐层下发"到此触底
```

一次 GET 的**文档化回调时序**（无重定向/无 challenge 时只走 ②③⑤）：

```text
① URLSessionTaskDelegate.urlSession(_:task:didReceive:completionHandler:)        // TLS/认证 challenge（如有）
② URLSessionDataDelegate.urlSession(_:dataTask:didReceive:completionHandler:)    // 收到响应头（决定接收或转下载）
③ URLSessionDataDelegate.urlSession(_:dataTask:didReceive:)                      // body 分块到达（0~n 次）
④ URLSessionTaskDelegate.urlSession(_:task:willPerformHTTPRedirection:...）      // 出现 3xx、系统跟随前回调
⑤ URLSessionTaskDelegate.urlSession(_:task:didCompleteWithError:)                // 收尾必调（成功 err == nil）
```

要点：

- **configuration ≈ 洋葱壳**：连接、缓存、TLS、公共头都声明在这里。**连接复用由系统自动管理**（HTTP/1.1 keep-alive 与 HTTP/2 多路复用），不像 OkHttp 那样暴露 `ConnectionPool` 对象给你配。
- **回调线程**：所有 delegate 回调运行在 `delegateQueue`（传 nil 时系统自建串行队列）；completionHandler 形式回调也来自该队列语义，**不保证主线程**，更新 UI 要自行派发。
- **生命周期强约束**：`URLSession` 对 delegate 持强引用，直到 `finishTasksAndInvalidate()`/`invalidateAndCancel()`；每个回调的 `completionHandler` 都必须**恰好调用一次**（不调=该 task 挂死），这与阶段 3 `decidePolicyFor` 的约束同源。
- **最接近"拦截器"的官方钩子是 `URLProtocol`**：`config.protocolClasses` 里注册自定义 `URLProtocol` 子类，可在 URL 加载系统内拦请求——这是文档支持的位置，但语义与 OkHttp 拦截器不一一对应，以 Apple 文档为准。

#### 2.3.5 用"等深度"把两条链路放到一张表

| 环节 | OkHttp 4.x（可进源码） | URLSession（文档化，以 Apple 文档为准） |
|---|---|---|
| 统一配置层 | `OkHttpClient.Builder` | `URLSessionConfiguration` |
| 请求入口 | `RealCall` / `enqueue` | `URLSessionTask`（须 `resume()`） |
| 补默认头 | `BridgeInterceptor` | 系统内部（公共头挂 `httpAdditionalHeaders`） |
| 缓存 | `CacheInterceptor`（磁盘） | `URLCache` + `requestCachePolicy` |
| 建连/TLS/复用 | `ConnectInterceptor` + `RealConnectionPool` + `Dns` | 系统内部（`httpMaximumConnectionsPerHost` 等策略） |
| 真实 IO | `CallServerInterceptor` | CFNetwork/Libnetcore（黑盒） |
| 逐层唤醒 | 栈式 `chain.proceed` 返回链 | `URLSession…Delegate` 回调时序 |
| 可插入点 | 应用/网络拦截器 | `URLProtocol`（protocolClasses）为主 |

---

### 2.4 代码验证

#### 2.4.1 Android（Kotlin）· 亲手摸洋葱

```kotlin
// 平台：Android。粘贴进任一 OKHttp 工程，观察签名头与拦截器语义
val client = OkHttpClient.Builder()
    .addInterceptor { chain ->                        // 应用拦截器：每次 Call 只进一次
        val signed = chain.request().newBuilder()
            .header("X-Sign", "sign_for_pipe_1")      // 只对走管道一的请求生效
            .build()
        chain.proceed(signed)                         // 往下层放行，等最终响应上收
    }
    .addNetworkInterceptor { chain ->                 // 网络拦截器：每次触网都会进（缓存命中不进）
        Log.d("Net", "hitting wire: ${chain.request().url}")  // 看见重试/重定向后的真实请求
        chain.proceed(chain.request())
    }
    .build()

client.newCall(Request.Builder().url("https://httpbin.org/get").build())
    .enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = Unit
        override fun onResponse(call: Call, resp: Response) {
            Log.d("Net", "final code=${resp.code}")   // 最终响应沿洋葱回到这
        }
    })
```

#### 2.4.2 iOS（Swift）· 对照 URLSession 回调时序

```swift
// 平台：iOS。对照 §2.3.4 回调时序，理解"逐层交底、逐层唤醒"
final class DigDelegate: NSObject, URLSessionDataDelegate {
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask,
                    didReceive res: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        print("② headers: \((res as? HTTPURLResponse)?.statusCode ?? -1)")
        completionHandler(.allow)
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        print("③ chunk \(data.count)B")
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError err: Error?) {
        print("⑤ done \(err.map(String.init(describing:)) ?? "ok")")   // 一定回调
    }
}
let config = URLSessionConfiguration.default
config.httpAdditionalHeaders = ["X-Sign": "pipe_1_only"]   // 签名只对本 session 的请求生效
let session = URLSession(configuration: config, delegate: DigDelegate(), delegateQueue: nil)
session.dataTask(with: URL(string: "https://httpbin.org/get")!).resume()
```

#### 2.4.3 一分钟验证"签名到不了管道二"

原生侧跑上面的 4.1/4.2，抓包确认请求带 `X-Sign`；再在同一 App 的 WebView 页面里 `fetch('https://httpbin.org/get')`，抓包看这条请求——**无 `X-Sign`**。这就用实验复现了 §2.3.3 的结论：不是"没配"，是根本不在一个栈里。

---

### 2.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 拿应用拦截器数"真实网络请求次数" | 统计永远偏少 | 应用拦截器每次 Call 只进一次，重定向/重试在更下层 | 统计挂网络拦截器（注意缓存命中不经过它） |
| 网络拦截器里"找不到"缓存命中请求 | 少了部分响应 | Cache 层短路，未触网 | 用 `response.cacheResponse/networkResponse` 区分来源 |
| 以为 `okhttp/4.x` UA 是库自带 | 字段排障迷路 | OkHttp 默认不发 UA，多半是封装层加的 | 最小 demo 抓包复核；以实测为准 |
| 把 MemCache 当 OkHttp 缓存 | 命中率对不上 | OkHttp Cache 只有磁盘缓存（DiskLruCache） | 读 `CacheInterceptor`/`Cache` 源码确认 |
| iOS 回调里直接操作 UI | 偶发卡顿/崩溃 | delegate 回调不保证主线程 | 派发回 `DispatchQueue.main`（以 Apple 文档为准） |
| 硬抄 OkHttp 源码行号 | 版本升级即偏 | 4.x 各小版本行号浮动 | 记类名/方法名；行号只作定位辅助 |

---

### 2.6 自测题

1. 默写 OkHttp 4.x 拦截器洋葱的正确顺序（7 层）。
2. 应用拦截器和网络拦截器，谁"每次 Call 只进一次"、谁"每次触网都进"？谁看不见缓存命中的响应？
3. OkHttp 默认会自动给请求补 User-Agent 吗？抓包里看到的 `okhttp/4.x` 从哪来？
4. "给 H5 的 fetch 补个拦截器就行"——错在哪？正路是哪两条？
5. iOS 侧：`URLSessionConfiguration` / `URLSessionTask` / `delegateQueue` 各对应洋葱的哪个环节？回调线程语义是什么？
6. 动手题：跑 4.1，故意让 URL 302 一次，验证"应用拦截器只看到最终响应，网络拦截器能看到跳转后的那次触网请求"。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 应用拦截器 → RetryAndFollowUp → Bridge → Cache → Connect → 网络拦截器 → CallServerInterceptor。
2. 应用拦截器每次 Call 只进一次（中间重定向/重试的响应看不见）；网络拦截器每次真正触网都进；**缓存直接命中时不触网，网络拦截器看不见**。
3. **不会**。OkHttp 默认不设 User-Agent；`okhttp/4.x` 多半是业务/公司封装自己加的头（以实测为准）。
4. 错在跨栈：H5 fetch 走管道二，没有 okhttp3.Request，根本进不了拦截器列表。正路：拦截点转交管道一重发，或签名材料经桥下发、JS 侧自带。
5. 配置层/请求任务/回调线程；delegate 回调跑在 delegateQueue（nil 则系统自建串行队列），不保证主线程，均以 Apple 文档为准。
6. 用 httpbin.org/redirect-to 模拟 302：应用拦截器打印次数 = 1；网络拦截器至少 2 次（跳转前后各触网一次）。以实测为准。

</details>

---

---

## 3 · 让 H5 请求并入客户端网络库：三种方案与取舍

---

### 3.1 问题引入

看完第 2 节你已明白：H5 请求默认进不了 OkHttp 的洋葱。那要不要让它进？**取决于你的容器想不想让 H5 享受签名/HTTPDNS/统一监控。** 本节给三种常见"并入"路线：各自代码骨架、机制、以及一笔取舍账。别急着抄——**先确认你们容器的现状策略**（有的容器已把 API 并入网关，有的保持 H5 直连只注入公共 header）。

---

### 3.2 先破误区

> • 误区 1："把 H5 请求拦下来交给 OkHttp 发，就万事大吉了。"
> • 事实：拦截代理等于你自己重写了一遍 HTTP 行为——重定向跟随、缓存头语义、Service Worker、流式响应，全要代理层复刻，否则就丢能力。

> • 误区 2："Bridge 代理是最省事的接入法。"
> • 事实：Bridge 代理是接入成本最高的一条路（每个 API 调用点都要改写），但也是能力覆盖最全、和 JS 契约绑定最深的一条。

> • 误区 3："shouldInterceptRequest 只拦静态资源，拦不到接口请求。"
> • 事实：JS 发起的 fetch/XHR 也是"WebView 网络栈发出的资源请求"，会回调 shouldInterceptRequest；真正的硬限制是拿不到 POST 请求体（见 §3.1）。

---

### 3.3 原理讲解：三条路线

#### 3.3.1 路线 1 · 拦截代理（把请求重定向进管道一）

**思路**：WebView 在发起请求前给容器一次"把持"机会，容器转交 OkHttp/URLSession 发送，再把回包"喂"回 WebView。

![拦截代理方案图](/images/webview-and-native/stage6-02-intercept-proxy.png)


**Android：`WebViewClient.shouldInterceptRequest`**

- JS 调 `fetch`/`XHR` 的请求、`<img>`/`<script>` 等子资源、主文档加载，都会在这里回调（回调在**非 UI 线程**，可直接做网络 IO）。
- 返回 `null` = 放行，内核照常自己发（管道二）；返回 `WebResourceResponse` = 用你给的**状态码/头/body 流**作为响应 —— 这就是"截胡"。
- 硬限制：**只能"替换响应"，不能改"将要发出"的原请求头**；且**读取不到请求 body** —— 拦到 POST 也重放不出来。所以"POST 接口代理"通常只能改走 Bridge（路线 2）。以实测为准（抓包对比 body 即可复现）。

**iOS：`WKURLSchemeHandler`（iOS 11+）**

- 通过 `WKWebViewConfiguration.setURLSchemeHandler(_:forURLScheme:)` 注册。生命周期：
  - `startURLSchemeTask`：拦截开始，你在这里用 URLSession（管道一）发真实请求；
  - `didReceive(response)` → `didReceive(data)`（可多次）→ `didFinish`：按序回写，回写也给状态/头/分块 body；
  - `stopURLSchemeTask`：取消或任务失效时调用，之后**再回调该 task 会崩溃**，须 guard。
- 关键限制：**默认只拦自定义 scheme**（如 `myapi://`）。`http(s)` 属于 WebKit 标准方案，注册 handler 不会生效（以实测为准/以 Apple 文档为准）。要拦 http(s) 只能"前端把接口改写成自定义 scheme + 容器映射回真实 URL"这类 hack，会丢掉 HTTPS 证书校验、缓存、语义化的内建行为，**通常不建议**。

#### 3.3.2 路线 2 · Bridge 代理（原生发，能力最全）

**思路**：不改网络栈，**改调用方式**——前端所有 API 不再直接 `fetch`，而是打包成 `{requestId, action, data}` 经桥发给原生，由原生网络库统一发请求并回传。

- 优点：请求 100% 走管道一，签名/HTTPDNS/弱网/监控**天然全开**；POST body 也能带（桥协议带参）；还能用非 HTTP 协议（公司 RPC 网关）。
- 代价：**接入成本最高**——所有调用点要改成 `requestApi(action, data)`；错误码/超时/取消/并发去重/上传/流式，全要在桥协议上重新定义一遍。这就是"和 JS 绑定最深"的含义：你的前端从此依赖容器桥的能力清单与版本（呼应阶段 4 的 callbackId 设计）。

#### 3.3.3 路线 3 · 自研内核 / 容器接管网络栈

**思路**：从内核层把 WebView 的网络栈整个重写/代理到统一网络层。公开层面的共性一句话：**"把 WebView 网络栈重写或代理到统一网络层"**——腾讯 X5→XWeb、UC U4、以及阿里内部 H5 容器，对外资料都落在这一表述上。

> ⚠️ 红线：这一条**只写公开事实**。是重写 netstack、还是本地代理、还是启动注入，各家不公开，**不虚构内部机制**。自研内核=重资产（内核跟随 Chromium 迭代、合规、更新节奏全压给自己），绝大多数团队到不了这一步，知道"它是路线 3"即可。

---

### 3.4 代码验证（双端最小骨架）

> 可直接粘贴的完整文件在 demo/stage-6-network-library/（示例代码详见 demo 包）（`ProxyInterceptorSample.kt`、`URLSchemeHandlerSample.swift`、`api-bridge.js`）。

#### 3.4.1 Android 拦截转发骨架（Kotlin）

```kotlin
// 平台：Android（API 21+，6 参构造 WebResourceResponse 需 21+）。演示"拦 H5 API → OkHttp 转发"。
class ApiProxyWebViewClient(private val ok: OkHttpClient) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView,
                                        req: WebResourceRequest): WebResourceResponse? {
        if (!req.url.host.endsWith("api.example.com")) return null   // 非 API 域名 → 放行走管道二
        // ① 用管道一重发（注意：拿不到原请求 body，POST 请改走桥）
        val resp = ok.newCall(
            Request.Builder().url(req.url.toString())
                .method(req.method, if (req.method == "GET") null else
                    "POST 代理不支持 body，请走桥".toRequestBody("text/plain".toMediaType()))
                .build()
        ).execute()
        // ② 把 OkHttp 的响应封成 WebResourceResponse 喂回 WebView
        val ctype = resp.header("Content-Type") ?: "application/octet-stream"
        val charset = ctype.substringAfter("charset=", "utf-8")      // encoding 参数是"字符集"
        return WebResourceResponse(
            ctype.substringBefore(';'), charset,                      // mime / charset
            resp.code, resp.message ?: "OK",
            resp.headers.toMultimap().mapValues { it.value.joinToString(", ") }, // 头：透传
            resp.body!!.byteStream())                                 // body：原生流
    }
}
```

注意三件事：**OkHttp 会透明解 gzip**，所以 body 流可直接给；`encoding` 参数要给字符集而非 Content-Encoding；头透传时别把 `Content-Length` 一起搬（流式长度已变）。

#### 3.4.2 iOS WKURLSchemeHandler 骨架（Swift）

```swift
// 平台：iOS 11+。演示 start/回写/finish 生命周期；注册给自定义 scheme。
final class APIProxyHandler: NSObject, WKURLSchemeHandler {
    private var live = NSHashTable<WKURLSchemeTask>.weakOptions()   // 记活体，stop 后防崩

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        live.add(urlSchemeTask)
        let original = urlSchemeTask.request.url!          // myapi://path?query → 映射 https://...
        let real = URL(string: original.absoluteString.replacingOccurrences(of: "myapi://", with: "https://"))!
        URLSession.shared.dataTask(with: real) { data, resp, err in
            guard self.live.contains(urlSchemeTask) else { return }   // 已 stop：静默退出
            guard let http = resp as? HTTPURLResponse, let data = data else {
                urlSchemeTask.didFailWithError(err ?? URLError(.badServerResponse)); return
            }
            urlSchemeTask.didReceive(http)                            // 响应头
            urlSchemeTask.didReceive(data)                            // body（可分块多次）
            urlSchemeTask.didFinish()                                 // 必须收口
        }.resume()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        live.remove(urlSchemeTask)   // 之后对该 task 的任何回调都会崩溃
    }
}
// 注册：config.setURLSchemeHandler(APIProxyHandler(), forURLScheme: "myapi")
```

#### 3.4.3 前端 Bridge 代理 api.js 骨架（现代 JS）

```javascript
// 平台：H5。演示"API 不再直接 fetch，统一走桥 + requestId 绑定回调 + 超时"
let seq = 0;
const pending = new Map();                      // requestId → {resolve, reject, timer}

window.requestApi = function (action, data, { timeout = 8000 } = {}) {
  const requestId = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {           // 超时兜底：桥丢了也不能让 Promise 挂死
      pending.delete(requestId); reject(new Error(`api timeout: ${action}`));
    }, timeout);
    pending.set(requestId, { resolve, reject, timer });
    window.myBridge.request(JSON.stringify({ requestId, action, data }));
  });
};

// 原生处理完回调注入的统一入口（由容器 evaluateJavascript 调用）
window.onNativeApiReply = function (raw) {
  const { requestId, ok, data, error } = JSON.parse(raw);
  const p = pending.get(requestId);
  if (!p) return;                              // 已超时/重复回包：丢弃
  clearTimeout(p.timer); pending.delete(requestId);
  ok ? p.resolve(data) : p.reject(new Error(error));
};

// 调用方式（对比：改造前直接 fetch；改造后统一走桥）
// const user = await window.requestApi('user.getInfo', { id: 1 });
```

---

### 3.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| POST 接口代理不了 | fetch POST 拦到了却重发失败 | shouldInterceptRequest 拿不到请求 body | POST 走 Bridge（路线 2），拦截代理只管 GET/子资源 |
| 代理后重定向/Cookie 丢失 | 302 后续请求没带 Cookie | 代理层用原生库直发，没复刻浏览器导航语义 | 代理层显式跟随重定向；从 CookieManager/CookieStore 取 Cookie 注入 |
| 强缓存"失效" | 同 URL 二次加载仍回源 | HTTP 缓存交由原生网络库解析，WebView 磁盘缓存不再管这条请求 | 明确缓存责任边界；该管的缓存策略交给 OkHttp Cache |
| Service Worker 不生效 | SW 的 fetch 事件不触发 | fetch 被接管后 SW 语义被旁路（以实测为准） | SW 场景不给代理，或放弃代理 |
| iOS 回写后崩溃 | task 已 stop 还在回调 | stopURLSchemeTask 后回调非法 | 记活体guard；didFinish 前判 contains |
| 回包没 finish | 请求永远 pending | 异常路径漏掉 didFail/didFinish | 每条路径都收口（success/fail/超时） |

---

### 3.6 取舍表与决策建议

| 维度 | ① 拦截代理 | ② Bridge 代理 | ③ 自研内核 |
|---|---|---|---|
| 接入成本 | 中（改容器，前端无感） | 高（前端全量改 API 调用） | 极高（内核级重写） |
| 能力覆盖 | 中：签名/HTTPDNS/监控生效；但缓存头、SW、流式需代理层复刻 | 高：管道一能力全量可用（含 POST、RPC 协议） | 极高：网络栈整体接管 |
| 对现有 H5 的破坏 | 低（前端不改代码；风险在语义差异） | 高（调用方式/错误码契约全换） | 高（内核与页面行为都变） |
| 调试复杂度 | 中：一跳变两跳，抓包看"拦截前/后"两条 | 低~中：收敛到原生一侧，问题好归因 | 高：内核黑盒 |
| Service Worker | ❌ 破坏（fetch 被旁路） | ❌ 基本不适用（未触发网页 fetch） | 视内核实现 |
| HTTP 缓存头 | 由原生网络库策略接管 | 由原生策略接管 | 内核自定义 |
| POST body | ❌ 拿不到 | ✅ 协议可带 | ✅ |

**决策建议（落到常见场景）**：
- **存量 H5 想快速让 API 带上签名/HTTPDNS/监控** → 优先 **① 拦截代理**：领域内灰度 API 域名，前端零改动；POST 走桥兜底。这是多数团队的性价比之选。
- **新建/可重构的 H5，接口是全量 API**，且团队能维护桥契约 → **② Bridge 代理**：能力天花板最高，页面向"壳能力"靠拢。
- **想做 SW / 离线小应用** → ①②都别动这块，SW 与"接管"语义互斥（以实测为准）；离线诉求交给阶段 7 的离线包机制。
- **团队真的在做容器/内核自研** → 才考虑 **③**；公开层面对齐"网络栈代理到统一网络层"的共性即可。

---

### 3.7 自测题

1. `shouldInterceptRequest` 能拦到 H5 里 `fetch()` 发起的请求吗？它最致命的盲区是什么？
2. `WebResourceResponse(encoding)` 第二个参数应该填什么？把 `gzip` 填进去会发生什么？
3. `WKURLSchemeHandler` 默认只拦哪类 scheme？为什么"拦 http(s)"通常不建议做？
4. 为什么说 Bridge 代理"接入成本最高、能力最全、和 JS 绑定最深"？举两个具体表现。
5. 决策题：存量 H5 全是业务 API 页面、想尽快带签名上监控，选 ①②③ 哪条？POST 接口怎么办？
6. 动手题：跑 demo 的拦截骨架，在 Charles 里观察一条被代理的请求——它应出现"两条记录"（WebView 发出前的拦截不抓包可见原因 + OkHttp 实际发出带 `X-Sign`），解释为什么。

<details>
<summary>参考答案（思考后再点开）</summary>

1. **能拦到**（fetch/XHR 也是 WebView 网络栈的资源请求）。盲区：**读不到 POST 请求体**，所以拦到了也重放不出；POST 走桥。
2. 应填**字符集**（如 `utf-8`）。填 `gzip` 会让 WebView 把字节流当 gzip 文本解码→乱码；实际 OkHttp 已透明解压。
3. 只拦**自定义 scheme**。http(s) 由 WebKit 自持、handler 不生效；硬做要 scheme 映射 hack，丢证书校验/缓存/SW 语义（以实测为准）。
4. 每个 API 调用点要改 `requestApi(action, data)`（成本）；原生能力全量可用（能力）；契约=action 白名单+回包格式+错误码+超时，全绑在桥上（绑定深）。
5. 选 **① 拦截代理**（前端零改动、按域名灰度）；POST 接口单独走 **Bridge 兜底**。
6. 被代理的请求在 Charles 常看到的是 **OkHttp 那一次**（或两次，取决于内核是否也发了原请求被替换），其中带 `X-Sign`/`公共头` 的即管道一发出的那条；`WebView 原本要发的那份`被你的响应替换掉了。以实测为准。

</details>

---

## 4 · 网关登录态与弱网剖析：管道二到底缺了什么

---

### 4.1 问题引入

"我明明 App 里登录了，为什么 H5 接口还是 401？""我们上了 HTTPDNS，H5 怎么还在劫持？""这个请求在客户端监控大盘里根本查不到。" 三个问题，同一个根因：**H5 请求走管道二，管道一的"三剑客"——网关签名、HTTPDNS、链路监控——根本不在它那条路上。**

---

### 4.2 先破误区

> • 误区："App 登录了，H5 就天然是登录态。"
> • 事实：登录态是"带凭证的请求被网关认出来"的结果。H5 请求不带网关要的那张凭证（token/sign），网关就答 401——登录没登录都如此。

> • 误区："HTTPDNS 是全局的，加在哪都一样。"
> • 事实：HTTPDNS 只对【走绑定它的那套网络栈】的请求生效。H5 走管道二，默认不经过它。

> • 误区："H5 接口慢，说明网络库有问题。"
> • 事实：先归因"走哪条栈"，再谈是签名、DNS、还是连接池的锅（SOP 见第 5 节）。

---

### 4.3 原理讲解

#### 4.3.1 网关怎么知道"你是谁"：签名与 token

多数公司的网关（API 网关）不是"放行所有请求"，而是认一个**凭证**：token（业务身份）+ 更严的手机签名 / 报文签名（`appSign`，由登录态、设备、参数按固定算法算出，防篡改）。

- **token 从哪来**：容器在登录成功后拿到 token（常存 ClientStorage / Cookie），通过**桥**暴露给 H5，或把它当成公共头/Cookie 注入 WebView。H5 侧的"命令行"：`window.myBridge.getToken()` 或 `window.myBridge.getAuthInfo()`。
- **签名从哪来（两条注入路径）**：
  1. **桥拿容器 token → 前端带**：前端 `requestApi` 时把 token/sign 放进公共 header 或参数。简单直白，但签名算法一旦复杂（或想防篡改）就搬不动。
  2. **拦截器注入**：走第 3 节方案①（拦截代理）时，容器在网络库拦截器里自动补签名头——前端无感、签名不出前端、更安全。

**📌 关键：签名/HTTPDNS/监控对 H5 生效的前提 = 该请求必须走管道一的网络栈。** 没有这个前提，token 只能靠 JS 手动带、签名只能靠前端自己做弱校验、监控只能靠前端埋点。这就是"网关三剑客在管道二缺位"的根源。

#### 4.3.2 HTTPDNS 与系统 DNS：区别 + "对 H5 生效"的前提

| | 系统 DNS（管道二默认） | HTTPDNS（绑在管道一） |
|---|---|---|
| 解析方式 | 走系统 resolver，UDP 53，明文问询 | 走 HTTP(S) 接口向权威 DNS 服务商拿 IP |
| 优点 | 无需改动，浏览器自带 | 抗中间人劫持、结果可缓存可调，弱网更稳 |
| 缺点 | 可被运营商劫持污染、公司域名常背锅 | 要接入；**只对它绑定的栈生效** |

`httpdns://api.example.com` 这类写法只在客户端网络库内部被识别。网页里照样 `https://api.example.com` → 由 WebView 内核用**系统 DNS** 解析。所以：
- "加了 HTTPDNS 为何 H5 没提速" —— 归因很明确：**HTTPDNS 只作用于管道一，这条 H5 请求在管道二**。
- 想让 H5 享受 HTTPDNS，只有两条：让请求走管道一（第 3 节方案①），或前端用 **DoH（DNS-over-HTTPS）** 直接请求外部 DNS——注意 DoH 是网页行为、能得到防篡改的解析结果，但**不是**帮你 App 网关的私有 HTTPDNS，二者别混。

#### 4.3.3 弱网信号与 WebView 里前端能控制什么

弱网表现三类：**超时**（不响应）、**重试**（偶发瞬断→失败）、**降级**（降分辨率/降清晰度/切备用域）。在管道二的 WebView 里，这些信号大部分**不受前端精确控制**：

| 信号 | 管道二里前端能做什么 |
|---|---|
| 超时（慢但不断） | 用 `AbortController`/`Promise.race` 自己设超时并向用户兜底；但**无法改内核的 connect/read 超时**（以实测为准） |
| 重试 | 手动指数退避重发；**内核自动重试不归你管**，只能靠抓包观察 |
| 降级 | 图片 `loading="lazy"`、切低清源、备用 CDN——这些**前端可做** |
| 连接池/TLS 复用 | 内核自持，多半**前端管不了**（案例见第 5 节 caseC） |

一句话：**前端能改"业务层"（超时、重试、降级），改不了"内核层"（连接池、TLS、真正的网络超时语义）**——这正是"弱网优化是客户端网络库能力"而 H5 拿不到的原因之一。

#### 4.3.4 H5 侧弱网兜底：组合拳思路

想要不依赖管道一，前端也能给用户体感兜底，思路是三类拼起来：

| 机制 | 作用 | 适用于 |
|---|---|---|
| **离线包** | 首屏静态资源不依赖网络，弱网也能开 | 首屏 html/js/css（阶段 7 细讲） |
| **重试指数退避** | 接口瞬时失败自动重试，jitter 防雪崩 | 幂等 GET/查询接口 |
| **关键接口桥代理** | 登录/下单/支付等关键接口改走原生网络库 | 网关签名、强校验、支付等强依赖管道一能力 |

这三条不是互斥而是**分层**：静态走离线、幂等走重试、关键走桥——弱网下把"打开就白屏"变成"页面能开 + 接口尽力 + 关键保活"。

---

### 4.4 代码验证

#### 4.4.1 桥拿 token + H5 补头（前端强制带上登录态）

```javascript
// 平台：H5。即便不走管道一，也让请求带上 token 补"登录态"。
const token = window.myBridge?.getToken?.();        // 容器桥暴露；无桥则为 null
const authHeaders = token ? { 'X-Auth-Token': token } : {};

const resp = await fetch('/api/user', { headers: authHeaders });
if (resp.status === 401) {
  // 登录态失效：让容器重新登录并刷新 token（桥），再决定是否重放
  const refreshed = await window.myBridge?.refreshLogin?.();
  if (!refreshed) window.location.href = '/login';
}
```

#### 4.4.2 重试指数退避（前端可控的弱网兜底）

```javascript
// 平台：H5。幂等 GET 用指数退避 + jitter，避免雪崩。
async function withRetry(fn, { retries = 3, baseMs = 500, maxMs = 4000 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      const jit = Math.random() * 0.3 * baseMs;
      await new Promise(r => setTimeout(r, Math.min(baseMs * 2 ** i, maxMs) + jit));
    }
  }
}
const data = await withRetry(() => fetch('/api/list').then(r => r.json()));
```

#### 4.4.3 关键接口兜底：判断"该走管道一还是管道二"

```javascript
// 平台：H5。用容器能力做"管道归因"再决定走法。
function shouldUseBridge(action) {
  // 生产里按 action 白名单/域名判定；这里示例
  return /^(pay|login|placeOrder)$/.test(action) ||
    (navigator.onLine === false && typeof window.myBridge?.request === 'function');
}
// 关键接口：走桥（管道一，网关签名/HTTPDNS生效）
// 普通接口：走 fetch（管道二，前端自带 retry/token）
```

（上一小节为思路骨架，实际按你们容器的能力清单封装 `requestApi` 判断。）

---

### 4.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 带 token 仍 401 | 加了 `X-Auth-Token` 还是被网关拒 | 网关要的是签名(sign)，不是 token | 走拦截器注入真签名；token 只解决"身份"不解决"防篡改" |
| 桥 token 过期不同步 | H5 侧 token 过期但容器没刷新 | 桥 token 生命周期未打通 | 401 检测 + 桥刷新回放（§4.4.1） |
| 误以为 DoH=HTTPDNS | H5 用了 DoH 还是 401/慢 | DoH 只解决 DNS 可信，不解决管道一能力 | 需要管道一能力仍要走桥/拦截代理 |
| 弱网超时"失效" | 前端设置了 timeout 仍卡很久 | 内核网络超时语义不受 JS 控制 | 用 `AbortController` 兜底；以实测为准 |
| 离线包误用 | 想靠离线包救"登录/下单"接口 | 离线包只管静态资源 | 关键接口走桥，别把接口硬塞离线包 |

---

### 4.6 自测题

1. "App 登录了，H5 接口就天然 200"——错在哪？
2. HTTPDNS 对 H5 生效的前提是什么？不加前提想用，前端可退而求其次用什么？
3. 弱网下，前端能控制"超时/重试/降级"中的哪类？
4. 给一个 H5 侧弱网兜底的三件套组合？为什么关键接口要走桥？
5. 动手题：在 Charles 里对同一接口分别看"原生请求"和"H5 fetch"的响应耗时，再给 H5 fetch 加上 4.4 节的重试模板与“桥拿 token”补头，观察 401 是否仍复现。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 登录态=请求被网关凭凭证认出。H5 请求默认不带网关签名的凭证（token/sign），网关答 401。
2. 前提=走管道一的网络栈。前端可退而求其次：DoH（DNS-over-HTTPS）解决 DNS 可信问题，但那是网页级，不同于 App 私有 HTTPDNS。
3. 能控制"业务层"：超时（AbortController）、重试（指数退避）、降级（低清/备用源）；控制不了内核层连池/TLS/内核网络超时语义（以实测为准）。
4. 三件套=离线包（静态）+ 重试指数退避（幂等接口）+ 关键接口桥代理（登录/支付）。关键接口走桥，是因为网关签名/HTTPDNS/强校验只在管道一生效。
5. 原生请求带签名/走网络库耗时多数更稳；H5 fetch 补 token+retry 后，登录态侧 401 缓解但"签名类 401"不缓解，恰好证明"token≠sign、管道二缺签名"。

</details>

---

## 5 · 线上疑难分析 SOP：管道归属三步法 & 三个高频 case 走查

---

### 5.1 问题引入

线上一条 H5 接口慢 / 401 / 抓不到包。你查前端、查容器、查网络库，三头都查不得要领。**很多时候不是代码 bug，是"这条请求到底走哪条栈"没判清。** 本节给你一套可复用的归因流程 + 三个高频 case 的走查模板，把"玄学排查"变成"三步定案"。

---

### 5.2 先破误区

> • 误区：一出现"网络慢"就下结论"网络库问题"。
> • 事实：近 80% 的此类问题，根因是"请求归属没判对"——H5 请求压根没在客户端网络库里，自然没有它的签名/HTTPDNS/监控。

> • 误区："抓包能抓到 = 走了客户端网络库。"
> • 事实：系统代理（Charles）对两条栈都生效，抓到不等于走管道一。要按下面三步定案。

---

### 5.3 原理讲解：一张决策树 + 判定三步法

![线上疑难归因流程图](/images/webview-and-native/stage6-03-incident-flow.png)


**管道归属判定三步法（顺序执行，跳步必踩坑）**：

1. **看 UA 特征定"疑似哪条栈"**
   ```text
   Charles/抓包里：User-Agent 含"; wv)"（Android WebView）→ 像管道二
                  出现容器的自定义标识（如 myapp/2.x）→ 可能是容器 UA（需再确认是否真走客户端）
                  出现 okhttp/4.x（若是原生库自带）→ 像管道一
   注意：UA 是"疑似"，容器可改写/伪装 UA → 必须进第 2 步确认
   ```
2. **看抓包证书链 / header**
   ```text
   缺统一签名头(X-Sign)、无客户端公共头、内核 UA → 几乎确认管道二
   带签名头 + 客户端库证书信任策略 → 像管道一
   （HTTPS 解密看证书链可区分信任锚；以实测为准）
   ```
3. **看客户端监控维度**（定案）
   ```text
   在客户端网络大盘 / 链路追踪里能搜到这条 URL 的请求时延 → 确证走了管道一（能下钻耗时）
   搜不到 → 不是"丢数据"，是根本没进管道一（改走前端监控/时序）
   ```

**三剑客与判定盒对应**（对照第 4 节）：
- **签名？** → H5 接口 401 / 原生请求组正常 → 判管道二缺签名
- **HTTPDNS？** → "上了 HTTPDNS 没提速/仍劫持" → 判请求归属，HTTPDNS 只作用管道一
- **连接池？**（caseC）→ H5 慢但原生快 → 判连接/TLS 复用是否在 WebView 生效
- **监控？** → 大盘查不到 → 判没进管道一

---

### 5.4 代码验证 / 三个高频 case 走查

#### 5.4.1 caseA · 原生接口正常，但 H5 接口偶发 401

**现象**：原生页所有接口 200；H5 页同一网关接口偶尔 401，重试后有的好有的不好。

**走查**：
1. **UA**：抓包看 H5 这条请求 = 内核 UA（`; wv)`），且**无签名头** → 疑似管道二。
2. **证书链/header**：HTTPS 解密看去签名头确实缺；对比原生请求有 `X-Sign`。
3. **监控**：客户端大盘搜不到这条 H5 URL → 确认管道二。

**定位**：**"H5 请求没走内网网关签名"**。网关对无签名请求随机/按策略给 401（不因你登录成功就放行）。

**命令行/日志关键字**：
```bash
# 用 tcpdump 或 Charles 导出，grep 同一 URL，对比两端请求头
tcpdump -s 0 -A -i lo0 'tcp port 443' | grep -A2 'GET /api'    # macOS 抓 HTTPS 明文需代理解密
# Charles 里导出 .har，或直接看 Response Header 里的网关错误码
curl -s -D - 'https://gateway.example.com/api/x' -H 'X-Sign: invalid'   # 复现"缺签名时的 401"
# 日志关键字：搜索 401 / wv) / X-Sign 缺省
```
（真机 HTTPS 要配合 Charles 根证书，见阶段 5 抓包基础。）

**处置**：让这条 H5 请求走上管道一（拦截代理补签名）或前端带真实签名凭证（第 4 节）；**不要**去后端"放行无签名 401"。

---

#### 5.4.2 caseB · 加了 HTTPDNS，H5 没提速

**现象**：原生接口 DNS 解析明显变快、抗劫持；H5 的页面/接口解析仍走系统 DNS（或仍被劫持）。

**走查**：
1. **UA**：H5 请求 = 内核 UA → 疑似管道二。
2. **抓包**：观察 DNS 阶段（Charles 能看到解析耗时，或用 `dig` 对比）；看 IP 是否落到 HTTPDNS 服务商返回的那组 IP → 仍是系统 resolver → 未走 HTTPDNS。
3. **监控/日志**：客户端网络库日志里有 `httpdns` 命中记录；H5 这条没有 → 确证"HTTPDNS 只作用管道一"。

**定位**：**HTTPDNS 没作用于这条 H5 请求**。

**命令行/日志关键字**：
```bash
curl -s 'http://your-httpdns.service/d?host=api.example.com'   # 验证 HTTPDNS 服务商给什么 IP
dig +short api.example.com                                     # 对比系统 DNS 给的 IP（若被劫持会不同）
# 日志关键字：httpdns / resolve / connect（仅原生请求出现）
```

**处置**：要么让 H5 走管道一；要么前端用 DoH 只解决"可信解析"，别指望它带给你 App 网关的私有 HTTPDNS 能力。

---

#### 5.4.3 caseC · H5 请求慢，但原生请求快

**现象**：同一接口，原生页 request 几十 ms，H5 fetch 要 300ms+，尤其首次。

**走查**：
1. **UA**：H5 这条 = 内核 UA → 像管道二；原生对照 = 客户端 UA。
2. **抓包时序**（Charles 分步打开看 connect/TLS/data 阶段）：H5 首次常含 **connect + TLS 握手**；原生首次也可能有新连，但**复用后**第二次原生走连接池几乎零开销。
3. **判定**：**"连接池复用 / TLS 会话复用是否在 WebView 生效"**——WebView 可能不复用/缓存策略不同（同源多请求是否共连、TLS 会话是否缓存），**以实测为准**（抓包看相同 SNI 的 connect 次数）。

**定位**：H5 慢在连接/TLS 建立阶段，而非业务后端；原生靠连接池/TLS 复用摊薄了该成本。

**命令行/日志关键字**：
```bash
# Charles 步骤条看 connect/TLS/data 耗时占比；线程里搜 TCP handshake 次数
# 或用网络监控 SDK 在 H5 侧打点：performance + Resource Timing
window.performance.getEntriesByType('resource').filter(e=>e.name.includes('api'))
  .forEach(e => console.log('connect', Math.round(e.connectEnd-e.connectStart),
                            'tls',    Math.round(e.secureConnectionStart?e.connectEnd-e.secureConnectionStart:0)));
# 日志关键字：connect=TLS / reused connection / fromCache in WebKit console Timeline
```

**处置**：判断是"需要优化连接复用"（尽量少用动态参数打散 URL、同域聚合），还是"该走管道一拿连接池"（高频接口）。**以实测的 connect 阶段耗时决定**，别凭感觉。

---

### 5.5 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 跳步直接定案 | 把 H5 慢甩锅网络库 | 没先判归属 | 严格按三步走：UA→证书/头→监控 |
| 拿 UA 下死结论 | UA 被容器改写判错 | UA 可伪造/覆盖 | UA 只定位疑似，进第 2/3 步确认 |
| "抓不到包"当没发 | 强缓存命中不触网 | HTTP 缓存短路 | 区分"没发"与"被缓存"；看缓存命中日志 |
| 只看一次样本 | 偶发 401/慢 误判成常态 | 样本量不够 | 多抓几条 + 对比原生对照组 |
| 服务器 AccessLog 误导 | 认为是后端慢 | 忘看客户端侧 connect/TLS 阶段 | 用 Resource Timing 把服务端/传输分离 |

---

### 5.6 自测题

1. 说出三条"判定三步法"的顺序与每一句要点。
2. caseA 中，为什么"原生都 200、H5 偶发 401"常被归因为"网络库没打通"？
3. caseB 中，HTTPDNS 已经上了，为什么 H5 还是系统 DNS 解析？
4. caseC 里，怎么用 `performance.getEntriesByType('resource')` 分离出 connect 耗时？
5. 动手题：用第 3 节的拦截代理，把 caseA 那条 H5 接口代理进管道一，重测 401 是否消失，并用三步法确认请求现在落进客户端监控。

<details>
<summary>参考答案（思考后再点开）</summary>

1. ①看 UA 定疑似分栈 → ②看抓包证书链/header 确认 → ③看客户端监控维度定案。跳步必踩坑。
2. 不是网络库没打通，而是**H5 请求根本没在客户端网络库里**，没带网关签名 → 网关 401。
3. HTTPDNS 只作用管道一；这条 H5 请求在管道二，仍走系统 DNS。要么让它走管道一，要么前端 DoH 只解决可信解析。
4. `e.connectEnd - e.connectStart` 是 TCP 建连（含 TLS）耗时；`secureConnectionStart` 存在进一步看 TLS 段。对比原生对照组（走管道一，连接池少建连）。
5. 代理后该请求应带 `X-Sign`、在客户端大盘可搜到；重测 401 消失。以实测为准。

</details>

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| 管道一 | 客户端网络库那条通道：原生代码用 OkHttp/URLSession 发的请求走的路，统一签名、HTTPDNS、监控都长在这上面。 |
| 管道二 | WebView 内核自带的网络栈：页面里 fetch/XHR/`<img>` 的请求默认都从它直发，App 层管不着。 |
| Chromium 网络栈（netstack） | Android WebView 内核内置的网络实现，也就是管道二在 Android 上的真身。 |
| WebKit / CFNetwork | iOS 上 WebView 用的系统网络栈，管道二在 iOS 侧的对应实现。 |
| OkHttp | Android 最常用的原生 HTTP 网络库，常再叠一层网关/Retrofit 封装，是管道一的典型本体。 |
| URLSession | iOS 原生发请求的系统 API（常被封装），iOS 版管道一的身份。 |
| HTTPDNS | 用 HTTP 接口直接向 DNS 服务商拿 IP、防运营商劫持的能力，默认只挂在管道一上。 |
| 统一签名 | 客户端网络库自动给请求补上防篡改签名头的机制，H5 请求默认享受不到。 |
| 链路监控 | 在请求出口埋点、把耗时成败上报大盘的能力，同样只覆盖管道一。 |
| 连接池 | 复用已建好的 TCP/TLS 连接、省掉重复握手的机制，两条栈的连接池互不相干。 |
| QUIC/HTTP3 | 建连更快的新一代传输协议，由网络库支持，管道二默认不沾你这套优化。 |
| Charles | 常用的抓包代理工具：系统代理对两条管道都生效，所以"抓到包"不等于"走了管道一"。 |
| 拦截器洋葱 | OkHttp 把多层拦截器串成"进层下发、出层上收"的链条，像剥洋葱一样一层层处理请求与响应。 |
| Application Interceptor | 最外层的应用拦截器，每次 `newCall` 只进一次，看不见重定向/重试的中间响应，只拿最终响应。 |
| RetryAndFollowUpInterceptor | 内置"重试与跟随"层：换路重试、跟随 3xx 跳转，401 时用 authenticator 换凭证重发，跟随上限 20 次。 |
| BridgeInterceptor | 内置"桥接"层：给请求补 Host、gzip、Cookie 等默认头，响应侧负责透明解压。 |
| CacheInterceptor | 内置缓存层：强缓存命中直接短路返回，没命中就带 条件头下探、304 则把缓存拼接回去。 |
| ConnectInterceptor | 内置建连层：到连接池找可复用连接，没有才做 DNS、TCP 连接和 TLS 握手。 |
| 网络拦截器 | 用 `addNetworkInterceptor` 加的层，每次真正触网都会进，缓存命中不触网就不经过它。 |
| CallServerInterceptor | 洋葱最内层，全链路唯一真正把请求报文写进网络、再读回响应的地方。 |
| RealCall | OkHttp 里一次请求调用的实体，拦截器链由它的 `getResponseWithInterceptorChain()` 组装。 |
| chain.proceed | 把（可能改过的）请求交给下一层拦截器，等下层全部处理完，沿洋葱把最终响应上收回来。 |
| DiskLruCache | OkHttp Cache 底层的磁盘缓存实现——OkHttp 只有磁盘缓存，没有内存缓存。 |
| Dns 接口 | OkHttp 的域名解析入口，把默认的 `Dns.SYSTEM` 换成 HTTPDNS 实现，管道一就全局生效。 |
| URLSessionTask | iOS 上一次请求的任务（三段式 Configuration → Session → Task），默认挂起、必须调 `resume()` 才开始。 |
| delegateQueue | URLSession 回调跑的队列，不保证主线程，更新 UI 要自己派回主线程。 |
| URLProtocol | iOS 官方文档允许的"最像拦截器"的钩子，注册进 `config.protocolClasses` 就能拦 URL 加载系统的请求。 |
| 拦截代理 | 容器在 WebView 真正发请求前，把请求“劫持”下来改用客户端网络库发送的一条路线 |
| shouldInterceptRequest | Android 给 WebView 的一次“把持请求”机会：返回 null 放行、返回 WebResourceResponse 就当响应 |
| WebResourceResponse | 容器塞回给 WebView 的自定义响应（状态码 + 头 + body 流） |
| WKURLSchemeHandler | iOS 上接管某类 scheme 请求的处理器，能手动回写响应 |
| startURLSchemeTask / stopURLSchemeTask | WKURLSchemeHandler 的生命周期：开始拦截 / 任务被取消时停止 |
| 自定义 scheme | 如 `myapi://` 这种非 http(s) 的协议串，WKURLSchemeHandler 默认只拦这类 |
| Bridge 代理 | 前端不再直接 fetch，而是把请求打包经桥发给原生、由原生网络库发的路线 |
| requestId | 前端为每个 API 调用生成的唯一编号，用来把原生回包对应回哪个 Promise |
| POST body 拿不到 | shouldInterceptRequest 只能替换响应、读不到原请求体，所以 POST 重放不出来 |
| 统一网络层 | 各厂自研内核“把 WebView 网络栈代理/重写到统一网络层”的公开目标表述 |
| 网关签名 | API 网关要求请求带的一个由登录态/设备/参数算出的篡改校验串，认不出就算 401 |
| token | 网关认的"业务身份凭证"，不像签名那样防篡改 |
| API 网关 | 前端背后统一收请求、做鉴权/限流/路由的那一层后端入口 |
| 签名注入 | 容器在拦截器里自动给请求补签名头的做法，前端无感、签名不出前端 |
| 系统 DNS | 走系统 resolver 的常规域名解析，WebView 默认用这套，易被运营商劫持 |
| DoH（DNS-over-HTTPS） | 网页侧用 HTTPS 请求外部 DNS 的方式，解决解析可信，但不等同于 App 私有 HTTPDNS |
| 弱网三类信号 | 超时（不响应）/ 重试（瞬时失败）/ 降级（降低清晰度/换源） |
| AbortController | JS 里手动取消请求的 API，用来补"前端自己的超时" |
| 重试指数退避 | 失败后按指数增长等待再重试，加随机 jitter 防雪崩 |
| 离线包 | 把静态资源打进 App，弱网下首屏也能开（阶段 7 详谈） |
| 关键接口桥代理 | 登录/支付等关键接口改走原生网络库，从而吃上网关签名与 HTTPDNS |
| 管道归属 | 判定一条请求走的是客户端网络库（管道一）还是 WebView 内置网络栈（管道二） |
| 判定三步法 | 先看 UA 定疑似 → 再看抓包证书链/header 确认 → 最后看客户端监控维度定案 |
| UA 特征 | 不同网络栈发出的请求 User-Agent 不同，可作"疑似哪条栈"的第一线索 |
| 证书链 | 抓包里 HTTPS 证书的签发链条，能看出请求被谁发出（WebView 栈 / 客户端库） |
| X-Sign | 客户端网络库给请求自动加的签名头示例名，带上即说明走了网关签名 |
| Resource Timing | 浏览器/WebView 暴露的资源请求耗时明细 API，可拆出 connect/TLS 阶段 |
| connect 阶段 | `connectEnd - connectStart`：TCP 建连（含 TLS 握手）耗时 |
| 连接复用 | 同一域名后续请求复用已有 TCP/TLS 连接、省去重复握手 |
| 对照组 | 排查时拿"原生页同接口请求"当参照，对比 H5 请求差异 |
| 缓存命中短路 | 强缓存命中时请求根本不发出去，"抓不到包"不等于"没发" |
