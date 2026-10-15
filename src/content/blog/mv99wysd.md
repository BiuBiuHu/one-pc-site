---
title: 一平台双角色：在 AI 测试平台中同时实践 MCP Client 与 MCP Server
date: 2026-10-15
excerpt: MCP 落地实践
category: 思考
---

> 我们在一个 AI 自动化测试平台里，同时扮演了 MCP 生态的两个角色：**作为 Client，让测试 Agent 调度全公司的外部工具**；**作为 Server，把平台自身的测试能力变成所有人可调用的工具**。这篇文章先分三层讲清 MCP 的原理（是什么→说什么→怎么说），再分别展开双端的工程实践，最后复盘一次真实接入过程中"从报错到规范姿势"的完整排障。

---

## 1. 引子：一个平台的两个 MCP 角色

我们维护着一个面向移动端与 H5 业务的 AI 自动化测试平台：测试人员登记被测业务，AI Agent 依据 AI 资产（Skills / Rules / Prompts）自动生成测试用例，再由执行引擎在 Web 沙箱或真机上跑完整个用例并产出报告。

平台成熟后有两大痛点：

- **对内**：自动化用例跑不出"完整闭环"。用例执行中经常需要查询订单状态、开关 Mock、核验服务端数据——这些能力散落在公司各业务团队的服务里，测试 Agent 够不着。
- **对外**：平台沉淀的测试能力（管理测试任务、查询用例、发起执行、获取执行结果）只能通过 REST API 被少数系统硬编码调用。公司里大量 Agent（AI 编程助手、内部 Copilot、自动化流水线）都基于 MCP 构建，却用不上我们。

有意思的是，这一对痛点恰好对应 MCP 的两个视角：


                ┌────────────────────────────┐
外部 MCP Server   │      我们的测试平台          │    对外 MCP Server
（订单/文档/监控…） │  ┌────────┐    ┌─────────┐ │   （任务/用例/执行）
▲            │  │MCP     │    │MCP      │ │        ▲
│            │  │Client  │    │Server   │ │        │
└────调用─────┼─▶│Gateway │    │Provider │ │◄──调用─┘
│  └────────┘    └─────────┘ │
│      Agent  /  执行引擎     │
└────────────────────────────┘
向左：作为 Client 消费别人的工具          向右：作为 Server 输出自己的工具

```

同一个 Node.js 服务，向左是 MCP **Client**，向右是 MCP **Server**。两端是两个独立立项的项目，下文按"原理 → Client → Server → 排障复盘"的顺序展开。

---

## 2. 三层递进：MCP 原理速览

这一章分三层递进：**协议的定位是什么（是什么）→ 消息长什么样（说什么）→ 消息怎么传输（怎么说）**。每层都很短，读完刚好够读懂后文的工程实践。

### 2.1 第一层：MCP 是什么、谁跟谁说话

MCP（Model Context Protocol，模型上下文协议）是一个**开放协议**，标准化了"AI 应用"与"外部数据源/工具"之间的连接方式——好比 AI 应用的 USB-C 接口：双方按协议实现，任何 AI 应用都能即插即用任何工具服务器。

先对齐三层角色（最容易混淆的一组概念）：

```
┌──────────── MCP Host（宿主应用）────────────┐
│  例如：Claude Code、IDE 插件、我们的测试平台   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │MCP Client│  │MCP Client│  │MCP Client│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
└───────┼─────────────┼─────────────┼────────┘
│ 1:1         │             │
▼             ▼             ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│MCP Server│  │MCP Server│  │MCP Server│
└──────────┘  └──────────┘  └──────────┘

