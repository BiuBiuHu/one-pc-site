---
title: 关于意图识别的思考 ---- Plan + 工具设计
date: 2026-08-31
excerpt: 做了这么多意图识别的实践，我终于想明白，该怎么做意图识别了
category: 思考
---

**我做了很多轮意图识别，最后发现：问题可能根本不在意图识别**最近我一直在迭代「安排日历」里的意图识别。

一开始，我以为这只是一个很普通的分类问题：

用户说一句话，模型判断他想做什么。

比如：

* “明天下午三点帮我开个会” → 创建日程
* “我明天有什么安排？” → 查询日程
* “把下午三点的会议取消掉” → 删除日程
* “改到四点吧” → 修改日程

看起来并不复杂。

但真正做进产品之后，我发现一个很麻烦的问题：

**Bad Case 永远修不完。**

修好了“明天下午开会”，换成“明天下午帮我留两个小时”可能又不行。

修好了单轮对话，多轮澄清又出了问题。

修好了意图分类，模型知道用户想创建日程，却又不一定真的调用创建日程的 Tool。

于是整个开发过程逐渐变成：

> 发现一个 Case → 改 Prompt → 测试 → 修好 → 又出现新的 Case → 再改 Prompt……

做了很多轮以后，我开始意识到：

**这可能已经不是一个 Prompt Engineering 问题，而是一个 Agent 架构问题。**

---

## 一、真正的意图，往往不在用户最后一句话里

日历是一个非常典型的多轮交互场景。

例如用户说：

> 帮我安排一个产品讨论。

系统不能直接创建，因为缺少时间。

于是 Agent 问：

> 你希望安排在什么时候？

用户回答：

> 明天下午吧。

Agent继续问：

> 下午几点？

用户回答：

> 三点。

如果只看最后一句“三点”，几乎无法判断用户到底想干什么。

真正的用户意图其实分布在整个 Conversation History 中：

```text
User: 帮我安排一个产品讨论
Assistant: 你希望安排在什么时候？
User: 明天下午吧
Assistant: 下午几点？
User: 三点
```

最终我们需要恢复出来的其实是：

```text
Action: CreateEvent

Title: 产品讨论
Date: 明天
Time: 15:00
```

所以我现在越来越倾向于：

**不要过早把每一句 User Message 独立分类。**

应该把最近一段 Conversation History 连同当前输入一起交给模型，让模型判断：

> 用户当前到底想完成什么事情？

换句话说，意图识别的输入不是：

```text
User Message
```

而应该是：

```text
Conversation Context
+
Current User Message
+
System Context
```

这是第一个变化。

---

# 二、不要让“意图识别”成为整个系统的中心

我最开始的思路其实比较传统。

模型负责输出一个 JSON：

```json
{
  "intent": "create_event",
  "title": "产品讨论",
  "date": "tomorrow",
  "time": "15:00"
}
```

然后程序根据 JSON：

```text
LLM
 ↓
Intent JSON
 ↓
Business Code
 ↓
Calendar API
```

这个架构非常容易理解。

但随着能力越来越复杂，我发现它开始变得笨重。

因为真实世界里的用户请求不是几个 Enum 可以完全描述的。

比如：

> 明天下午找个我和 Alex 都有空的时间聊一下项目，大概一个小时。

这里至少包含：

```text
理解意图
 ↓
解析日期
 ↓
查询我的 Calendar
 ↓
查询 Alex 的 Availability
 ↓
寻找共同空闲时间
 ↓
创建 Event
```

这时候所谓的 Intent 已经不再只是：

```text
CREATE_EVENT
```

而是一系列需要完成的 Action。

所以我后来逐渐把架构调整成了：

```text
Conversation
      ↓
     LLM
      ↓
   Agent Loop
   ↙   ↓   ↘
Query  Create  Update ...
Calendar Event Event
```

**Intent 不再一定需要成为一个显式的中间产物。**

