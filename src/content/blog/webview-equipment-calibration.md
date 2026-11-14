---
title: 装备与认知校准
date: 2026-11-14
excerpt: "同一份 H5 在安卓、iPhone、微信和银行 App 里表现不同，往往不是前端写错了，而是容器、内核和调试装备不一样。先把最小可运行环境搭起来。"
category: WebView 与客户端
series: WebView 与客户端
seriesOrder: 1
lang: zh
draft: false
ogImage: /images/webview-and-native/stage0-01-debug-tools.png
---

> 📖 本章由 2 节合并而成，便于整体阅读与分享。逐节精读/修改请用本目录下的分篇源文件；配图相对路径仍有效。

**本章目录**

- 1 · 装备清单与环境搭建——"同一份 H5，为什么在安卓、iPhone、微信、银行 App 里长得不一样"
- 2 · 认知校准测试——10 道易错题，先测出你把 WebView 想岔在哪
- 本章术语表

---
## 1 · 装备清单与环境搭建——"同一份 H5，为什么在安卓、iPhone、微信、银行 App 里长得不一样"

---

### 1.1 问题引入

你把同一个 H5 打进安卓、iPhone、加了壳的银行 App 里跑，`alert` 长得不一样、返回键回退行为不一样、有的能 `localStorage` 持久化、有的重启就清。前端第一反应是"我的代码在不同浏览器渲染有差异"，于是去查 CSS 兼容。查了一小时没结果——因为你工具没配齐，连"这个页面到底跑在哪个壳、走哪条网络管道"都看不见。

本节先把**调试装备**和**最小可运行环境**搭起来。它不教你写客户端，只让你能看懂客户端工具、能归因、能验证。读完后你一小时内能跑通"一个本地 HTML 分别在 Android / iOS 的 WebView 里打开"。

---

### 1.2 先破误区

> • 误区 A：WebView 里的页面 = 浏览器里打开，用浏览器 F12 一样能调试。
> • 事实：WebView 没有地址栏、没有可访问的 DevTools 入口。调试必须靠端侧工具（chrome://inspect / Safari 检查器），且项目未必开了调试开关。

> • 误区 B：App 里的网络请求都走客户端的网络库，抓包就等于看 OkHttp 日志。
> • 事实：H5 里的 `fetch`/XHR/图片走 WebView 内置网络栈（管道二），与客户端 OkHttp/URLSession（管道一）是两条独立管道（总章 §0.5）。抓包、证书信任、HTTPDNS 都要按"管道二"来理解。

> • 误区 C：装了 Charles 根证书就能抓 HTTPS。
> • 事实：只是装了不等于被信任。Android 7+ 默认不信任用户证书、iOS 要手动开"完全信任"——这两条是抓包"装上还不行"的头号原因。

---

### 1.3 原理讲解：一张工具矩阵 + 三条信任链路

#### 1.3.1 工具族谱（一张图看清）

![调试工具矩阵](/images/webview-and-native/stage0-01-debug-tools.png)


这张图把工具按**作用于总章三层模型的哪一层**分：`adb`/`Xcode Devices`/`Android Studio` 管 **System 层**（设备、菜单、证书信任），Charles 横跨 **System + Container 层**，`chrome://inspect`/Safari 检查器/vConsole 管 **Web 层**（DOM/JS/网络/存储）。下文逐一拆解各工具的原理与用法。

- **Android Studio（SDK / 模拟器 / adb）**：装好 `platform-tools`，`adb devices` 能列出设备。`adb` 是 Android 调试的脐带：`adb install` 装包、`adb logcat` 看日志、`adb push` 把证书/文件推进设备。
- **Xcode（模拟器 / 真机签名 / Devices 窗口）**：iOS 只能在 macOS + Xcode 上开发。模拟器在 `Xcode → Open Developer Tool → Simulator`；真机要到开发**签名**（开发者账号 + 信任证书）；`Window → Devices and Simulators` 看设备清单。
- **Charles（HTTPS 抓包）**：核心是**中间人（MITM）+ 自签根证书**。Charles 有私钥，它给每个域名下发一张"用 Charles 根证书签发的域名证书"。要看明文，必须同时满足三层：
  1. **装上** Charles 根证书（系统/用户证书库都有才算）；
  2. **被信任**（见下 3.2）；
  3. **打开 SSL Proxying**（并勾选目标域名）。只装证不开 SSL Proxying，HTTPS 只能看到 `CONNECT` 隧道、见不到内容。
