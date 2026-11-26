---
title: "Hooks / Middleware — Agent 生命周期钩子与 Human-in-the-Loop"
date: 2026-11-25
excerpt: "高风险操作如何让人类审批介入？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 17
---

> 目标：在工具调用前后插入横切逻辑（日志、鉴权、限流），并实现高风险操作的人类审批机制

---

## 背景：Agent 执行过程中的"横切关注点"

Agent 在执行任务时，有一类逻辑和业务本身无关，但每个工具调用都需要：

- **日志**：记录每次工具调用的入参、出参、耗时
- **鉴权**：某些工具只有特定用户才能调用
- **限流**：防止 Agent 在循环中疯狂调用同一个工具
- **审计**：记录完整的执行链路，用于事后排查

如果把这些逻辑写进每个工具的 `execute` 函数里，会导致代码重复、难以维护。

**解决方案**：用中间件模式，把横切逻辑从工具实现中剥离出来。

---

## 核心设计：onEvent 是天然的切面

回顾第15课的 `chatWithToolsStream`，所有事件都通过 `onEvent` 这一个出口流出：

```typescript
await agent.chatWithToolsStream(message, context, onEvent);
```

**`onEvent` 就是 Agent 内部和外部世界之间唯一的出口**。在这里插入中间件，不需要修改 Agent 核心代码。

---

## 第一层：基础中间件——日志

```typescript
// 最简单的中间件：在每个事件发出前打印日志
function withLogging(
  onEvent: (event: AgentEvent) => void,
  sessionId: string
): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    // 记录时间戳和事件类型
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${sessionId}] event=${event.type}`);

    // 工具调用额外记录工具名和参数
    if (event.type === 'tool_call_start') {
      console.log(`  → tool=${event.toolName} args=${JSON.stringify(event.args)}`);
    }
    if (event.type === 'tool_call_result') {
      console.log(`  ← tool=${event.toolName} result_length=${event.result.length}`);
    }

    // 放行：调用原始 onEvent
    onEvent(event);
  };
}

// 使用方式
const loggedSendEvent = withLogging(rawSendEvent, sessionId);
await agent.chatWithToolsStream(message, context, loggedSendEvent);
```

---

## 第二层：安全中间件——工具白名单

```typescript
// 只允许调用白名单内的工具，其他一律拦截
function withToolWhitelist(
  onEvent: (event: AgentEvent) => void,
  allowedTools: string[]
): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    if (event.type === 'tool_call_start') {
      if (!allowedTools.includes(event.toolName)) {
        // 拦截：不放行，改发一个 error 事件
        onEvent({
          type: 'error',
          message: `工具 "${event.toolName}" 不在允许列表中`,
        });
        throw new Error(`BLOCKED: 非法工具调用 ${event.toolName}`);
      }
    }
    onEvent(event);
  };
}
```

---

## 第三层：性能中间件——耗时统计

```typescript
// 统计每个工具调用的耗时
function withTiming(
  onEvent: (event: AgentEvent) => void
): (event: AgentEvent) => void {
  const toolStartTimes = new Map<string, number>();

  return (event: AgentEvent) => {
    if (event.type === 'tool_call_start') {
      toolStartTimes.set(event.toolName, Date.now());
    }

    if (event.type === 'tool_call_result') {
      const startTime = toolStartTimes.get(event.toolName);
      if (startTime) {
        const elapsed = Date.now() - startTime;
        console.log(`  ⏱ ${event.toolName} 耗时 ${elapsed}ms`);
        toolStartTimes.delete(event.toolName);
      }
    }

    onEvent(event);
  };
}
```

---

## 组合多层中间件

每一层只做一件事，通过函数嵌套组合：

```typescript
// web-server.ts
app.post('/api/chat', async (req, res) => {
  const rawSendEvent = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 从内到外：timing → whitelist → logging → rawSendEvent
  // 执行顺序从外到内：logging 先执行，最后才到 rawSendEvent
  const composedOnEvent = withLogging(
    withToolWhitelist(
      withTiming(rawSendEvent),
      ['get_current_time', 'list_files', 'read_file']
    ),
    sessionId
  );

  await agent.chatWithToolsStream(message, context, composedOnEvent);
  res.end();
});
```

这和 Express 的 `app.use(middleware)` 是同一个设计模式——**函数式中间件链**。

---

## Human-in-the-Loop：把"人类审批"作为特殊中间件

### 什么是 Human-in-the-Loop？

在 Agent 执行高风险操作（删文件、发邮件、执行代码）前，**暂停执行**，向用户展示"我要做这件事，你同意吗？"，等用户确认后再继续。

```
正常 Agent Loop：
LLM → 决定调用工具 → 执行工具 → 结果回传 LLM → 继续...

Human-in-the-Loop：
LLM → 决定调用工具 → ⏸️ 暂停，等用户审批 → 用户点允许 → 执行工具 → 结果回传 LLM
                                             → 用户点拒绝 → 把拒绝结果回传 LLM
