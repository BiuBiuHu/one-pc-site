---
title: 安全与权限
date: 2026-11-14
excerpt: "桥是能力也是后门。用信任三问看 JSBridge 怎么失守，上线前把配置安全和合规清单过一遍。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 10
lang: zh
draft: false
ogImage: /images/webview-and-native/stage9-01-jsbridge-trust.png
---

> 📖 本章由 3 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · JSBridge 安全模型：桥是能力，也是被打开的"后门"
- 2 · 经典漏洞复盘：五个案例，看桥怎么失守、防线怎么补
- 3 · 配置安全与合规清单：上线前，把这些一字一句过一遍
- 本章术语表

---
## 1 · JSBridge 安全模型：桥是能力，也是被打开的"后门"

### 1.1 问题引入

某天你们 H5 里多了个埋点 SDK，它的 `<script>` 从 CDN 加载。结果线上 App 里登录态莫名被读出，用户还被"自动"分享了内容。排查到最后：不是后端被黑，是**加载的脚本调了你们暴露给网页的桥方法** `share()`、`getToken()`——因为桥对任何能调用它的页面，一视同仁地放行。

桥是一把双刃剑：**JS 能调到的每个桥方法，就等于把一份客户端能力开放给了页面。** 页面可以是你们自己的，也可以是别人塞进来的——这个区分，正是本章要讲的核心。

---

### 1.2 先破误区

> • 误区："JSBridge 是 App 给自家 H5 用的，别人调不到。"
> • 事实：桥注入在 WebView 的 JS 世界里。任何能在这个 WebView 里执行 JS 的页面都够得着它——包括被 XSS 注入的脚本、第三方的 `<iframe>`、被劫持后 302 跳过去的恶意页面。桥不设防，就等于 App 把原生能力开放给了"任何能进这个窗的人"。

> • 误区："我收到 token 再调桥，把 token 给页面没关系，反正没公网可走。"
> • 事实：token 是"带着就能过门禁的凭证"。只要它被放进页面 JS 可见的内存里，一旦页面被注入脚本、被第三方 iframe 拉到、被截取，token 就被带走。最小化原则：页面要什么才给什么。

---

### 1.3 原理讲解：桥的信任模型三问

判断一座桥是否安全，不是问"这个桥有没有加密"，而是每次对被调用的方法问三个问题：

| 问题 | 要查清的东西 | 防御手段 |
|---|---|---|
| **哪个页面在调？** | 发起调用的是不是白名单里的域名 | 来源校验（host / origin / source） |
| **能调什么？** | 这个页面有没有资格调这个方法 | 方法级权限表 |
| **带了什么证？** | 有没有可信凭证证明"是你"，且没被篡改 | 签名 / token 最小化下发 |

三问皆过才放行。缺一问，这座桥就只在"侥幸"层面是安全的（图见下）。

![JSBridge 信任三问](/images/webview-and-native/stage9-01-jsbridge-trust.png)


#### 1.3.1 第一问：来源校验——最难也最容易被绕过

来源校验的目标：**识别"说话的是哪个页面"**。最常见的三种来源证据，各有坑：

- **Referer**：`http` 跳转时浏览器会带，但 `https→http`、`meta` 跳转、`noreferrer` 下会缺失；更致命的是它**由页面可控**，想伪造并不难，不能作为唯一依据。
- **document.URL / host**：当前文档地址。在 JS 里读它，比 Referer 可靠，但仍会被 `about:blank`（空地址）、`data:`、被 302 之后的主机地址搞出歧义。
- **跨域 iframe / 302**：页面 A 用 `<iframe src="https://evil.com">` 包一层，或把链接 302 到恶意域名——此时"当前文档"到底算 A 还是算 evil.com，以 WebView 实测为准，不同内核判定不一致。**这也是校验必须放原生侧、而不是放 JS 侧的原因**：JS 侧自己判断宿主，宿主可能被页面自己说糊弄。

> 结论：来源校验要放在**桥的入口**（原生侧），并且**用"协议 + host"做整串判断**，别只用"后缀包含"。

#### 1.3.2 第二问：方法白名单——能调什么要按页面分级

身份的下一步是**授权**。把桥方法分成几档：

