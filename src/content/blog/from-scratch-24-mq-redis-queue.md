---
title: "第二十四课：用 Redis 实现一个任务队列"
date: 2026-11-25
excerpt: "用 LPUSH/BRPOP 亲手搭生产者-消费者队列？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 25
---

> 目标：用 Redis List + `LPUSH/BRPOP` 亲手实现一个生产者/消费者任务队列，为后续多 Worker 与进度追踪打好地基

---

## 背景：从"为什么要 MQ"到"用一个真 MQ"

第23课我们回答了"**为什么**需要消息队列"——同步 Agent 卡在 HTTP 超时、连接中断、无法水平扩展三个硬限制上。但"懂道理"和"跑起来"之间还差一层：**我们自己的 Agent 该怎么接入一个真实的任务队列？**

这一课不引入 RabbitMQ / RocketMQ 这样的重量级中间件，而是用 **Redis 的两个原生命令 `LPUSH` + `BRPOP`** 亲手搭一个最朴素、但完全能用的任务队列：

```
生产者（Producer）              Redis List                消费者（Worker）
      │                            │                          │
      │── LPUSH task-A ──────────▶│ [task-B, task-A]           │
      │                            │                          │
      │                            │◀── BRPOP（阻塞弹出）───────│
      │                            │── 返回 task-A ───────────▶ │── 执行
```

为什么用 Redis？因为：
1. **单线程、原子**：同时多个 Worker `BRPOP` 也不会取到同一个任务（第25课会深入讲这一点）
2. **命令足够**：`LPUSH` 入队、`BRPOP` 出队、`HSET` 存任务状态，都不需要额外客户端
3. **本就是 Agent 的常驻件**：前面课程已经把会话、上下文、进度都往 Redis 放了，队列再复用它，少一套运维

读完这一课，你会得到一个产线能用的最小队列，也会被第25课（多 Worker）、第26课（进度追踪）、第28课（Agent SDK）直接复用。

---

## 核心原理：LPUSH + BRPOP 就是队列

Redis 的 List 天然就是队列。两个命令各管一头：

```
                      ┌─────────── Redis List: agent:tasks ───────────┐
 生产者                  │      ┌────────────────────────────┐          │
 LPUSH(队头入)  ─────────▶      │ task-5 │ task-4 │ task-3 │  │◀── BRPOP(队尾出)
                          │      └────────────────────────────┘          │
                      └──────────────────────────────────────────────┘
```

- **`LPUSH key value`**：把任务压入队头（生产者用）
- **`BRPOP key timeout`**：从队尾弹出任务；如果队列为空，**阻塞等待最多 `timeout` 秒**（消费者用）

`BRPOP` 里的 **B = Blocking（阻塞）**，这是它比 `RPOP` 高明的地方：

```
用 RPOP（非阻塞）：
  while (true) {
    const task = RPOP(agent:tasks)
    if (task === null) sleep(1000)   ← 空转，每秒浪费一次轮询 + 延迟
    else 处理(task)
  }

用 BRPOP（阻塞）：
  while (true) {
    const task = BRPOP(agent:tasks, 5)   ← 没有任务就挂起等待，不占 CPU
    if (task) 处理(task)                  ← 5 秒超时返回 null，再循环
  }
```

**为什么阻塞很重要？** 第23课讲过，`await` 一个 I/O 不占 CPU。`BRPOP` 阻塞时，Node 事件循环可以去处理别的请求。一个进程开几十个"等任务的 Worker"也压不垮它——这正是后面几课能水平扩展的基石。

> ⚠️ 注意：`BRPOP` 返回的是一个**二元数组** `[key, value]`，不是单纯的 value。因为它可以同时监听多个 key（`BRPOP key1 key2 ...`），返回时告诉你是从哪个 key 弹出的。

---

## 设计：两个角色 + 一个状态容器

我们把队列拆成三个文件，职责清晰：

```
src/queue/
├── producer.ts   ← 生产者：入队 + 查任务状态（给 Web Server / 前端用）
└── worker.ts     ← 消费者：BRPOP 取任务 → 交给 Agent 执行 → 写结果
```