模型理解了用户想做什么之后，可以直接决定下一步应该调用什么 Tool。

这其实是从：

**Intent Classification**

逐渐走向：

**Agent Decision Making。**

---

# 三、把日历能力变成 Tools，而不是无限扩充 Intent

于是我开始把日历的基础能力注册成 Tools。

最基本的是 CRUD：

```text
query_calendar
create_event
update_event
delete_event
```

每个 Tool 都有明确的：

```text
name
description
parameters
return value
error
```

例如：

```text
create_event(
  title,
  start_time,
  end_time,
  participants,
  ...
)
```

Agent拿到这些能力之后，就可以自己决定什么时候调用。

例如：

> 帮我看看明天下午有没有空。

Agent：

```text
→ query_calendar()
→ 返回结果
→ 给用户回答
```

而：

> 明天下午三点帮我安排一个产品讨论。

则是：

```text
→ create_event(...)
→ 返回成功
→ 告诉用户已经创建
```

如果信息不完整：

> 帮我安排一个产品讨论。

Agent不调用任何 Tool，而是直接回答：

> 你希望安排在什么时候？

用户：

> 明天下午三点。

第二轮模型重新拿到 Conversation Context：

```text
User: 帮我安排一个产品讨论
Assistant: 你希望安排在什么时候？
User: 明天下午三点
```

此时信息完整：

```text
→ create_event(...)
```

这套机制最大的变化在于：

**澄清本身也是 Agent 行为的一部分，而不需要单独设计一个巨大的状态机。**

---

# 四、Tool Calling 失败，也不意味着 Agent 失败

接下来又出现了另一个现实问题。

Tool 会失败。

而且失败原因很多。

比如模型调用：

```text
create_event(...)
```

结果可能返回：

```text
INVALID_ARGUMENT
```

也可能：

```text
TIME_CONFLICT
```

甚至：

```text
DATABASE_TIMEOUT
```

这三种错误虽然都是“Tool 调用失败”，但处理策略完全不同。

所以我现在更倾向于把 Tool Error 做结构化分类。

例如：

```text
Tool Error
    │
    ├── Parameter Error
    │       ↓
    │    Agent Retry
    │
    ├── Business Error
    │       ↓
    │    Agent Reasoning
    │
    └── System Error
            ↓
       Fail + Observability
```

### 参数错误

比如：

```text
start_time format invalid
```

这种错误完全可以重新返回给模型。

模型可能发现：

> 原来 Tool 要的是 ISO 8601。

于是重新生成参数并 Retry。

不需要用户知道第一次调用失败了。

---

### 业务错误

例如：

```text
TIME_CONFLICT
```

这不是系统故障。

Agent可以继续处理：

```text
创建日程
 ↓
发现冲突
 ↓
查询附近空闲时间
 ↓
给用户推荐替代时间
```

甚至未来可以进一步：

> 这个时间和你的周会冲突。16:00 和 16:30 都有空，需要帮你改到其中一个吗？

这实际上已经进入真正的 Agent Reasoning。

---

### 系统错误

例如：

```text
Database Timeout
Internal Server Error
Network Error
```

这种问题模型自己解决不了。

此时应该：

```text
停止 Retry
+
返回用户可理解的信息
+
写入 Observability
+
触发监控
```

然后由开发者根据 Trace 定位。

所以：

**Agent Retry 不是万能重试，而应该建立在 Error Taxonomy 之上。**

---

# 五、做到这里以后，我又发现了一个问题：ReAct 会漂移

如果整个系统只是：

```text
Think
 ↓
Act
 ↓
Observe
 ↓
Think
 ↓
Act
 ↓
Observe
```

也就是经典 ReAct Loop，那么简单任务很好用。

例如：

> 创建明天下午三点的会议。

可能只需要一次 Tool Call。

但任务复杂以后，问题就出现了。

比如：

> 把我明天下午所有会议往后推一个小时，如果有冲突就找附近的空闲时间，重要会议不要动。

