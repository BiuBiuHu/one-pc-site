---
title: "并发控制与限流 — 让 Agent 服务多用户而不崩溃"
date: 2026-11-25
excerpt: "多用户并发时如何不被 API 限流打崩？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 36
---

> 目标：理解 Agent 服务的并发风险，掌握请求队列、令牌桶限流、用户级配额三种控制手段

---

## 背景：单用户好用，多用户就崩

一个 Agent 在本地跑得很好，一旦部署成服务，多用户同时请求就会出现：

- **API 限流**：OpenAI 有 RPM（每分钟请求数）和 TPM（每分钟 Token 数）限制，并发太高直接 429
- **账单爆炸**：没有用户级配额，一个用户可以无限调用，把所有预算耗光
- **服务雪崩**：大量并发请求同时打到 LLM API，失败后同时重试，形成"惊群效应"

---

## 核心概念：三层并发控制

```
用户请求
    │
    ▼
① 用户级配额检查（每个用户每分钟/每天最多多少次）
    │
    ▼
② 全局并发限制（同时处理的请求数上限）
    │
    ▼
③ API 层令牌桶限流（控制对 LLM API 的调用速率）
    │
    ▼
LLM API
```

---

## 第一层：用户级配额

```typescript
interface UserQuota {
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
}

interface UserUsageRecord {
  requestTimestamps: number[];   // 最近请求的时间戳列表（用于滑动窗口计算）
  dailyRequestCount: number;
  dailyTokenCount: number;
  lastResetDate: string;         // 'YYYY-MM-DD' 格式，用于判断是否需要重置日计数
}

const DEFAULT_QUOTA: UserQuota = {
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 200,
  maxTokensPerDay: 100_000,
};

export class UserQuotaManager {
  private usageMap: Map<string, UserUsageRecord> = new Map();
  private quotaMap: Map<string, UserQuota> = new Map();

  // 设置特定用户的配额（不设置则使用默认值）
  setQuota(userId: string, quota: Partial<UserQuota>): void {
    this.quotaMap.set(userId, { ...DEFAULT_QUOTA, ...quota });
  }

  private getQuota(userId: string): UserQuota {
    return this.quotaMap.get(userId) ?? DEFAULT_QUOTA;
  }

  private getOrCreateUsage(userId: string): UserUsageRecord {
    if (!this.usageMap.has(userId)) {
      this.usageMap.set(userId, {
        requestTimestamps: [],
        dailyRequestCount: 0,
        dailyTokenCount: 0,
        lastResetDate: new Date().toISOString().slice(0, 10),
      });
    }
    return this.usageMap.get(userId)!;
  }

  // 重置日计数（如果已经是新的一天）
  private resetDailyCountIfNeeded(usage: UserUsageRecord): void {
    const today = new Date().toISOString().slice(0, 10);
    if (usage.lastResetDate !== today) {
      usage.dailyRequestCount = 0;
      usage.dailyTokenCount = 0;
      usage.lastResetDate = today;
    }
  }

  // 检查是否允许请求，不允许则抛出错误
  checkAndConsume(userId: string): void {
    const quota = this.getQuota(userId);
    const usage = this.getOrCreateUsage(userId);

    this.resetDailyCountIfNeeded(usage);

    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // 清理一分钟前的时间戳（滑动窗口）
    usage.requestTimestamps = usage.requestTimestamps.filter((ts) => ts > oneMinuteAgo);

    // 检查每分钟限制
    if (usage.requestTimestamps.length >= quota.maxRequestsPerMinute) {
      const oldestTs = usage.requestTimestamps[0];
      const waitSeconds = Math.ceil((oldestTs + 60_000 - now) / 1000);
      throw new Error(`请求过于频繁，请 ${waitSeconds} 秒后再试（每分钟限 ${quota.maxRequestsPerMinute} 次）`);
    }

    // 检查每日限制
    if (usage.dailyRequestCount >= quota.maxRequestsPerDay) {
      throw new Error(`今日请求次数已达上限（${quota.maxRequestsPerDay} 次），请明天再试`);
    }

    // 通过检查，记录本次请求
    usage.requestTimestamps.push(now);
    usage.dailyRequestCount++;
  }

  // 记录 Token 消耗（在 LLM 调用完成后调用）
  recordTokenUsage(userId: string, tokenCount: number): void {
    const usage = this.getOrCreateUsage(userId);
    const quota = this.getQuota(userId);

    usage.dailyTokenCount += tokenCount;

    if (usage.dailyTokenCount > quota.maxTokensPerDay) {
      console.warn(`⚠️ 用户 ${userId} 今日 Token 消耗已超限：${usage.dailyTokenCount} > ${quota.maxTokensPerDay}`);
    }
  }

  // 查询用户当前配额使用情况
  getUsageSummary(userId: string): {
    requestsThisMinute: number;
    dailyRequests: number;
    dailyTokens: number;
    quota: UserQuota;
  } {
    const usage = this.getOrCreateUsage(userId);
    const quota = this.getQuota(userId);
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    return {
      requestsThisMinute: usage.requestTimestamps.filter((ts) => ts > oneMinuteAgo).length,
      dailyRequests: usage.dailyRequestCount,
      dailyTokens: usage.dailyTokenCount,
      quota,
    };
  }
}
```

