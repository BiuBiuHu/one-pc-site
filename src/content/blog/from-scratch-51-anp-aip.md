---
title: "更多 Agent 互操作协议（ANP / AIP）"
date: 2026-11-25
excerpt: "还有更多的 Agent 互操作尝试吗？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 48
---

> 目标：在 MCP / ACP / A2A 之外，补充两个生态派系——走"去中心化身份"路线的 **ANP**，
> 与走"科研网格路由"路线的 **AIP**，便于横向对比与选型

---

## 背景

47~49 课聊的 MCP / A2A / ACP 是当下主流三件套。但 Agent 互操作生态远不止它们，
还有两个常被并列提起的国内团队协议：**ANP**（Agent Network Protocol，去中心化身份派）
与 **AIP**（Agent Interaction Protocol，科研网格路由派）。

它们解决的问题与 MCP/A2A/ACP 有重叠，但切入点和取舍很不一样，值得放进来做一次全景对比。

---

## ANP — Agent Network Protocol（"Agentic Web 的 HTTP"）

**来源**：[agent-network-protocol/AgentNetworkProtocol](https://github.com/agent-network-protocol/AgentNetworkProtocol)（~1.4k+ stars，中文开源社区，官方明确"未发行任何数字货币"）

**定位**：想做"智能体互联网时代的 HTTP"。愿景是把人类互联网从"平台中心"转向"协议中心"，
让海量 Agent 像网页一样彼此发现、互联、协作——即 **Web of Agents**。

### 核心设计

- **复用互联网基础设施**：不重建网络栈，直接用 HTTP、TLS、DNS、CDN、CA、Search。
- **W3C DID 去中心化身份**：Agent 用 DID 标识，而非平台账号。内置 `did:wba`（Web 绑定的 DID 方法）与 `did:web`（原生）。
- **协议族（ANP-01 ~ ANP-10）**分层组织：

| 层 | 规范 | 作用 |
|----|------|------|
| 身份/加密消息层 | ANP-02 DID 认证、ANP-03 did:wba、ANP-04 命名(WNS)、ANP-05 授权、ANP-06 元协议(草案) | 认证、寻址、加密端到端消息 |
| 应用协议层 | ANP-07 Agent 描述、ANP-08 发现、ANP-09 即时消息、ANP-10 支付(草案) | 让 Agent 能"自述能力、被找到、协作、结算" |

- **元协议（Meta-protocol，草案）**：Agent 之间通过 `anp.get_capabilities` / `anp.negotiate`
  动态协商，再决定后续用哪套接口、Profile、安全模型与 schema —— 即"先谈好用哪套协议，再通信"。

- **关键机制**：
  - Agent Description（自述能力文档，类似 A2A 的 Agent Card，但绑定 DID）→ 对应 MCP/A2A 的"能力描述"。
  - Discovery（`.well-known` 主动 + 搜索 Agent 被动注册）→ 对应"发现"层。
  - WNS（Web Name Service）：人类可读的 handle → DID 解析。

> **一句话**：ANP 把"身份、命名、发现、协商、加密"当成一个完整的互联网级协议套件来做，
> 押注去中心化（DID）。与 MCP/A2A 偏"面向调用"不同，ANP 更偏"面向连接与身份"。

---

## AIP — Agent Interaction Protocol（中科院自动化所）

**来源**：[ScienceOne-AI/Agent-Interaction-Protocol](https://github.com/ScienceOne-AI/Agent-Interaction-Protocol)，
中国科学院自动化研究所研发的分布式智能体交互协议，面向**科学（科研）场景**的大规模多智能体系统。

### 核心设计

- **gRPC 通信**：以 gRPC（二进制）为底层传输，相比 JSON-RPC，序列化/反序列化更快、
  更轻量，适合高频、大规模调用。
- **网关中心路由**：除点对点通信外，支持以**网关**为中心的路由模式，便于把一组科学 Agent
  注册到同一网关统一管理调度。
- **统一接口**：同一套接口同时覆盖
  - **Agent ↔ Agent**：双向流式交互；
  - **Agent ↔ 工具/数据**：工具调用与数据访问。
- **MCP 兼容**：定义 **MCP 代理节点**，可把现成 MCP Server 直接接入 AIP 系统，
  经网关统一注册、调度、调用，**无需改协议格式**。

### 三要素组件（注册模型）

| 组件 | 角色 |
|------|------|
| `Gateway` | 中心网关，负责路由与分组管理 |
| `ToolBox` | 工具集合，把普通函数注册成可被 AIP 调用的工具 |
| `Agent` | 智能体，注册到网关后可收/发 AIP 消息 |

```
ToolBox-A ─┐
Agent-A  ──┤
Agent-B  ──┼──▶ Gateway（中心路由）
MCP 代理节点─┘    │  统一注册 / 调度
                  ├──▶ Agent-C（点对点/经网关）
                  └──▶ ToolBox-B
```

> **一句话**：AIP 押注"科研场景 + 高性能（gRPC）+ 中心化网关编排"，并主动兼容 MCP 生态，
> 与 ANP 的"去中心化身份"路线形成鲜明对照。

---

## 全景对比（五个协议）

| 维度 | MCP | A2A | ACP | ANP | AIP |
|------|-----|-----|-----|-----|-----|
| 发起方/社区 | Anthropic | Google→LF | Zed | 中文开源社区 | 中科院自动化所 |
| 边界 | Agent↔工具/数据 | Agent↔Agent（跨组织） | 前端↔单个 Agent | Agent↔Agent（去中心化身份） | Agent↔Agent/工具（网格 + 路由） |
| 身份模型 | 无（工具域） | 无（能力名卡） | 无（会话） | **W3C DID** | 网关注册 ID |
| 传输 | JSON-RPC (stdio/HTTP) | JSON-RPC (HTTP/SSE) | JSON-RPC (stdio) | HTTP/TLS + DID | **gRPC（二进制）** |
| 核心卖点 | 接工具/数据 | 跨系统任务委托 | 前端互通会话 | 身份/发现/协商/加密 | 高性能 + 网关编排 + MCP 兼容 |
| 典型目标 | 单个 Agent 的能力 | 跨组织协作 | IDE 接 Coding Agent | Web of Agents | 大规模科研智能体 |

> 优势不重叠：需要"接工具"用 MCP；要"门面"用 ACP；要"跨系统委托"用 A2A；
> 要"去中心化身份+发现+加密"看 ANP；要"科研级高吞吐+网关路由"看 AIP。

---

## 如何选型（一句话）

```
接工具 / 拿数据        → MCP
前端 IDE 驱动 Coding Agent → ACP
跨组织 / 跨厂商任务委托  → A2A
去中心化身份 + 发现 + 加密 → ANP（偏互联网级连接）
科研 / 大规模 + 高吞吐 + 网关 → AIP（gRPC）
```

---

## 关联课程

| 课程 | 文档 |
|------|------|
| MCP / ACP / A2A 三协议总对比 | [第 49 课](/blog/from-scratch-49-agent-protocols/) |
| A2A — Agent-to-Agent 协议 | [第 47 课](/blog/from-scratch-47-a2a/) |
| ACP — Agent Client Protocol | [第 48 课](/blog/from-scratch-48-acp/) |
| 用 ACP 驱动 Claude Code（实战） | [第 50 课](/blog/from-scratch-50-acp-demo/) |

> 参考出处：ANP 官方仓库 `agent-network-protocol/AgentNetworkProtocol`（README / ANP-01~10 规范索引）；
> AIP 官方仓库 `ScienceOne-AI/Agent-Interaction-Protocol`（README 中文/英文）。本课基于两份官方 README
> 整理，版本以官方仓库为准。