Agent可能需要：

```text
查询日历
→ 判断哪些会议可以修改
→ 修改 A
→ 查询冲突
→ 修改 B
→ 重新查询
→ 修改 C
→ ...
```

执行链一旦变长，模型很容易逐渐偏离用户最开始的目标。

这就是我们今天讨论到的一个很重要的问题：

**ReAct Loop 很容易发生 Goal Drift。**

模型每一步都在根据最新 Observation 做决定。

但是走了五六步之后，它可能已经把最初的约束忘掉了一部分。

比如：

> “重要会议不要动。”

执行到后面可能就被弱化了。

于是我们聊到了 Planner。

---

# 六、Planner 的三种实现

目前我认为比较典型的有三种。

## 方案一：Planner 内置在 Agent Loop

第一轮强制生成 Plan：

```text
User
 ↓
Plan
 ↓
ReAct
 ↓
Tool
 ↓
Observation
 ↓
ReAct
```

例如：

```text
Goal:
调整明天下午的会议

Plan:
1. 查询明天下午所有会议
2. 判断哪些会议允许移动
3. 每个会议顺延 1 小时
4. 检查冲突
5. 冲突时寻找最近空闲时间
6. 不修改重要会议
```

之后整个 ReAct Loop 都带着这个 Plan。

它最大的价值就是：

**不断把 Agent 的注意力拉回原始目标。**

---

## 方案二：独立 Planner Agent

把 Planner 和 Executor 完全拆开：

```text
             ┌─────────────┐
User ───────→│ Planner     │
             └──────┬──────┘
                    ↓
                  Plan
                    ↓
             ┌─────────────┐
             │ Executor    │
             └──────┬──────┘
                    ↓
                  Tools
```

Planner 负责：

```text
What should be done?
```

Executor 负责：

```text
How to execute it?
```

这种方式职责非常清晰，也非常适合复杂 Agent。

但代价也明显：

**多一次甚至多次模型调用。**

Latency、Token Cost、系统复杂度都会增加。

对于“明天下午三点提醒我开会”这种请求，显然没有必要。

---

# 七、第三种方案反而是我目前最喜欢的：Planner as a Tool

还有一种很有意思的设计：

**把 Planner 本身注册成一个 Tool。**

例如：

```text
Tools:
- query_calendar
- create_event
- update_event
- delete_event
- create_plan
```

Agent收到：

> 明天下午三点提醒我开会。

它发现非常简单：

```text
create_event()
```

直接执行。

根本不需要 Planner。

但如果用户说：

> 把我下周所有和项目 A 有关的会议重新整理一下，尽量集中到周二和周三，但不要影响已经确认的重要会议。

模型判断：

> 这个任务比较复杂。

于是：

```text
create_plan()
```

得到：

```text
1. 查询下周会议
2. 筛选项目 A
3. 标记不可移动会议
4. 查询周二、周三空闲时间
5. 生成迁移方案
6. 检查冲突
7. 请求用户确认
8. 执行修改
```

然后再进入 ReAct Loop。

于是整个架构变成：

```text
                 User
                   ↓
                 Agent
              ↙     ↓     ↘
         Simple   Complex   Clarify
           ↓        ↓         ↓
         Tool    Planner    User
                    ↓
                  Plan
                    ↓
                  ReAct
                    ↓
                  Tools
```

我现在比较喜欢这个方案的原因是：

**简单任务保持简单，复杂任务才支付 Planning 的成本。**

Planner 从 Agent 的固定流程，变成了一种按需调用的认知能力。

---

# 八、未来还可以继续演进：Hierarchical Planning

如果以后它不再只是一个 Calendar Agent，而逐渐成为一个 Life Assistant，那么 Planning 可能还需要继续分层。

比如用户说：

> 我希望三个月以后可以参加一次半程马拉松。

这已经不是 Calendar CRUD 了。

系统可能需要把它拆成：

```text
Goal
 ↓
Plan
 ↓
Tasks
 ↓
Calendar Actions
```

