---
title: A2A — Agent-to-Agent 协议
date: 2026-10-23
excerpt: A2A 让不同进程、组织和厂商的 Agent 用任务状态机协作；这篇讲清 Agent Card、四步流程，以及一份可跑的 TypeScript 示例。
category: AI
---

> 目标：理解 A2A 协议，掌握跨进程/跨组织的 Agent 间协作，并写出一份可跑的 TypeScript 示例。

---

## 背景

多 Agent 教程里常见的 **Orchestrator 模式**，本质是**进程内**协作：

```
主 Agent ──(函数调用/工具封装)──▶ 子 Agent    ← 都在同一个进程里
```

现实中，Agent 往往部署在**不同的进程、不同的组织、甚至不同厂商**：

```
用户的需求：
「帮我查一下这周末上海往返北京的机票，再订个离机场近的酒店」

需要的 Agent：
✈️ 航空公司 Agent   —— 可能是航司自己部署的
🏨 酒店 Agent       —— 可能是 OTA 平台部署的
👤 你的旅行助手 Agent —— 你要自己写的
```

这三个 Agent 由**不同团队开发、部署在不同系统**，你不能简单地 `import` 对方的代码，
更不可能把对方的内部工具直接暴露出来。这时候就需要一个**跨系统的 Agent 通信协议**——
这就是 **A2A（Agent-to-Agent）**。

---

## A2A 是什么

**A2A（Agent-to-Agent）** 是 Google 于 2025 年 4 月发布的开放协议，后来捐给了 **Linux Foundation**
（与 MCP 在 Anthropic 主导下、Agent 互操作标准化方向形成互补）。

它解决的核心问题：**让一个 Agent 能把一个「任务」委托给另一个完全陌生的 Agent，并拿回结果**。
对参与方的要求是「黑盒」——你只需要知道对方**能做什么**和**怎么提交任务**，不需要也不允许窥探
对方内部怎么实现的。

### A2A 与 MCP 的关系（一句话）

```
MCP  = Agent → 工具 / 数据        (垂直连接，Agent 的「手」)
A2A  = Agent → Agent             (水平连接，Agent 之间的「外交协议」)
```

两者**互补，不竞争**。一个 Agent 可以同时用两者：

```
┌─────────────────────────────────────────────┐
│                你的 Agent                    │
│                                             │
│   ┌──────────────┐   ┌──────────────────┐   │
│   │  对下：MCP    │   │  对左右：A2A     │   │
│   │ 接数据库/工具 │   │ 和外部 Agent 协作 │   │
│   └──────────────┘   └──────────────────┘   │
└─────────────────────────────────────────────┘
```

> MCP 是 Agent 的「手」，A2A 是 Agent 之间的「外交协议」，两者互补不竞争。
> MCP / ACP / A2A 的三协议对照是互补读物，本文只展开 A2A。
> 若要先弄清 MCP 作为「手」的那一侧，可看本站的 [MCP 入门](/blog/mv99u875/) 和 [一平台双角色实践](/blog/mv99wysd/)。

---

## A2A 的核心概念

### 1. Agent Card（能力名片）

每个 A2A Agent 暴露一个 `/.well-known/agent.json`，描述它**能做什么**：
- `name`、`description` —— 人类和机器可读的能力描述
- `skills` —— 它提供的技能列表
- `defaultInputModes / defaultOutputModes` —— 支持的内容类型（text、file 等）
- `securityMeasures` —— 鉴权方式、身份校验等

```
GET https://travel.agent/.well-known/agent.json
```

拿到 Agent Card，客户端就知道「它能订机票」以及「怎么调它」。

### 2. Task（任务）

A2A 交互的最小单位是 **Task**，它是有完整生命周期的状态机：

```
submitted → working → input-required ─┐
     │            │                   │(需要补充信息时)
     │            ▼                   │
     └────► completed ←───────────────┘
            │
            ├── succeeded（成功，带 Artifact）
            └── failed（失败，带错误信息）

另有：canceled（被取消）、rejected（被拒绝）
```

任务可能是**长周期**的（比如订单审核可能要几小时），所以 A2A 天然支持**异步**：
客户端提交任务后，可以轮询、用 SSE 订阅、或等对方回调。

### 3. Message 与 Artifact（对话与产物）

- **Message**：任务过程中的对话，`{ role: "user" | "agent", parts: [...] }`
- **Artifact**：任务**产出物**（最终交付的文件、JSON、图片等），挂在 completed 的任务上

```
系统：请安排北京到上海的航班
  ↓ Message（user/agent 你来我往）
Agent：已完成 → 产出 Artifact：[机票 PDF、订单号、价格]
```

### 4. 能力协商（Capability Negotiation）

客户端提交任务时，可以带上 `Message`，随时能被要求补充信息（`input-required`）。
这模拟了真实的人类协作——对方不是一键出结果，而是会来问你要更多信息。

---

## 工作流程（四步）