- `public`：任何白名单页面都能调（如 `hideLoading`）。
- `login` 级：需要登录态的 H5 才能调（如写 Cookie）。
- `sensitive`：仅限少数字台页或后台维护页（如发分享、取设备号），且通常要**二次确认**。

原生侧维护一张 **方法 → 允许域名集合** 的权限表，调方法时先查表。这张表不要写死在跳转逻辑里另一个地方，要和来源校验走同一份配置。

#### 1.3.3 第三问：凭证——签名与 token 的最小化

- **签名**：对参数做 HMAC（密钥只在原生和后端，不在页面），页面不能自证。适用于"页面调桥时证明参数没被改"。
- **token 下发最小化**：别把"全量 token 一次性给页面"。页面要展示用户信息，就只给它信息；要调写接口，就给它一个**限时、限域、限方法**的最小 token。宁可多几次桥调用按需取，也别图省事一次发全。

---

### 1.4 代码验证：来源校验骨架（防御向）

下面给出**最小可用**的来源校验骨架，双端各一段。核心原则：在桥的入口用"协议 + host"做强判断，不在 JS 里判断。

#### 1.4.1 Android（Kotlin）· 桥入口判 URL host

```kotlin
// 平台：Android ｜ 用途：JSBridge 调用的来源校验骨架（防御向）
// 思路：App 里每个 WebView 绑定自己的"允许 host"列表；
//       任何 addJavascriptInterface / shouldOverrideUrlLoading 进入桥方法前，先过这条闸。
class SecureBridge(private val webView: WebView, private val allowedHosts: Set<String>) {

    // 精确匹配"协议+host"，不允许 *. 后缀包含（防 *.example.com 被 evil.example.com 顶替）
    private fun isAllowed(host: String): Boolean {
        val parts = host.lowercase()
        // 例：白名单只放 "app.example.com"，别放 "example.com" 或 "*.example.com"
        return allowedHosts.contains(parts)
    }

    // 桥被调用时的统一入口
    @JavascriptInterface
    fun call(method: String, json: String): String {
        val page = webView.url ?: return "{\"err\":\"no-url\"}"
        val host = Uri.parse(page).host ?: return "{\"err\":\"no-host\"}"
        if (!isAllowed(host)) return "{\"err\":\"forbidden-host\"}"

        // 第二问：查方法级权限表
        val permitted = permissionTable[method]?.contains(host) ?: false
        if (!permitted) return "{\"err\":\"forbidden-method\"}"

        // 第三问：敏感方法要求签名
        if (sensitiveMethods.contains(method)) {
            // 这里把签名校验留给原生+后端，页面没有密钥
            val sigOk = verifyHmac(json, serverNonce)   // 示意：HMAC 校验
            if (!sigOk) return "{\"err\":\"bad-signature\"}"
        }
        return dispatch(method, json)
    }
}
```

> 说明：`verifyHmac`、`dispatch` 是示意占位，不必照抄真实签名协议。这段要表达的是**顺序**：先验来源 → 再查方法权限 → 最后敏感方法验签名。哪一步不过都直接拒，不给任何业务反馈细节（防探测）。

#### 1.4.2 iOS（Swift）· decidePolicyFor 里判 host

```swift
// 平台：iOS ｜ 用途：WKWebView 的 WKNavigationDelegate 来源校验骨架（防御向）
// 思路：在导航层就把来源挡在门外，桥方法只对白名单 host 开放。
func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
) {
    let whitelist: Set<String> = ["app.example.com"]   // 精确 host，别用后缀匹配
    guard let url = navigationAction.request.url,
          let host = url.host?.lowercased(),
          let scheme = url.scheme?.lowercased(),
          scheme == "https",                          // 协议一起校验
          whitelist.contains(host)                     // host 精确命中
    else {
        decisionHandler(.cancel)                       // 来源不合法：直接取消
        return
    }
    // 方法级权限与签名校验放进 messageHandler 那一步（和 Android 对应）
    decisionHandler(.allow)
}
```

> ⚠️ 这类校验若长年手写 if/else 散落各处，后面就难维护；正规容器会把这份判断收敛成一份：**来源校验 + 方法权限表 + 签名** 一起配置的"安全桥接三件套"。

---

### 1.5 安全桥接三件套（直接照抄进评审清单）

