---
title: "异步多 Agent 系统"
date: 2026-11-25
excerpt: "多个 Agent Worker 如何并行消费任务？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 26
---

> 目标：让多个 Agent Worker 通过消息队列并行处理任务，实现真正的水平扩展

---

## 背景：单 Worker 的瓶颈

第24课实现了一个 Worker，它通过 `while + BRPOP` 不停地从队列里取任务、执行、再取下一个。

但问题是：**一个 Worker 同一时刻只能处理一个任务**。

```
任务队列：[task-1, task-2, task-3, task-4, task-5]

单 Worker（串行处理，每个任务 30 秒）：

Worker:  ┃ task-1 ┃ task-2 ┃ task-3 ┃ task-4 ┃ task-5 ┃
时间:    0s      30s      60s      90s     120s     150s

→ task-5 要等 120 秒才轮到它

三个 Worker（并行处理）：

Worker-1: ┃ task-1 ┃ task-4 ┃
Worker-2: ┃ task-2 ┃ task-5 ┃
Worker-3: ┃ task-3 ┃
时间:     0s      30s      60s

→ task-5 只等 30 秒就开始了，总耗时从 150s 降到 60s
```

**需要的改动出奇地少**——因为第24课的 Worker 设计已经是"无状态"的了，我们只需要多启动几个就行。

---

## 核心原理：为什么多个 Worker 可以安全地消费同一个队列？

这是本课最重要的概念。你可能会担心：两个 Worker 同时 `BRPOP`，会不会取到同一个任务？

**不会。** 因为 Redis 是**单线程模型**：

```
Redis 内部只有一个线程处理所有命令
即使 3 个 Worker 同时发出 BRPOP，Redis 也是一个一个串行处理的

时刻 T1：队列 = [task-C, task-B, task-A]

Redis 收到的命令序列（排好队的）：
  ① Worker-1 的 BRPOP → 弹出 task-A → 返回给 Worker-1
  ② Worker-2 的 BRPOP → 弹出 task-B → 返回给 Worker-2
  ③ Worker-3 的 BRPOP → 弹出 task-C → 返回给 Worker-3

每个任务只会被弹出一次，不可能重复
```

这就是用 Redis 做任务队列的最大优势之一——**不需要加锁，不需要分布式协调**，原子性是天然的。

---

## 多 Worker 的两种部署方式

### 方式一：单机多 Worker（同一个 Node.js 进程内）

在一个进程里创建多个 Worker 实例，每个实例有自己独立的 Redis 连接和 Agent：

```
┌─── Node.js 进程 ─────────────────────────┐
│                                           │
│  Worker-1 ──BRPOP──▶ ┌────────┐          │
│  Worker-2 ──BRPOP──▶ │ Redis  │          │
│  Worker-3 ──BRPOP──▶ └────────┘          │
│                                           │
│  三个 Worker 各自在 await BRPOP           │
│  互不阻塞（事件循环可以同时管理多个）      │
└───────────────────────────────────────────┘
```

**为什么这能工作？** 回忆上一课的讨论：`await BRPOP` 是 I/O 等待，不占 CPU。一个事件循环可以同时管理几百个 `await`，所以在一个进程里开 3~10 个 Worker 完全没问题。

**什么时候不够用？** 当 Agent 执行有 CPU 密集操作（大量 JSON 处理、代码分析等）时，单进程的单线程会成为瓶颈。

### 方式二：多机多 Worker（各自独立的进程/机器）

每台机器独立运行 Worker 进程，都连接同一个 Redis：

```
┌── 机器 A ──┐   ┌── 机器 B ──┐   ┌── 机器 C ──┐
│ Worker-1   │   │ Worker-2   │   │ Worker-3   │
│ Worker-2   │   │ Worker-3   │   │ Worker-4   │
└─────┬──────┘   └─────┬──────┘   └─────┬──────┘
      │                │                │
      └────────────────┼────────────────┘
                       │
                 ┌─────▼─────┐
                 │   Redis   │
                 └───────────┘
```