任务本身不放在 List 里——List 只存**任务 ID**，任务的详细数据（消息、会话、状态、结果）存在 **Redis Hash** 里：

```
Redis List（排队队列）                 Redis Hash（任务数据）
  agent:tasks                          task:{taskId}
  ┣━ task-abc123         ┐
  ┣━ task-def456          ├─ 只存 ID      ┌─ task-abc123 ─┐
  ┗━ task-ghi789         ┘                 │ message   : "列出文件"│
                                          │ sessionId : "s1"      │
                                          │ status    : pending   │
                                          │ priority  : normal    │
                                          └────────────────┘
```

**为什么 ID 和详情分离？**
- 队列只关心"排队顺序"，List 越小、`BRPOP` 越快
- 详情放 Hash 方便随时查状态、改状态，不必把整个任务在队列里搬进搬出
- Worker 从 List 弹出的是 ID，再按 ID 去 Hash 取完整详情——这样 Queue 和状态解耦，为第26课的进度追踪留好了口子

**任务状态机**（后面所有课都沿用这套状态值）：

```
         enqueue            Worker 取到           成功 / 失败
  new ──────────▶ pending ──────────▶ running ──────────▶ done / failed
                    │                                      ▲
                    └────────────── 超时未取┐               │
                                            └── 一直 pending
```

---

## 实现一：生产者 Producer（入队 + 查状态）

```typescript
// src/queue/producer.ts
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';

export type TaskPriority = 'normal' | 'high';

export interface TaskStatus {
  taskId: string;
  message: string;
  sessionId: string;
  priority: TaskPriority;
  status: 'pending' | 'running' | 'done' | 'failed';
  steps?: unknown[];
  result?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  workerId?: string;   // 第25课会加：记录是哪个 Worker 处理的
}

export class TaskProducer {
  private redis = createClient({ url: this.redisUrl });

  constructor(private redisUrl: string = 'redis://localhost:6379') {}

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  /**
   * 入队：LPUSH 任务 ID 到 List，并把详情写入 Hash
   * @returns 任务 ID，前端拿到它即可轮询/订阅进度
   */
  async enqueue(
    message: string,
    sessionId: string = 'default',
    priority: TaskPriority = 'normal'
  ): Promise<string> {
    const taskId = randomUUID();
    const task: TaskStatus = {
      taskId,
      message,
      sessionId,
      priority,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // 1. 详情写进 Hash
    await this.redis.hSet(`task:${taskId}`, {
      taskId,
      message,
      sessionId,
      priority,
      status: 'pending',
      createdAt: task.createdAt,
    });

    // 2. 根据优先级，把 ID 压进不同的队列
    //    高优先级进 agent:tasks:high，普通进 agent:tasks
    const queue = priority === 'high' ? 'agent:tasks:high' : 'agent:tasks';
    await this.redis.lPush(queue, taskId);

    return taskId;
  }

  /** 查任务状态（前端轮询、Web Server 初始加载、SSE 前先查一次都走这里） */
  async getTaskStatus(taskId: string): Promise<TaskStatus | null> {
    const raw = await this.redis.hGetAll(`task:${taskId}`);
    if (!raw || Object.keys(raw).length === 0) return null;
    return {
      taskId,
      message: raw.message,
      sessionId: raw.sessionId,
      priority: raw.priority as TaskPriority,
      status: raw.status as TaskStatus['status'],
      steps: raw.steps ? JSON.parse(raw.steps) : undefined,
      result: raw.result,
      error: raw.error,
      createdAt: raw.createdAt,
      completedAt: raw.completedAt,
      workerId: raw.workerId,
    };
  }
}
```

**关键点：**
- `enqueue` 两步走——先写 Hash 详情，再 `LPUSH` 进 List。**顺序不能反**：先进 List、后写 Hash 的话，Worker 取到 ID 时详情还没就绪，会查不到。
- 用 `randomUUID()` 当任务 ID，天然全局唯一，多生产者并发也不会撞。
- `priority: 'high'` 走独立的 `agent:tasks:high` 队列——这是为 VIP 用户/紧急任务预留的"插队通道"（第25课的监控看板会分别统计这两个队列）。

---

## 实现二：消费者 Worker（BRPOP 取任务 → 执行 → 写状态）