| 序号 | 项 | 落地形态 |
|---|---|---|
| ① | **scheme / host 校验** | 桥入口 / 导航决策拦截层，精确匹配"协议+host"，拒绝后缀包含、拒绝凭 Referer |
| ② | **方法级权限表** | 方法 → 允许域名集合，原生侧集中配置；敏感方法单独列 |
| ③ | **敏感操作二次确认** | 分享、支付、取隐私信息前，弹系统级确认或走原生二次弹窗，不经页面 JS 直接执行 |

> 前端能贡献的：**不在 JS 里自己伪造来源**，明确区分"页面业务逻辑"和"桥调用"，敏感操作尽量不把完整 token 留在 JS 内存里（用完即弃 / 短时效）。

---

### 1.6 坑点清单

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 用后缀匹配域名 | 上线后 `evil.example.com` 能调桥 | `*.example.com` 把子域全放开 | 精确 host 白名单 |
| 只信 Referer | https 页面 Referer 缺失/可伪造 | 来源证据不可信 | 原生侧判 document 的 scheme+host |
| iframe 包一层 | 第三方 iframe 触发桥方法 | 跨域 iframe 对桥可见性以内核为准 | 校验 origin/source/顶层 frame |
| 302 后歧义 | 跳转后 host 判断错 | 重定向改了当前文档身份 | 导航决策层整串校验后再放行 |
| 全量 token 一次下发 | JS 内存泄漏/注入被带 token | 凭证过度下发 | 最小化、短时效、按需取 |

---

### 1.7 自测题

1. 简答：桥的"信任三问"是哪三问？各对应什么防御手段？
2. 判断：用 `Referer` 作为唯一来源校验是否可靠？为什么？
3. 简答：为什么 `*.example.com` 白名单比 `example.com` 更危险？
4. 动手：在你们容器配置里找桥的域名白名单，看它是精确 host 匹配还是后缀匹配。
5. 简答：token"全量一次下发"为什么危险？最小化的三条正交维度是什么？

<details>
<summary>参考答案（思考后再点开）</summary>

1. 哪个页面在调（来源校验）／能调什么（方法白名单）／带了什么证（签名 + token 最小化）。
2. 不可靠。https→http、`noreferrer`、`meta` 跳转都会让它缺失，且它由页面可控可伪造；只能作辅助。
3. `*.example.com` 把 `evil.example.com`、`pwn.example.com` 一并放开，等于把边界扩到整个子域命名空间。
4. （动手）重点看是否用"协议 + host"整串精确匹配，还是只要后缀包含就放。
5. 全量 token 留在页面 JS 内存，一旦被注入/iframes 拉走就泄露。最小化正交维度：限时（短时效）、限域（只给需要的页面）、限方法（只给够调某方法的最小权限）。

</details>

---

> **回顾**：桥安全不是单一手段，是"来源验证 + 方法授权 + 凭证最小化"的层层递进。下一节我们复盘五个经典漏洞，看防线是怎么被攻破、又怎么被补上的。

---

---

## 2 · 经典漏洞复盘：五个案例，看桥怎么失守、防线怎么补

### 2.1 问题引入

"这些漏洞都是十年前的事了，跟我有什么关系？"——有关系。今天一段 `loadUrl("file://...")`、一个打开的 `allowFileAccess`、一次没校验 host 的 scheme 路由，都可能是同型漏洞的新副本。本章按固定五段复盘五个案例。**只讲原理与防御，不提供任何攻击代码。**

---

### 2.2 漏洞 ①：addJavascriptInterface 反射漏洞（Android，API 17 前）

**年代背景**：Android 4.1（API 16）及更早，`addJavascriptInterface` 把整个 Java 对象挂进 JS，不要求注解。

**原理图景**：早期实现把 `obj` 的**公共方法全部映射**给 JS——包括从 `Object` 继承的 `getClass()`，拿到它就能沿反射链摸到可执行系统命令的类。前提：**WebView 加载了不可信内容**（被劫持页面、被注入的 XSS）。

**为什么会发生**：API 把"暴露对象"和"暴露能力"画了等号，无白名单；宿主又常加载第三方页面/广告，把全能力桥挂给了不可信内容。

**修复与防御**：API 17 起**必须给方法加 `@JavascriptInterface` 注解**，未注解方法对 JS 不可见——官方以"注解白名单"收口；再配合最小暴露、`removeJavascriptInterface` 移除内置高危对象。`minSdkVersion` 别降到 16；老设备改走"URL Scheme 拦截"通道。