**这就是"水平扩展"的含义**：
- 任务太多处理不过来？加一台机器，启动几个 Worker
- 不需要改一行业务代码——新 Worker 启动后自动从队列取任务
- 某台机器挂了？队列里的任务不受影响，其他 Worker 继续消费

> 📌 这也是第23课说的"同步架构无法水平扩展"的对比——
> 同步架构下，任务绑定在 HTTP 连接上，连接在哪台机器任务就在哪。
> 异步架构下，任务在 Redis 队列里，**任何 Worker 都可以取走处理**。

---

## 实现：启动多个 Worker

代码改动很少，核心就是"循环创建多个 Worker 实例，每个并行启动"：

```typescript
// src/queue/start-workers.ts
import { AgentWorker } from './worker.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const WORKER_COUNT = Number(process.env.WORKER_COUNT ?? '3');

async function startWorkers(): Promise<void> {
  console.log(`🚀 启动 ${WORKER_COUNT} 个 Worker...`);

  // 创建多个 Worker，每个有独立的 Redis 连接 + Agent 实例
  const workers = await Promise.all(
    Array.from({ length: WORKER_COUNT }, async (_, index) => {
      const worker = new AgentWorker(REDIS_URL, `worker-${index + 1}`);
      await worker.connect();
      return worker;
    })
  );

  // 优雅退出（后面详细解释）
  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在优雅退出...`);
    await Promise.all(workers.map(worker => worker.disconnect()));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 并行启动所有 Worker（每个内部是无限循环）
  await Promise.all(workers.map(worker => worker.start()));
}

startWorkers().catch(console.error);
```

运行方式：

```bash
# 启动 3 个 Worker
WORKER_COUNT=3 npx tsx src/queue/start-workers.ts

# 输出：
# 🚀 启动 3 个 Worker...
# [worker-1] 开始监听任务队列...
# [worker-2] 开始监听任务队列...
# [worker-3] 开始监听任务队列...
```

---

## Worker 改进：加入 workerId

在第24课的 Worker 基础上，只需要加一个小改动——给每个 Worker 一个 ID，记录"谁在处理什么"：

```typescript
// 第24课的 Worker：
await this.redis.hSet(`task:${task.taskId}`, { status: 'running' });

// 本课的改进：多加一个 workerId 字段
await this.redis.hSet(`task:${task.taskId}`, {
  status: 'running',
  workerId: this.workerId,   // ← 就加了这一行
});
```

这样查询任务状态时，可以知道"这个任务正在被 worker-2 处理"，方便排查问题。

---

## 优雅退出：不要粗暴 kill

当你按 Ctrl+C 或者部署平台发 SIGTERM 信号时，Worker 可能正在处理一个任务。

```
粗暴退出（直接 kill）：
  Worker 正在执行 task-A 的第 5 步
  → 进程被杀
  → task-A 已经从队列中取走了（BRPOP 是弹出操作）
  → 但没处理完，Hash 中 status 永远停在 "running"
  → task-A 丢失了 ❌

优雅退出：
  收到 SIGTERM
  → 设置 isRunning = false
  → 当前任务继续执行完
  → while 循环检查到 isRunning = false，退出
  → task-A 正常完成 ✅
```

实现方式就是第24课 Worker 的 `isRunning` 标志 + BRPOP 超时：

```
Worker 的循环：
  while (isRunning) {          ← 每次循环检查是否该退出
    BRPOP(..., 5秒超时)        ← 最多等 5 秒就返回，让循环有机会检查 isRunning
    if (有任务) 处理任务
  }

收到 SIGTERM → isRunning = false
→ 当前的 BRPOP 最多 5 秒后返回
→ 循环发现 isRunning = false，退出
```

---

## 多 Worker 时序：完整流程

```
Producer                 Redis                    Worker-1        Worker-2
   │                       │                         │               │
   │                       │   ← BRPOP（阻塞等待）───│               │
   │                       │   ← BRPOP（阻塞等待）───┼───────────────│
   │                       │                         │               │
   │── LPUSH task-A ──────▶│                         │               │
   │                       │── 唤醒 Worker-1 ───────▶│               │
   │                       │                         │── 处理 task-A  │
   │── LPUSH task-B ──────▶│                         │               │
   │                       │── 唤醒 Worker-2 ────────┼──────────────▶│
   │                       │                         │               │── 处理 task-B
   │                       │                         │               │
   │── LPUSH task-C ──────▶│                         │               │
   │                       │   （Worker-1 和 2 都在忙，task-C 排队等待）
   │                       │                         │               │
   │                       │                         │── task-A 完成  │
   │                       │   ← BRPOP ─────────────│               │
   │                       │── 返回 task-C ─────────▶│               │
   │                       │                         │── 处理 task-C  │
