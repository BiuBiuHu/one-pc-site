---
title: "用 ACP 驱动 Claude Code（实战 Demo）"
date: 2026-11-25
excerpt: "用 ACP 驱动真实编码 Agent 跑起来。"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 47
---

> 目标：手写一个 ACP 客户端，通过官方适配器把真正的 Claude Code 拉起来干活，
> 把 48 课讲的线协议完整跑一遍（已在本机验证通过）

---

## 定位

- 48 课讲清了 ACP 的**抽象与线协议**；本课写**可运行的真实代码**。
- 复现链路：

```
我们用 TS 写的 Client ──spawn──▶ @zed-industries/claude-code-acp（官方 ACP 适配器）
        JSON-RPC 2.0 over stdio          │ 内部调用 Claude Agent SDK query()
        initialize / session/new / ...   ▼
                                    真正的 Claude Code
```

- 传输是 **stdio + JSON-RPC**，完全手写，不依赖 `@agentclientprotocol/sdk`。

---

## Demo 位置

```
examples/acp-claude-code/
├── package.json     # 只依赖官方适配器 + tsx/typescript
├── tsconfig.json
└── client.ts         # 手写 ACP v1 客户端（单文件）
```

## 运行

```bash
cd examples/acp-claude-code
npm install

# 传一个 prompt 给 Claude Code 干
npm run dev -- "请只输出一行文本：1 + 1 = 2。不要使用任何工具。"
```

> 前置：本机 Claude Code 可用（`claude` 命令存在），且保持**登录态**（`claude` 会话或
> `ANTHROPIC_API_KEY`）。demo 只发一个 prompt，做纯应答、不落盘。

### 真实输出（本机捕获）

```
[client] 拉起 ACP 适配器，prompt = "请只输出一行文本：1 + 1 = 2。不要使用任何工具。"

[init] protocolVersion = 1, 能力 = { promptCapabilities: { image: true, embeddedContext: true },
  mcpCapabilities: { http: true, sse: true }, loadSession: true,
  sessionCapabilities: { fork: {}, list: {}, resume: {} } }
[init] authMethods = [{"description":"Run `claude /login` in the terminal","name":"Log in with Claude Code","id":"claude-login"}]
[session] sessionId = 231e88fb-c321-40c1-8b46-bb0f764e2842

[思考] The user wants a single line of text: "1 + 1 = 2", no tools.
1 + 1 = 2
[prompt] stopReason = end_turn
```

可以看到：
- `session/update` 先推 `agent_thought_chunk`（思考推理）
- 再推 `agent_message_chunk` 逐字打出 `1 + 1 = 2`
- 最终 `session/prompt` 响应 `stopReason: end_turn`，本次交互正常结束。

---

## 线协议（真实抓包，49 课示例的对照）

### 1. initialize —— 协商

```jsonc
// Client → Agent（stdout 写入一行 JSON）
{ "jsonrpc": "2.0", "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,                    // ← 整数！不是 {major, minor}
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true,
      "auth": { "terminal": true }
    },
    "clientInfo": { "name": "acp-demo", "url": "", "version": "0.1.0" }
  } }

// Agent → Client：返回协议版本 + 能力 + 鉴权方式
{ "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": { "...": "..." },
    "authMethods": [ { "id": "claude-login", "...": "..." } ]
  } }
```

### 2. session/new —— 建会话

```jsonc
{ "jsonrpc": "2.0", "id": 2,
  "method": "session/new",
  "params": { "cwd": "/abs/path", "mcpServers": [] } }   // ← mcpServers 必传（可空数组）

// Agent → Client
{ "id": 2, "result": { "sessionId": "231e88fb-...", "models": { "...": "..." }, "modes": { "...": "..." } } }
```

### 3. session/prompt —— 提交任务（异步、流式）

```jsonc
{ "jsonrpc": "2.0", "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "231e88fb-...",
    "prompt": [ { "type": "text", "text": "请只输出一行：1 + 1 = 2" } ]  // ← 字段名是 prompt，不是 content
  } }
```

### 4. session/update —— Agent 主动推送（通知，无 id）

```jsonc
// 通知参数固定 { sessionId, update }，update.sessionUpdate 是判别字段
{ "jsonrpc": "2.0", "method": "session/update",
  "params": {
    "sessionId": "231e88fb-...",
    "update": { "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "The user wants..." } }
  } }
{ "jsonrpc": "2.0", "method": "session/update",
  "params": {
    "sessionId": "231e88fb-...",
    "update": { "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "1 + 1 = 2" } }
  } }

// 任务结束：session/prompt 的响应带 stopReason
{ "id": 3, "result": { "stopReason": "end_turn" } }
```

---

## 实现要点（对应 48 课的每一个抽象）

| 48 课概念 | 真实实现 |
|-----------|---------|
| 能力协商 | `initialize` 用 `protocolVersion: 1`（整数），能力由 Agent 在 `result.agentCapabilities` 声明 |
| Session 创建 | `session/new` 必传 `cwd`（绝对路径）+ `mcpServers`（空数组） |
| Prompt Turn | `session/prompt`、用户内容字段是 `prompt`（数组，含 `{type:'text',text}`） |
| 流式事件 | `session/update` 通知，参数 `{ sessionId, update }`，用 `update.sessionUpdate` 判别（`agent_message_chunk` / `tool_call` / `plan`…），文本在 `update.content.text` |
| 停止原因 | 响应 `result.stopReason`（`end_turn` 等） |
| 请求/通知分流 | **响应**必有 `result/error`；**Agent 请求**必有 `method`；通知无 `id`。三个都要区分 |