**给前端的启示**：前端评审要问"这个桥挂给了哪些页面"——不可信页面能调到高危方法，锅在容器。

---

### 2.3 漏洞 ②：file 域攻击（Android）

**年代背景**：配置类漏洞，主角是两个 WebSettings 开关：`allowFileAccessFromFileURLs`、`allowUniversalAccessFromFileURLs`。

**原理图景**：默认值与版本相关（`allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` 自引入起默认即为 **false**，需显式打开才危险；`allowFileAccess` 在不同 API 级别默认值不同，新版本已默认 false——具体以你们目标的 API 级别实测为准）。前者允许 `file://` 页面用 XHR 读**其他本地文件**；后者更宽——本地页对**任意来源**的请求不受同源约束。前提是**本地 HTML 被注入**（如分享内容落地成临时 HTML 再打开），脚本便能读 App 私有文件。

**为什么会发生**：老代码保留历史默认值；"自己的 file 页面可信"假设不成立——本地页一样可能被塞恶意脚本；抄示例配置从未评估后果。

**修复与防御**：release 包**显式关掉**两个开关；不加载任意落地的本地 HTML；离线包走容器自家 scheme/拦截映射，不走 `file://`。

```kotlin
// 平台：Android ｜ 用途：file 域相关开关的防御性配置（骨架，防御向）
webSettings.apply {
    allowFileAccess = false                       // 按需开；能不开就不开
    allowFileAccessFromFileURLs = false           // API 17+ 默认 false，显式再关一遍
    allowUniversalAccessFromFileURLs = false      // 同上；开了必须进上线清单说明理由
}
```

**给前端的启示**：`file:` 协议不代表更可信，反而代表"能力受限或异常敏感"；别把敏感数据落成"让 App 再打开"的本地文件。

---

### 2.4 漏洞 ③：URL Scheme 劫持

**年代背景**：Android 的"scheme 抢注"与 iOS 的 scheme 钓鱼，跨年代通用问题。

**原理图景**：Android 的自定义 scheme（如 `hybrid://`）**不归一个 App 独有**——任何 App 都能在 manifest 里声明同一 scheme。若容器做 scheme 路由却**不校验调用方与参数来源**，第三方 App 就能构造同 scheme URL 拉起你的容器页并塞进伪造参数。另一分支：H5 被 302 指向恶意 scheme（`evil://...`），而拦截层没有白名单，恶意 host 也放行。

**为什么会发生**：scheme 本是公开的路由名却被当秘密；拦截层"只认 scheme 不认 host"；302 链路中间跳转的 host 不在校验范围。

**修复与防御**：**scheme 前缀校验 + 域名白名单双闸**——scheme 认自家的，host 认白名单；对外入口优先用 App Links / Universal Links 这类"域名可验证"机制；容器维护"允许拉起的原生页"路由表，表外拒绝。

**给前端的启示**：别把"调起原生"的 URL 放进分享链/二维码等不可控入口；`location.href = 'xxx://...'` 前确认走自家路由。

---

### 2.5 漏洞 ④：XSS 与桥的组合

**年代背景**：不是某个 CVE，而是一类组合问题——**Web 侧任意一个 XSS 都能被"放大"成客户端侧问题**。

**原理图景**：Web 里 XSS 的后果通常是"当前页为所欲为"。但 WebView 里页面背后**还挂着一座桥**：被注入的脚本拿到 `window.xxxBridge` 后，调桥 = 调客户端。**桥的能力上限，就是 XSS 的实际伤害上限。**

**为什么会发生**：XSS 被视为前端 Bug、桥被视为客户端资产，**没人把"XSS + 桥"当组合威胁建模**。

**修复与防御**：三层收口——① XSS 本身：输出转义、模板默认转义、CSP；② 桥最小化：`getToken` 等敏感方法不挂普通业务页；③ 敏感操作二次确认：分享/支付/取隐私弹原生确认框。

**给前端的启示**：评审报"页面有无 XSS 风险"时，**同时报挂了哪些桥方法**——伤害 = 页面 × 桥能力，两边都要进威胁模型。

---

### 2.6 漏洞 ⑤：消息伪造与来源歧义

**年代背景**：现代桥主力通道（`WKScriptMessageHandler` / 注入对象）是**挂在 WebView 上的"全局信箱"**，不天然区分"谁寄的信"。

