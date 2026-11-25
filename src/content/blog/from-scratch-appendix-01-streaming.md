---
title: "附录 A1：流式输出（SSE 推送 / 断线续传 / Checkpoint / 取消）"
date: 2026-11-25
excerpt: "流式输出速答卡：SSE、断线续传、Checkpoint、取消。"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 49
---

> **本卷定位**：`附录 A1`~`A7` 是《Agent 架构七题》速答卡，把正文各卷知识点压缩成 7 道高频面试题的"知识体系 + 速答话术"。建议**读完正文后按 A1→A7 顺序刷**，每篇末尾都有指向下一篇的引子。**本卷顺序即"一次 Agent 请求从出发到落库的生命周期"**：A1 怎么发出去 → A2 写的可靠性 → A3 状态存哪 → A4 并发隔离 → A5 存储选型 → A6 数据库事务 → A7 定时任务收尾。
> **对应课程**：第3课(流式) · 第6课(手写SSE) · 第15课(UI可视化) · 第22课(streamText源码/背压) · 第30课(真流式Agent Loop) · 第38课(checkpoint) · 附录A2(写可靠性/幂等)
> **面试考察点**：SSE 协议细节、断线重连、Checkpoint、用户取消的上游传播
> **本文结构**：**一、知识体系**（把"流式→续传→checkpoint→取消"成体系讲透，读懂为主）；**二、答题卡**（速背话术 + 追问答案，备面为主）

---

# 一、知识体系

> 主线逻辑：`SSE 是传输层怎么推` → `断了怎么续`（三层模型）→ `带工具的 Agent 靠 checkpoint 续跑` → `取消怎么停上游`。

## 1. SSE 是"传输层"的东西

**SSE（Server-Sent Events）** = 服务器→客户端**单向**的 HTTP 长连接，`Content-Type: text/event-stream`。每次事件用空行 `\n\n` 分帧：

```text
id: 7
event: agent_message_chunk
data: {"text":"生成的","sessionId":"x"}

id: 8
data: {"text":"内容"}

```

- 字段：`id`(事件序号，Last-Event-ID 用)、`event`(事件类型)、`data`(payload，可多行)、`retry`(重连间隔)。
- **心跳保活**：代理/网关空转会掐长连接 → 发注释行 `: ping\n\n`，代理不把它当业务数据。
- **背压(小包风暴)**：LLM 可能一秒蹦一个词，别每个 chunk 都透传——做**增量缓冲**（攒 20ms 或攒够 N 字符再 flush），对应第22课（streamText 源码解析）的 `AsyncIterator + ReadableStream` 背压。
- **flushing**：`res.flushHeaders()` + 每次 write 后 flush，因为 Node 传输层分段 buffer 不主动吐给浏览器（第15课）。

**为什么选 SSE 不选 WebSocket**：Agent 是"服务器单向下推"，SSE 协议自带 `text/event-stream` 分帧 + 事件重连语义，对网关/缓存/CDN 友好、成本低；WebSocket 的双向能力这里用不上，属过度设计。

## 2. 断线续传的"三层模型"（本知识体系的骨架）

把"续传"拆成三个粒度——**这是回答一切续传问题的主干**：

| 粒度 | 断的是什么 | 典型方案 | 能恢复什么 |
|------|-----------|---------|-----------|
| **传输层** | TCP/字节流 | 自动重连、HTTP Range、SSE 重连 | 继续收"没收到的字节" |
| **内容层** | 哪几条消息丢了 | `Last-Event-ID`、事件游标、重放 | 把"没看到的文字"补回来 |
| **任务执行层** | 副作用错位/重复 | **checkpoint** + 幂等键 | "已做过不重跑"，只接着干 |

**一句话定位**：`Last-Event-ID` 只活在**内容层**；带工具的 Agent 必须靠 checkpoint 沉到**任务执行层**。续传的难点从来不是"文字"，而是**区分『这步已生效』和『这步还没做』**。

### 2.1 Last-Event-ID 具体怎么找回数据

游标回放三步：
1. 服务端给每个事件编**递增 id**（如事件表主键）；
2. 客户端记 last-seen，JS 的 `EventSource` 断线**自动重连**并带上 `Last-Event-ID` 请求头；
3. 服务端执行 `select ... where id > N` 重发 8、9、10…，客户端补回来。

**两个前提（易被挖）**：
- 服务端必须**留得住历史**——内存缓冲会被 trim/丢失，可靠要落 DB 或持久化 MQ；
- 它回放的是"事件**描述**"，不是"重新**执行**动作"——夹着已生效副作用（如已下单）的事件不会也不该重跑。

## 3. 续传方案谱系 + 选型

