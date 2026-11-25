---
title: "第 48 课：ACP — Agent Client Protocol"
date: 2026-11-25
excerpt: "编辑器和编码 Agent 之间如何实时通信？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 45
---

> 目标：深入理解 ACP 协议——传输、能力协商、Session 生命周期、Prompt Turn、权限模型，
> 并读懂官方 TS SDK 示例

---

## 背景

前几课我们把边界越拉越远：

```
47 课 A2A ：Agent ↔ Agent     （跨系统协作）
12 课 MCP ：Agent ↔ 工具/数据  （接能力）
```

但还漏了一个**很常见、很别扭**的边界——**客户端（前端/IDE）↔ 单个 Agent**：

```
❌ 混乱的局面：
Codex 有自己的聊天 UI
Claude Code 有自己的聊天 UI
Amazon Q CLI 又有自己的 UI
…每个 Agent 都私搭一套前端，UI 复用不了

✅ 希望的抽象（像 LSP 一样）：
任何编辑器/前端  ──同一个协议──▶  任何 Coding Agent
```

这个把"Agent 的**背面实现**"和"Agent 的**正面界面**"解耦的协议，就是 **ACP（Agent Client Protocol）**，
由 **Zed** 推出（2025），目标是成为"Agent 界的 LSP"。

> 三方角色：Zed（编辑器=Client）；Gemini CLI、Codex CLI、Qwen Code、GitHub Copilot（预览）、
> Claude（via adapter）等（Agent 侧，见官方 Agents 列表）。
> 官方文档：<https://agentclientprotocol.com>

---

## ACP 是什么

**ACP** 标准化了**代码编辑器（Client）** 与 **Coding Agent（Agent）** 之间的双向、实时通信。
用官方一句话：它定义"客户端"（交互式源码查看/编辑程序）和"Agent"（用生成式 AI 自主改代码的程序）
之间的接口。

### 两个角色

```
┌──────────────┐    ACP（双向、JSON-RPC）   ┌─────────────────┐
│   Client     │ ◀───────────────────────▶ │     Agent       │
│  (编辑器/UI) │                           │  (Coding Agent) │
└──────────────┘                           └─────────────────┘
  · 面向人类：显示消息、渲染事件              · 面向模型：跑 Agent Loop
  · 拥有文件系统 & 终端权限                  · 不直连文件/终端，向 Client"借用"
  · 控制敏感操作的"许可权"                   · 把状态/结果主动推给 Client
```

关键点：这是**一对一**（一个 client ↔ 一个 agent），且**双向主动**——Client 不只是发请求，
Agent 也**主动推送事件**（流式文本、工具状态、计划、模式变更）。这正是它区别于"普通 API"的本质。

### 类比 LSP

| | LSP | ACP |
|---|-----|-----|
| 目标 | 任意编辑器 ↔ 任意语言服务器 | 任意客户端 ↔ 任意 Coding Agent |
| 解耦 | 编辑器的代码分析/补全 | 前端的聊天/文件操作/会话 |
| 角色 | client(编辑器) ↔ server(语言服务) | client(UI) ↔ agent |
| 双向 | 服务器可主动推送（publishDiagnostics 等） | Agent 可主动推事件 |

---

## 三协议定位（与 MCP / A2A 对比）

```
MCP  = Agent ↔ 工具/数据     （Agent 的"手"）
ACP  = 客户端 ↔ 单个 Agent   （Agent 的"门面"，给人看的那面）
A2A  = Agent  ↔ Agent       （Agent 之间的"外交"）
```

> 三者的全维度对比、选型与组合见 [第 49 课：MCP / ACP / A2A 三协议总对比](/blog/from-scratch-49-agent-protocols/)。

---

## 一、传输与封装

**ACP 的线协议是 JSON-RPC 2.0**，本身**传输无关**：