```

### 核心机制：Promise 暂停与唤醒

```typescript
// 存储待审批的 Promise resolve 函数
// key: approvalId（UUID），value: resolve 函数
const pendingApprovals = new Map<string, (approved: boolean) => void>();

// 在工具的 execute 函数里实现审批等待
const deleteFileTool = tool({
  description: '删除文件（高风险，需要用户审批）',
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }, options) => {
    const approvalId = crypto.randomUUID();

    // 1. 通过 onEvent 告诉前端"需要审批"
    //    options 里的 onEvent 需要在工具注册时注入（见下文）
    options.onEvent?.({
      type: 'approval_required',
      approvalId,
      toolName: 'delete_file',
      args: { path },
      description: `即将删除文件: ${path}，此操作不可逆`,
    });

    // 2. 创建 Promise，阻塞等待用户点击
    const approved = await new Promise<boolean>((resolve) => {
      pendingApprovals.set(approvalId, resolve);

      // 30 秒超时自动拒绝，防止永久阻塞
      setTimeout(() => {
        if (pendingApprovals.has(approvalId)) {
          pendingApprovals.delete(approvalId);
          resolve(false);
        }
      }, 30000);
    });

    // 3. 用户拒绝
    if (!approved) {
      return { error: '用户拒绝了此操作' };
    }

    // 4. 用户允许，执行真正的删除
    fs.unlinkSync(path);
    return { success: true, message: `已删除 ${path}` };
  },
});

// 新增路由：前端点击"允许/拒绝"后调用
app.post('/api/approve', (req, res) => {
  const { approvalId, approved } = req.body;
  const resolve = pendingApprovals.get(approvalId);
  if (resolve) {
    pendingApprovals.delete(approvalId);
    resolve(approved);  // 唤醒工具里等待的 Promise
  }
  res.json({ success: true });
});
```

### 完整数据流

```
Agent 决定调用 delete_file
    │
    ▼
execute() 被调用
    │
    ├─ onEvent(approval_required) ──SSE──▶ 前端显示审批弹窗
    │                                        ┌──────────────────────┐
    │                                        │ ⚠️ Agent 请求权限     │
    │   ⏸️ await Promise（阻塞等待）          │ 即将删除: src/foo.ts  │
    │                                        │ [✅ 允许] [❌ 拒绝]   │
    │                                        └──────────────────────┘
    │                                               │ 用户点击
    │                                               ▼
    │                              POST /api/approve { approvalId, approved: true }
    │                                               │
    │◀── pendingApprovals.get(id)(true) ────────────┘
    │    Promise 被 resolve，await 结束
    │
    ▼
执行真正的删除操作
    │
    ├─ onEvent(tool_call_result) ──SSE──▶ 前端显示结果
```

### 前端审批弹窗

```javascript
// index.html — 处理 approval_required 事件
case 'approval_required':
  showApprovalModal(event);
  break;

function showApprovalModal({ approvalId, toolName, args, description }) {
  const modal = document.createElement('div');
  modal.className = 'approval-modal';
  modal.innerHTML = `
    <div class="approval-card">
      <div class="approval-icon">⚠️</div>
      <h3>Agent 请求权限</h3>
      <p>${description}</p>
      <pre>${JSON.stringify(args, null, 2)}</pre>
      <div class="approval-actions">
        <button onclick="submitApproval('${approvalId}', true)">✅ 允许</button>
        <button onclick="submitApproval('${approvalId}', false)">❌ 拒绝</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function submitApproval(approvalId, approved) {
  document.querySelector('.approval-modal').remove();
  await fetch('/api/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId, approved }),
  });
  // 服务端的 Promise 被 resolve，Agent 继续执行
}
```

---

## 关键设计点

| 问题 | 解决方案 |
|------|----------|
| **如何暂停 Agent？** | `await new Promise(resolve => pendingApprovals.set(id, resolve))` |
| **如何唤醒 Agent？** | 前端调用 `/api/approve`，服务端 `resolve(true/false)` |
| **超时怎么处理？** | `setTimeout` 30 秒后自动 `resolve(false)`，拒绝操作 |
| **多用户并发？** | `approvalId` 用 UUID，每个审批请求独立，互不干扰 |
| **用户关掉页面？** | 超时机制兜底，不会永久阻塞 |

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **中间件模式** | 用函数包装函数，在不修改核心逻辑的前提下插入横切关注点 |
| **装饰器（Decorator）** | `withLogging(withWhitelist(rawFn))` 是函数式装饰器的典型写法 |
| **AOP（面向切面编程）** | 把日志、鉴权等横切逻辑从业务代码中剥离，集中管理 |
| **Human-in-the-Loop** | 把人类决策插入 Agent 执行循环，用于高风险操作的审批 |
| **Promise 暂停** | `new Promise(resolve => map.set(id, resolve))` 创建可被外部唤醒的等待点 |
| **超时兜底** | `setTimeout` 防止审批永久阻塞，保证系统健壮性 |

---

## 下一步

- [ ] 实现结构化输出（Structured Output），让 LLM 输出严格符合 JSON Schema 的数据
