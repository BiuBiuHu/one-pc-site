---
title: "Optimistic vs Pessimistic Locks: Two Worldviews for Concurrent Writes"
date: 2026-11-01
excerpt: "Optimistic and pessimistic locks are opposite bets on concurrent write conflicts: validate at update when clashes are rare, or take exclusive ownership first when they are frequent."
category: Engineering
lang: en
---

> In one line: optimistic and pessimistic locks are **two opposite bets on "concurrent write conflicts"** — one assumes clashes are rare and checks only at update time; the other assumes a clash is coming and takes exclusive ownership before it works.
>
> **Series**: Transactions → Locks → Idempotency → DDD → Query performance. [Database transactions](/en/blog/db-transaction) · This post · [Idempotency](/en/blog/idempotency) · [Domain-driven design (DDD)](/en/blog/domain-driven-design) · [Database query performance](/en/blog/db-query-performance)
> **Division of labor with transactions**: Locks are one way to implement a transaction's "isolation" (locks + MVCC). This post stays on **locks** (pessimistic / optimistic, DB locks / distributed locks / in-memory CAS, selection, and the cash-loan case). For **ACID / isolation levels / MVCC / distributed transactions**, see [Database transactions](/en/blog/db-transaction).
> **Learning order**: Read the transactions post first to understand "why you need a transaction", then come back here for "which lock to use on a write conflict, and how to choose"; or interleave as needed.

---

## 1. Build the intuition first

Two programmers both need to change the balance on order `id=1`:

- **Pessimistic lock**: You're both going to write? **Lock it first**. Don't touch it while I write; you can touch it after I release.
- **Optimistic lock**: Write away. Whoever submits last and finds a **version mismatch** fails and starts over.

| | Pessimistic lock | Optimistic lock |
|---|---|---|
| Assumption | Write conflicts are **frequent**, so take exclusive ownership early | Write conflicts are **rare**, so let them through and validate at commit |
| When the lock is taken | **Before** the work | At **commit / update** |
| Keywords | lock / exclusive | version / CAS (Compare-And-Swap) |

---

## 2. Pessimistic lock

Core: **take the lock, then do the work, stay exclusive the whole time, then release.** Lock granularity decides how much concurrency you get.

### 2.1 Database layer: `SELECT ... FOR UPDATE`

```sql
BEGIN;
-- Lock the row you will change first (exclusive lock). Other transactions' reads and writes block until this one commits
SELECT * FROM account WHERE id = 1 FOR UPDATE;
UPDATE account SET balance = balance - 100 WHERE id = 1;
COMMIT;   -- the lock is released only after commit
```

- **FOR UPDATE** = exclusive lock (write lock); **FOR SHARE** = shared lock (read lock; concurrent reads are fine).
- The lock is **released on commit / rollback**, so a pessimistic lock must sit inside a transaction, and **lock hold time = transaction length**.
- Risk: **hold the lock too long → block a flood of concurrency → deadlock** (two transactions each waiting for the other to release).

### 2.2 Application layer: single-process locks vs distributed locks

| Scene | Implementation |
|---|---|
| Single process, single thread | `synchronized` / `ReentrantLock` |
| Single machine, many instances | An in-process lock is useless. You need a **distributed lock**: Redis `SETNX`, a ZooKeeper ephemeral node, or a unique-index row lock in the database |

**The usual cost of a pessimistic lock**: lower concurrency, deadlock risk, and everyone else blocks while you hold it — it fits **write-heavy, high-conflict hotspots**.

---

## 3. Optimistic lock

Core: **do not lock the row. At update time, CAS-check `version`. A mismatch means someone else wrote first — fail and retry.**

### 3.1 Typical implementation: a `version` column

```sql
-- Read: fetch the current version first
SELECT balance, version FROM account WHERE id = 1;   -- version = 3

-- Write: put version in the predicate and increment it; affectedRows = 0 means someone else already changed version
UPDATE account
   SET balance  = balance - 100,
       version  = version + 1
 WHERE id = 1 AND version = 3;
-- if affectedRows == 0 → conflict; retry (re-read, then try again)
```

### 3.2 Other CAS shapes