---

## 实战升级：让 Agent 真干活（读文件并修改）

`client.ts` 已实现 **Agent→Client 请求分发**，能替 Agent 读写文件并真实验证落盘：

```
Client(我们)                           Claude Code（经适配器）
   │  initialize 声明 fs.read/write │   → 适配器禁用内置 Read/Write/Edit
   │  session/prompt:「读取 todo.md 并追加一行」
   │◀─ session/update tool_call ────│ Edit sandbox/todo.md
   │◀─ session/request_permission ──│ 申请改文件
   │── result {outcome:selected} ──▶│ 自动选 allow_once（真实 UI 应弹窗）
   │◀─ fs/read_text_file ───────────│ 借用：读原文件
   │── result {content} ──────────▶│
   │◀─ fs/write_text_file ──────────│ 借用：写入新内容（我们真实落盘）
   │── result {} ────────────────▶│
   │◀─ result stopReason: end_turn ─│ 完成
```

### 真实跑通的输出

```
[fs 借用] 读 .../sandbox/todo.md（42 字符）
[权限] Agent 申请：Edit ... → 自动 allow_once(Allow)
[fs 借用] 读 .../sandbox/todo.md（42 字符）
[fs 借用] 写 .../sandbox/todo.md（62 字符）✔ 已落盘
...
[prompt] stopReason = end_turn
```

演示后 `sandbox/todo.md` 真实变化：

```diff
 # 今日待办
 - [ ] 学完 ACP 协议
 - [ ] 跑通 ACP demo
+- [x] ACP 借用文件系统成功
```

> 这就是 ACP 核心设计的落地：**文件读写在 Client 侧发生**，Agent 全程只"申请/借用"，
> 我们既能看到、也能拦截每一次文件操作。

---

## 踩坑记录（实现时真实遇到的坑）

1. **嵌套会话保护**（最容易踩）：
   在本会话内部跑这个 demo 时，适配器直接报
   `"Claude Code cannot be launched inside another Claude Code session."`
   因为 shell 带着 `CLAUDECODE` 环境变量。对策：给适配器子进程的环境变量里清掉
   `CLAUDECODE`、`CLAUDE_CODE_SSE_PORT`、`CLAUDE_CODE_ENTRYPOINT`。

2. **`protocolVersion` 是整数**：写成 `1`，不是 `{major:1, minor:0}`（旧版文档写错过）。

3. **`session/new` 必传 `mcpServers`**：只传 `cwd` 会报 `Invalid params`（SDK zod 强校验）。

4. **`session/prompt` 字段是 `prompt`**：传 `content` 会参数不合法，正确是
   `prompt: [{ type: 'text', text }]`。

5. **通知不是 `updates[]` 数组**：真实是 `{ sessionId, update }` 单个对象，
   判别字段是 `update.sessionUpdate`（不是 `kind`）。

6. **鉴权**：`authMethods` 可能要求 `authenticate`，本适配器 `authenticate` 未实现
   （依赖本机登录态）。如果停在本机未登录，先 `claude` 登录或设好 `ANTHROPIC_API_KEY`。

7. **JSON-RPC id 冲突（本 demo 最大的坑）**：我们的 `session/prompt` 请求 id 可能与
   Agent 发来的 `fs/write_text_file` 请求 id 撞号（两边都从 1 递增）。若只按"带 id 就认作响应"
   分派，会把 Agent 的文件请求误判成自己的响应 → 既没写文件、又报 `cannot read stopReason`。
   **正解**：响应必有 `result/error`、请求必有 `method`，按此区分。

8. **Agent→Client 的请求必须应答**：`fs/*`、`session/request_permission` 这些带 `id` 的
   Agent 请求，若 Client 不回 `result`，Agent 会一直等下去（表现为卡死）。新加能力时
   别忘了让 `handleAgentRequest` 兜底回应。

---

## 排障速查

| 现象 | 可能原因 / 处理 |
|------|----------------|
| `ENOENT: node_modules/.bin/claude-code-acp` | 没 `npm install` |
| `Internal error / Query closed before response` | 嵌套会话：清 `CLAUDECODE` 等环境变量 |
| `Invalid params` on session/new | 漏传 `cwd`（绝对路径）或 `mcpServers` |
| `auth_required` / 登录失败 | 先 `claude /login` 或设 `ANTHROPIC_API_KEY` |
| prompt 无输出就结束 | 看 `stopReason`：`refusal`（拒绝）、`max_tokens`（太长）等 |
| 能读却写不了 / `cannot read stopReason` | **id 冲突**：按 `result/error 是响应、method 是请求` 分派（见坑 7） |

---

## 关联课程

| 课程 | 文档 |
|------|------|
| ACP — Agent Client Protocol（协议详解） | [第 48 课](/blog/from-scratch-48-acp/) |
| MCP / ACP / A2A 三协议总对比 | [第 49 课](/blog/from-scratch-49-agent-protocols/) |

> 想躺着用他人封装，可换用官方 `@agentclientprotocol/sdk` 的客户端；本 demo 刻意手写，
> 是为了把这层"线协议"看得一清二楚。