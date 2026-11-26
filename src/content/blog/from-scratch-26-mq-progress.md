---
title: "进度追踪与状态同步"
date: 2026-11-25
excerpt: "异步任务执行中，用户怎么实时看到进展？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 27
---

> 目标：让用户实时看到异步任务的执行进展，而不是盯着"处理中..."等待

---

## 背景：轮询的局限性

第24课用轮询（每秒查询一次）来获取任务状态，这有两个问题：

1. **延迟**：最坏情况下，任务完成后用户还要等 1 秒才知道
2. **浪费**：任务还没完成时，每秒都在发无效请求

更好的方案：**任务完成时主动推送给用户**，而不是让用户反复来问。

---

## 三种推送方案对比

| 方案 | 实现复杂度 | 实时性 | 适用场景 |
|------|-----------|--------|----------|
| **轮询（Polling）** | 低 | 低（有延迟）| 简单场景，任务数少 |
| **SSE（Server-Sent Events）** | 中 | 高 | 单向推送，任务进度更新 |
| **WebSocket** | 高 | 高 | 双向通信，实时协作 |

本课实现 **SSE 推送**：Worker 完成任务后，通过 Redis Pub/Sub 通知 Web Server，Web Server 再通过 SSE 推送给前端。

---

## 架构：Redis Pub/Sub 作为通知总线

```
Worker 完成任务
    │
    ├─ 更新 Redis Hash（任务状态）
    │
    └─ PUBLISH task:done:{taskId} "done"
                    │
                    ▼
            Redis Pub/Sub
                    │
                    ▼
        Web Server（订阅了这个频道）
                    │
                    └─ SSE 推送给等待的前端连接
```

---

## 实现：Worker 发布完成通知

在第25课的 Worker 基础上，任务完成/失败时发布通知：

```typescript
// src/queue/worker.ts（在第25课基础上扩展）
// 在 processNextTask 的成功/失败处理后，加入 PUBLISH

// 任务成功完成
await this.redis.hSet(`task:${task.taskId}`, {
  status: 'done',
  result: finalText,
  completedAt: String(Date.now()),
  steps: JSON.stringify(steps),
});

// 发布完成通知，频道名包含 taskId，让 Web Server 精确订阅
await this.redis.publish(`task:update:${task.taskId}`, JSON.stringify({
  taskId: task.taskId,
  status: 'done',
}));

// 任务失败
await this.redis.hSet(`task:${task.taskId}`, {
  status: 'failed',
  error: errorMessage,
  completedAt: String(Date.now()),
});

await this.redis.publish(`task:update:${task.taskId}`, JSON.stringify({
  taskId: task.taskId,
  status: 'failed',
  error: errorMessage,
}));
```

---

## 实现：Web Server 订阅并通过 SSE 推送

```typescript
// src/web-server-async.ts（完整版）
import express from 'express';
import { createClient } from 'redis';
import { TaskProducer } from './queue/producer.js';

const app = express();
app.use(express.json());
app.use(express.static('src/public'));

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// 主 Redis 客户端（用于读写）
const redisClient = createClient({ url: REDIS_URL });
await redisClient.connect();

const producer = new TaskProducer(REDIS_URL);
await producer.connect();

// 提交任务
app.post('/api/tasks', async (req, res) => {
  const { message, sessionId, priority } = req.body;
  const taskId = await producer.enqueue(
    message,
    sessionId ?? 'default',
    priority ?? 'normal'
  );
  res.json({ taskId, status: 'pending' });
});

// 查询任务状态（用于初始加载）
app.get('/api/tasks/:taskId', async (req, res) => {
  const result = await producer.getTaskStatus(req.params.taskId);
  if (!result) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.json(result);
});

// SSE：实时推送任务状态更新
app.get('/api/tasks/:taskId/stream', async (req, res) => {
  const { taskId } = req.params;

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 先发送当前状态（防止客户端连接时任务已经完成）
  const currentStatus = await producer.getTaskStatus(taskId);
  if (currentStatus) {
    res.write(`data: ${JSON.stringify(currentStatus)}\n\n`);

    // 如果任务已经结束，直接关闭 SSE 连接
    if (currentStatus.status === 'done' || currentStatus.status === 'failed') {
      res.end();
      return;
    }
  }

  // 为这个连接创建独立的 Redis 订阅客户端
  // 注意：执行 subscribe 的客户端不能再执行普通命令，所以必须单独创建
  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  // 订阅这个任务的更新频道
  await subscriber.subscribe(`task:update:${taskId}`, async (message) => {
    const update = JSON.parse(message);

    // 获取完整的任务状态（包含 steps、result 等）
    const fullStatus = await producer.getTaskStatus(taskId);
    if (fullStatus) {
      res.write(`data: ${JSON.stringify(fullStatus)}\n\n`);
    }

    // 任务结束，关闭连接
    if (update.status === 'done' || update.status === 'failed') {
      await subscriber.unsubscribe(`task:update:${taskId}`);
      await subscriber.disconnect();
      res.end();
    }
  });

  // 客户端断开连接时，清理订阅
  req.on('close', async () => {
    try {
      await subscriber.unsubscribe(`task:update:${taskId}`);
      await subscriber.disconnect();
    } catch {
      // 忽略断开时的错误
    }
  });
});

app.listen(3000, () => console.log('🚀 异步 Web Server 已启动，端口 3000'));
```