- **Database**: the atomic `WHERE version = old` update above.
- **Memory / application**: Java `AtomicInteger.compareAndSet`, atomic ops in Node / C.
- **Redis**: `WATCH` + `EXEC` (optimistic-lock semantics).
- **Timestamp / compare the whole row before and after**: also works, but **timestamps are coarse and can ABA**. Prefer a monotonically increasing `version`.

### 3.3 Gains and costs of an optimistic lock

- **Gains**: no lock, reads do not block, high throughput, no deadlock.
- **Costs**: a conflict becomes a **lost update (an empty write)** and needs a **retry**; lots of conflicts turn into a retry storm and write efficiency collapses.
- Fits **read-heavy, low-conflict** work.

> **The ABA problem**: if you only compare "the value did not change" instead of "the version increased", `A→B→A` looks as if nothing happened. A `version` that **increments by 1 every time** (monotone) avoids this naturally.

---

## 4. One comparison table + a selection rule

| Dimension | Pessimistic lock | Optimistic lock |
|---|---|---|
| Conflict frequency it fits | High | Low |
| Read / write shape | Write-heavy | Read-heavy, few writes |
| Concurrent throughput | Low | High |
| Deadlock risk | Yes | No |
| How a conflict is handled | Block and wait | Fail and retry |
| Implementation cost | Higher (locks / distributed locks) | Low (one `version` column + retry) |
| Lock granularity | Table / row / record; coarse or fine | Smallest (only at update time) |

**Selection slogan**:

- **Write-heavy, high conflict, needs strong consistency** → pessimistic lock (for example inventory deduction — the classic oversell hotspot).
- **Read-heavy, low conflict, needs high throughput** → optimistic lock (profile copy, like-counts).
- The more general move: **optimistic by default + retry on conflict, then add a pessimistic backstop on hotspots**.

---

## 5. Details and pitfalls

1. **Keep pessimistic-lock transactions short**: lock hold time = transaction time. Do not do external I/O inside the transaction, or the lock sits too long.
2. **Optimistic locks need idempotency + retry**: a retry must not deduct twice. Deduplicate before you retry.
3. **Distributed environments**: optimistic CAS depends on a single-row atomic UPDATE (inside one DB). You cannot do atomic CAS across databases / tables — you need a distributed lock or a transaction.
4. **Lock granularity**: prefer **row** locks over table locks. Smaller grain, more concurrency.
5. **ABA**: optimistic locks must use a **monotonically increasing `version`**. Do not compare timestamps alone.

---

## 6. In Agent scenes

| Scene | Which to use |
|---|---|
| Several Agents change the same Checkpoint state at once | Optimistic lock: `WHERE stepIndex = ? AND version = ?`, so a step is not overwritten |
| Shared Redis state written by many Workers | Optimistic lock: `WATCH` + `EXEC`; if conflict is high, add a SETNX distributed lock |
| Scheduled jobs on many instances, no double-run | Pessimistic lock: Redis `SETNX` — whoever gets the lock runs |
| Inventory / balance hotspots — oversell is fatal | Pessimistic `FOR UPDATE` for strong consistency, or optimistic + strict retry |
| Reliability of Agent writes | Optimistic version+CAS against concurrent writes, plus a state machine that **rejects repeats in a terminal state** |

> One line for Agent scenes: **prefer a row-level optimistic lock when you can; use a distributed pessimistic lock when you need hotspot / cross-instance strong consistency.**

---

## 7. Worked case: cash-loan withdrawal (pessimistic vs optimistic)

> In finance, "withdraw / deduct" is the classic **read-modify-write race**. It shows the real difference between the two locks most clearly.

### 7.1 Setup and the hazard

- The user's **available balance is 5000**, and they start **two withdrawals at the same time** on two devices, 4000 each.
- Rule: before withdrawing, check `balance >= amount`, otherwise reject (prevent **overdraft / over-withdraw**).
- Hazard: both "read 5000 first and both think 4000 is fine" → with no protection you **overdraw** — 8000 leaves a 5000 account = a funds incident.

### 7.2 Pessimistic version: lock the row, then check (`FOR UPDATE`)

```sql
BEGIN;
SELECT balance FROM account WHERE id = u1 FOR UPDATE;   -- ① lock that balance row immediately
-- Business check: 5000 >= 4000?
UPDATE account SET balance = balance - 4000 WHERE id = u1;
COMMIT;                                                   -- lock released only on commit
```