**原理图景**：若页面里有**跨域 iframe**，部分内核/历史版本下其内脚本**可能触达宿主的桥对象或消息通道**（可见性以实测为准）。而原生侧若只信 `data`、不校验 `origin` / `source`，第三方页就可能"代仿"合法页面寄信。

**为什么会发生**：信箱是单实例，"信从哪来"要靠宿主主动校验；信任没有自动隔离。

**修复与防御**：原生侧**校验 origin / source / frame**（能力以实测为准）；消息加**一次性 nonce + 原生回执**防重放；高风险容器**禁止跨域 iframe** 或让桥**不暴露给子 frame**。

**给前端的启示**：少让"会调桥的页面"嵌第三方 iframe；必须嵌时用 `sandbox` 最小集隔离，并写死"iframe 域不享有桥权限"。

---

### 2.7 坑点清单

| 漏洞 | 一句话根因 | 今天仍要查的一行配置 |
|---|---|---|
| ① 反射 | 全量暴露未注解方法 | `minSdkVersion` ≥ 17；桥方法全加注解 |
| ② file 域 | 本地页同源被撕开 | release 是否显式关掉两个 file 开关 |
| ③ Scheme 劫持 | 只认 scheme 不认 host | 导航拦截是否 scheme + host 双校验 |
| ④ XSS + 桥 | 桥能力 = XSS 上限 | 业务页是否挂了 getToken 级方法 |
| ⑤ 消息伪造 | 只看 data 不看 origin | 原生是否校验 origin / source / frame |

---

### 2.8 自测题

1. 简答：`@JavascriptInterface` 注解修复反射漏洞的原理？白名单粒度是"方法"还是"对象"？
2. 判断：`allowUniversalAccessFromFileURLs` 默认是 true，对吗？（提示：分 API 版本。）
3. 线上出现"被 302 到 evil.com 的页面能调桥"，用上一节"三件套"的哪几件能挡住？
4. 动手：搜 H5 项目里的 `<iframe`，判断"它所在页面挂了哪些桥方法"。
5. 简答：为什么"XSS 的伤害上限取决于桥"？给两条削弱手段。

<details>
<summary>参考答案（思考后再点开）</summary>

1. API 17 起只把**带注解的公共方法**映射给 JS——粒度是"方法"，未注解的（含反射入口）全部不可见。
2. 分辨两件事：`allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` 引入起默认 false；`allowFileAccess` 的默认值随 API 级别有变（新版本默认 false）。以目标 API 实测为准。
3. 来源校验（导航层 host 白名单取消非法跳转）+ 方法级权限表。
4. （动手）重点看承载桥调用的页面；"第三方 iframe × 敏感桥"同页即风险组合。
5. 攻击者可用的最大能力 = 桥暴露给该页面的方法集合；削弱：方法级权限表 + 敏感操作原生二次确认。

</details>

---

---

## 3 · 配置安全与合规清单：上线前，把这些一字一句过一遍

### 3.1 问题引入

安全评审通过不代表能上线。多数翻车不是因为攻击高级，而是**上线前没人把 configuration 过一遍**：漏关 file 开关、release 留着调试口、明文没关、隐私清单少写一项……本章给双端「安全配置 + 权限链路 + 数据合规」对照，收口成一份可照抄的 15 条上线前 Checklist。

---

### 3.2 先破误区

> • 误区："WebView 安全 = 桥做好校验就行。"
> • 事实：桥只是话术里的进攻面之一。配置项（file 域、mixed content、明文流量、调试口）是另一张清单，漏一个就可能把前面所有校验归零。

> • 误区："关调试口影响我们联调。"
> • 事实：WebView 调试口（Android `setWebContentsDebuggingEnabled(true)` / iOS `isInspectable`）只该在 debug build 开。release 打开等于把整个 WebView 内容页暴露给能连上调试端口的任何人/工具。

---

### 3.3 原理讲解

#### 3.3.1 安全配置 Checklist（Android / iOS 双列）

