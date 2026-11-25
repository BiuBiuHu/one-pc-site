---
title: "第 49 课：MCP / ACP / A2A 三协议总对比"
date: 2026-11-25
excerpt: "MCP / ACP / A2A 各自解决什么问题？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 46
---

> 目标：一张表讲清 Agent 生态三大协议的定位、区别、选型与组合

---

## 背景

前面三课分别介绍了三个协议，它们都叫"Agent 协议"，但解决的**边界**完全不同，
容易被混在一起。本课把它们放到同一张图、同一张表里做总对比，作为快速查阅的对照参考。

```
MCP  = Agent ↔ 工具/数据     （Agent 的"手"：接能力）
ACP  = 客户端 ↔ 单个 Agent   （Agent 的"门面"：给前端/人看的那面）
A2A  = Agent  ↔ Agent      （Agent 的"外交"：跨系统协作）
```

---

## 一、定位图（一句话版本）

```
          前端 / IDE（人）
                │
                │ ACP（门面）
                ▼
      ┌───────────────────┐  A2A（外交）  ┌─────────────┐
      │     我的 Agent     │◀────────────▶│  外部 Agent  │
      │                   │              │  （跨组织）   │
      │  ┌─────────────┐  │              └─────────────┘
      │  │ MCP Client  │  │
      │  └──────┬──────┘  │
      └─────────┼─────────┘
                │ MCP（手）
                ▼
        数据库 / 工具 / 服务
```

- **对下接能力 → MCP**（垂直，层次低，能力细粒度暴露）
- **对外露门面 → ACP**（垂直，把"单一 Agent"交给前端去驱动）
- **对平找同事 → A2A**（水平，任务委托给对等 Agent，黑盒）

---

## 二、全维度对比表

| 维度 | MCP | ACP | A2A |
|------|-----|-----|-----|
| 发起方 | Anthropic (2024.11) | Zed (2025) | Google (2025.04) → Linux Foundation |
| 边界 | Agent ↔ 工具/数据 | 客户端(UI) ↔ 单个 Agent | Agent ↔ Agent |
| 对端 | 工具、资源、Prompt | 编辑器/前端界面 | 另一个独立 Agent |
| 关系 | 一对多（Agent 调多个工具） | 一对一、双向主动 | 对等任务委托 |
| 核心抽象 | tools / resources / prompts | initialize 协商 / Session / Prompt Turn / `session/update` 通知 | Agent Card / Task / Message / Artifact |
| 对端可见性 | 细粒度暴露能力 | Agent 内部模型不外泄，但工具/文件操作对 Client **可观测** | 双方互为黑盒（opaque） |
| 交互方向 | 请求 → 响应（单向为主） | **双向主动**（Agent 可 push 事件） | 提交任务 → 进度 → 产物（异步） |
| 任务语义 | 一次工具调用 | 一场会话中的多轮交互 | 跨系统长周期任务（状态机） |
| 协议封装 | JSON-RPC 2.0 | JSON-RPC 2.0 | JSON-RPC 2.0 |
| 典型传输 | stdio / Streamable HTTP | stdio（标准）/ Streamable HTTP(草案) | HTTP / SSE |
| 信任域 | 同域（Agent 自己的环境） | 同域（client 与自己的 agent） | **跨域**（组织/厂商之间） |
| 类比 | Agent 的"手" | Agent 的"门面"/"Agent 界的 LSP" | Agent 的"外交协议" |
| 典型示例 | Agent 连数据库、支付、内部服务 | IDE(如 Zed) 驱动 Gemini CLI / Codex CLI 等 | 旅行助手协调航司/酒店 Agent |

---

## 三、关键差异点详解

### 1. 解决的问题不同

| 协议 | 回答的问题 |
|------|-----------|
| MCP | 我的 Agent 怎么**用工具 / 拿数据**？ |
| ACP | 我的前端/IDE 怎么**驱动这个 Agent**，跟它实时对话？ |
| A2A | 我这个 Agent 怎么**把任务委托给另一个 Agent** 并拿回结果？ |

### 2. 边界与信任域（最本质的区别）

- **MCP / ACP** 都发生在**同域内**（你自己的 Agent 和它自己的工具/前端）。
- **A2A** 是唯一真正为**跨组织、跨厂商**设计的——双方互为黑盒，不能也不该窥探对方实现。

