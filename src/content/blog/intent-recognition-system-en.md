---
title: "Intent Recognition System Design: Unbounded Problems to the Model, Bounded Problems to Code"
date: 2026-09-07
excerpt: "Intent recognition isn't a classification problem — it's an observable, verifiable execution chain that's allowed to admit uncertainty. One principle: give unbounded problems to the model (understanding), bounded problems to code (compute and guard)."
category: AI
ogImage: /images/intent-recognition-system.png
lang: en
---

Before building the calendar agent, I thought intent recognition was a **classification problem**: the user says a sentence, the system files it under "create schedule", "query schedule", or "chit-chat", then extracts parameters. Sounded like a standard NLP pipeline.

The real trouble came from three sentences that look almost identical:

- "Tomorrow 3pm, meet Zhang San" → **write** the calendar
- "What's on tomorrow afternoon" → only **read** the calendar
- "Had a meeting yesterday afternoon, so tired" → touch **nothing**

All three have a date and the word "meeting", but the cost of misjudging is completely different. A query judged as chit-chat makes the user ask again; a casual remark judged as creation silently writes a dirty record — the user won't notice at the time, and won't remember which sentence caused it later.

So the real problem isn't "guess the intent more accurately", it's **when the model guesses wrong, how does the system avoid doing damage**. That sentence changed the whole architecture. This post is about how the architecture grew, and how it converged on one principle: **unbounded problems to the model, bounded problems to code**.

## The whole picture: from classification pipeline to execution chain

The system started as a four-layer classification pipeline and ended as an execution chain of "one big model + code closing the loop". The evolution:

| Version | Recognition chain | Model round-trips per create |
|---------|-------------------|------------------------------|
| v0.1–v0.3 | L1 regex classify (primary) → L2 slot small model → L3 intent small model → L4 council | 0–2 small models + big model sometimes |
| v0.5 | delete L1 regex; L2 → L3 → L4, escalate on low confidence | 2 small models + big model almost always |
| **v0.6** | **one big model (recognition + tool choice merged) + code receipts** | **1 big model** |

The current hot path:

```mermaid
flowchart TB
  Msg[User message] --> L4[L4 council check<br/>only timed "yes"]
  L4 --> Clar{active command and<br/>regex extracts patch?}
  Clar -->|yes| Stub[code merges stub<br/>0 model round-trips]
  Clar -->|no| Agent[qwen3.8-max, thinking off<br/>recognition + tool choice in one]
  Agent -->|write/final query| Code[code emits receipt from tool result]
  Agent -->|no tool| Text[model text is the reply<br/>chit-chat / refuse]
  Agent -->|intermediate read| Agent
  Stub --> Exit[exit check<br/>no write, no "created"]
  Code --> Exit
  Text --> Exit
  Exit --> User[reply]
```

Below: core principle → why we deleted layers → each piece → guarding safety.

## Core principle: unbounded to the model, bounded to code

This system once ran on regex rules. Regex handling natural language is fundamentally **enumerating human phrasing**: you write "周日", the user says "周天"; you add "周天", they say "这个周末". Phrasings are endless — every rule you add has a next miss behind it.

Three real bugs we hit all came from this cause:

- "这个周末去修汽车轮毂" — "weekend" wasn't in the date rules, the whole sentence became `ambiguous`
- "周日下午2点" — the rules knew "周日" and "下午2点" separately, but not "said together"
- a lone "天" — the character class `[一二三四五六日天]` was too wide, treating a non-word as a valid date

But not all code has this disease. The key is whether the **input space is bounded or unbounded**:

- **Unbounded**: arbitrary human sentences. "What do they want", "which words are the title" — infinite phrasings. **Give to the model.**
- **Bounded**: a few explicit parameters. "What date is 'tomorrow'", "do two ranges conflict", "did this round write an event". **Keep in code** — exhaustively unit-testable, always a definite answer; the model does arithmetic *worse*.

One sentence: **the model understands, the code computes and guards.**

This principle also decides what to delete and what to keep. After deleting regex classification, field-level regex **stayed** — date/time parsing (`ScheduleTimeService`), clarification slot extraction, receipt detection. Their input is a single expression or a single factual question, bounded, not "recognizing intent". We deleted "regex deciding the user's intent", not regex itself.

## Why delete the layers: the front classifier became pure tax

v0.5's chain was L2 slot model → L3 intent model, two `qwen-turbo` calls that had to finish **serially** before the first SSE token (1–2.5s each). Worse, L3 often returned no candidate confidence, the code defaulted it to 0.8, and the escalation threshold was 0.85 — so many create requests ran both small models and then *still* called the big model.

One "tomorrow 3pm, meeting" could cost **three serial model round-trips**, ~5 seconds in preprod.

Then we asked a blunt question: who is the front classifier still serving?

It used to have two jobs: decide which tools to give the model, and decide whether to take a code fast-path. But if making that decision requires two serial model calls first, the "fast path" is no longer fast. Since the final big model can pick tools anyway, the standalone intent-classification stage became pure tax.