| 方案 | 思路 | 适用 |
|------|------|------|
| `Last-Event-ID` | 服务端单向推 + 猜你断在哪 | 只要文字连续性 |
| **幂等键** (Idempotency Key) | 客户端带唯一 key，服务端去重 | 防"重复执行副作用"，最实用 |
| 事件流 + 订阅游标 | 流写 MQ/DB，客户端带 cursor 订阅可回放 | 多消费端、要历史、要审计 |
| 快照 + 增量 (Snapshot+Delta) | 定期全量快照 + 增量 diff | 状态大、断线久、避免无限历史 |
| WebSocket + 应用层 Ack | 客户端回执"我收到 N"，服务端补 N 之后 | 双向交互、精确回补 |
| **Checkpoint + 幂等** | 持久化每步状态，恢复接着跑 | 工具型 Agent 的"续跑" |

```
只要文字连续性      → Last-Event-ID 够用
担心重复执行副作用   → 加幂等键
要"干到一半接着干"   → checkpoint（每步状态）+ plan 定位
要历史/多端/审计     → 事件流 + 游标订阅
状态大、断线久       → snapshot + delta
要双向交互/精确回补   → WebSocket + 应用层 ack
```

> 本质统一视角：`Last-Event-ID` 是"客户端被动挨推、猜断点"；订阅游标 / Ack 是"客户端主动告诉服务端我读到哪，服务端精确回补"。

## 4. Checkpoint：任务执行层的"续跑"

### 4.1 存什么——一份完整可恢复状态

```ts
interface Checkpoint {
  checkpointId: string;        // 每次纯增量(c-5, c-6...)
  threadId: string;            // 任务/会话
  messages: Message[];         // 完整对话 + 工具结果
  plan: Step[];                // 每步 status: pending / in_progress / done / failed
  preToolIntents: Map<string, {status:'pending'|'done', idempotencyKey}>;
  config: { model; tools; cwd; ... };
}
```

### 4.2 什么时机存——盯住 agent loop 的稳定点

| 时机 | 存什么 | 为什么 |
|------|--------|--------|
| 每个"工具步骤"**完成后** | 完整状态 + `status:done` | 断点最细、回放最少 |
| 执行副作用工具**【前】** | intent + 幂等键(`pending`) | 知道"这个工具可能做了一半"，可去重 |
| 每条 assistant 消息出完 | 完整对话 + 游标 | 文字层续传 |
| Session 开始 / 用户输入边界 | 初始快照 / 兜底 | 无状态也有一版 |

### 4.3 什么方式存——介质 + 三个硬要求

| 介质 | 适合 |
|------|------|
| 内存 + JSON 文件 | 教学、快速原型 |
| SQLite | 单实例可靠、零运维（够用的生产起点） |
| PostgreSQL | 多实例、ACID、并发安全 |
| Redis | 要快 + TTL（需配 AOF/RDB 才不丢） |

三个硬要求：
- **追加式/不可变**：`(threadId, 新checkpointId)` 不覆盖旧版 → 可回滚/重放，恢复取最新；
- **原子写入**：整份序列化成一块一次写入，别半改半存；
- **同写多读**：对外就是 `put(...)` / `get_latest(...)` 两个方法，写只在稳定点发生。

### 4.4 怎么恢复

```
读最新版 → 还原 messages/plan/config → 定位最后一个 done 的 step → 从那儿循环
preToolIntents 里 pending 无结果 → 按幂等去重 或 标记重试/失败
```

> 这就是把 Agent 跑成"**带命令日志的状态机**"（类似 WAL / 事件溯源）：动作做成可重放的命令日志，副作用用幂等键去重。LangGraph 的 checkpointer 正是这套。

## 5. 用 Hooks 打 Checkpoint（Claude Code 不侵入打法）

不侵入 agent loop，用 hooks 在工具/生命周期边界打点：

| 时机 | Hook | 写什么 |
|------|------|--------|
| 执行副作用工具【前】 | `PreToolUse` | intent `{tool,args,status:pending,key}` |
| 工具【后】完成 | `PostToolUse` | 标 done + 存 `tool_response` |
| 工具失败 | `PostToolUseFailure` | 标 failed → 可重试/回滚 |
| 一个 turn / subagent 结束 | `Stop` / `SubagentStop` | 打阶段边界标记 |
| 上下文压缩前 | `PreCompact` | 压缩前落一版全量（防记忆被裁丢） |

**边界（必答）**：hook 输入**只有当前这一次工具事件**的上下文（tool_name/input/response），看不到完整对话与 plan → hooks 给的是**工具级意图/结果日志（幂等 trace）**，**不是全量快照**；全量续传仍靠 Claude 自家 `--resume`/transcript。两者叠加 = 完整方案。
**实现要点**：状态写外部 store（按 `task_id` 分桶）；hook 每个独立进程、无内存共享；并发写用 DB/`O_APPEND` 保原子性。