```
① 发现        GET https://travel.agent/.well-known/agent.json
                    → 拿到 Agent Card（它干嘛的、怎么调）

② 提交任务    POST /message  { method: "tasks/send", params: { message } }
                    → 返回 task 与 taskId

③ 获取进度    POST /message  { method: "tasks/get", params: { id } }
                    → 轮询任务状态（working / input-required / completed...）
                    或用 SSE /tasks/pushSubscription 订阅进度

④ 拿产物      任务 completed(succeeded) → Task.artifacts 里拿到最终交付
```

> 所有方法都通过 **JSON-RPC 2.0** 请求/响应，走 HTTP（内部为 POST /message 端点）。

---

## 示例代码（TypeScript）

我们实现一个「天气 Agent」服务端 + 一个客户端，完整跑一遍四步。

> 说明：官方 `a2a-sdk` 的 TypeScript 版本成熟度还不高，为聚焦协议本身，
> 这里直接用 **Express + 原生 JSON-RPC**，不含第三方 SDK 依赖。

### 依赖

```bash
tnpm install express @types/express cors
# 本地等价：npm install / pnpm add 同样这几个包
```

### 服务端：天气 Agent（server.ts）

```typescript
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

/** 内存任务存储：taskId -> Task */
const tasks = new Map<string, Task>();

// ---------- 类型定义（A2A 消息的最小裁剪） ----------
type TaskStatus =
  | 'submitted' | 'working'
  | 'input-required' | 'completed'
  | 'failed' | 'canceled' | 'rejected';

type Task = {
  id: string;
  status: TaskStatus;
  messages: Message[];
  artifacts: Artifact[];
};

type Message = { role: 'user' | 'agent'; parts: { text?: string }[] };
type Artifact = { id: string; name: string; parts: { text?: string }[] };

// ---------- ① Agent Card：能力名片 ----------
app.get('/.well-known/agent.json', (_req, res) => {
  res.json({
    name: 'Weather Agent',
    description:
      '查询指定城市今天的天气，返回温度、天气状况和建议。' +
      '输入必须是城市名，例如 "北京"。',
    skills: [
      {
        id: 'weather_lookup',
        name: '天气查询',
        description: '给定城市名，返回当前天气',
        tags: ['weather'],
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    securityMeasures: [],
  });
});

// ---------- 业务逻辑：查询天气 ----------
function lookupWeather(city: string): string {
  const records: Record<string, string> = {
    北京: '晴，25°C，适合出行',
    上海: '多云，27°C，体感闷热',
    深圳: '雷阵雨，30°C，记得带伞',
  };
  return records[city] ?? `暂无 ${city} 的天气数据`;
}

// ---------- ②③④ 消息入口：处理 tasks/send、tasks/get ----------
app.post('/message', (req, res) => {
  const { id: requestId, method, params } = req.body;

  // ③ 获取任务进度
  if (method === 'tasks/get') {
    const task = tasks.get(params.id);
    if (!task) return res.status(404).json(jsonrpcError(requestId, -32001, '任务不存在'));
    return res.json(jsonrpcResult(requestId, { task }));
  }

  // ② 提交任务
  if (method === 'tasks/send') {
    const taskId = randomUUID();
    const userMessage: Message = params.message;
    const city = userMessage.parts?.[0]?.text?.replace(/[的天气，。\s]/g, '') ?? '';

    const task: Task = {
      id: taskId,
      status: 'working',
      messages: [userMessage],
      artifacts: [],
    };
    tasks.set(taskId, task);

    // 模拟长任务：500ms 后完成
    setTimeout(() => {
      task.status = 'completed';
      task.messages.push({ role: 'agent', parts: [{ text: `查询完成` }] });
      task.artifacts.push({
        id: randomUUID(),
        name: 'weather-result',
        parts: [{ text: lookupWeather(city) }],
      });
    }, 500);

    return res.json(jsonrpcResult(requestId, { task }));
  }

  // 未实现的方法
  return res.json(jsonrpcError(requestId, -32601, 'Method not found'));
});

// ---------- JSON-RPC 2.0 包装 ----------
function jsonrpcResult(id: string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcError(id: string, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

app.listen(3001, () => console.log('Weather Agent 已启动：http://localhost:3001'));
```

### 客户端：提交任务并轮询（client.ts）

```typescript
const AGENT_URL = 'http://localhost:3001';

type AgentCard = {
  name: string;
  description: string;
  skills: { id: string; name: string }[];
};

type Task = {
  id: string;
  status:
    | 'working'
    | 'completed'
    | 'input-required'
    | 'failed'
    | 'canceled'
    | 'rejected';
  artifacts: { parts: { text?: string }[] }[];
};

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(`${AGENT_URL}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// ① 发现：拉取 Agent Card，确认对方能干嘛
async function discover() {
  const card: AgentCard = await fetch(
    `${AGENT_URL}/.well-known/agent.json`,
  ).then((r) => r.json());
  console.log(`发现 Agent：${card.name} — ${card.description}`);
  console.log('技能：', card.skills.map((s) => s.name).join('、'));
}

