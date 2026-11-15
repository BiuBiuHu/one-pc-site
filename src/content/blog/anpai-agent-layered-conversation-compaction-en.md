---
title: Designing Layered Conversation Compaction in Anpai
date: 2026-11-15
excerpt: "Anpai compresses conversation history in layers so an agent can follow a continuing discussion and still retrieve original details. The design is still being refined in isolated staging."
category: Agent Development
series: Agent Development
seriesOrder: 10
ogImage: /images/anpai-agent-compaction/01-request-en.png
lang: en
draft: false
---

Anpai's conversation context design serves two needs: helping an agent follow a continuing discussion, and letting it recover details after older history has been compressed. Summaries preserve the thread of the discussion; the original archive preserves the evidence. Multiple summary levels control input size, while background execution reduces the time users spend waiting for history to be processed.

## 1 What continuity requires

A user replied “Yes,” and the agent lost track of what they were agreeing to.

We encountered this in Anpai. The assistant had just offered to create a reminder. After the user agreed, it asked what the user wanted to schedule. The continuity expected from a collaborative assistant had broken.

![An early conversation continuity failure](/images/anpai-agent-compaction/context-loss-original.png)

*Original Chinese product screenshot: after the user agrees, the assistant asks for the task again.*

The initial fault was that some request paths did not pass history correctly. That requires fixing context delivery first: the second request must include the relevant first question, answer, and tool results. Only after short conversations work should we evaluate continuity after compaction.

As history grows, summaries reduce what the model must read, but abstraction loses detail. We therefore retain both summaries and the original records. The agent normally works with summaries and recent messages, then retrieves originals when it needs exact wording, numbers, or the history of a change.

## 2 From a new request to original evidence

Read the numbered arrows from top to bottom. Core receives the follow-up, and the agent obtains assembled context before calling the model. The optional section shows retrieval: a tool reads original records, adds them to the context, and the model runs again. Summary generation is a separate process described later.

![Request handling and optional retrieval of original records](/images/anpai-agent-compaction/01-request-en.png)

Core prepares identity and permissions, a time snapshot, system instructions, and available tools. Before every model call, the context manager loads valid summaries and recent originals, adds the current question and tool results, and checks capacity. Conversation storage in the diagram represents original records, summaries, and checkpoints. The agent accesses it through tools that enforce ownership and version checks, rather than accessing the database directly.

For example, a summary might say that a budget was revised. The user then asks, “What did I change it to, and what exactly did I say?” The agent can follow the summary's source reference, retrieve the message, and use its precise amount and wording. This illustrates the mechanism; it does not guarantee that the agent will detect every missing detail.

## 3 How the layers control history size

| Layer | Contents | Purpose |
|---|---|---|
| Original archive | Messages, extracted attachment text, and actual tool receipts | Exact quotations, verification, and context reconstruction |
| Recent originals | Recent complete interactions and interactions still in progress | Understanding follow-ups such as “Yes” or “the second one” |
| Segment summaries | Earlier goals, constraints, changes, and open questions | Carrying forward the state of prior work |
| Parent summaries | A broader history covered by several summaries | Reducing input when segment summaries themselves become too large |

The following example shows how context is assembled. Parent P already summarizes A and B. The current input includes P, the later segment C, and recent records that have not yet been compressed.

![Summary roots selected for the current context](/images/anpai-agent-compaction/02-layers-en.png)

Parent and child nodes remain in storage, but the model does not receive P together with the A and B it already covers. Multiple roots can remain active; the system does not have to compress the entire conversation into a single summary before answering.

A summary node stores its `body`, original-source manifest `source_manifest`, and `child_ids`. Parent summaries inherit references to the original evidence. A merge takes effect only when it actually reduces the complete input size.

A checkpoint records the active `root_ids`, coverage `cutoff`, and original-content revision. Context assembly loads the active roots and adds history beyond the cutoff. New history can be compacted incrementally while completed work remains reusable.

## 4 Generating, storing, and reusing summaries

Core's capacity policy triggers compaction. It estimates history size when records are appended or a conversation is reopened; the context manager can also request background work when the assembled input approaches capacity. The agent does not have to decide whether to compact. A background task makes a separate model call to generate summary text. Server code selects complete interactions, validates sources, stores nodes, and publishes checkpoints.

![Summary generation, persistence, and reuse on the next turn](/images/anpai-agent-compaction/03-compaction-en.png)

“Compaction worker” groups `ConversationCompactionJobs` and `ConversationCompactionService`. These are Core modules executed through queue events, so the user does not need to keep the page open. The background context manager assembles summary inputs, the model generates text, and `ConversationSummaryStore` saves nodes and commits checkpoints. The request entry in this diagram stands for the foreground request path; the agent still drives the actual model calls.

Before a checkpoint is committed, the server checks the original-content revision, task lease, node readiness, and expected checkpoint version. This prevents a slower, outdated task from overwriting newer progress. Foreground requests read published checkpoints.

Background work still has call budgets, timeouts, and retry limits. If input exceeds the hard limit, the foreground request may wait for a bounded period. If the input still cannot fit, the request fails explicitly and the original records remain intact.

## 5 Keeping retrieval traceable

Summaries provide an overview; original records provide precision. The agent can use `search_conversation` to locate earlier records and `read_conversation` to read a versioned reference. A known reference can be read directly, and long records can be paginated.

Current conversation search supports literal matching, speaker filters, and chronological browsing. No match means that the particular query found nothing. This retrieval path is independent of the public web-search toggle.

We also retain source attribution and verification status. User statements, assistant replies, and tool receipts remain distinguishable. Summary statements carry `unverified_summary` status. For example, “the assistant said it found no record” must not become “the absence of a record has been verified” through compaction.

A valid reference establishes provenance, not the accuracy of the summary's interpretation. Conflicts, exact quotations, and important execution states may still require reading the original. The server checks permissions, versions, and pagination; the agent decides whether to retrieve and how to interpret the result.

## 6 Conversation compaction and long-term memory

| Dimension | Conversation compaction | Long-term memory |
|---|---|---|
| Scope | The current conversation | Information associated with the user across conversations |
| Contents | Goals, constraints, changes, and progress | Explicitly saved events, experiences, preferences, and relationships |
| Entry into reasoning | Checkpoint-based assembly of summaries and recent originals | On-demand queries through memory tools |
| Storage | Originals, summary nodes, and checkpoints | `memory_items` and `memory_sources` |
| Updates | Generate and merge summaries as history grows | Separate save, correction, and deletion operations |

The ordinary agent path accesses `MemoryService` through `search_memory`, `remember_memory`, `correct_memory`, and `forget_memory`. Queries are scoped to the user and search active confirmed entries using keyword matching and filters such as time ranges. Corrections retain replacement relationships; deletion is soft deletion. “Confirmed” describes the entry's saved status, not external verification of the claim.

“Keep this article short” constrains the current task. “Keep my technical articles concise from now on” expresses a preference across tasks. Both must be understood in the current conversation, but long-term persistence requires a separate operation. Summary depth describes compression and coverage; summary nodes do not automatically become long-term memory entries.

## 7 Current limits

This design is still being refined in isolated staging. Validation starts with complete context delivery in short conversations, then checks continuity and original retrieval after compaction, and finally evaluates whether background execution reduces waiting. Existing summary reuse and original-record retrieval have been exercised through real request paths. Large tool results can still crowd out subsequent reasoning, however; retrieving the correct original does not by itself guarantee a completed answer.