## 6. checkpoint vs transcript：会不会膨胀

| | checkpoint | transcript / 事件日志 |
|---|---|---|
| 目的 | 从断点接着跑 | 审计、追溯、重放历史 |
| 存储 | **覆盖式只留最新一份**(+1~2 兜底) | append 留史 |
| 会话长会不会越来越多 | **不会**（一份最新态） | **会**（日志宿命） |

- `squash/合并` **只在用 delta/WAL 增量式存可恢复态时才需要**（增量链定期压实）；覆盖式根本用不上。
- 要回滚到"很早的某个完成步骤" → 走 transcript 重放重建任意状态，**不靠 checkpoint 历史**。

## 7. 用户取消：取消链向上游传（最容易漏）

```
用户(点取消) → 前端发取消 → 网关 AbortController → 中台取消 LLM API → 释放资源
```

- 取消要**向上游传**：调第三方 LLM 用 `AbortSignal`，否则上游还在烧钱吐 token。
- 取消 ≠ 丢弃状态：显式把状态机写成 `CANCELLED`，别让它飘在半空。
- 区分语义：`cancel`（未开始/运行中，可重试） vs `取消`（已产生副作用，不能直接销毁）。

---

# 二、答题卡

## 30 秒版

> "流式我用 **SSE**(服务器→客户端单向、天然适合 LLM 单向下推),第30课把 generateText 的**伪流式**升级成 streamText 的 **fullStream 真流式**,工具调用阶段靠 `experimental_continueSteps` 继续。SSE 推送复用第15课的 `flushHeaders` + 事件审计层；**断线续传给增量 buff 打游标、弃掉从头重放**；带工具的 Agent 靠 **checkpoint + 幂等键**沉到任务执行层续跑,不重跑已完成步骤。用户取消用 **cancel 链把 AbortSignal 一路传到上游 LLM**,省掉空转资源。"

## 完整答题卡

### A. 用什么推：SSE vs WebSocket

| 维度 | SSE | WebSocket |
|---|---|---|
| 方向 | 单向(服务器→客户端) | 双向 |
| 协议 | HTTP 长连接 + `text/event-stream` | TCP 握手升级 |
| 重连 | 浏览器原生 + `Last-Event-ID` 续传 | 需自己实现 |
| 适用 | 服务器单下行流(LLM 正好) | 双向实时协作 |

**结论话术**：Agent 流式是"服务器单向下推",SSE 协议级自带重连语义,部署对网关/缓存/CDN 更友好。别为了"实时"盲目上 WebSocket。

### B. 关键实现细节

- **保活**：代理/网关空转会掐断长连接 → 发注释行 `: ping\n\n` 做心跳。
- **backpressure(小包风暴)**：LLM 吐 token 可能一秒只蹦一个词,别每个 chunk 都透传,做**增量缓冲**(攒 20ms 或攒够 N 字符再 flush)→ 第22课的 `AsyncIterator + ReadableStream` 背压。
- **flushing**：`res.flushHeaders()` + 每次 write 后 flush(第15课)。

### C. 连接断了怎么续

- 客户端：断线后用 `Last-Event-ID` + `retry` 重连。
- 服务器：不能只断客户端,要**保存可续传游标**(增量 token 落一张 Redis,cursor 递增),从游标后面的 offset 继续插,不从头重排。
- Agent 的难：流式不止文字,中间有工具调用/推理步骤 → 把"已完成的步骤"存成 **checkpoint**,重连从最后一步继续(复用第38课的思路迁移到流式)。

### D. 用户取消了怎么停上游

- 取消要**向上游传**:调第三方 LLM 用 `AbortSignal`,否则上游还在烧钱吐 token。
- 取消 ≠ 丢弃状态:显式把状态机写成 `CANCELLED`。
- 区分语义:`cancel`(未开始/运行中,可重试) vs 取消(已产生副作用,不能直接销毁)。

## 追问 Q&A

**Q1：为什么选 SSE 而不是 WebSocket？**
A：Agent 是"服务器→客户端"纯下行,SSE 协议自带 `text/event-stream` 分帧和事件重连语义,对网关/CGI/缓存更友好,成本低。WebSocket 的双向能力这里用不上,属于过度设计。

**Q2：断了之后除了 Last-Event-ID 还有别的方案吗？**
A：先把续传拆成三层：传输层(重连)、内容层(Last-Event-ID/游标重放)、任务执行层(checkpoint)。Last-Event-ID 只活在内容层、补的是文字。带工具的 Agent 必须上升到任务执行层：把已完成的工具步骤持久化成 checkpoint,重连后定位最后一个 done 的步骤"接着跑"(已完成的绝不重跑),且每步带幂等键防止重放副作用,只把 cursor 之后的新增量插下去——把"补文字"升级成"接着执行"。其他备选：幂等键、事件流+游标订阅、快照+增量、WebSocket+Ack(详见知识体系 §3)。

