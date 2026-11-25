---
title: "第二十七课：Remote Gateway — 远程驱动本地 Agent"
date: 2026-11-25
excerpt: "如何从手机/网页远程驱动本地编码 Agent 干活？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 28
---

> 目标：从任意远程端（手机/网页/CLI）发一条消息，让本地开发机上的 Agent 自动执行任务，结果实时回传

---

## 背景：为什么需要 Remote Gateway？

有些 Agent 任务必须在**本地机器**上执行：
- 访问本地文件系统（代码库、配置文件）
- 调用只在本地运行的服务（本地数据库、内网 API）
- 驱动本地工具（Claude Code、本地 IDE）

但你可能在手机上、在另一台电脑上，想远程触发这些任务。

**Remote Gateway** 解决这个问题：

```
你的手机/远程电脑
    │ 发送指令
    ▼
云端 Gateway（公网可访问）
    │ 通过 WebSocket 长连接
    ▼
本地开发机上的 Agent Worker
    │ 执行任务（访问本地文件、调用本地服务）
    ▼
结果实时回传给云端 Gateway
    │
    ▼
你的手机/远程电脑（看到结果）
```

---

## 核心机制：WebSocket 反向连接

关键点：**本地 Worker 主动连接云端 Gateway**，而不是 Gateway 连接 Worker。

这样做的原因：
- 本地机器通常在 NAT 后面，没有公网 IP，外部无法直接连接
- 本地 Worker 主动发起连接，穿透 NAT
- Gateway 只需要一个公网地址

```
本地 Worker ──WebSocket 连接──▶ 云端 Gateway（公网 IP）
                                      │
                                      │◀── 远程客户端（手机/网页）
```

---

## 实现：云端 Gateway

```typescript
// src/gateway/gateway-server.ts
import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// 已注册的本地 Worker 连接
// key: workerId，value: WebSocket 连接
const registeredWorkers = new Map<string, WebSocket>();

// 等待结果的 Promise resolve 函数
// key: taskId，value: resolve 函数
const pendingTasks = new Map<string, (result: TaskStreamEvent[]) => void>();

// 收集每个任务的流式事件
const taskEventBuffers = new Map<string, TaskStreamEvent[]>();

interface TaskStreamEvent {
  type: string;
  toolName?: string;
  content?: string;
  fullText?: string;
}

// ── WebSocket：接受本地 Worker 的注册 ──────────────────────────────────────
wss.on('connection', (ws, req) => {
  const workerId = req.url?.replace('/?workerId=', '') ?? randomUUID();
  registeredWorkers.set(workerId, ws);
  console.log(`✅ Worker 已注册: ${workerId}（当前在线: ${registeredWorkers.size}）`);

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      taskId: string;
      event: TaskStreamEvent;
    };

    const { taskId, event } = message;

    // 收集流式事件
    if (!taskEventBuffers.has(taskId)) {
      taskEventBuffers.set(taskId, []);
    }
    taskEventBuffers.get(taskId)!.push(event);

    // 任务完成，resolve 等待的 Promise
    if (event.type === 'done' || event.type === 'error') {
      const resolve = pendingTasks.get(taskId);
      if (resolve) {
        resolve(taskEventBuffers.get(taskId)!);
        pendingTasks.delete(taskId);
        taskEventBuffers.delete(taskId);
      }
    }
  });

  ws.on('close', () => {
    registeredWorkers.delete(workerId);
    console.log(`❌ Worker 断开: ${workerId}（当前在线: ${registeredWorkers.size}）`);
  });
});

// ── HTTP API：远程客户端提交任务 ───────────────────────────────────────────
app.post('/api/run', async (req, res) => {
  const { message, workerId } = req.body;

  // 选择一个可用的 Worker
  const targetWorkerId = workerId ?? registeredWorkers.keys().next().value;
  const workerWs = targetWorkerId ? registeredWorkers.get(targetWorkerId) : undefined;

  if (!workerWs || workerWs.readyState !== WebSocket.OPEN) {
    res.status(503).json({ error: '没有可用的本地 Worker，请先启动本地 Agent' });
    return;
  }

  const taskId = randomUUID();

  // 创建等待结果的 Promise
  const resultPromise = new Promise<TaskStreamEvent[]>((resolve) => {
    pendingTasks.set(taskId, resolve);
    // 5 分钟超时
    setTimeout(() => {
      if (pendingTasks.has(taskId)) {
        pendingTasks.delete(taskId);
        resolve([{ type: 'error', content: '任务超时（5分钟）' }]);
      }
    }, 300000);
  });

  // 把任务发给本地 Worker
  workerWs.send(JSON.stringify({ taskId, message }));
  console.log(`📤 任务已发给 Worker ${targetWorkerId}: ${taskId}`);

  // 等待结果（SSE 流式返回）
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 实时转发事件给远程客户端
  // 用一个临时的事件监听器，在任务完成前持续转发
  const forwardEvents = () => {
    const buffer = taskEventBuffers.get(taskId);
    if (buffer && buffer.length > 0) {
      // 转发所有新事件
      buffer.forEach(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      buffer.length = 0; // 清空已转发的事件
    }
  };

  const forwardInterval = setInterval(forwardEvents, 100);

  // 等待任务完成
  await resultPromise;
  clearInterval(forwardInterval);
  forwardEvents(); // 转发最后一批事件
  res.end();
});

// 查询在线 Worker 列表
app.get('/api/workers', (_req, res) => {
  res.json({
    count: registeredWorkers.size,
    workers: Array.from(registeredWorkers.keys()),
  });
});

const PORT = Number(process.env.PORT ?? 8080);
httpServer.listen(PORT, () => {
  console.log(`🌐 Gateway 已启动，端口 ${PORT}`);
});
```

