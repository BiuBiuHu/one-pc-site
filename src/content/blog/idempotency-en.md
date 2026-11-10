---
title: "Idempotency: Same Operation Once or N Times Must Yield the Same Result"
date: 2026-11-02
excerpt: "In distributed systems retries are the default; without idempotency every retry is a new write. Idempotency turns retry-safety into a built-in capability."
category: Engineering
lang: en
series: Full-Stack Engineering
seriesOrder: 8
---

> In one line: in a distributed system, **retries are normal** (timeout retry, MQ at-least-once, a user mashing the button). **Without idempotency, every retry is a new write** — idempotency is what makes "retry-safe" the default.
>
> **Series**: Transactions → Locks → Idempotency → DDD → Query performance. [Database transactions](/en/blog/db-transaction) · [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock) · This post · [Domain-driven design (DDD)](/en/blog/domain-driven-design) · [Database query performance](/en/blog/db-query-performance).

---

## 1. What idempotency is

**Definition**: one business request, executed once or executed N times, has the same effect on system state.
In math: `f(f(x)) = f(x)`.

**Why you need it** — these scenes all force you into it:

| Scene | Where it comes from |
|---|---|
| Timeout retry | The network jittered; you cannot tell success from failure, so you retry |
| User double-submit | Front-end mash-clicks, weak-network resend |
| Duplicate message delivery | MQ is **at-least-once**; duplicates will happen |
| Scheduled job double-fire | Multiple instances, compensation re-runs |

### Naturally idempotent vs naturally not

| Operation | Idempotent? |
|---|---|
| `SELECT` (read) | ✅ |
| `UPDATE .. SET x = 5` (overwrite / absolute value) | ✅ |
| `DELETE WHERE id = ?` | ✅ (deleting many times ends the same) |
| `UPDATE .. SET x = x + 1` (incremental write) | ❌ |
| `INSERT` with no unique key | ❌ |
| Transfer "deduct 100" | ❌ |

> Prefer **rewriting the operation** so it is naturally idempotent (turn `+1` into "overwrite / append-and-dedupe on a unique dimension"). Add an idempotency mechanism only after that.

---

## 2. Core implementation: idempotency key + idempotency table

### 2.1 Who generates the idempotency key

| Who generates it | When | Notes |
|---|---|---|
| **Client (recommended)** | Before the call | Retries of the same "business intent" carry the same key (e.g. a UUID); only then can a failed retry be deduped |
| Server | On arrival | Easier to stop abuse, but the "persist first, then retry" flow is more complex |

Bind the key to a **business intent**: not one key per "HTTP request", but one key per "this order / this transfer".

### 2.2 Idempotency table shape and the handling flow

```sql
CREATE TABLE idempotent (
  idempotent_key VARCHAR(64) PRIMARY KEY,   -- the unique index is the concurrency backstop
  request_hash   CHAR(64),                  -- same key, different request
  response       TEXT,                      -- cache the first response
  status         TINYINT,                   -- in progress / done
  version        BIGINT,
  created_at     DATETIME
);
```

```
Request arrives (key)
  ├─ Exists & same request_hash → return the cached response (replay-safe)
  ├─ Exists & different request_hash → 409 reject (same key, tampered replay)
  └─ Missing → INSERT to claim it (unique index) → run the business → write response
        ↑ insert conflict = another request is in flight / already done → look it up and return
```

> **The unique index is the last gate**: even if the code check misses a concurrency window, a DB-layer `Duplicate entry` stops the second insert — no "check then insert" can replace that.

---

## 3. A checklist of common idempotency moves

| Move | How it works | Fits |
|---|---|---|
| **Unique index / unique constraint** | The DB refuses a duplicate insert | Every "create" operation |
| **Idempotency table (above)** | key + response cache | General writes |
| **Anti-replay token** | Mint a token on page enter; consume it with `SETNX` on submit; used once, then dead | Form double-submit |
| **Optimistic lock version / CAS** | `WHERE version=?` update, retry on conflict | Concurrent updates (see [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock)) |
| **State machine** | A terminal state (SUCCEEDED) refuses a repeat; only intermediate states can re-enter | Task / order flow |
| **Overwrite / absolute value** | Write the "final value", not an increment | Writes you can reshape |
| **Distributed lock** | Only one runner at a time | Stops concurrency; **does not replace idempotency** (locks expire) |

---

## 4. Idempotency vs locks vs transactions (how the three relate)

| | What it solves | What happens when it fails |
|---|---|---|
| **Lock** (pessimistic / distributed) | Stops "**simultaneous** writes" (mutual exclusion) | Lock timeout / loss → may run twice |
| **Transaction** | Guarantees "a group of writes all happen or none do" | Cannot cover cross-database / external side effects (see [Database transactions](/en/blog/db-transaction)) |
| **Idempotency** | Stops "**duplicate** writes" (retry-safe) | It **is** the last backstop; it does not depend on the others |

In one line: **locks stop concurrency, transactions stop half-commits, idempotency stops retries. You need all three layers; idempotency is the floor.**

---

## 5. In Agent scenes