| 传输 | 状态 | 说明 |
|------|------|------|
| **stdio**（标准输入/输出） | v1 标准 | 本地 Client 启动 Agent 子进程，通过 stdin/stdout 通信，最常用 |
| **Streamable HTTP** | v1 草案提议 | 面向远程/网络场景，仍在演进 |
| 自定义传输 | 允许 | 协议不锁死通道，可按需实现 |

> ⚠️ 常见误解：ACP **不是**"v1 用 Socket(TCP)、v2 用 HTTP+SSE"。v1 的标准就是 **stdio**。
> v2 目前只是**实验性草案**（sdk 中 `@agentclientprotocol/sdk/experimental/v2`），生产默认用 v1。

所有消息走 **JSON-RPC 2.0 信封**：

```jsonc
// 请求
{ "jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": { ... } }
// 响应
{ "jsonrpc": "2.0", "id": 1, "result": { ... } }
// 通知（无 id，单向，Agent→Client）
{ "jsonrpc": "2.0", "method": "session/update", "params": { ... } }
```

---

## 二、连接生命周期（四步）

```
① 建立传输（spawn 子进程 / stdio）
② initialize    —— Client 发起，双方协商 protocolVersion + capabilities
③ authenticate  —— 若 Agent 需要鉴权，Client 按 authMethods 完成登录（可选）
④ 就绪          —— 握手完成，进入 Session 交互
```

### initialize：能力协商（Agent 决定协议细节）

```
Client → Agent ：initialize
  { protocolVersion: 1, clientInfo:{name,url,version}, clientCapabilities }

Agent → Client ：initialize result
  {
    protocolVersion,                       // 双方同意的协议版本（当前稳定 v1）
    agentCapabilities: {
      sessionModesSupport: true,           // 是否支持 session 模式(如 plan/ask)
      authMethodsSupport: true,            // 是否支持鉴权（若 false 跳过 authenticate）
      extensibilitySupport: false,         // 是否支持扩展
    },
    authMethods: [],                       // 鉴权方式：oauth2 / api_key / none ...
  }
```

关键思想：**协议版本和能力由 Agent 声明**，Client 按返回值适配，而不是 Client 单方面假设。

### authenticate：可选鉴权

- Agent 在 `initialize` 返回里给出 `authMethods`（如 `api_key`、`oauth2`）。
- Client 完成认证后调用 `authenticate`，传入 token。
- Agent 返回是否成功；之后进入就绪。

---

## 三、Session 会话管理

一对 Client/Agent 之间可以管理多个 **Session**，每个 Session 一组上下文：

| 方法 | 作用 |
|------|------|
| `session/new` | 新建会话 → 返回 `sessionId`。参数：`cwd`（必须绝对路径）+ `mcpServers` |
| `session/load` | 用已有 `sessionId` 恢复历史会话 |
| `session/list` | 列出该 Agent 上的会话 |
| `session/resume` | 恢复（fork）某个历史会话 |
| `session/close` | 关闭会话 |
| `session/delete` | 删除会话 |
| `session/set_mode` | 切换会话模式（如进入 plan 模式） |
| `session/set_config_option` | 设置会话配置项 |
| `session/prompt` | 向会话提交一轮用户输入（**核心**） |
| `session/cancel` | 取消当前正在进行的 turn（带取消原因） |
| `session/request_permission` | **Agent→Client**：向用户申请敏感操作权限 |

> `sessionId` 是收敛多轮对话的关键：客户端靠它把一轮轮 turn 归档成"一个会话"渲染在 UI 里。

---

## 四、Prompt Turn：一次完整交互

`session/prompt` 是 ACP 的核心——它触发一次"Agent 干活"，且是**异步、流式**的：

```
Client                          Agent
  │  session/prompt              │
  │  { sessionId,                │
  │    content:[text...],        │
  │    requestPermissionMode }   │
  │─────────────────────────────▶│
  │                        Agent 开始跑 loop
  │  ◀── session/update 通知流 ──│  agent_message_chunk(流式文本)
  │  ◀── session/update ─────────│  tool_call / tool_call_update(工具状态)
  │  ◀── session/update ─────────│  plan_update(计划)
  │  ◀── session/update ─────────│  available_commands_update(斜杠命令)
  │  ◀── session/update ─────────│  current_mode_update(模式切换)
  │                              │  ... 可随时穿插
  │  ───── result ──────────────▶│
  │  { stopReason: "end_turn" }  │  响应=本 turn 结束
```