Worker 是常驻进程，核心就是一个无限循环的 `while`：

```typescript
// src/queue/worker.ts
import { createClient } from 'redis';
import type { TaskStatus } from './producer.js';
import { Agent } from '../agent/agent.js';   // 前面课程攒下的 Agent

export class AgentWorker {
  private redis = createClient({ url: this.redisUrl });
  private isRunning = true;   // 优雅退出的开关

  constructor(
    private redisUrl: string = 'redis://localhost:6379',
    private workerId: string = 'worker-unknown',
  ) {}

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async start(): Promise<void> {
    console.log(`[${this.workerId}] 开始监听任务队列...`);
    while (this.isRunning) {
      // BRPOP：无任务时阻塞最多 5 秒，让循环有机会检查 isRunning
      // 同时监听普通和高优先级两个队列
      const result = await this.redis.brPop(
        ['agent:tasks:high', 'agent:tasks'],
        5
      );

      // 5 秒没等到任务，BRPOP 返回 null，继续循环
      if (!result) continue;

      // result = [key, value]，value 就是任务 ID
      const taskId = result.element;
      await this.process(taskId);
    }
    console.log(`[${this.workerId}] 已优雅退出`);
  }

  private async process(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task) return;

    // 标记运行中（第25课会在这里加 workerId）
    await this.redis.hSet(`task:${taskId}`, { status: 'running' });
    console.log(`[${this.workerId}] 🔄 处理任务 ${taskId.slice(0, 8)}`);

    try {
      // 交给 Agent 执行（复用前面课程积累的 chat 能力）
      const agent = new Agent(process.env.OPENAI_API_KEY!, 'gpt-4');
      const result = await agent.chat(task.message, {
        sessionId: task.sessionId,
        workspaceRoot: process.cwd(),
        messages: [],
      });

      // 成功：写结果与状态
      await this.redis.hSet(`task:${taskId}`, {
        status: 'done',
        result,
        completedAt: new Date().toISOString(),
      });
      console.log(`[${this.workerId}] ✅ 任务 ${taskId.slice(0, 8)} 完成`);
    } catch (error) {
      // 失败：记错误状态，任务不丢失
      const message = error instanceof Error ? error.message : String(error);
      await this.redis.hSet(`task:${taskId}`, {
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      });
      console.error(`[${this.workerId}] ❌ 任务 ${taskId.slice(0, 8)} 失败: ${message}`);
    }
  }

  private async loadTask(taskId: string): Promise<TaskStatus | null> {
    const raw = await this.redis.hGetAll(`task:${taskId}`);
    if (!raw || Object.keys(raw).length === 0) return null;
    return {
      taskId,
      message: raw.message,
      sessionId: raw.sessionId,
      priority: raw.priority as TaskStatus['priority'],
      status: raw.status as TaskStatus['status'],
      createdAt: raw.createdAt,
    };
  }

  /** 优雅退出：把 isRunning 置 false，等当前任务跑完、BRPOP 超时后再退出 */
  async disconnect(): Promise<void> {
    this.isRunning = false;
  }
}
```

### 为什么用 `BRPOP(['high', 'normal'], 5)` 同时监听两个列表？

`BRPOP` 可以一次阻塞监听多个 key，**永远优先从最左边的 key 取**。所以我们把高优先级队列放最前：

```
BRPOP(['agent:tasks:high', 'agent:tasks'], 5)
        └─ 高优先级先取
```

这样只要高优先级队列里有任务，就一定优先于普通任务被弹出——实现了简单可靠的优先级。

### 优雅退出：`isRunning` 的作用

直接杀掉 Worker 会有大问题：任务已经从 List 里 `BRPOP` 取走了，但还没处理完，`running` 状态永远卡在那儿，任务就"丢"了。

```
粗暴退出：
  Worker 正在处理 task-A
  → 进程被杀（SIGKILL）
  → task-A 已经不在 List 里了
  → Hash 里 status 卡在 'running'
  → task-A 永久丢失 ❌

优雅退出：
  收到 SIGTERM / 按 Ctrl+C
  → disconnect() 把 isRunning 置 false
  → 当前任务继续执行完，正常写 done
  → while 循环发现 isRunning = false，退出 ✅
```