---

## 第二层：全局并发限制（信号量）

控制同时处理的请求数，防止并发过高压垮 LLM API：

```typescript
export class Semaphore {
  private maxConcurrent: number;
  private currentCount: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  // 获取一个并发槽位，如果已满则等待
  async acquire(): Promise<void> {
    if (this.currentCount < this.maxConcurrent) {
      this.currentCount++;
      return;
    }

    // 已达并发上限，加入等待队列
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  // 释放一个并发槽位，唤醒等待队列中的下一个
  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next();
    } else {
      this.currentCount--;
    }
  }

  // 包装异步函数，自动管理槽位的获取和释放
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  get activeCount(): number {
    return this.currentCount;
  }

  get waitingCount(): number {
    return this.waitQueue.length;
  }
}

// 使用示例：最多同时处理 5 个请求
const globalSemaphore = new Semaphore(5);

async function handleRequest(userId: string, message: string): Promise<string> {
  console.log(`当前并发：${globalSemaphore.activeCount}，等待中：${globalSemaphore.waitingCount}`);

  return globalSemaphore.run(async () => {
    // 在这里执行 Agent 调用
    const result = await someAgentCall(userId, message);
    return result;
  });
}
```

---

## 第三层：令牌桶限流（Token Bucket）

控制对 LLM API 的调用速率，防止触发 OpenAI 的 RPM 限制：

```typescript
export class TokenBucket {
  private capacity: number;         // 桶的容量（最大令牌数）
  private tokensPerSecond: number;  // 每秒补充的令牌数
  private currentTokens: number;
  private lastRefillTime: number;

  constructor(capacity: number, tokensPerSecond: number) {
    this.capacity = capacity;
    this.tokensPerSecond = tokensPerSecond;
    this.currentTokens = capacity;  // 初始满桶
    this.lastRefillTime = Date.now();
  }

  // 补充令牌（根据距上次补充的时间计算）
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = elapsedSeconds * this.tokensPerSecond;

    this.currentTokens = Math.min(this.capacity, this.currentTokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  // 尝试消耗指定数量的令牌
  // 返回 true 表示成功，false 表示令牌不足需要等待
  tryConsume(tokens: number = 1): boolean {
    this.refill();

    if (this.currentTokens >= tokens) {
      this.currentTokens -= tokens;
      return true;
    }

    return false;
  }

  // 等待直到有足够的令牌，然后消耗
  async consume(tokens: number = 1): Promise<void> {
    while (!this.tryConsume(tokens)) {
      // 计算需要等待多久才能有足够的令牌
      this.refill();
      const deficit = tokens - this.currentTokens;
      const waitMs = Math.ceil((deficit / this.tokensPerSecond) * 1000);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  get availableTokens(): number {
    this.refill();
    return Math.floor(this.currentTokens);
  }
}

// 使用示例：OpenAI GPT-4o 的 RPM 限制是 500，换算成每秒约 8 次
// 设置桶容量为 10（允许短暂突发），每秒补充 8 个令牌
const apiRateLimiter = new TokenBucket(10, 8);

async function callLLMWithRateLimit(messages: unknown[]): Promise<string> {
  // 等待令牌桶有可用令牌
  await apiRateLimiter.consume(1);

  const { text } = await generateText({
    model,
    messages: messages as Parameters<typeof generateText>[0]['messages'],
  });

  return text;
}
```

---

## 在 Express 服务器中组合使用三层控制

```typescript
import express from 'express';

const app = express();
const quotaManager = new UserQuotaManager();
const globalSemaphore = new Semaphore(10);   // 最多同时处理 10 个请求
const apiRateLimiter = new TokenBucket(20, 8); // 控制 LLM API 调用速率

app.post('/api/chat', async (req, res) => {
  const { message, userId = 'anonymous' } = req.body as { message: string; userId?: string };

  // 第一层：用户配额检查
  try {
    quotaManager.checkAndConsume(userId);
  } catch (error) {
    res.status(429).json({ error: (error as Error).message });
    return;
  }

  // 第二层 + 第三层：全局并发 + API 限流
  try {
    const result = await globalSemaphore.run(async () => {
      await apiRateLimiter.consume(1);
      // 执行 Agent 调用...
      return '模型回复内容';
    });

    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **用户级配额** | 每个用户每分钟/每天的请求次数和 Token 消耗上限 |
| **滑动窗口** | 用时间戳列表实现的精确限流，比固定窗口更平滑 |
| **信号量（Semaphore）** | 控制同时执行的任务数，超出上限的请求进入等待队列 |
| **令牌桶（Token Bucket）** | 控制请求速率，允许短暂突发，长期维持在设定速率以内 |
| **RPM** | Requests Per Minute，OpenAI API 的每分钟请求数限制 |
| **TPM** | Tokens Per Minute，OpenAI API 的每分钟 Token 消耗限制 |

---

## 与其他课程的关联

- **第16课（Hooks/Middleware）**：三层限流控制可以封装成中间件，在请求进入 Agent 前统一拦截，而不是散落在各个路由里
- **第31课（Token 成本控制）**：用户级 Token 配额和第31课的 Token 追踪器配合使用，实现精确的成本控制