| 配置项 | Android（WebSettings / manifest / network） | iOS（WKWebViewConfiguration / Info.plist） |
|---|---|---|
| file 域访问 | `allowFileAccess`（默认 true，需按场景关）；`allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs`（**API 17+ 默认关，release 保持关**） | iOS 无对等的 file 域同源穿透开关；`fileURL` 与 http 混合加载受限明显 |
| 混合内容 | `setMixedContentMode`：默认 `MIXED_CONTENT_NEVER_ALLOW`（若允许需显式设置，评估风险） | 无从属开关，策略由内核决定，涉及 http 资源时以实测为准 |
| 明文流量 | `usesCleartextTraffic`（`network_security_config` 里的 base 更细）——默认随 targetSdk 收紧，越新越严 | **ATS（App Transport Security）**：默认阻拦明文 HTTP；`NSAllowsArbitraryLoads` 只应临时/scope 开放 |
| 调试口 | `setWebContentsDebuggingEnabled(true)` 只在 debug，release 必须 false | `isInspectable` 只在 debug；release 关 |
| 证书锁定 | OkHttp CertificatePinner（pin 原生栈）；WebView 侧 pin 以实测为准 | URLSession / 相关库 pin；同样不等同 WebView |
| 证书锁定 × 抓包 | **pin 会直接让 Charles 抓不到**——内部调试环境用 **debug build 关掉 pin**，release 才开 | 同左：内部联调、抓包阶段用 debug 关 pin |

> ⚠️ 证书锁定防"中间人"，代价是"自己人抓不到包、证书一换就全线崩"：**仅 release 且只对高价值域名 pin；内部调试环境 debug build 关闭 pin**。粒度与范围进上线清单复核。

#### 3.3.2 权限链路：相机 / 定位 / 麦克风 / 相册

WebView 里 H5 用 `getUserMedia`、定位 API 申请权限，**不是一条直达系统弹窗的路**，中间隔着宿主：

- **Android**：`WebChromeClient.onPermissionRequest` 先被触发 → 宿主再走**运行时权限**（`requestPermissions`，需声明）→ 用户同意后**回写 H5**（`PermissionRequest.grant()`）。任一步漏，H5 都是拒绝。
- **iOS**：H5 的 `getUserMedia` 能否拉起系统弹窗**以实测为准**；即便 Web 侧通过，前提是 **Info.plist 写了对应用途描述**（如 `NSCameraUsageDescription`），没写就静默失败。
- 双端共性：**"宿主申请过一次"≠"每个页面都能用"**。被拒/撤回后的回调要打成闭环。

#### 3.3.3 数据合规：采集最小化

- **UA / 设备标识采集最小化**：UA 里带机型、系统版本就够排查用，别把能定位到个人的设备标识随手丢给第三方 SDK。
- **隐私同意前不采集**：拿到隐私授权（或符合当地合规前提）之前，不采集、不上报可识别用户的字段。
- 涉敏字段（IDFA 类标识、精确位置、相册内容）逐个过清单：**用到才请求、请求前先声明用途**。

---

### 3.4 代码验证：Android 权限链路骨架 + iOS 配置骨架

#### 3.4.1 Android（Kotlin）· 把 onPermissionRequest 接到宿主运行时权限

```kotlin
// 平台：Android ｜ 用途：WebChromeClient 把 WebView 权限请求交给宿主运行时权限（骨架）
class SecureWebChromeClient(private val host: Activity) : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
        // 逐个把 WebView 的请求映射到宿主运行时权限
        val wanted = request.resources.toList()
        val androidPerms = wanted.mapNotNull {
            when (it) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                else -> null          // 宿主不支持的资源，直接拒绝
            }
        }
        if (androidPerms.isEmpty() || host.checkSelfPermission(androidPerms[0]) != PACKAGE_GRANTED) {
            if (androidPerms.isNotEmpty()) {
                host.requestPermissions(androidPerms.toTypedArray(), H5_PERMISSION_REQ)
            }
            request.deny()            // 未拿到就拒绝；拿到后回写 grant()（示意）
            return
        }
        request.grant(wanted)
    }
}
```

#### 3.4.2 iOS（Swift）· release 关闭调试口 + 只开所需 ATS

```swift
// 平台：iOS ｜ 用途：release 关调试口（骨架）
#if DEBUG
    webView.isInspectable = true      // 仅 debug
#else
    webView.isInspectable = false     // release 关死
#endif
```
```xml
<!-- Info.plist 片段：能不开就尽量不开；开了也尽量 scope 到具体域名（示意） -->
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSExceptionDomains</key>
  <dict>
    <key>yourserver.example.com</key>
    <dict>
      <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
    </dict>
  </dict>
</dict>
```