- **chrome://inspect**：Chromium 系 WebView 的 DevTools 远程调试。**debug 构建（Debuggable WebView）默认可调**；release 构建必须客户端在代码里 `WebView.setWebContentsDebuggingEnabled(true)` 才开。要在浏览器输入 `chrome://inspect`，连接 USB 后等设备出现，再打开页面（记得连上后先让 App 里的 WebView 真正加载一个页面才有条目）。
- **Safari 开发菜单 → 设备**：iOS 的远程检查器（等同 WebKit 版 DevTools）。**真机前置**：iPhone 上开「设置 → Safari → 高级 → Web 检查器」，Mac 上 `Safari → 偏好设置 → 高级 → 勾选"在菜单栏显示开发"`。
- **vConsole / eruda**：注入页面里的一段 JS，在页内弹一个迷你控制台，看 `console` 报错、请求、cookie。**不用接电脑**，适合线上/灰度，但能力远弱于 DevTools（没有 React/内存面板）。

#### 1.3.2 三条"证书信任"链路（最容易翻车的三处）

| 场景 | 缺哪步 | 现象 | 正确做法 |
|---|---|---|---|
| Charles 抓 Android HTTPS | Android 7+ 用户证书默认不被信任 | 装证后仍显示证书无效/连不上 | 装到**系统证书库**（模拟器常见做法），或让客户端在 networkSecurityConfig 为 debug 构建声明信任用户证书（对 WebView 流量是否生效以实测为准） |
| Charles 抓 iOS HTTPS（真机/ 模拟器） | 装了证但没开"完全信任" | 浏览器提示"此连接非私人连接" | 「设置 → 通用 → 关于本机 → 证书信任设置」→ 为 Charles 根证书打开**完全信任** |
| chrome://inspect 连不上 | 构建是 release 且没开调试开关 | `chrome://inspect` 里看不到设备 | 客户端 `setWebContentsDebuggingEnabled(true)`；未处理就要求走 debug 构建 |

> 🔴 **红线（准确，别想当然）**：Android 7.0（API 24）开始，**用户安装的 CA 证书默认不被 App 信任**，只有系统证书库里的才被系统 WebView 信任——抓包抓不到 HTTPS 明文，多半卡在这，不是装证没装好。iOS 的根证书信任在「关于本机 → 证书信任设置」里**默认关闭**，必须手动打开才生效。

#### 1.3.3 前端视角的最小可用搭建顺序（不展开客户端工程细节）

```
1) 装两台"底座"：Android Studio（含 SDK/模拟器/adb）与 Xcode（含 iOS 模拟器）
2) 各起一个模拟器/连一台真机 → adb devices / Xcode Devices 都能看到它
3) 建一个最小原生工程，把下方"判断代码"粘进去跑通一个 WebView 页面（见下文 1.4 节）
4) 用 Charles 抓通这个页面的 HTTPS（吃透上面 3.2 的三条链路）
5) 用 chrome://inspect（Android）与 Safari 检查器（iOS）分别连上同一个页面
6) 收尾：跑通 `demo/stage-0-setup` 的 hello 页，双端都看到"同一份 H5"
```

你**不需要**懂如何建完整 Android/iOS 工程——只要求能"粘贴、点编译、跑起来"。

---

### 1.4 代码验证：三份可直接粘贴的最小页面

#### 1.4.1 先准备一个本地 HTML（放进 App 资源）

把 `demo/stage-0-setup/web/hello.html` 放进：Android 的 `assets/` 目录 / iOS 的 Bundle 资源。

#### 1.4.2 Android · 最小 WebView Activity（Kotlin）