这也是为什么 A2A 强调 **Task 状态机 + 异步**：跨系统协作往往是长周期（审批、预订、外部执行），
不可能用一个同步 HTTP 搞定。

### 3. 交互主动性

- MCP：基本上是「Agent 发出请求 → 拿到工具结果」，单向为主。
- ACP：**双向主动**。Agent 通过 `session/update` 主动推 `agent_message_chunk`（流式文本）、
  `tool_call`（工具状态）、`plan_update`（计划）等事件给前端。
- A2A：异步任务委托，客户端提交后通过轮询/SSE 获取进度，也可能被对方要求补充信息（`input-required`）。

### 4. 对端可见性

- MCP：对端是一组组细粒度的 tool/resource，能力**全部暴露**给 Agent。
- A2A：只暴露「能力名片（Agent Card）」+「提交任务」两个入口，内部完全黑盒。
- ACP：Client 是门面，Agent 的整体能力对 Client 暴露，但 Agent 的内部模型/记忆不下传。

---

## 四、选型决策指南

```
❓ 我要「接一个工具/数据」？
    → 用 MCP
❓ 我要「在前端 IDE 里驱动我的 Coding Agent」？
    → 用 ACP
❓ 我要「把活儿外包给另一个组织/厂商的 Agent」？
    → 用 A2A
❓ 我「一个 Agent 内部」既要接工具、又要被前端驱动、又要找外部帮手？
    → 三者组合（见下一节）
```

### 组合范式（企业 Agent 常见形态）

```
  前端 / IDE（人）
     │ ACP
   ┌─▼───────────────┐
   │    我的 Agent     │◀── A2A ──▶ 外部 Agent（跨组织）
   │ ┌──────────────┐ │
   │ │ MCP Client    │ │
   │ │  └─ 数据库/服务│ │
   │ └──────────────┘ │
   └──────────────────┘
     ACP：人 ↔ 我的 Agent（门面）
     MCP：我的 Agent ↔ 它的工具（手）
     A2A：我的 Agent ↔ 外部 Agent（外交）
```

---

## 五、FAQ 速答

**Q1：MCP 和 A2A 冲突吗？**
A：不冲突。A2A 官方定位就是 "complementary to MCP"。MCP 管 Agent-工具，A2A 管 Agent-Agent。

**Q2：既然 MCP 能把子 Agent 封装成工具，为什么还要 A2A？**
A：MCP 是进程内/同信任域、要求能力细粒度暴露。跨组织时对方不愿暴露内部工具，
也不愿暴露任务生命周期。A2A 用任务状态机 + 黑盒，专为跨系统。

**Q3：ACP 和 LSP 什么关系？**
A：设计目标一致——解耦"实现"与"前端"，是"Agent 界的 LSP"。LSP 管代码分析，ACP 管交互会话。

**Q4：ACP 和 A2A 区别一句话？**
A：ACP 是「前端 ↔ 单个 Agent」（门面，一对一），A2A 是「Agent ↔ Agent」（外交，对等）。

**Q5：三个都要用吗？**
A：取决于场景。一个完整的编程 Agent 通常三者组合：ACP 接 IDE、MCP 接工具、A2A 找外部专家。

**Q6：本地和远程分别用什么传输？**
A：三者均传输无关、都用 JSON-RPC 2.0 信封。ACP v1 标准是 stdio（同机）、
Streamable HTTP 为草案；A2A 走 HTTP/SSE/长轮询；MCP 常用 stdio 或 Streamable HTTP。

---

## 关联课程

| 课程 | 文档 |
|------|------|
| MCP — Model Context Protocol | [第 12 课](/blog/from-scratch-12-mcp/) |
| A2A — Agent-to-Agent 协议 | [第 47 课](/blog/from-scratch-47-a2a/) |
| ACP — Agent Client Protocol | [第 48 课](/blog/from-scratch-48-acp/) |
| 更多协议：ANP / AIP（生态补充） | [第 51 课](/blog/from-scratch-51-anp-aip/) |
| 用 ACP 驱动 Claude Code（实战） | [第 50 课](/blog/from-scratch-50-acp-demo/) |