例如：

```text
完成半程马拉松
        ↓
制定 12 周训练计划
        ↓
每周训练 4 次
        ↓
寻找用户空闲时间
        ↓
创建具体日程
```

这时候：

```text
Goal Planner
     ↓
Task Planner
     ↓
Calendar Agent
     ↓
Tools
```

Planner 自然就会从一个简单 Tool，逐渐演进成 Hierarchical Planner。

但这是后面的事情。

我越来越觉得，Agent 架构有一个很重要的原则：

> **不要一开始就把最终架构全部造出来，而应该让复杂度随着问题出现逐层生长。**

---

# 九、重新看“意图识别”：也许它根本不是一个分类器

走到这里，再回头看最开始的问题，会发现很有意思。

一开始我想解决的是：

> 如何提高意图识别准确率？

所以我不断增加：

```text
Intent
Prompt
Rules
Examples
Few-shot
Bad Case
```

但是现在我越来越觉得：

对于 Agent 产品来说，所谓的“意图识别”可能根本不应该只是：

```text
User Input
      ↓
Intent Classifier
      ↓
CREATE / QUERY / UPDATE / DELETE
```

更合理的结构可能是：

```text
Conversation Context
          ↓
    Agent Reasoning
          ↓
 ┌────────┼─────────┐
 ↓        ↓         ↓
Answer  Clarify   Action
                   ↓
              ┌────┴────┐
              ↓         ↓
            Simple    Complex
              ↓         ↓
            Tool      Planner
                        ↓
                      ReAct
                        ↓
                      Tools
```

Intent Recognition 从一个独立模块，逐渐变成了 Agent Reasoning 的一部分。

这也是我最近做日历 Agent 最大的一个认知变化。

---

# 十、Bad Case 修不完的时候，也许应该停下来看看架构

做 AI 产品很容易陷入一种状态：

出现 Bad Case，就继续改 Prompt。

这当然有用。

但如果你发现：

> **一个 Case 修好了，换一种表达方式又坏了。**

而且这种事情不断发生，那么值得停下来问一个问题：

**我到底是在解决模型能力问题，还是在用 Prompt 弥补架构问题？**

这是两件完全不同的事情。

我现在给自己的一个判断标准是：

如果一个问题需要不断增加：

```text
if 用户这样说……
如果上一轮这样……
如果这个字段不存在……
如果发生冲突……
如果 Tool 失败……
如果……
```

那么很可能意味着：

**这里应该出现一个新的架构抽象了。**

它可能是：

```text
Tool
Memory
Planner
State
Workflow
Error Taxonomy
Observability
```

而不是 Prompt 里的第 87 条规则。

---

# 写在最后

最近做 Agent 越来越强烈的一个感受是：

**Agent 工程真正困难的地方，并不是让 LLM “更聪明”，而是设计一个架构，让 LLM 即使偶尔不聪明，系统仍然能够稳定工作。**

Conversation 帮它恢复上下文。

System Prompt 给它边界。

Tools 给它行动能力。

Structured Error 给它纠错能力。

Planner 帮它保持目标。

Observability 帮开发者发现系统性问题。

Memory 则让它逐渐理解这个用户。

最后形成的其实已经不是一个所谓的“意图识别模块”。

而是：

```text
Context
   ↓
Reasoning
   ↓
Planning
   ↓
Action
   ↓
Observation
   ↓
Recovery
   ↓
Memory
```

**这是一个完整的 Agent Loop。**

所以现在如果再让我回答：

> “日历 Agent 的意图识别应该怎么做？”

我的答案可能会变成：

**不要只做意图识别。**

让 Agent 理解用户正在完成的事情，给它足够清晰的工具、约束、Planning 和错误恢复机制，然后让“意图”自然地体现在它下一步选择的 Action 里。

这可能比维护一个越来越庞大的 Intent Classifier，更接近 Agent 产品最终应该有的样子。