```

- **Host**：AI 应用本体，能力的聚合方（Claude Code、我们的测试平台）；
- **Client**：Host 内部的连接器，**与每个 Server 保持 1:1 连接**——不是"整个应用是一个 Client"；
- **Server**：能力提供方。

Server 暴露三类能力原语，关键差别在**谁控制**：

| 原语 | 控制方 | 常用协议方法 |
|------|-------|-------------|
| **Tools（工具）** | **模型自主**决定是否调用 | `tools/list`（支持 cursor 分页）、`tools/call`、`notifications/tools/list_changed` |
| **Resources（资源）** | 应用决定何时读取 | `resources/list`、`resources/read`（返回 text/blob） |
| **Prompts（提示词模板）** | 用户主动选择 | `prompts/list`、`prompts/get` |

绝大多数集成围绕 Tools 构建，本文双端亦然。

### 2.2 第二层：消息长什么样——JSON-RPC 2.0

MCP 的报文全部基于 **JSON-RPC 2.0**。JSON 是数据格式（信封），JSON-RPC 是用信封寄信的规则——只有三种消息，**判定方法就是看有没有 `id`**：

| 消息 | 有无 `id` | 期待响应 | 例子 |
|------|----------|---------|------|
| Request | ✅ | 必须回 | `initialize`、`tools/list`、`tools/call` |
| Response | ✅（沿用请求 id） | 发起者接收 | `result` 与 `error` **互斥** |
| Notification | ❌ | 无人期待 | `notifications/initialized` |

```
initialize 握手 → 能力协商
tools/call:
→ { "jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{ "name":"...", "arguments":{...} } }
← { "jsonrpc":"2.0", "id":3, "result":{ "content":[ { "type":"text", "text":"..." } ] } }

```

两个工程细节在后文排障中会反复出现：

1. **工具结果是 `content` 数组**（text / image / resource 三种类型），"失败但可恢复"用 `isError: true` 标记，协议错误才走 `error`；
2. **响应里必须能找到 `jsonrpc` + `id` + `result`/`error`**——如果对端返回的不是这个形状（比如普通 REST 的 JSON），Client 反序列化直接失败。记住这条契约，4.2 的两种方言对照与 4.4 的鉴权实践都建立在它之上。

### 2.3 第三层：谁先谁后——时序与 Transport

**时序**：所有会话都从同一条链路开始——`initialize`（交换协议版本与 capabilities）→ `notifications/initialized` → `tools/list` 发现 → `tools/call` 调用。能力协商是强制的：没在 `initialize` 里声明过的能力方法不能调用。

**Transport（消息的运输方式）** 则分两类：

| Transport | 场景 | 说明 |
|-----------|------|------|
| **stdio** | 本地集成 | Client 以子进程方式拉起 Server，管道通信。stdout 被 JSON-RPC 征用——往它打印调试文字会让 Client 解析崩溃（调试信息必须走 stderr） |
| **Streamable HTTP**（现行规范） | 远程集成 | 单一 HTTP 端点（如 `/mcp`），所有交互走 POST。响应形态二选一：简单请求直接 `application/json`；长任务可升级为 `text/event-stream` 流——由 Server 决定，但受 Client 的 `Accept` 头约束 |

Streamable HTTP 取代了第一代的 HTTP+SSE 双端点方案，而且**规范正在向"无状态化"演进**（移除会话、断线重发、请求自包含）——这一点我们留在第 6 章呼应架构决策。

最后一个工程常识：**远程 Server 必须有认证**。规范推荐 OAuth 2.1，企业内一般由统一网关收口（Client 凭证连网关，网关鉴权后把用户身份转发给后端 Provider）——"身份如何跨网关传递"正是第四章最有嚼头的设计点。

---

## 3. Part 1 · 作为 MCP Client：让测试 Agent 用上全公司的工具

带着第二章的概念回到实践：我们的平台是 Host（2.1），内部为每个被登记的外部 MCP Server 维护一个 Client 连接（2.3 握手时序），把抓回来的 Tools 交给测试 Agent（2.2 的 tools/call 语义）。

### 3.1 场景与原则

典型场景：一条 H5 用例跑到第 3 步，需要"查询页面 URL 里的 orderId 对应的订单状态"来决定后续断言。没有 MCP 之前，测试同学要么手工查数据，要么为每个业务单写一遍对接代码。

引入 MCP 后，产品形态是：

1. 用户在「AI 资产管理中心 → MCP」里**自助登记**任意远程 MCP Server（URL + 认证信息）；
2. 平台执行 `initialize` + `tools/list`，把该 Server 的工具目录抓回并存档；
3. 测试 Agent 生成用例时可以调用这些工具获取数据，也可以在步骤里生成 `mcpCall`，让**每次执行实时调用**；
4. 执行引擎跑到该步骤时，由平台服务端代理调用外部 MCP Server，结果写入步骤变量供后续断言。

四条设计原则是我们少走弯路的关键：

| 原则 | 说明 |
|------|------|
| **MCP 是 AI 资产** | Server/Tool 描述与 Skills/Prompts 并列为资产类型；**凭证不是资产**，归当前用户的 Secret Manager |
| **统一调用出口** | 前端手动调用、Agent 自主调用、脚本执行、执行后动作——全部汇聚到服务端同一个 `invoke()`，**禁止**前端 JS / Agent 模型 / 沙箱脚本直连外部 MCP |
| **凭证不出服务端** | Token/Secret/Header 只存密文（AES-256-GCM，实体里只有 `credentialRef`），不进步骤 JSON、Prompt、沙箱和日志 |
| **执行期校验** | 不做任务启动前预检；调用时没权限就在该步骤报明确错误码，不阻塞任务启动 |

### 3.2 关键机制：`serverKey` 与"配置归人，任务共享依赖"

一个容易踩的坑：任务可以被共享/转交，那任务里的 MCP 依赖存的是谁的配置和凭证？

我们的答案：**任务只保存 `serverKey + toolName`，不保存配置与凭证**。`serverKey` 是按规范化 URL 生成的稳定指纹（协议+host 归一化、去默认端口、query 排序、拒绝敏感 query 参数），不同用户安装同一地址得到相同 `serverKey`。执行时以**本次执行者**身份解析他自己的连接与凭证——没有配置的执行者在该步骤收到 `MCP_SERVER_NOT_CONFIGURED` 这类明确错误，而不是去借任务创建者的权限。

声明式 `mcpCall` 步骤由 AI Agent 生成、确定性编译器编译，禁止手写：

```json
{
  "stepIndex": 3,
  "type": "mcpCall",
  "mcp": {
    "serverKey": "mcp_order-query_7f3a2c91",
    "toolName": "query_order",
    "inputBindings": { "orderId": { "source": "page.url", "path": "orderId" } },
    "saveAs": "orderQueryResult",
    "failurePolicy": "required"
  }
}
```
输入绑定支持固定值、页面上下文和前序步骤变量——用户不写一行提取脚本。

### 3.3 统一调用链路

所有入口（手动/Agent/脚本执行）共享同一条时序：

```
invoke(actorUserId, serverKey, toolName, input)
  → 建 queued invocation + traceId
  → 校验 Tool scope / 授权状态 / Input Schema / 超时
  → 从 Vault 读取当前用户凭证
  → 创建 MCP Client（Streamable HTTP，兼容 SSE）→ initialize → tools/call
  → 脱敏、限长、耗时统计 → 更新 invocation 状态
```
Agent 侧通过薄适配器把个人 MCP Tool 动态包装成平台 ToolRegistry 里的标准 Tool，让 Agent 自主决定何时调用。

---

## 4. Part 2 · 作为 MCP Server：把测试能力变成全公司的工具

### 4.1 需求与工具盘点

平台侧的目标：外部 Agent 通过 MCP 发现并调用测试平台的能力。第一期工具目录刻意收敛为"稳定的业务能力"：


| 工具                                    | 类型   | 说明                                        |
| --------------------------------------- | ------ | ------------------------------------------- |
| `list_test_tasks` / `get_test_task`     | 只读   | 列出/查看有权限的测试任务                   |
| `list_test_cases` / `get_test_case`     | 只读   | 任务下的用例目录与详情                      |
| `get_test_run` / `get_execution_result` | 只读   | 执行批次进度 / 单次执行结果摘要             |
| `start_test_run`                        | **写** | 异步启动一次测试执行，返回`runId`，配幂等键 |

工具目录纯粹到不含任何"底层能力"：数据库查询、ADB、Shell、文件读写、任意 HTTP 代理一律不暴露——MCP 工具是产品化接口，不是数据库的透传层。

### 4.2 一期：MCP-Lite REST——先看两种方言的对照

企业内建了一个统一 MCP 网关，负责面向 Client 的鉴权与会话管理，对 Provider 提供两种接入姿势：**简化协议（MCP-Lite）** 或 **代理已有标准 MCP Server（Streamable HTTP）**。

理解它们最快的方式是对照"同一个动作"（`tools/call`）在两种方言下的报文：

```
标准 MCP（JSON-RPC，企业网关面向 MCP Client 的方言）：
  POST /mcp
  { "jsonrpc":"2.0", "id":3, "method":"tools/call",
    "params":{ "name":"get_test_task", "arguments":{ "taskId":"..." } } }
  ← { "jsonrpc":"2.0", "id":3, "result":{ "content":[...], "isError":false } }

MCP-Lite（网关回源调用 Provider 时的方言）：
  POST /mcp/tools/call
  { "name":"get_test_task", "arguments":{ "taskId":"..." } }
  ← { "content":[...], "isError":false }
```
语义完全一致，MCP-Lite 只是**把 JSON-RPC 的信封拆掉、method 摊平进 URL**，方便 Provider 用普通 Web 框架实现。第一版我们就按 MCP-Lite 实现（官方 SDK 封装的轻量包装，注册 7 个工具约 130 行），并且网关会在 `tools/call` 请求体里注入**当前 SSO 用户身份**（`user.empId` 等扩展字段），服务端解析后即可按真实用户做数据权限。

这一版配套了完整的"治理四件套"，也是 MCP Server 区别于普通 REST API 的核心工作量：

1. **身份解析与所有权校验**：调用者 → principal → 资源所有权校验，`get_test_task` 只能命中"自己拥有或被分享"的任务；
2. **幂等**：`start_test_run` 要求调用方提供 `idempotencyKey`，同键同参返回首次结果，同键不同参抛冲突；
3. **限流与超时**：并发调用上限、单调用 15s 超时、出入参体积上限；
4. **审计与来源标记**：所有请求打 `callSource=mcp` + 工具名 + 调用方 + traceId，与 CLI/Web 来源在同一条日志体系内可区分。

### 4.3 二期：补一条标准 Streamable HTTP 端点

为了让**所有标准 MCP 客户端**都能直连（不止走网关的），我们把同一个工具目录又包了一层官方 `StreamableHTTPServerTransport`，在 `/mcp/http` 上提供标准 JSON-RPC 端点：

```ts
// stateless 模式：每请求一个 transport，无会话状态（演进方向，见第 6 章）
const server = createServerWithRegisteredTools();   // 复用 7 个工具的注册逻辑
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,          // ← 无会话
  enableJsonResponse: true,               // 简单请求直接回 JSON
});
ctx.res.once('close', () => transport.close());
await server.connect(transport);
await transport.handleRequest(ctx.req, ctx.res, parsedBody);
ctx.respond = false;   // 响应由 transport 直写
```
增量代码不到 100 行，工具注册零改动——**得益于一期把"工具定义"和"协议暴露"分离**。至此服务端同时说两种"方言"：MCP-Lite（给网关回源）和标准 Streamable HTTP（给任意 MCP 客户端）。

### 4.4 接入统一网关：两条路径与注入头鉴权

把 Server 挂上统一网关时，有两类正统接法（我们都走通了）：

- **路径 A · MCP-Lite**：注册接入类型选 HTTP，地址填 MCP-Lite endpoint。实现最薄（两个 REST 接口），用户身份由网关在 `tools/call` 请求体注入。
- **路径 B · 代理已有标准 MCP Server**（我们的最终形态）：接入类型选 Streamable HTTP，地址指向 `/mcp/http`。内部鉴权**不要自造 Authorization 协议**，按网关规范在「Server 选项」里配置两个注入头：

```properties
mcp.headers.X-Api-Key=<服务端约定的密钥>     # 固定头：每个请求都带，证明"来自网关"
mcp.headers.SSO-Emp-Id=$ctx.user.empId      # 动态头：调用工具时注入当前登录用户
```
服务端校验 `X-Api-Key`（与环境变量密钥全等），用户身份**优先读注入的工号**，缺失时回退 Token 绑定的固定身份（本地调试用）。上线验证矩阵：

```
initialize（X-Api-Key 正确）          → 200  serverInfo 正常返回
tools/call + 动态头=用户A（资源属主）  → 200  返回用户A自己的任务列表
tools/call + 动态头=用户B（无资源）    → 200  total=0  ← 数据权限按真实调用者隔离
X-Api-Key 错误                        → 401  JSON-RPC error
```
两个容易忽略的发布前置项：**Provider 域名要进网关白名单**；**凭证用请求头 + 加密存储**，不要放 URL（网关日志会明文记录）。

---

## 5. 验证与发布策略

两端我们都坚持"本地全绿才上预发、预发矩阵通过才进发布"，差异化的矩阵如下：


| 层级 | MCP Client                                                   | MCP Server                                                          |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 本地 | tsc + build + 定向测试（Gateway/Compiler/Adapter）+ 全量回归 | initialize/tools/list/tools/call 冒烟 + 三态鉴权用例 + 用户隔离用例 |
| 预发 | 真实凭证连外部 Server，跑通含`mcpCall` 步骤的任务            | 网关连通性 → 工具发现 → 带注入身份的调用 → 错误密钥 Negative     |
| 治理 | invocation 记录 + traceId + 脱敏长度                         | callSource 审计 + 幂等键 + 有限目录                                 |

发布层面：MCP Server 的 Provider 走常规 CI/CD 流水线；网关侧的注册、域名白名单、请求头配置是**独立于代码的发布前置项**——写进发布 checklist 能省掉大量来回。

---

## 6. 规范演进：无状态化，以及我们为什么"提前站对了方向"

Streamable HTTP 之后，MCP 规范还在演进，主线是一个词：**无状态化（Stateless）**——移除协议级会话（`Mcp-Session-Id`）、取消 `initialize` 前置握手、删除断点续传，让每个请求完全自包含（版本与能力通过请求 `_meta` 携带）。

为什么值得特别关注：

1. **水平扩展**：无会话粘滞，任何实例处理任何请求，扩缩容零迁移；
2. **Serverless 友好**：自包含请求才能按需冷启动；
3. **排查简单**：每个请求可 curl 独立重放，没有需要恢复的中间状态。

落回我们的实现：`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` 正是官方 SDK 的 **stateless 模式**——每请求新建 transport、响应即完、无会话残留。加上 `enableJsonResponse: true`，快请求走 JSON、需要时长任务响应可升级为流——与规范演进方向一致。**当初为了省事做的无状态选择，恰好站在了规范要去的方向上**；后续即便规范全面铺开，服务端也几乎不用改。

SSE 在无状态下依然可用，只是角色变了：从"绑定会话的常驻通道"降级为"单个请求的响应形态"（流的生命周期 = 单个请求的生命周期）。我们的读工具都是短请求，`enableJsonResponse` 直接走 JSON 即可，长任务场景再考虑流式。

---

## 7. 经验总结

1. **一个平台可以同时是 Client 和 Server**，两端共用"工具定义与协议解耦"的整洁边界后，接新协议的边际成本极低；
2. **先想清楚"凭证归谁"**：Client 侧凭证按"人"隔离并加密；Server 侧身份由网关注入，绝不相信请求体里自报家门；
3. **写工具必须配幂等键**，异步执行返回 `runId` 而非等待结果——Agent 世界里超时重试是常态；
4. **工具目录要克制**：暴露"产品化的稳定接口"，而不是数据库透传；
5. **协议对不上的第一步是看响应形状**：`jsonrpc=null` 意味着对端根本不是 JSON-RPC 服务，按端点类型对号入座；
6. **网关代理模式的内部鉴权用注入头**，固定头证明来源、动态头携带用户，别发明私有 Authorization 协议；
7. **协议选型尽量贴规范主线**（如 Streamable HTTP 的 stateless 模式）——规范在演进，跟着走就没有返工。

---

## 8. 下一步

- Client 侧：接入动态客户端 OAuth2.1（通用 AI 编程工具零配置授权）、MCP 资产的团队级共享策略；
- Server 侧：高危工具（停止执行）按审批灰度开放、工具描述的质量扫描与选项级覆盖、出站方向应用可信身份（M2M）打通更多下游。

MCP 的价值在于**互操作的标准接口**：当平台同时具备"调度全公司工具"和"被全公司调度"两种能力时，AI 测试才真正长在了生态上。

---

*注：本文为对外技术分享版本，涉及企业内部平台名称、域名、凭证与业务数据均已泛化或脱敏。*

```

```

