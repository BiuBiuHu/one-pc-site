---
title: "Thinking About Intent Recognition: Plan + Tool Design"
date: 2026-08-31
excerpt: "After many rounds of intent recognition, I finally understand how it should be done."
category: Thoughts
lang: en
---

**I did many rounds of intent recognition, and finally found: the problem may not be intent recognition at all.** Lately I've been iterating on intent recognition in a "schedule calendar" product.

At first I thought this was just an ordinary classification problem:

The user says a sentence, the model judges what they want to do.

For example:

* "明天下午三点帮我开个会" → create schedule
* "我明天有什么安排？" → query schedule
* "把下午三点的会议取消掉" → delete schedule
* "改到四点吧" → update schedule

Seems simple enough.

But once it went into a real product, I found a very annoying problem:

**Bad cases never run out.**

Fix "明天下午开会", and "明天下午帮我留两个小时" breaks.

Fix single-turn, and multi-turn clarification breaks.

Fix intent classification — the model knows the user wants to create a schedule, but doesn't necessarily call the create-schedule tool.

So development gradually became:

> find a case → change the prompt → test → fix → a new case appears → change the prompt again……

After many rounds, I started to realize:

**This may no longer be a prompt-engineering problem, but an agent-architecture problem.**

---

## 1. The real intent often isn't in the user's last sentence

A calendar is a very typical multi-turn interaction.

For example, the user says:

> Help me schedule a product discussion.

The system can't create directly, because time is missing.

So the agent asks:

> When would you like it?

The user replies:

> Tomorrow afternoon.

The agent continues:

> What time in the afternoon?

The user replies:

> Three.

If you only look at the last sentence "三点", you can hardly tell what the user wants.

The real intent is distributed across the whole conversation history:

```text
User: 帮我安排一个产品讨论
Assistant: 你希望安排在什么时候？
User: 明天下午吧
Assistant: 下午几点？
User: 三点
```

What we ultimately need to recover is:

```text
Action: CreateEvent

Title: 产品讨论
Date: 明天
Time: 15:00
```

So I now lean more and more toward:

**Don't classify every single user message independently too early.**

Give the model a recent stretch of conversation history together with the current input, and let it judge:

> What is the user actually trying to accomplish right now?

In other words, the input to intent recognition isn't:

```text
User Message
```

but:

```text
Conversation Context
+
Current User Message
+
System Context
```

That's the first change.

---

## 2. Don't make "intent recognition" the center of the system

My initial approach was fairly traditional.

The model outputs a JSON:

```json
{
  "intent": "create_event",
  "title": "产品讨论",
  "date": "tomorrow",
  "time": "15:00"
}
```

Then the program, based on the JSON:

```text
LLM
 ↓
Intent JSON
 ↓
Business Code
 ↓
Calendar API
```

This architecture is very easy to understand.

But as capabilities grew more complex, it started to feel heavy.

Because real-world user requests can't be fully described by a few enums.

For example:

> 明天下午找个我和 Alex 都有空的时间聊一下项目，大概一个小时。

This involves at least:

```text
understand intent
 ↓
parse date
 ↓
query my calendar
 ↓
query Alex's availability
 ↓
find common free time
 ↓
create event
```

At this point "intent" is no longer just:

```text
CREATE_EVENT
```

but a series of actions to complete.

So I gradually adjusted the architecture to:

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

**Intent no longer necessarily needs to be an explicit intermediate artifact.**

After the model understands what the user wants, it can directly decide what tool to call next.

This is a shift from:

**Intent Classification**

toward:

**Agent Decision Making.**

---

## 3. Turn calendar capabilities into tools, not infinitely expanding intents

So I started registering the calendar's basic capabilities as tools.

The most basic is CRUD:

```text
query_calendar
create_event
update_event
delete_event
```

Each tool has clear:

```text
name
description
parameters
return value
error
```

For example:

```text
create_event(
  title,
  start_time,
  end_time,
  participants,
  ...
)
```