| Scene | Where idempotency lands |
|---|---|
| Tool calls auto-retry | The tool itself must be idempotent: a retry = try another way, **never deduct twice / never notify twice** |
| MQ at-least-once | Consumer dedupes with an idempotency table on `messageId` (or a business order number) |
| Scheduled jobs on many instances | Idempotent executor + a distributed lock (if the lock dies, idempotency is the backstop) |
| Checkpoint | State machine: a `completed` step refuses re-entry; resume idempotently from `nextStepIndex` |
| Reconciliation | The "long-funds, create the missing order" path must itself be idempotent, or error-handling becomes a new error |

---

## 6. Worked case: cash-loan withdrawal double-disbursement (how idempotency saves you)

> Same **business** as the withdrawal case in [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock), two different failures:
> "two at the same time" → locks stop it; "a late duplicate" → only idempotency can stop it.

### 6.1 The scene, and the mess without idempotency

The user withdraws 4000. The request times out on the network. The front end **auto-retries** and sends the same request again.

| Time | Request 1 (withdraw 4000) | Request 2 (timeout retry, same business intent) |
|---|---|---|
| t1 | Deduct 4000, create a disbursement order, disburse successfully | |
| t2 | The response is lost on the wire | |
| t3 | | Deduct 4000 again, disburse again |
| Result | | The ledger should have paid 4000, the user received 8000 = **double disbursement (money out twice)** |

> This is not "two writers at the same time". It is "the **same operation executed twice by two requests separated in time**".

### 6.2 Why a lock cannot stop it, and only idempotency can

```
Locks stop: two requests [running at the same time] (mutual exclusion)
Idempotency stops: request 1 already finished; request 2 is a [late] retry
         → nobody is writing now, so every lock lets it through → the same thing is done twice
```

A late retry is invisible to locks. Only idempotency ("have I already done this business?") can recognize it.

### 6.3 How idempotency saves you: idempotency table + unique index

| Request | What the backend does |
|---|---|
| Request 1 | Lookup idempotency table: miss → **unique-index claim insert** → disburse → write the result back |
| Request 2 (retry) | Lookup idempotency table: **key exists + same hash** → **return the previous result**, do not run again |

```sql
CREATE TABLE idempotent (
  idempotent_key VARCHAR(64) PRIMARY KEY,  -- unique index: last backstop for the concurrency window
  request_hash   CHAR(64),                 -- same key, tampered request
  response       TEXT,                     -- cache the first success
  status         TINYINT,                  -- in progress / success / failure
  created_at     DATETIME
);
```

```java
@Transactional
public WithdrawResult withdraw(String requestId, BigDecimal amount) {
    // 1) Claim idempotency: requestId is the unique index; a true duplicate throws Duplicate
    boolean first = idempotentMapper.tryInsert(requestId, hash(amount));
    if (!first) {
        //    This order (or its retry) was already handled → return the cached result, never deduct again
        return idempotentMapper.getCachedResponse(requestId);
    }
    try {
        WithdrawResult r = withdrawService.process(amount);  // the real disburse / deduct
        idempotentMapper.markDone(requestId, r);
        return r;
    } catch (Exception e) {
        idempotentMapper.markFailed(requestId);   // mark failed so a retry can re-enter
        throw e;
    }
}
```

### 6.4 It stacks with locks; it is not either / or

- Two requests **arrive at the same time** → the unique index `Duplicate` stops the second (the unique constraint = "the database as a lock").
- A retry **arrives late** → `tryInsert` sees "already handled" and returns the cached result.
- The ideal pair: **pessimistic / optimistic locks stop "at the same time" + an idempotency table stops "late"** — not even once extra.

### 6.5 Cash-loan idempotency landing checklist

| Scene | Idempotency key | What it stops |
|---|---|---|
| Withdraw / disburse request retry | `requestId = withdrawal number` | Double disbursement |
| Repayment deduct call | `repayNo` | Double deduct |
| MQ disburse / repay callback (at-least-once) | Consumer uses `messageId` | Broker redelivery |
| Credit application | `applicationNo` | Duplicate application |

> Money-flow rule: on any async path that "moves money / pays money", delivery is **at-least-once** (at least once, maybe many times) — **the consumer must default to idempotent**. That is the floor, not an option.

---

## 7. Interview crib

- Start with the definition: `f(f(x)) = f(x)`; retry-safe = idempotent.
- Five moves in a row: **unique index → idempotency table (key + hash + response cache) → state machine → optimistic-lock CAS → naturally idempotent writes**.
- Generate the idempotency key from "business intent"; same key + different hash on the server returns 409.
- The unique index is the last backstop for the concurrency window; "check then insert" cannot stop a race.
- Idempotency vs locks: locks stop simultaneous work, idempotency stops repeats; **a lock is an optimization, idempotency is the floor**.

---

## 8. ChangeLog

| Version | Date | Change |
|---|---|---|
| V1 | 2026-10-29 | First draft |
| V1.1 | 2026-11-01 | Added "6. Worked case: cash-loan withdrawal double-disbursement", paired with the locks-post withdrawal case as "same scene, two failures" |