| Time | Withdrawal A (4000) | Withdrawal B (4000) |
|---|---|---|
| t1 | `FOR UPDATE` → **gets the row lock** | |
| t2 | | `FOR UPDATE` → ⛔ **blocks and waits** (queued) |
| t3 | Check 5000≥4000 ✅; deduct to 1000 | ⛔ still blocked |
| t4 | `COMMIT` (releases the lock) | Unblocked → reads the latest `balance=1000` |
| t5 | | Check 1000≥4000 ❌ **reject "insufficient balance"** |

**Result**: only A succeeds. Total withdrawn is 4000, never over 5000 ✅. B is **blocked in a queue**. The lock is held from the check through COMMIT.

### 7.3 Optimistic version: no row lock; compare `version` at commit

```java
Account a = accountMapper.selectById(u1);   // ① snapshot read, get version (no lock)
int rows = accountMapper.deductWithVersion(u1, 4000, a.getVersion());
// UPDATE account SET balance = balance - 4000, version = version + 1
//  WHERE id = u1 AND version = #{oldVersion}
if (rows == 0) {                            // ② version mismatch = conflict
    return retryWithOptimisticLock(u1, 4000);   // retry
}
```

| Time | Withdrawal A (4000) | Withdrawal B (4000) |
|---|---|---|
| t1 | Read `balance=5000, version=1` | Read `balance=5000, version=1` |
| t2 | `UPDATE ... WHERE version=1` → ✅ 1 row | `UPDATE ... WHERE version=1` → ⛔ 0 rows (version is already 2) |
| t3 | commit | **Detect conflict → retry** |
| t4 | | Retry reads `balance=1000, version=2` → check 1000≥4000 ❌ **reject "insufficient balance"** |

**Result**: only A succeeds, same as above ✅. B **never blocks**; it just sees a version mismatch at commit → retry is the backstop.

### 7.4 Comparison and what a finance shop should pick

| | Pessimistic lock | Optimistic lock |
|---|---|---|
| What withdrawal B is doing right now | **Blocked in a queue** waiting for A to commit | Runs as usual; only discovers the conflict at commit |
| Lock hold time | Long (SELECT → COMMIT) | Tiny (just the UPDATE instant) |
| How a conflict is handled | By "waiting" | By "retrying" |

**Finance recommendation** (money columns, high conflict, must be strongly consistent):

- Prefer a **single atomic UPDATE** (simplest; the predicate itself stops over-withdraw):

```sql
UPDATE account SET balance = balance - 4000
 WHERE id = u1 AND balance >= 4000;   -- 0 rows = insufficient balance
```

- When you must "read it out, run a complex business check, then deduct", use **pessimistic `FOR UPDATE`**.
- **Leave optimistic locks for low-conflict fields** (profile / notes / state machines). Do not put a money hotspot on optimistic locks alone — frequent conflicts become a retry storm.

> **Two common misunderstandings (correct them)**:
> 1. A pessimistic lock is **not** "nobody else can read" — others can still snapshot-read the **old version**. They just cannot write, and cannot take the lock.
> 2. An optimistic lock is **not** "nobody else can write" — others can still read and write. The version check at commit flags the conflict, and the late writer fails and retries.

---

## 8. Interview crib

- Pessimistic = lock first, then work (exclusive, blocking, easy to deadlock); optimistic = validate at update (high concurrency, retry on conflict).
- The selection key is **conflict frequency + the read / write shape**. Write-heavy, high conflict → pessimistic; read-heavy, low conflict → optimistic.
- Do not skip **ABA**: optimistic locks dodge it with a monotonically increasing `version`.
- Across instances (distributed), do not try CAS inside the DB. Use a distributed lock (Redis SETNX / ZK).

---

## 9. ChangeLog

| Version | Date | Change |
|---|---|---|
| V1 | 2026-10-29 | First draft |
| V1.1 | 2026-11-01 | Added "7. Worked case: cash-loan withdrawal" (pessimistic vs optimistic, with a concurrency timeline + finance selection notes + two common-misunderstanding corrections) |
| V1.2 | 2026-11-01 | Cleared the split with the transactions post: added the banner note on "division of labor with transactions + learning order"; deduped, did not merge |