### session/update 通知类型（Agent→Client）

> 通知走一个方法 `session/update`，参数固定为 `{ sessionId, update }`；`update.sessionUpdate` 是判别字段。

| `update.sessionUpdate` | 含义 |
|-----------------------|------|
| `agent_message_chunk` | 流式增量文本（`update.content.text`，供 UI 打字机效果） |
| `agent_thought_chunk` | Agent 的内部思考片段（可选推送） |
| `user_message_chunk` | 用户消息的回显 |
| `tool_call` / `tool_call_update` | 工具调用开始 / 状态更新（用 `toolCallId` 配对） |
| `plan` | Agent 的"行动计划"（`update.plan` 为条目数组） |
| `available_commands_update` | 可用斜杠命令列表更新 |
| `current_mode_update` | 会话模式变更（`update.currentModeId`，如进入 plan） |
| `config_option_update` / `session_info_update` / `usage_update` | 配置、会话信息、token 用量更新 |

> 另有 **`/` 方法簇**（Agent→Client 的请求，非 `session/update`）承载交互式能力：
> `fs/read_text_file`、`fs/write_text_file`、`terminal/create|kill|output|wait_for_exit`、
> `elicitation/create`（向用户收集信息）、`session/request_permission`（申请权限）等。

### result.stopReason：这轮为什么结束

```
end_turn            正常完成
max_tokens          触达 token 上限
max_turn_requests   达到最大轮次请求数
refusal             Agent 拒绝继续（用户 prompt 及之后内容不进入下一轮）
cancelled           被 session/cancel 取消
```

客户端拿到 `stopReason` 才知道：这轮是"说完了"、还是"卡在鉴权"、还是要等用户补料。

---

## 五、核心机制

### 1. Tool Call：工具调用是可观测的流

Agent 执行工具不是"黑盒一笔"，而是发两件事让 UI 实时展示：

```jsonc
// 工具开始：外层 kind=tool_call，内层 toolCall.kind 描述工具类别
{ "jsonrpc":"2.0", "method":"session/update",
  "params":{ "updates":[{ "kind":"tool_call", "toolCall":{
      "id":"tc_1", "kind":"edit", "state":"in_progress",
      "label":"保存 sum.ts", "argsAsJson":{ "path":"src/sum.ts" } } }] } }
// 工具结束：用 toolCall.id 配对
{ "kind":"tool_call_update",
  "params":{ "toolCall":{ "id":"tc_1", "state":"completed", "toolCallResult":{...} } } }
```

- 每个工具有一个 `toolCallId`，`tool_call` / `tool_call_update` 靠它配对。
- `kind` 描述工具类别：`read / create / edit / delete / move / execute / search / fetch / think / other`。

### 2. 权限模型：敏感操作要"许可"

Agent 默认**无权**随意执行危险操作。Agent 触发敏感操作时，通过
`session/request_permission` 向 Client 申请，Client 弹窗让用户选择：

```
allow_once / allow_always / reject_once / reject_always   （用户 vs 本轮）
会话模式控制默认策略：
"default"   → 危险操作都提示确认
"acceptEdits" → 自动接受文件编辑
"plan"      → 只规划不执行
"bypassPermissions" → 全放行（慎用）
"dontAsk"   → 不提示，非预批准一律拒绝
```

> 设计意图：**把"危险操作"的决定权交给人和前端**，Agent 只有"申请"（`session/request_permission`），
> 没有"裁决"。

### 3. 文件系统与终端：Agent 向 Client"借用"

ACP 的一个重要设计——**Agent 不直接碰磁盘/终端，而是发请求让 Client 执行**：