---

## 实现：本地 Worker（连接到云端 Gateway）

```typescript
// src/gateway/local-worker.ts
import WebSocket from 'ws';
import { Agent } from '../agent/agent.js';
import type { AgentEvent } from '../agent/agent.js';
import type { CoreMessage } from 'ai';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://localhost:8080';
const WORKER_ID = process.env.WORKER_ID ?? `local-${process.pid}`;

async function startLocalWorker(): Promise<void> {
  // 与前面课程保持一致的 Agent 构造签名：
  // (apiKey, modelName, baseURL?, systemPrompt?, workspaceRoot?, rulesManager?, skillsManager?)
  const agent = new Agent(
    process.env.OPENAI_API_KEY!,
    process.env.MODEL_NAME ?? 'gpt-4',
    process.env.OPENAI_BASE_URL
  );

  // 连接到云端 Gateway，带上 workerId
  const ws = new WebSocket(`${GATEWAY_URL}?workerId=${WORKER_ID}`);

  ws.on('open', () => {
    console.log(`✅ 已连接到 Gateway: ${GATEWAY_URL}`);
    console.log(`   Worker ID: ${WORKER_ID}`);
    console.log('   等待远程任务...');
  });

  ws.on('message', async (data) => {
    const { taskId, message } = JSON.parse(data.toString()) as {
      taskId: string;
      message: string;
    };

    console.log(`\n📥 收到任务 ${taskId}: ${message}`);

    // 发送事件给 Gateway 的辅助函数
    const sendEvent = (event: AgentEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ taskId, event }));
      }
    };

    try {
      const context = {
        sessionId: taskId,
        workspaceRoot: process.cwd(),
        messages: [] as CoreMessage[],
      };

      await agent.chatWithToolsStream(message, context, sendEvent);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendEvent({ type: 'error', message: errorMessage });
    }
  });

  ws.on('close', () => {
    console.log('⚠️ 与 Gateway 的连接断开，5 秒后重连...');
    setTimeout(() => startLocalWorker(), 5000);
  });

  ws.on('error', (error) => {
    console.error('WebSocket 错误:', error.message);
  });
}

startLocalWorker().catch(console.error);
```

---

## 使用方式

### 1. 启动云端 Gateway

```bash
# 在有公网 IP 的服务器上
GATEWAY_URL=ws://your-server.com:8080 node dist/gateway/gateway-server.js
```

### 2. 在本地开发机启动 Worker

```bash
# 本地机器，连接到云端 Gateway
GATEWAY_URL=ws://your-server.com:8080 \
OPENAI_API_KEY=sk-xxx \
node dist/gateway/local-worker.js
```

### 3. 从任意地方发送任务

```bash
# 手机、另一台电脑，通过 HTTP 发送任务
curl -X POST https://your-server.com/api/run \
  -H "Content-Type: application/json" \
  -d '{"message": "列出当前目录的所有文件"}'
```

---

## 断线重连机制

本地 Worker 的网络可能不稳定，需要自动重连：

```typescript
// 在 local-worker.ts 中，ws.on('close') 已经实现了重连
ws.on('close', () => {
  console.log('⚠️ 与 Gateway 的连接断开，5 秒后重连...');
  setTimeout(() => startLocalWorker(), 5000);
  // 指数退避：可以改成 Math.min(retryDelay * 2, 60000)
});
```

---

## 完整数据流

```
远程客户端（手机/网页）
    │ POST /api/run { message: "列出文件" }
    ▼
云端 Gateway
    │ WebSocket.send({ taskId, message })
    ▼
本地 Worker（通过 WebSocket 长连接接收）
    │ agent.chatWithToolsStream(message, context, sendEvent)
    │
    ├─ sendEvent(thinking_start) ──WebSocket──▶ Gateway ──SSE──▶ 远程客户端
    ├─ sendEvent(tool_call_start) ──────────▶ Gateway ──SSE──▶ 远程客户端
    ├─ sendEvent(tool_call_result) ─────────▶ Gateway ──SSE──▶ 远程客户端
    └─ sendEvent(done) ─────────────────────▶ Gateway ──SSE──▶ 远程客户端（连接关闭）
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **反向连接** | 本地 Worker 主动连接云端 Gateway，穿透 NAT，无需公网 IP |
| **WebSocket 长连接** | 保持持久连接，Gateway 可以随时向 Worker 推送任务 |
| **事件转发** | Gateway 把 Worker 的 AgentEvent 实时转发给远程客户端（SSE）|
| **断线重连** | Worker 检测到连接断开后自动重连，保证服务持续可用 |
| **workerId** | 支持多个本地 Worker 注册，Gateway 按需分配任务 |

---

## 下一步

- [ ] **第28课：手写 Agent SDK** — 前面几课我们已经攒下了 Rules、Skills、中间件、远程网关等一堆能力，是时候把它们收敛成一个开箱即用、链式调用的 SDK，让重复的拼装成本降到最低