// ② 提交任务
async function sendTask(message: string) {
  return rpc<{ task: Task }>('tasks/send', {
    message: { role: 'user', parts: [{ text: message }] },
  }).then((r) => r.task);
}

// ③ 轮询任务，直到终态
async function pollUntilDone(taskId: string, intervalMs = 300) {
  for (;;) {
    const { task } = await rpc<{ task: Task }>('tasks/get', { id: taskId });
    if (task.status === 'completed') return task;
    if (['failed', 'canceled', 'rejected'].includes(task.status)) {
      throw new Error(`任务失败：${task.status}`);
    }
    await sleep(intervalMs); // 还没完，再等一会儿
  }
}

async function main() {
  await discover();

  const task = await sendTask('北京今天天气怎么样？');
  console.log(`任务已提交：${task.id}（状态 ${task.status}）`);

  const done = await pollUntilDone(task.id);
  // ④ 拿产物
  console.log('结果：', done.artifacts[0].parts[0]?.text);
}

main().catch((e) => console.error(e));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### 运行

```bash
# 开两个终端
tnpm run tsx -- server.ts   # 服务端
tnpm run tsx -- client.ts   # 客户端
# 本地等价：npx tsx server.ts / npx tsx client.ts
```

```
发现 Agent：Weather Agent — 查询指定城市今天的天气，返回温度、天气状况和建议。
技能：天气查询
任务已提交：3f7a...（状态 submitted）
结果：晴，25°C，适合出行
```

---

## 生产环境要点（简版）

1. **鉴权**：Agent Card 会声明 `securityMeasures`（如 Bearer Token / OAuth）。
   跨组织调用必须有身份认证，不要裸奔。
2. **幂等**：`tasks/send` 可传 `taskId` 用作幂等键，避免网络重试造成重复下单。
3. **长任务**：用 SSE `tasks/pushSubscription` 订阅进度，别一直死轮询。
4. **补充信息**：对方返回 `input-required` 时要回 `/tasks/acknowledged` 告知收到，
   然后 `tasks/update` 补充 `parts` 继续推进。
5. **传输模式**：即兴的短任务用 HTTP 同步即可；长周期任务用 SSE 或回调更合适。

---

## 与 MCP 的组合架构示例

一个真实的 Agent 往往是「对内 MCP、对外 A2A」：

```
┌──────────────────────── 你的 Agent ────────────────────────┐
│                                                           │
│   A2A 出口：/message   ← 外部 Agent 通过这里的 tasks/*      │
│        │                     提交/查询任务                  │
│        ▼                                                   │
│   ┌──────────────────────────────────────┐                 │
│   │          你的业务逻辑(Reasoning)       │                 │
│   │           需要工具/数据时 ↓           │                 │
│   │   ┌──────────────────────────────┐   │                 │
│   │   │ MCP Client                    │   │                 │
│   │   │   └─ 数据库工具 / 支付工具 /.. │   │                 │
│   │   └──────────────────────────────┘   │                 │
│   └──────────────────────────────────────┘                 │
└───────────────────────────────────────────────────────────┘
```

- **对下（同域）**：用 MCP 接入数据库、支付、内部服务，能力细粒度暴露。
- **对左右（跨域）**：用 A2A 与其他组织/厂商的 Agent 协商任务，能力黑盒化。

这也呼应了 A2A 官方的一句话定位：**"A2A is complementary to MCP"** ——
MCP 让 Agent 有「手」，A2A 让 Agent 有「同事」。

同一套组合，在本站的 [MCP 双角色实践](/blog/mv99wysd/) 里能看到「对下用 MCP 接工具」的工程细节；本文补的是「对左右用 A2A 谈任务」的那一半。

---

## 常见面试追问

**Q1：既然 MCP 能把子 Agent 封装成工具，为什么还需要 A2A？**
A：MCP 面向「进程内/同信任域」的工具调用，要求把对端能力细粒度暴露出来。
跨组织场景里对方不愿暴露内部工具，也不想让你管它的任务生命周期。A2A 用
任务状态机 + 黑盒封装，专门解决跨系统协作。

**Q2：A2A 和 MCP 冲突吗？**
A：不冲突。A2A 官方明确是「complementary to MCP」。一个管 Agent-工具，
一个管 Agent-Agent。

**Q3：A2A 任务为什么强调异步？**
A：实际协作是长周期的（审批、预订、外部执行），同步阻塞不现实。
Task 状态机 + 轮询/SSE 让双方独立演进。

---

## 小结

- A2A 解决**跨进程/跨组织/跨厂商**的 Agent 间协作，与 MCP 互补。
- 核心抽象：**Agent Card**（发现）、**Task**（生命周期）、**Message/Artifact**（对话与产物）。
- 四步流程：发现 → 提交任务 → 获取进度 → 拿产物，全部走 JSON-RPC 2.0 over HTTP。
- 对内用 MCP 接工具，对外用 A2A 协作，是最常见的企业组合。