注意 `BRPOP` 的 5 秒超时是**故意**的：如果它永久阻塞，循环就永远没机会回到 `while` 顶检查 `isRunning`。超时让它最多 5 秒醒一次，看一眼开关。

---

## 跑起来：启动 Producer + Worker

**第一步：确保本机有 Redis**（macOS 可用 `brew install redis && redis-server`）。

**第二步：同时开两个终端。**

终端一——启动 Worker：

```bash
OPENAI_API_KEY=sk-xxx npx tsx src/queue/worker.ts
# 输出：
# [worker-1] 开始监听任务队列...
```

终端二——用生产者入队（这里用一个简单的启动脚本）：

```typescript
// src/queue/send-task.ts —— 入队一条任务，然后轮询等到它完成
import { TaskProducer } from './producer.js';

const producer = new TaskProducer();
await producer.connect();

// 入队，立刻拿到 taskId（不阻塞）
const taskId = await producer.enqueue('帮我列出当前目录的文件', 'session-001');
console.log('任务已入队，taskId:', taskId);

// 轮询查询状态（简单版；第26课会改成 SSE 主动推送）
while (true) {
  const status = await producer.getTaskStatus(taskId);
  console.log('状态:', status?.status);

  if (status?.status === 'done' || status?.status === 'failed') {
    console.log('最终结果:', status.result ?? status.error);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));   // 每秒查一次
}

process.exit(0);
```

```bash
npx tsx src/queue/send-task.ts
# 输出：
# 任务已入队，taskId: 7f3c…（随机）
# 状态: pending
# 状态: running
# ...（Worker 执行 Agent）
# 状态: done
# 最终结果: ✅ `src/` 目录下包含 index.ts、agent.ts ...（Agent 的回复）
```

**完整时序：**

```
发送脚本：LPUSH agent:tasks task-7f3c ──▶ Redis
Worker：  BRPOP(agent:tasks, 5)          │
            │                            │── 弹出 task-7f3c
            │ HSET task:7f3c running     │
            │── Agent 执行（调 LLM）──────▶
            │ HSET task:7f3c done + result
发送脚本：轮询 HSET task:7f3c → 见到 done → 打印结果
```

---

## 踩坑记录

### 坑一：BRPOP 返回的是数组，不是值

新手最常踩。`BRPOP` 的返回值是 `[key, value]` 二元数组，因为要告诉你"这个值是从哪个 key 弹出的"。

```typescript
// ❌ 错误
const task = await this.redis.brPop(['agent:tasks'], 5);
console.log(task);   // task 是个数组！

// ✅ 正确
const result = await this.redis.brPop(['agent:tasks'], 5);
console.log(result?.element);   // node-redis 用 result.element 取到值
```

> 注意：node-redis（`redis` 包 v4+）返回 `{ key, element }` 对象；raw Redis 协议返回数组。写前先确认你用的客户端返回结构。

### 坑二：先写 Hash 再 LPUSH，顺序别反

如果先 `LPUSH` 进 List、后写 Hash 详情，Worker 可能在"详情还没就绪"时就把 ID 取走、然后 `hGetAll` 查到空。**先落 Hash，再入 List**。

### 坑三：把 Agent 实例放在循环里创建，会很慢

`new Agent(...)` 需要初始化 provider、加载模型。如果每处理一个任务都 `new` 一次，I/O 和初始化开销巨大。正确做法是**在 `start()` 里创建一次、循环外复用**：

```typescript
async start(): Promise<void> {
  const agent = new Agent(process.env.OPENAI_API_KEY!, 'gpt-4');  // 只创建一次
  while (this.isRunning) {
    // ... 处理任务时直接复用 agent
  }
}
```

（上面的示例为突出重点做了简化；真实实现请把 `agent` 提到 `start` 里。）

### 坑四：BRPOP 超时选太短 → 空转浪费；太长 → 关闭响应慢

| 超时 | 问题 |
|------|------|
| 太短（0.1s）| 没有任务时高频空转，白白烧 CPU |
| 太长（30s）| 按 Ctrl+C 时要等 30 秒才退出 |
| **适中（5s）**| 空转可以接受，关闭也能 5 秒内响应 |