> 上面的代码量足够你入评审参考，动手实验见 demo/stage-9-security（示例代码详见 demo 包）。

---

### 3.5 权限链路自测 / 坑表

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| H5 调相机直接被打回 | onPermissionRequest 没接或 Manifest 缺声明 | 权限没透传 | Android 接 onPermissionRequest + 运行时权限 |
| iOS 调麦没弹窗 | Info.plist 缺用途描述 | 缺声明 | 补 `NSMicrophoneUsageDescription` |
| release 能调试 | 真机连上调试口 | 调试口没按 build 关 | debug 开 / release 关 |
| 抓包全失败 | release 包 Charles 解不开 | pin 开着 / user CA 不信 | debug build 关 pin |
| 明文被拦 | http 资源加载失败 | ATS / cleartext 默认严 | 只对必须域名 scope 开放 |

---

### 3.6 上线前 WebView 安全与合规 Checklist（15 条）

![上线前 WebView 安全与合规 Checklist](/images/webview-and-native/stage9-02-launch-checklist.png)


**逐条勾完再发版**：

1. ⚠️ `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` 在 release 为关。
2. ⚠️ `allowFileAccess` 只在必要场景开启，不整体放开。
3. ✅ Mixed content（`setMixedContentMode` / ATS）对非必要域名保持阻拦。
4. ✅ 明文流量只对白名单内必要域名放开，其余仍禁。
5. ✅ WebView 调试口（Android / iOS）release 一律关。
6. ✅ 证书锁定只 pin 高价值域名，内部环境用 debug 关 pin。
7. ✅ JSBridge 白名单校验（scheme + host）已启用，不靠 Referer。
8. ✅ 桥方法按权限表分级，敏感方法不挂普通业务页。
9. ✅ 敏感操作有原生二次确认。
10. ✅ 相机/定位/麦克风/相册权限链路双端打通并有回写。
11. ✅ Manifest（Android）与 Info.plist（iOS）权限用途描述齐全。
12. ✅ UA / 设备标识采集已最小化，无多余字段给第三方。
13. ✅ 隐私同意前不采集、不上报可识别用户字段。
14. ⚠️ 引入的第三方 SDK 逐个过权限与数据边界评审。
15. ✅ 白名单域名、路由 scheme 表与其《生效环境对应表》版本一致。

---

### 3.7 自测题

1. 简答：为什么 WebView 调试口不能留在 release？它暴露的是什么？
2. 简答：Android H5 调相机，完整链路经过哪三层？漏了哪层会怎样？
3. iOS 里 H5 `getUserMedia` 不弹系统的排查起点是什么？
4. 判断：证书锁定开了就一劳永逸。（提示：抓包、证书轮换。）
5. 动手：用上面的 15 条把你的一个线上 H5 容器过一遍，写出没过的项。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 调试口等于把页面内部（DOM、脚本、存储、网络）开放给连接者；release 开着 = 任何能连上的人都能读到业务，属于高危。
2. `onPermissionRequest`（WebView 层）→ 宿主运行时权限（系统层）→ 回写 `grant()` 给 H5；漏宿主层不会弹窗。
3. 先查 `Info.plist` 是否写了对应用途描述（如 `NSCameraUsageDescription`）；再看 WebKit 侧 `getUserMedia` 在你们内核里是否支持（以实测为准）。
4. 错。pin 防中间人，但会让 Charles 等内部抓包失效、证书轮换时冒全挂风险；策略是 debug 关、release 只对高价值域名 pin。
5. （动手）重点通常是 6/7/11/14 几条——pin、白名单、用途描述、第三方 SDK。

</details>