Once the agent has these capabilities, it decides itself when to call them.

For example:

> 帮我看看明天下午有没有空。

Agent:

```text
→ query_calendar()
→ return result
→ answer the user
```

While:

> 明天下午三点帮我安排一个产品讨论。

is:

```text
→ create_event(...)
→ return success
→ tell the user it's created
```

If information is incomplete:

> 帮我安排一个产品讨论。

The agent calls no tool, and directly answers:

> 你希望安排在什么时候？

User:

> 明天下午三点。

The second round's model gets the conversation context again:

```text
User: 帮我安排一个产品讨论
Assistant: 你希望安排在什么时候？
User: 明天下午三点
```

Now the information is complete:

```text
→ create_event(...)
```

The biggest change of this mechanism:

**Clarification itself is part of agent behavior, not something requiring a separate huge state machine.**

---

## 4. Tool-calling failure doesn't mean agent failure

Next came another real problem.

Tools fail.

And for many reasons.

For example, the model calls:

```text
create_event(...)
```

The result may be:

```text
INVALID_ARGUMENT
```

or:

```text
TIME_CONFLICT
```

or even:

```text
DATABASE_TIMEOUT
```

These three errors are all "tool call failed", but the handling is completely different.

So I now lean toward structurally classifying tool errors.

For example:

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

### Parameter error

For example:

```text
start_time format invalid
```

This error can be returned to the model.

The model may realize:

> So the tool wants ISO 8601.

Then regenerate the parameter and retry.

The user doesn't need to know the first call failed.

---

### Business error

For example:

```text
TIME_CONFLICT
```

This isn't a system fault.

The agent can continue:

```text
create schedule
 ↓
find conflict
 ↓
query nearby free time
 ↓
recommend alternative times to the user
```

Even further in the future:

> This time conflicts with your weekly meeting. 16:00 and 16:30 are free — want to move it to one of them?

This is real agent reasoning.

---

### System error

For example:

```text
Database Timeout
Internal Server Error
Network Error
```

The model can't solve this.

At this point you should:

```text
stop retrying
+
return user-understandable info
+
write to observability
+
trigger monitoring
```

Then the developer locates it from the trace.

So:

**Agent retry isn't a universal retry — it should be built on an error taxonomy.**

---

## 5. After this, I found another problem: ReAct drifts

If the whole system is just:

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

the classic ReAct loop, then simple tasks work great.

For example:

> 创建明天下午三点的会议。

probably needs only one tool call.

But once tasks get complex, problems appear.

For example:

> 把我明天下午所有会议往后推一个小时，如果有冲突就找附近的空闲时间，重要会议不要动。

The agent may need:

```text
query calendar
→ decide which meetings can move
→ modify A
→ query conflict
→ modify B
→ re-query
→ modify C
→ ...
```

Once the execution chain gets long, the model easily drifts from the user's original goal.

This is a very important problem we discussed today:

**The ReAct loop easily causes goal drift.**

The model makes each decision based on the latest observation.

But five or six steps in, it may have forgotten part of the original constraints.

For example:

> "重要会议不要动。"

may get weakened later in execution.

So we talked about the Planner.

---

## 6. Three Planner implementations

Currently I think there are three typical ones.

## Option 1: Planner built into the agent loop

The first round forces plan generation:

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

For example:

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

After that the whole ReAct loop carries this plan.

Its biggest value:

**Continuously pulling the agent's attention back to the original goal.**

---

## Option 2: independent Planner agent

Split Planner and Executor completely:

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

Planner is responsible for:

```text
What should be done?
```

Executor is responsible for:

```text
How to execute it?
```

This has very clear responsibilities and suits complex agents.

But the cost is obvious:

**One or more extra model calls.**

Latency, token cost, and system complexity all increase.

For "明天下午三点提醒我开会", it's clearly unnecessary.

---

## 7. The third option is my current favorite: Planner as a Tool