```kotlin
// 平台：Android · Kotlin（Activity）
// 用途：最小可运行 WebView——loadUrl 本地 asset 与线上 https 各一次
// 粘贴到：Android 最小工程（MainActivity），并在 AndroidManifest 里加 <uses-permission android:name="android.permission.INTERNET"/>
import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        setContentView(web)

        // ① 本地文件（hello.html 放进 assets/）
        web.loadUrl("file:///android_asset/hello.html")
        // ② https 一次（换真实可访问地址）
        // web.loadUrl("https://example.com")
    }
}
```

#### 1.4.3 iOS · 最小 WKWebView UIViewController（Swift）

```swift
// 平台：iOS（UIKit + WebKit）
// 用途：最小可运行的 WKWebView——本地 Bundle 资源与线上 https 各一次
// 粘贴到：iOS 最小工程，作为 viewDidLoad 里的内容；hello.html 放进 Target 的 Copy Bundle Resources

import UIKit
import WebKit

final class ViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let web = WKWebView(frame: view.bounds)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(web)

        // ① 本地 Bundle 资源
        if let url = Bundle.main.url(forResource: "hello", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url)
        }
        // ② https 一次（换真实可访问地址）
        // web.load(URLRequest(url: URL(string: "https://example.com")!))
    }
}
```

---

### 1.5 常见环境坑表（开跑前先扫一眼）

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| 模拟器抓不到包 | 真机正常、模拟器 Charles 看不到 | 模拟器走宿主代理配置不同/没装证书 | 给模拟器设系统代理指向 Charles；Android 模拟器把证装进**系统证书库** |
| 证书装了还不行 | 提示证书无效/握手失败 | Android 7+ 不信任用户证书；iOS 没开完全信任 | 见 §1.3.2 三条链路，逐条核对 |
| inspect 看不到设备 | `chrome://inspect` 空 | release 构建未开调试开关 | `setWebContentsDebuggingEnabled(true)` 或改用 debug 构建 |
| Safari 检查器连不上 | 开发菜单里没有你的手机 | 真机没开「Web 检查器」/没插线信任 | 开「设置 → Safari → 高级 → Web 检查器」，首次插线在手机点"信任此电脑" |
| 只看到 CONNECT 隧道 | Charles 有连接但无明文 | 没开 SSL Proxying | Charles → Proxy → SSL Proxying Settings，加入目标域名并勾选 |
| iOS 本地 file 打不开 | 页面白屏、无网络 | 本地文件加载方式不对 | 用 `loadFileURL(_:allowingReadAccessTo:)`，不用 `load(URLRequest:)` 拼 file:// |
| 双端表现不一致却无从查 | 同一 H5 两端口径不一 | 没区分 debug/release、没接 DevTools | 两端分别接上 DevTools（见下文 1.3.1），看 console/网络 |

#### 1.5.1 环境自检清单（10 项，从上往下逐条过）

| # | 自检项 | 验证方法（一行） |
|---|---|---|
| 1 | adb 可用 | 终端 `adb devices` 能列出模拟器/真机序列号与 `device` 状态 |
| 2 | Android 模拟器可联网 | 模拟器里打开浏览器访问任意 https 站点不出错 |
| 3 | Xcode 真机签名通过 | Xcode → Devices and Simulators 里设备无黄色警告，可 Run 到真机 |
| 4 | Android WebView 页面跑通 | MainActivity 加载 `file:///android_asset/hello.html` 能看到内容 |
| 5 | iOS WKWebView 页面跑通 | ViewController `loadFileURL` hello.html 能看到内容 |
| 6 | Android 可被 inspect | 手机开 USB 调试，浏览器开 `chrome://inspect` 能看到设备与其 WebView |
| 7 | iOS 可被 Safari 检查 | 真机开「Web 检查器」，Mac Safari「开发」菜单里出现该页面 |
| 8 | Charles 能代理流量 | 手机 Wi-Fi 代理指向电脑 IP:8888，Charles 会话列表有请求滚动 |
| 9 | HTTPS 能看明文 | 开 SSL Proxying 后，请求行/响应体可见明文（非 `CONNECT` 隧道） |
| 10 | vConsole/eruda 可用 | 注入脚本后页面右下角出现浮动按钮，点开能看到 `console` 输出 |