---

## 前端：SSE 接收进度更新

```html
<!-- src/public/async-chat.html -->
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>异步 Agent 聊天</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    #chat { border: 1px solid #ddd; border-radius: 8px; padding: 16px; min-height: 300px; }
    .task-card { background: #f5f5f5; border-radius: 6px; padding: 12px; margin: 8px 0; }
    .status-pending { color: #888; }
    .status-running { color: #2196F3; }
    .status-done { color: #4CAF50; }
    .status-failed { color: #f44336; }
    .steps { font-size: 12px; color: #666; margin-top: 8px; }
    input { width: 100%; padding: 8px; box-sizing: border-box; margin-top: 16px; }
    button { padding: 8px 16px; margin-top: 8px; cursor: pointer; }
  </style>
</head>
<body>
  <h2>异步 Agent 聊天</h2>
  <div id="chat"></div>
  <input id="input" type="text" placeholder="输入消息..." />
  <button onclick="sendMessage()">发送</button>

  <script>
    async function sendMessage() {
      const input = document.getElementById('input');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';

      // 1. 提交任务，立刻得到 taskId
      const { taskId } = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }).then(r => r.json());

      // 2. 在 UI 上创建任务卡片
      const card = createTaskCard(taskId, message);
      document.getElementById('chat').appendChild(card);

      // 3. 通过 SSE 监听任务进度
      const eventSource = new EventSource(`/api/tasks/${taskId}/stream`);

      eventSource.onmessage = (event) => {
        const status = JSON.parse(event.data);
        updateTaskCard(card, status);

        // 任务结束，关闭 SSE 连接
        if (status.status === 'done' || status.status === 'failed') {
          eventSource.close();
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        updateTaskCardError(card, '连接中断');
      };
    }

    function createTaskCard(taskId, message) {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.id = `task-${taskId}`;
      card.innerHTML = `
        <div><strong>你：</strong>${message}</div>
        <div class="status-pending">⏳ 等待处理...</div>
        <div class="steps"></div>
        <div class="result"></div>
      `;
      return card;
    }

    function updateTaskCard(card, status) {
      const statusEl = card.querySelector('.status-pending, .status-running, .status-done, .status-failed');
      const stepsEl = card.querySelector('.steps');
      const resultEl = card.querySelector('.result');

      if (status.status === 'pending') {
        statusEl.className = 'status-pending';
        statusEl.textContent = '⏳ 等待处理...';
      } else if (status.status === 'running') {
        statusEl.className = 'status-running';
        statusEl.textContent = '🔄 执行中...';
        if (status.steps?.length > 0) {
          stepsEl.textContent = '工具调用：' + status.steps
            .filter(s => s.type === 'tool_call')
            .map(s => s.toolName)
            .join(' → ');
        }
      } else if (status.status === 'done') {
        statusEl.className = 'status-done';
        statusEl.textContent = '✅ 完成';
        resultEl.innerHTML = `<strong>Agent：</strong>${status.result}`;
      } else if (status.status === 'failed') {
        statusEl.className = 'status-failed';
        statusEl.textContent = `❌ 失败：${status.error}`;
      }
    }

    function updateTaskCardError(card, message) {
      const statusEl = card.querySelector('[class^="status-"]');
      statusEl.className = 'status-failed';
      statusEl.textContent = `❌ ${message}`;
    }
  </script>
</body>
</html>
```

---

## 完整数据流

```
用户点击发送
    │
    ▼
POST /api/tasks → 返回 taskId（立刻，< 10ms）
    │
    ▼
GET /api/tasks/:taskId/stream（SSE 连接建立）
    │
    ├─ 立刻推送当前状态（pending）
    │
    ▼
Worker 开始处理任务
    │
    ├─ HSET task:{taskId} status=running
    ├─ PUBLISH task:update:{taskId}
    │       │
    │       ▼
    │   Web Server 收到 Pub/Sub 消息
    │       │
    │       └─ SSE 推送 running 状态给前端
    │
    ├─ 执行工具，更新 steps
    ├─ PUBLISH task:update:{taskId}（每步更新）
    │
    ▼
任务完成
    │
    ├─ HSET task:{taskId} status=done result=...
    ├─ PUBLISH task:update:{taskId}
    │       │
    │       ▼
    │   Web Server 推送 done 状态，关闭 SSE
    │
    ▼
前端显示最终结果，EventSource 关闭
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **Redis Pub/Sub** | 发布/订阅模式，Worker 发布通知，Web Server 订阅并转发给前端 |
| **subscriber.duplicate()** | 执行 subscribe 的客户端必须独立，不能复用普通读写客户端 |
| **SSE + Pub/Sub** | 组合使用：Pub/Sub 解耦 Worker 和 Web Server，SSE 解耦 Web Server 和前端 |
| **先查后订阅** | 建立 SSE 连接时先查当前状态，防止任务已完成但前端错过通知 |
| **req.on('close')** | 客户端断开时清理 Redis 订阅，防止内存泄漏 |

---

## 下一步

- [ ] 实现 Remote Gateway，从任意远程端驱动本地 Agent 执行任务