There's an interesting design:

**Register the Planner itself as a tool.**

For example:

```text
Tools:
- query_calendar
- create_event
- update_event
- delete_event
- create_plan
```

The agent receives:

> 明天下午三点提醒我开会。

It finds this very simple:

```text
create_event()
```

execute directly.

No planner needed.

But if the user says:

> 把我下周所有和项目 A 有关的会议重新整理一下，尽量集中到周二和周三，但不要影响已经确认的重要会议。

The model judges:

> This task is complex.

So:

```text
create_plan()
```

and gets:

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

Then enters the ReAct loop.

So the whole architecture becomes:

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

Why I like this option now:

**Simple tasks stay simple; complex tasks pay the planning cost.**

The Planner went from a fixed step in the agent flow, to an on-demand cognitive capability.

---

## 8. Future evolution: hierarchical planning

If later it's no longer just a calendar agent but gradually a life assistant, planning may need further layering.

For example, the user says:

> 我希望三个月以后可以参加一次半程马拉松。

This is no longer calendar CRUD.

The system may need to break it into:

```text
Goal
 ↓
Plan
 ↓
Tasks
 ↓
Calendar Actions
```

For example:

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

At this point:

```text
Goal Planner
     ↓
Task Planner
     ↓
Calendar Agent
     ↓
Tools
```

The Planner naturally evolves from a simple tool into a hierarchical planner.

But that's for later.

I increasingly feel there's an important principle in agent architecture:

> **Don't build the entire final architecture up front — let complexity grow layer by layer as problems appear.**

---

## 9. Re-examining "intent recognition": maybe it isn't a classifier at all

Reaching here and looking back at the original problem is interesting.

At first I wanted to solve:

> How to improve intent-recognition accuracy?

So I kept adding:

```text
Intent
Prompt
Rules
Examples
Few-shot
Bad Case
```

But now I increasingly feel:

For agent products, "intent recognition" maybe shouldn't be just:

```text
User Input
      ↓
Intent Classifier
      ↓
CREATE / QUERY / UPDATE / DELETE
```

A more reasonable structure might be:

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

Intent recognition went from an independent module to part of agent reasoning.

This is my biggest cognitive change from the recent calendar-agent work.

---

## 10. When bad cases never run out, maybe stop and look at the architecture

Making AI products, it's easy to fall into a state:

A bad case appears, so keep changing the prompt.

This is useful, of course.

But if you find:

> **Fix one case, and a different phrasing breaks it again.**

and this keeps happening, it's worth stopping to ask one question:

**Am I solving a model-capability problem, or using prompts to patch an architecture problem?**

These are two completely different things.

My judgment standard now:

If a problem keeps needing more:

```text
if the user says this……
if the last round was this……
if this field doesn't exist……
if there's a conflict……
if the tool fails……
if……
```

then it likely means:

**A new architectural abstraction should appear here.**

It might be:

```text
Tool
Memory
Planner
State
Workflow
Error Taxonomy
Observability
```

rather than the 87th rule in the prompt.

---

## In closing

My strongest feeling from recent agent work:

**The really hard part of agent engineering isn't making the LLM "smarter", but designing an architecture where the system still works stably even when the LLM is occasionally not smart.**

Conversation restores its context.

System prompt gives it boundaries.

Tools give it action capability.

Structured error gives it recovery.

Planner keeps its goal.

Observability helps the developer find systemic problems.

Memory lets it gradually understand this user.

What forms in the end isn't really an "intent-recognition module".

It's:

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

**This is a complete agent loop.**

So if you ask me again:

> "How should a calendar agent's intent recognition be done?"

My answer may become:

**Don't just do intent recognition.**

Let the agent understand what the user is accomplishing, give it clear enough tools, constraints, planning, and error recovery, and let "intent" naturally show up in the action it picks next.

That's probably closer to what an agent product should ultimately look like, than maintaining an ever-growing intent classifier.