---

### 1.6 demo & 自测题

#### 1.6.1 demo
最小可跑示例见 `demo/stage-0-setup/`：`web/hello.html`（本地页）、`MinimalWebViewActivity.kt`、`MinimalWKWebViewController.swift`，README 里是一行拼装说明。

#### 1.6.2 自测题
1. 一个 H5 里的 `fetch('/api')`，默认走客户端 OkHttp 还是 WebView 内置网络栈？抓包按哪条管道理解？（提示：总章 §0.5）
2. Android 7+ 装了 Charles 用户证书，为什么 HTTPS 还是抓不到明文？
3. iOS 真机调试 WebView 页面前，要开哪两个开关（手机端 + Mac 端）？
4. 动手：跑通 `demo/stage-0-setup/MinimalWebViewActivity.kt`，把 `loadUrl` 从本地换到 https，观察两点表现差异。

<details>
<summary>参考答案（思考后再点开）</summary>

1. 走 **WebView 内置网络栈（管道二）**。抓包、证书、HTTPDNS 都要按管道二理解，它与客户端 OkHttp/URLSession（管道一）独立。
2. **Android 7.0 起用户安装的 CA 默认不被 App 信任**，必须装进系统证书库，或让 App 信任用户证书。只是装进"用户证书"库不够。
3. 手机端「设置 → Safari → 高级 → Web 检查器」打开；Mac 端「Safari → 偏好设置 → 高级 → 菜单栏显示开发」。
4. 本地 `file://` 走本地读、无网络栈差异；https 走 WebView 网络栈，可被 Charles 抓到明文（前提是按 §1.3.2 三条链路配好证书）。
</details>

---

## 2 · 认知校准测试——10 道易错题，先测出你把 WebView 想岔在哪

---

### 2.1 使用方法

**先自己答，再点开 `<details>` 翻答案。** 每题都是一个"场景"，你先在心里给结论，再对照"多数人的直觉 → 为什么错 → 正确认知"。最后给自己打分：**错 ≥ 5 题，说明你对 WebView 的模型基本建立在错误类比上，值得把整个系列从头精读**；错 3~4 题，定向补对应阶段即可；全对，直接往下读正文验证。

这 10 题是本系列所有坑的"种子"——每一题后面都标了它对应的阶段与篇名，方便按图索骥深入。

自测快速打分（可用它判断下一步）：

```text
对 01~10 题逐条标 勾/叉
错 ≥5 → 整系列从头精读（0→1→2→3→4→5→6…）
错 3~4 → 按每题的"深入指向"定向补阶段
全对   → 直接进每篇正文验证
```

---

### 2.2 题目

#### 2.2.1 ① 同一份 H5，在所有手机上表现一致吗？

你把 `position: fixed` 的底部按钮、`100vh` 的整屏页写到一套代码里，自测没问题，上线后 Android/iOS 表现不同。多数人的直觉："H5 是标准化的，内核不同也差不到哪去。"

<details>
<summary>参考答案</summary>

×× 直觉是错的。WebView 内核、版本、宿主容器都可能不同：iOS 统一是 WebKit，Android 有系统 WebView、X5/XWeb、U4 之分（内核碎片化）。`100vh`、fixed、键盘遮挡、安全区在小屏/不同内核上差异显著。正确认知：**同一份 H5，在不同内核 + 不同容器的组合里，行为是一个"组合函数"，不是看代码本身。**

深入：阶段 1 · 《内核谱系》。
</details>

#### 2.2.2 ② H5 里的 `fetch`，走客户端的 OkHttp/URLSession 吗？

你在 App 里跑 H5，`fetch('/api/login')` 发出去。多数人直觉："既然在 App 里，请求应该统一走客户端的网络库吧，能共享登录态和 HTTPDNS。"

<details>
<summary>参考答案</summary>