| 方法 | Agent 的用途 |
|------|--------------|
| `fs/read_text_file` | 请 Client 读某个文件的文本给它 |
| `fs/write_text_file` | 请 Client 把内容写到文件（经过权限审批） |
| `terminal/create/input/output` | 请 Client 起终端跑命令，再把输出流回给 Agent |

这保证了：**所有对文件系统/终端的副作用都发生在 Client 侧**，
Client 既能审计、也能拦截。对编辑器场景，收益是"Agent 随我看到的上下文一致，且我能把关我以为的危险操作"。

### 4. 向用户收集信息：Elicitation

有时 Agent 干到一半发现缺信息，ACP 让 Agent 主动**向用户提问**（elicitation），
而不只是停在原地。配合 `stopReason: user_intervention_required`，Client 把问题展示给用户，
用户回答后再继续。

### 5. Session Modes 与斜杠命令

- **Session Modes**：如 `default / acceptEdits / plan / dontAsk / bypassPermissions`。
  Client 用 `session/set_mode` 切换，Agent 用 `current_mode_update` 通知当前模式
  （例如进入"只规划不改代码"的 plan 模式）。
- **Slash Commands**：Agent 通过 `available_commands_update` 暴露可用斜杠命令，
  Client 在 UI 里渲染，用户选中后带对应命令调 `session/prompt`。

---

## 六、示例代码

ACP v1 的线协议是 **JSON-RPC 2.0 over stdio**。生产上通常直接用官方 SDK 而不是手写线协议。

### 官方 SDK

```bash
npm install @agentclientprotocol/sdk   # TypeScript 官方实现，默认 v1
```

其他官方 SDK：Python、Rust、Java、Kotlin（见 agentclientprotocol.com）。

### 客户端示例（spawn Agent 子进程 + stdio）

```typescript
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

// 打开一个 Agent 子进程，通过 stdio 通信
const agent = spawn('your-agent', [], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: agent.stdout });
const agentReq = (id: number, method: string, params: object) =>
  agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');

let promptId = 42;

async function main() {
  // ① initialize：协商协议版本与能力
  agentReq(1, 'initialize', {
    protocolVersion: { major: 1, minor: 0 },
    clientInfo: { name: 'my-editor', url: 'https://example.com', version: '0.1.0' },
    clientCapabilities: {},
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    // 响应(带 id) 与 通知(无 id) 分开处理
    if ('id' in msg) {
      if (msg.id === 1) {
        console.log('[init] 协议版本', msg.result.protocolVersion, '能力', msg.result.agentCapabilities);
        // ② 新建会话（cwd 必须绝对路径，mcpServers 必传）
        agentReq(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
      } else if (msg.id === 2) {
        const sid = msg.result.sessionId;
        console.log('[session] 已创建', sid);
        // ③ 提交一轮 Prompt（异步，Agent 后续推 session/update 通知）
        agentReq(promptId, 'session/prompt', {
          sessionId: sid,
          prompt: [{ type: 'text', text: '给这个仓库加一个 README' }],
        });
      } else if (msg.id === promptId) {
        console.log('[prompt] 结束，stopReason =', msg.result.stopReason);
      }
    } else {
      // 通知：Agent 主动推送
      handleNotification(msg);
    }
  });
}

function handleNotification(msg: any) {
  // 通知方法固定是 session/update，参数 { sessionId, update }
  const update = msg.params?.update;
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(update.content?.text ?? ''); // 流式文本
      break;
    case 'agent_thought_chunk':
      process.stdout.write(`\n[思考] ${update.content?.text ?? ''}`);
      break;
    case 'tool_call':
      console.log('\n[tool]', update.title || update.kind, '→', update.status);
      break;
    case 'tool_call_update':
      console.log('\n[tool-update]', update.status);
      break;
    case 'plan':
      console.log('\n[计划]', (update.plan ?? []).map((e: any) => `\n  • ${e.content}`).join(''));
      break;
    case 'current_mode_update':
      console.log('\n[mode]', update.currentModeId);
      break;
    default:
      console.log('\n[事件]', update?.sessionUpdate ?? '未知');
  }
}

main();
```