实际生产会用更长超时（如 30s），配合专门的关闭信号（Redis 的 `CLIENT KILL` 或实现一个"停止"频道）。这里 5 秒是为了演示方便。

### 坑五：轮询会导致延迟和浪费

本课演示用"每秒轮询"查状态，简单但不够优雅：
- 任务 0.5 秒就完成了，你却要等满 1 秒才知道（延迟）
- 任务跑 30 秒，你每秒都白查一次（浪费）

这是第26课的引子——它会用 **Redis Pub/Sub + SSE** 把"轮询"升级成"任务完成主动推送"。

---

## 常见问题（FAQ）

### Q1：Worker 执行到一半崩溃了，这个任务怎么办？

当前实现会**丢失**——因为 `BRPOP` 已经把它从 List 里弹走了，而消息只存在进程内存里，进程一挂就没了。这是 `LPUSH + BRPOP` 这套朴素方案的先天缺陷：**"弹出即可见"**，没有确认机制。

两个工业级解法：

**(1) `BRPOPLPUSH`（Redis 原生命令，Redis 6.2+ 用 `BLMOVE`）**
出队的同时把任务挪进一个"处理中"队列，处理完再删：

```
BRPOP agent:tasks  →  LMOVE agent:tasks agent:tasks:processing  ...
Worker 处理成功   →  LREM agent:tasks:processing 0 taskId
Worker 崩溃       →  taskId 躺在 agent:tasks:processing 里
                    另一个 Worker / 定时巡检把它搬回 agent:tasks 重试
```

这样任务永远不会"弹出去就没了"——它要么在 `agent:tasks`、要么在 `agent:tasks:processing`，二者必居其一。

**(2) 用 BullMQ 之类的专业队列库**
BullMQ 在其上又叠了 **ACK 机制**：任务被取走后进入 `waiting → active` 态，Worker 必须显式 `ack` 才算完成；Worker 挂掉后，任务按 `stalledInterval` 被判定为"卡住"，自动回到 `waiting` 重投。还内置了重试、退避、延迟任务、优先级，基本就是把这一课 + 第25课 + 第26课手写的东西都包好了。

> 教学里我们手写，是为了看清"队列到底是怎么工作的"；上生产时，如果团队不想维护这套状态机，直接上 BullMQ / RocketMQ 是更稳妥的选择。

### Q2：任务处理失败要不要重试？

本课的实现是把失败**如实写进 `failed` 状态**，不自动重试——因为**不是所有失败都该重试**（比如"用户输入的参数不合法"重试一百次还是错）。什么时候该重试、怎么重试，第32课（工具重试策略）有系统讲解。

### Q3：任务 ID 用什么生成？为什么不用自增号？

用 `randomUUID()`。自增号在**多生产者**并发时会撞（除非专门用 Redis `INCR` 统一发号），而 UUID 天然唯一，跨进程、跨实例都不会冲突。代价是 ID 长一点，但查询走 Hash、`BRPOP` 走 List，长度对性能没影响。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **LPUSH / BRPOP** | 一个压队头、一个弹队尾，天然构成先进先出（FIFO）队列 |
| **BRPOP 阻塞** | `B` 代表 Blocking，空队列时挂起等待，不占 CPU（呼应第23课） |
| **ID 与详情分离** | List 只存任务 ID，详情存 Hash，Queue 与状态解耦 |
| **状态机** | `pending → running → done/failed`，后续课程沿用同一套状态值 |
| **优雅退出** | `isRunning` 标志 + BRPOP 超时，让退出前把手头任务跑完 |
| **优先级队列** | 普通/高优先级两个 List，`BRPOP(['high','normal'], t)` 前队优先 |

---

## 下一步

> 这一课我们证明了一个 Worker 能"取任务 → 执行 → 写状态"，但**一个 Worker 同一时刻只能处理一个任务**。

- [ ] **第25课：异步多 Agent 系统** — 多启动几个 Worker 并行消费，用一个 Redis 的原子性实现真正水平扩展
- [ ] 本课的状态写入预留了 `workerId` 字段，第25课会补上，用于排查"这个任务谁在处理"