×× 不走。H5 里的 `fetch`/XHR/图片走 **WebView 内置网络栈（管道二）**（Android=Chromium netstack，iOS=WebKit），与客户端 OkHttp/URLSession（管道一）是两条独立管道。它默认不享受统一签名、HTTPDNS、弱网优化。正确认知：**你的 H5 请求几乎永远走 WebView 网络栈；想让它走客户端网络库需要容器做请求拦截并入（阶段 6 讲）。**

深入：总章 §2.3 ｜ 阶段 6 · 《两条网络栈的真相》。
</details>

#### 2.2.3 ③ WebView 里的 Cookie，一定留到下次打开吗？

你在 H5 里 `document.cookie = "token=xxx"` 写了一条 Cookie，关了 App 再打开，还在吗？多数人直觉："Cookie 是持久化的，肯定还在。"

<details>
<summary>参考答案</summary>

×× 不一定。Cookie 生命周期取决于：是否有 `Max-Age`/`Expires`（没有就是会话级）、容器是否限制本地存储/session 隔离、iOS `WKHTTPCookieStore` 与 `HTTPCookieStorage.shared` 是两套存储、Android `CookieManager` 是否跨实例共享。App 进程被回收、`WebView` 重建、容器清站点数据，都可能清掉。正确认知：**Cookie 的持久性由"宿主容器如何管理 WebView 的存储"决定，不能想当然按浏览器标签页理解。**

深入：阶段 5 · 《Cookie 三套体系与同步》。
</details>

#### 2.2.4 ④ 白屏 = 加载慢吗？

页面打开后一片白，等 3 秒还是白。多数人直觉："网络/首屏加载慢，等资源加载完就好。"

<details>
<summary>参考答案</summary>

×× 白屏 ≠ 加载慢。白屏是"容器在、内容空"：可能是渲染进程被杀（WebContent/渲染进程被回收）、JS 执行抛错、资源 404、数据接口异常、混合内容被拦。看进程与 console 才能归因。正确认知：**先分层归因（进程/资源/JS/数据），再决定是前端锅还是容器锅，不要一上来优化加载。**

深入：阶段 8 · 《白屏诊断》。
</details>

#### 2.2.5 ⑤ 按返回键，网页一定回退吗？

安卓 App 里 H5 页面，点系统返回键。多数人直觉："返回键就是网页里的后退，会回到上一页。"

<details>
<summary>参考答案</summary>

×× 不一定。返回键是被容器接管的：容器可以先判断 `WebView.canGoBack()`，能回退就先回退，回无可回才关掉页面/退出 App。也可能直接关掉 WebView 而忽略网页 history。正确认知：**返回键行为由容器的返回策略决定，可能"先回退网页、再退出"，两者都合法。**

深入：阶段 2 · 《导航控制与 URL 拦截》。
</details>

#### 2.2.6 ⑥ `localStorage` 一定持久可用吗？

你在 H5 里把登录态写进 `localStorage`，指望下次打开还在。多数人直觉："localStorage 是持久化的，重启也在。"

<details>
<summary>参考答案</summary>

×× 不一定。`localStorage` 的持久性跟随"WebView 的存储分区/站点数据"：容器清站点数据、切换 WebView 实例、iOS 某些历史版本对 localStorage 的回收机制，都可能让它失效。sessionStorage 更是随会话结束就没了。正确认知：**把登录态这类关键态只放 localStorage 是危险的，应走容器持久化通道（桥 + 原生存储）。**

深入：阶段 5 · 《前端存储的真相》。
</details>

#### 2.2.7 ⑦ 用 UA 判断容器，靠谱吗？

你用 `userAgent` 里的关键字判断"是不是某 App 的 WebView"，来开关功能。多数人直觉："UA 是系统给的，可信。"

<details>
<summary>参考答案</summary>

×× 不靠谱。UA 可以伪造（客户端可自定义，见过的 App 都能改 WebView UA），且同一 WebView 的 UA 会随内核版本、品牌机型变化。正确认知：**能用特性检测就用特性检测；必须识别容器时，优先走 JSBridge 能力探测/注入的明确标记，而不是解析 UA 字符串。**