要点：
- **请求（有 `id`）与通知（无 `id`）分流**——Client 靠 `id` 把响应匹配到具体请求。
- **`session/update` 是通知**，内部 `updates[]` 可能一次带多条不同 `kind` 的事件，逐条渲染。
- **权限弹窗**：收到 `request_permission` 通知时，Client 展示给用户，再回 `request_permission_response`。

### 消息序列总览

```
Client                    Agent
  ├─ initialize ─────────▶│  协商版本/能力
  ├─ session/new ────────▶│  建会话（cwd + mcpServers）→ sessionId
  ├─ session/prompt ─────▶│  提交一个 turn
  │◀── session/update ────│  agent_message_chunk（流式）
  │◀── session/update ────│  tool_call / tool_call_update
  │◀── session/update ────│  plan
  │◀── fs/write 等请求 ───│  （如需改文件/起终端，Agent 向 Client 借用）
  │◀── result─────────────│  stopReason: end_turn
```

---

## 七、生产环境要点

1. **传输**：本地就用 **stdio**（spawn Agent 子进程），别自己造 socket；远程等 Streamable HTTP 草案成熟。
2. **版本协商**：`initialize` 的 `protocolVersion` 是唯一权威——它决定走哪套线协议，别从 sdk 版本猜。
3. **权限把关**：把 `request_permission` 弹窗真正接到 UI，别无脑 allow；这是一道审计边界。
4. **事件是流不是包**：`session/update` 可反复推、可携带多条更新，UI 要增量地 append 而非覆盖。
5. **`stopReason` 决定 UI 分支**：`auth_required` 引导登录、`user_intervention_required` 引导补料、
   `end_turn` 才结束本轮。
6. **上下文与 token**：长会话要注意 token 上限（对应 `stopReason: max_tokens`），必要时给用户节流/续接提示。

---

## 八、常见面试追问

**Q1：ACP 和 LSP 什么关系？**
A：设计目标一致——解耦"实现"与"前端"，是"Agent 界的 LSP"。但 LSP 管代码分析补全，
ACP 管完整的交互会话（多轮对话、文件操作、权限、终端）。

**Q2：Client 为什么会被动收到事件？**
A：Agent 干活是异步的（流式文本、工具状态、计划、要授权）。ACP 双向主动，
Client 才能做响应式 UI，而不只是等一个 HTTP 响应。

**Q3：Agent 怎么改文件？直接写磁盘吗？**
A：不直接。Agent 发 `fs/write_text_file` 等请求**让 Client（编辑器）去写**，
文件系统/终端副作用都在 Client 侧，可审计、可拦截。

**Q4：权限谁说了算？**
A：Client/用户。Agent 只能 `session/request_permission` 申请，由用户选
`allow_once / allow_always / reject_once / reject_always` 决定；
会话模式（default/acceptEdits/plan/bypassPermissions/dontAsk）决定默认策略。

**Q5：ACP 和 A2A 区别？**
A：ACP 是「前端 ↔ 单个 Agent」（门面，一对一）；A2A 是「Agent ↔ Agent」（外交，对等）。

**Q6：本地和远程传输？**
A：ACP v1 标准是 stdio（同机）；Streamable HTTP 是 v1 草案提议，面向远程；v2 目前是实验草案。

---

## 小结

- ACP 用 **JSON-RPC 2.0 over stdio** 标准化「客户端 ↔ 单个 Coding Agent」，目标是"Agent 界的 LSP"。
- 生命周期：`initialize` 能力协商 → `authenticate` 鉴权 → `session/*` 会话管理 → `session/prompt` 交互。
- **Prompt Turn** 是异步流：`session/update` 通知（流式文本/工具/计划/模式）+ 响应 `stopReason`。
- 三个关键设计：**工具可观测（tool_call）、权限要申请（request_permission）、
  文件/终端向 Client 借用（fs/*、terminal/*）**。
- 与 MCP（手）、A2A（外交）组成 Agent 系统的三个正交边界。