---

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| 域名白名单 | 一张"只有这些域名能过"的允许名单，只有命中的页面才给放行。 |
| 来源校验 | 在桥入口先查"到底哪个页面在调"，确认不是别人冒充。 |
| 方法白名单 | 按"方法 → 允许的域名"做权限分档，页面没有资格的方法直接不给调。 |
| token 最小化 | 别把全套凭证一次交给页面，按需发"限时、限域、限方法"的最小凭证。 |
| HMAC 签名 | 用只有原生和后端知道的密钥对参数做摘要，页面自己伪造不了。 |
| Referer | 请求头里"我从哪来"的标注，但这值页面可控，只能当辅助证据。 |
| XSS | 攻击者往页面里注入脚本，"借你的页面身体"干坏事。 |
| addJavascriptInterface | Android 把原生对象暴露给 JS 的入口，暴露面越大越危险。 |
| 后缀匹配 | 用 `*.example.com` 这种宽松判断，容易把 `evil.example.com` 也放进来。 |
| 302 重定向 | 服务器把请求转跳另一个地址；中间那跳若不算 host 就可能绕过校验。 |
| 跨域 iframe | 一个页面里嵌的"别人家的"子页面；它对桥是否可见要以内核实测为准。 |
| 敏感操作二次确认 | 分享/支付/取隐私前弹系统或原生确认框，不靠页面 JS 直接执行。 |
| addJavascriptInterface 反射漏洞 | 早期 Android 把 Java 对象整个挂给 JS，攻击者顺着 `getClass()` 反射链一路摸到能执行系统命令的类。 |
| @JavascriptInterface 注解 | API 17 起的"方法白名单"：JS 只能看见带这个注解的方法，其余一律不可见。 |
| minSdkVersion | 工程里声明的最低支持的 Android 版本；降太低会让老设备的旧漏洞复活。 |
| file 域攻击 | `file://` 页面被注入脚本后，借宽松开关去读 App 私有本地文件的攻击面。 |
| allowFileAccessFromFileURLs | 开关：允许 `file://` 页面用 XHR 读其他本地文件。API 17 起默认关，release 保持关。 |
| allowUniversalAccessFromFileURLs | 更狠的同级开关：本地页对任意来源的请求都不受同源约束，等于把同源策略撕开。 |
| URL Scheme 劫持 | 自定义 scheme 不归一家独有，别的 App 抢注同名 scheme 就能伪造"调起原生"的 URL。 |
| App Links / Universal Links | 用可验证的域名归属替代裸 scheme 的官方拉起机制，比 scheme 难伪造。 |
| 同源策略 | 浏览器的基本隔离规则：不同来源的脚本互不许随便读对方的数据。 |
| CSP | Content Security Policy，网页上了一层"哪些脚本允许跑"的声明，用来压住 XSS 注入面。 |
| nonce | 一次性随机数，用来标记"这条消息是刚发的、不是重放的旧消息"。 |
| 消息伪造 | 桥的"全局信箱"不天然区分来信人，第三方页面模仿合法页面给原生寄假信。 |
| Mixed Content | HTTPS 页面里混进了 http 子资源，这个"混"本身就是个安全隐患，默认被拦。 |
| 明文流量 | 不走 TLS 加密的裸 http 传输；抓包就能看到内容，默认越新的系统管得越严。 |
| ATS | iOS 的强制 HTTPS 开关，默认拦明文 HTTP；要放开只能对特定域名做例外。 |
| usesCleartextTraffic | Android 侧"是否允许明文 http"的总开关，通常交给 network_security_config 更细控制。 |
| allowFileAccess 系列 | 控制 `file://` 页面的本体访问权限；能不开就不开，release 保持显式关闭。 |
| 证书锁定 | 客户端写死"只认这把证书"，防中间人；代价是自己人抓包难、换证书易全挂。 |
| 调试口 | WebView 允许外部连上看页面内部（DOM/脚本/存储/网络）的开关：`setWebContentsDebuggingEnabled` / `isInspectable`。 |
| onPermissionRequest | Android 上 WebView 把 H5 权限申请先交给宿主这一层，宿主再转走运行时权限。 |
| 运行时权限 | App 在运行期间向用户申请的实际系统权限，声明了才弹得出且要用户同意。 |
| Info.plist | iOS 的配置文件；权限用途描述（如 `NSCameraUsageDescription`）没写对，H5 调相机就静默失败。 |
| Manifest | Android 清单文件；权限要在这里声明，缺了声明底层就不会给。 |
| IDFA | iOS 用来跨 App 追踪用户的广告标识符，属于敏感、要最小化采集的字段。 |
| 隐私清单 | 上线前对"采集什么、上报给谁"做的合规核对，未同意前不采集可识别用户字段。 |
| 采集最小化 | 原则：只要够排查使用的字段，别把能定位到个人的设备标识随手丢给第三方 SDK。 |