深入：阶段 1 · 《内核谱系》 ｜ 阶段 4 · 《四种通信通道对比》。
</details>

#### 2.2.8 ⑧ 客户端加了 HTTPDNS，所以 H5 也提速了？

客户端同学说"加了 HTTPDNS，App 网络好多了"，你在 H5 里发现 `fetch` 的接口却还是慢、还是会被劫持。多数人直觉："同一个 App，网络优化应该全覆盖吧。"

<details>
<summary>参考答案</summary>

×× 没覆盖到。HTTPDNS、统一签名、连接池这些优化加在**客户端网络库（管道一）**，而 H5 的 `fetch` 走 WebView 网络栈（管道二），**默认接不到**。所以"原生接口快、H5 接口慢/偶发失败"很常见。正确认知：**要让 H5 也享受这些能力，必须容器把 H5 请求拦截后并入客户端网络库（阶段 6 三种方案），否则你 H5 永远是另一条没优化的路。**

深入：阶段 6 · 《两条网络栈的真相》 ｜ 《H5 请求并入客户端网络库的方案》。
</details>

#### 2.2.9 ⑨ 不实现 `WKUIDelegate` 时，iOS 的 JS `alert` 会弹吗？

你在 iOS WKWebView 里 `alert("hi")`，以为最普通的系统弹窗。多数人直觉："alert 么，肯定弹。"

<details>
<summary>参考答案</summary>

×× 不会弹，而且**静默吞掉**。iOS 的 `alert`/`confirm`/`prompt` 必须由宿主实现 `WKUIDelegate` 的对应方法去呈现原生弹窗，否则 WebKit 直接丢弃、JS 也不报错。这也是新手最大坑——以为页面没走这段逻辑，其实是没人接 `WKUIDelegate`。正确认知：**WKUIDelegate 三件套（alert/confirm/prompt）不属于 WebKit 自带 UI，是委托给宿主画的，不实现即无声消失。**

深入：阶段 3 · 《导航控制与弹窗的坑》。
</details>

#### 2.2.10 ⑩ 离线包 = HTTP 缓存吗？

你说"离线包就是把静态资源缓存在本地，就相当于强缓存"，用来解释 H5 打开快。多数人直觉："离线包和 HTTP 缓存一回事，都是本地有资源。"

<details>
<summary>参考答案</summary>

×× 完全不同。HTTP 缓存仍是"网络请求到 WebView 网络栈"后按缓存头命中；离线包是容器把静态资源**打进 App**，用 `shouldInterceptRequest`/`WKURLSchemeHandler` 把请求**拦截映射到本地文件**，甚至不需要走到真正网络链路、不受强缓存过期逻辑影响。正确认知：**离线包是容器的资产与拦截映射（管道之外），HTTP 缓存是 WebView 网络栈内的缓存策略（管道二内），别混为一谈。**

深入：阶段 7 · 《离线包的本质》 ｜ 阶段 5 · 《HTTP 缓存与强缓存问题》。
</details>

---

### 2.3 天学习路线（接续建议）

| 顺序 | 做什么 | 时长 | 对应当前阶段/后续 |
|---|---|---|---|
| 1 | 自答上面 10 题并翻答案，记录错题 | 30 分钟 | 本节 |
| 2 | 搭环境、跑通 `demo/stage-0-setup` 的 hello 页（双端） | 30 分钟 | 阶段 0 · 01 篇 |
| 3 | 精读总章《点击一个 URL 后都发生了什么》 | 1 小时 | 阶段 1 · 总章（上帝视角） |
| 4 | 按错题对应阶段补读（内核/导航/存储/网络/离线包…） | 定向 | 阶段 1 起按需跳 |
| 5 | 回到 10 题再自答一次，确认扭转过来了 | 15 分钟 | 本节（形成闭环） |

> 建议先把"第 ⑧⑩ 这类网络/存储根因"留在阶段 6、7 展开，今天只需建立直觉：**H5 有独立网络管道、容器有自己的存储与拦截体系**。