So v0.6 made the most radical change: remove L2/L3 from the hot path, merge recognition and tool choice into **one** big model call. This isn't "swap in a faster small model" — it's **removing "recognition" as a standalone stage**.

Deleting layers kept two boundaries:

- **Field-level regex tools stayed**: date parsing, clarification extraction, receipt detection — bounded, not "recognizing intent".
- **The code execution layer is untouched**: command merging, conflict detection, and persistence are "what to do after intent is decided", not "regex deciding intent for the model".

## Each piece: slots, clarification, sessions, evaluation

Getting the intent right doesn't mean every piece is right. The remaining pieces each have their own traps.

**Slots: the model may only give an "expression", never an "answer"**. "这个周末" passes `WE` as-is; what date that is gets computed by code. That was the old L2 iron rule, and v0.6 applies it unchanged to write-tool parameters — the model computes dates unreliably, arithmetic stays in `ScheduleTimeService`. Chinese time ambiguity ("7点半" is morning or evening) is also this piece's trap, detailed in the Chinese time parsing post.

**Clarification: reduce to empty, don't enumerate combinations**. How do you tell "周日下午2点" is a pure slot-filling reply? The old way wrote a giant regex enumerating "date / period / time" combinations and failed at both ends. The new way flips the question — not "what does it look like", but "after stripping slot words, what's left":

```ts
export function isScheduleClarificationReply(message: string): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  if (!text.match(CLARIFY_SLOT_PATTERN)) return false;   // must have a date/time word
  return (
    text
      .replace(CLARIFY_SLOT_PATTERN, '')     // strip date/time words
      .replace(CLARIFY_FILLER_PATTERN, '')   // strip connectors and fillers
      === ''                                  // nothing left → pure slot-filling
  );
}
```

The win: no combination enumeration; the lone "天" gets rejected naturally; the slot-word definition reuses the same regex source as the parser, so a new date phrasing changes one place.

**Sessions: old context from "default pour-in" to "read on demand"**. An old thread may hold content the user wants to continue, or stale relative dates — "meeting tomorrow" still gets poured into the prompt a month later, where the model sees a "tomorrow" that's no longer tomorrow. Now the context is segmented by silence gap (`SESSION_GAP_MINUTES`, default 120 min); the current prompt only injects the recent segment; older content leaves just a one-line marker, and the model reads it via archive search only when the user says "before". Uncertain facts: read, don't guess.

**Evaluation: why the gate stayed green while users kept finding problems**. After v0.6, offline eval stayed all-green while real usage kept surfacing new issues. The reason was embarrassing: `eval:agent:live` had "live" in its name but only ran route simulation — it never called a real model. We held a "green false evidence". Later we wired live eval to a real executor (real `streamChat` + real model + stubbed tool backend), giving model behavior its first automated evidence.

## Guarding safety: check facts at the exit, don't guess wording at the entrance

Models make mistakes. There are two ways to guard:

- **Entrance enumeration** (bad): predict what the model will say wrong, write rules to block — back to enumeration.
- **Exit validation** (ours): whatever the model said, before the result leaves, check one objective fact.

The best example is a real failure: the model called no write tool, yet replied "schedule created", and the database was empty. The way to block it isn't guessing the phrasing (infinite), it's asking one fact before the reply goes out: **did this round actually insert an event?**

Code maintains a `scheduleWritePersisted` flag, set `true` only when the database really writes. Before the reply goes out, if the text claims creation but the flag is `false` → replace the whole thing with an honest answer and record `unverified_create_claim`. Why replace, not append? Appending leaves both the fake receipt and the truth in the archive, and later reads have to guess which is real. After replacement, the archive holds only truth.

Beyond exit validation, there's one structural defense: **user isolation**. Every tool binds the authenticated `userId` in a server-side closure at creation; the parameter schema has **no user-identifier field** — the model can't even express "read someone else's data" because the parameter doesn't exist. Prompts can be bypassed; a capability that doesn't exist in the parameter space can't.

## Summary: an observable, verifiable execution chain

Looking back, what really changed was how we sliced the problem. At first we sliced one input into a four-layer classification pipeline, hoping each layer would be simpler. Instead, layers grew, latency rose, and errors multiplied at the seams.

Then we sliced differently — not by "rule, small model, big model", but by problem nature:

```
Open language — the model understands
Closed state — the code judges
Private facts — read through tools
Write results — proven by the database
Model behavior — tested with a real model
```

Intent recognition didn't become a bigger classifier. It became an **observable, verifiable execution chain that's allowed to admit uncertainty**.

If your agent is doing intent recognition, ask one question first: **are you "guessing intent more accurately", or "avoiding damage when the guess is wrong"?** The former is an endless arms race; the latter is a design that lands in code. Give the unbounded to the model, keep the bounded in code, and pin safety on "what the database did" rather than "what the model said" — those three are the most important things in this system.