**Q3：用户中途取消，你怎么省的资源？**
A：取消信号沿链路向上传,到网关用 AbortController 断掉对上游 LLM 的请求;同时把任务在状态机里标记 CANCELLED,避免 job 半挂;能回滚的记得补偿、不能回滚的走幂等对账。

**Q4：真流式里遇到工具调用怎么办？**
A：用 `streamText + fullStream`,`experimental_continueSteps: true` 允许工具执行完继续流式。事件流是 `[text-delta → tool-call → tool-result → step-finish] → [再一轮 thinking_start]`,`step-finish.isContinued` 判断是否还有后续 — 这就是第30课的核心。

**Q5：Last-Event-ID 断了之后具体怎么找回上次的数据？**
A：游标回放：服务端给每事件编递增 id,客户端记 last-seen(EventSource 断线自动带 `Last-Event-ID` 头),服务端 `where id>N` 重发补回去。两个前提：①服务端**留得住历史**(内存 buff 会丢,可靠落 DB/MQ)；②回放的是"事件描述"不是"重新执行动作",要"接着干未完成步骤"还得靠 checkpoint。

**Q6：checkpoint 怎么存?什么时机、什么方式？**
A：存完整可恢复状态=对话 + plan 步骤状态 + config + 幂等键,介质 SQLite/Postgres/Redis(可事务)。时机两个稳定点：**每个工具步骤完成后**存一版、**执行副作用工具前**记 intent+幂等键。恢复=读最新→找最后一个 done 步骤→接着跑,`pending` 意图按幂等去重或重试。要点：原子写入、追加不可变可回滚。

**Q7：能用 Hooks 做 checkpoint 吗？**
A：能,对 Claude Code 最不侵入。`PreToolUse` 记意图、`PostToolUse` 记 done+结果、`Stop/SubagentStop` 打 turn 边界、`PreCompact` 压缩前快照,写外部 store 按 task_id 分桶。**边界**：hook 输入只有当前这一次工具的上下文,看不到完整对话/plan → 它给的是"工具级幂等日志",不是全量快照;全量续传仍靠 Claude 自家 resume。两者叠加才完整。

**Q8：会话很长,checkpoint 会不会很多？**
A：不会,常见混淆。checkpoint 不该当日志留历史,而是覆盖式只留最新一份(+1~2 兜底),长会话也不堆积;真正线性膨胀的是 transcript(本来就 append 留史)。squash/合并只在用 delta/WAL 增量式存可恢复态时才需要,覆盖式用不上。要回滚到旧状态走 transcript 重放,不靠 checkpoint 历史。

## 避坑

- 不要只说"用了 SSE"就停,一定要带 `flushHeaders`/背压/重连/checkpoint 这些工程细节。
- 工具调用阻断流式这道题别把 generateText 伪流式硬当真流式讲,会被一眼看穿。
- 取消别只说前端层,面试官要的是"如何让上游 LLM 也停(省资源)"这条链路。
- 别把 checkpoint 当"日志留历史"——它是"覆盖式一份可续跑状态",历史交给 transcript。

## 课程弹药

| 来源 | 能用它回答什么 |
|---|---|
| 第3课 | 打字机效果、`onChunk`、write |
| 第6课 | `fetch + ReadableStream + TextDecoder` 手写 SSE、手动解析 delta — SSE 就是 `event-stream` + `\n\n` 分帧 |
| 第7课 | 伪流式:generateText 等全部完成再逐字模拟 |
| 第15课 | **`res.flushHeaders()` + TCP 分片 buffer** 是真实工程细节 |
| 第30课 | **灵魂题**:工具调用打断流式`[流式思考→阻塞执行→流式收尾]`,靠 `experimental_continueSteps`;`fullStream` 的 `text-delta/tool-call/tool-result/step-finish` |
| 第22课 | streamText 源码：AsyncIterator + ReadableStream + 背压 |
| 第38课 | checkpoint / 断点 + 原子写入，即"任务执行层"续传的正规实现 |
| 附录A2 | 写操作幂等 / 回滚，对应"幂等键 + intent 去重" |
| 第23/24课 | Redis 队列 + 游标，可类比"事件流 + 订阅游标"续传 |

> 背诵路径：**知识体系 §2(三层模型) → §4(checkpoint) → §5(hooks) → §6(不膨胀)**，再把每段压缩成答题卡里的一句话。
---

## 下一篇

流式把"结果怎么送到用户"讲完了，下一个问题是**结果写了会不会丢/会不会重复**。

- [ ] [附录A2：写操作可靠性（幂等 / 状态机 / 回滚）](/blog/from-scratch-appendix-02-write-reliability/)