---

## 本章术语表

| 术语 | 大白话解释 |
|---|---|
| adb | Android 的调试命令行工具：电脑用它列设备（`adb devices`）、装包、看日志、往设备推文件 |
| Charles | 电脑上的抓包代理工具，手机把 Wi-Fi 代理指到它，流量先过它这道"检查站"再出去 |
| MITM（中间人） | Man-in-the-Middle，Charles 站在手机和服务器中间转发请求，这样才能看到 HTTPS 明文 |
| 根证书 | Charles 自己签发证书用的"发证机构"凭证：装到手机上，手机才认它给每个域名签的证书 |
| SSL Proxying | Charles 的 HTTPS 解密开关，要勾选目标域名后开启，只装证不开它照样看不到内容 |
| CONNECT 隧道 | 抓包列表里"只看得到有条加密连接、看不到内容"的条目，说明解密开关没开 |
| chrome://inspect | 手机连电脑后在 Chrome 地址栏输入它打开的安卓 WebView 远程调试面板 |
| Safari 检查器 | Mac 上 Safari 调试 iPhone 页面的远程检查器，用前要先在手机端开「Web 检查器」 |
| vConsole / eruda | 注入页面的一段 JS，在页内弹一个迷你控制台，不用接电脑就能看报错、请求、Cookie |
| 系统证书库 | Android 7+ 默认只信任装在系统级证书库里的证书，只装到用户证书库抓包会失败 |
| 完全信任 | iOS 装完 Charles 根证书后还要在「证书信任设置」里手动打开的信任总闸，不开就白装 |
| 管道二（WebView 内置网络栈） | H5 里 fetch/XHR/图片实际走的网络通道，与客户端 OkHttp/URLSession（管道一）相互独立 |
| setWebContentsDebuggingEnabled | 客户端代码里打开安卓 WebView 调试的方法，release 包不调用它 chrome://inspect 就连不上 |
| debug / release 构建 | 客户端打包的两种形态：debug 供开发调试默认可 inspect，release 发布用且默认关闭调试 |
| 宿主容器 | 包着 WebView 的那个原生 App"壳"，返回键、存储、调试开关等一堆行为都由它决定 |
| 内核碎片化 | Android 上 WebView 内核不止一种（系统 WebView、X5/XWeb、U4），同一份 H5 表现可能各不相同 |
| 管道一 | 客户端 OkHttp/URLSession 那条网络通道，签名、HTTPDNS、连接池等优化都加在这条路上 |
| HTTPDNS | 不走系统域名解析、直接按 IP 发请求的客户端优化，默认覆盖不到 H5 的 fetch |
| 会话级 Cookie | 没写 Max-Age/Expires 的 Cookie，App 关掉这类宿主退出就没了，不会留到下次打开 |
| WKHTTPCookieStore | iOS WKWebView 自己的 Cookie 存储，与 HTTPCookieStorage.shared 是两套，互不同步 |
| CookieManager | Android 管理 WebView Cookie 的类，Cookie 是否跨页面共享由它的配置决定 |
| 白屏 | 页面打开只剩白背景：可能是渲染进程被杀、JS 报错、资源 404，不一定是加载慢 |
| canGoBack | 容器接返回键时先问 WebView 的这个方法"还能不能回退"，能就回退网页、不能才关页面 |
| localStorage | H5 的本地持久存储，但容器清站点数据时说没就没，登录态别只放这里 |
| UA（userAgent） | 浏览器自报的"身份字符串"，容器可以随意伪造，用它判断运行环境不靠谱 |
| JSBridge | H5 与客户端相互调用的"电话线"，也可用它的注入能力来可靠识别容器 |
| WKUIDelegate | iOS 宿主要实现的委托：不实现它，JS 的 alert/confirm/prompt 会被静默吞掉、界面上什么都不弹 |
| 离线包 | 容器把静态资源打进 App，用请求拦截直接映射到本地文件，和 HTTP 缓存完全是两码事 |