```

**关键观察**：
- Worker 空闲时在 BRPOP 上阻塞，**不占 CPU**
- 有新任务入队时，Redis **立刻唤醒**一个等待的 Worker
- 所有 Worker 都在忙时，新任务**排在队列里等待**，不会丢失

---

## 如何确定 Worker 数量？

这取决于你的任务特性：

| 场景 | 建议 Worker 数 | 原因 |
|------|---------------|------|
| **纯 LLM 对话**（I/O 密集）| 单机 10~50 个 | `await LLM` 不占 CPU，瓶颈在网络 |
| **Agent + 工具调用**（混合）| 单机 5~15 个 | 工具执行可能有 CPU 开销 |
| **代码分析/大文件处理**（CPU 密集）| 单机 = CPU 核心数 | CPU 密集任务，开太多互相抢 CPU 反而更慢 |

实际操作中，**从 3 个 Worker 开始，观察队列堆积情况**：

```bash
# 查看队列里积压了多少任务
redis-cli LLEN agent:tasks

# 如果持续 > 0 且增长，说明 Worker 不够用，加 Worker
# 如果一直是 0，说明 Worker 供大于求，可以减少
```

---

## 监控：一个简单的队列看板

生产环境中，你需要知道系统的健康状态。最简单的方式是加一个 HTTP 接口：

```typescript
// 加到 web-server-async.ts 中
app.get('/api/queue/stats', async (req, res) => {
  const pendingNormal = await redis.lLen('agent:tasks');
  const pendingHigh = await redis.lLen('agent:tasks:high');

  res.json({
    queue: {
      normal: pendingNormal,       // 普通队列积压数
      high: pendingHigh,           // 高优先级积压数
    },
    // 实际生产中还会加：活跃 Worker 数、过去 1 分钟完成数、平均处理时间等
  });
});
```

```bash
curl http://localhost:3000/api/queue/stats
# { "queue": { "normal": 5, "high": 0 } }
```

---

## 常见问题

### Q1：每个 Worker 需要独立的 Redis 连接吗？

**需要。** `BRPOP` 是阻塞命令——它会占住整个连接直到有结果返回。如果多个 Worker 共用一个连接，第一个 Worker 的 `BRPOP` 会阻塞住连接，其他 Worker 的命令全部排队等待。

### Q2：单机开 100 个 Worker 有意义吗？

对于 I/O 密集型（等 LLM 响应）：有意义，因为 `await` 不占 CPU。
对于 CPU 密集型（代码分析）：没意义，CPU 就那几个核，100 个 Worker 互相抢反而更慢。

### Q3：Worker 崩溃了正在处理的任务怎么办？

当前实现中，任务会**丢失**（BRPOP 已经从队列中弹出了）。第24课的 FAQ 中提到了解决方案（BRPOPLPUSH / BullMQ 的 ACK 机制），这里不重复。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **BRPOP 原子性** | Redis 单线程保证每个任务只被一个 Worker 取走，无需加锁 |
| **水平扩展** | 加 Worker 就能提升吞吐量，不改业务代码 |
| **两种部署方式** | 单机多实例（I/O 密集场景够用）vs 多机部署（真正的分布式） |
| **优雅退出** | `isRunning` 标志 + BRPOP 超时，确保当前任务完成后再退出 |
| **workerId** | 记录任务被哪个 Worker 处理，便于监控排查 |
| **Worker 数量** | I/O 密集型可以开很多，CPU 密集型不超过核心数 |

---

## 下一步

- [ ] 实现进度追踪与状态同步，让用户实时看到任务执行进展
