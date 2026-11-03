---
title: "Database Transactions: A Consistency Guide for Frontend Engineers"
date: 2026-11-01
excerpt: "Use frontend-familiar analogies to unpack transaction ACID, isolation levels, MVCC, Spring transaction pitfalls, and the fallbacks you need once work leaves a single service."
category: Engineering
lang: en
---

> **Readers**: Frontend engineers (same learning path [This post] → Locks → Idempotency → DDD → [Query performance / sharding](/en/blog/db-query-performance))
> **Series**: Transactions → Locks → Idempotency → DDD → Query performance. This post · [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock) · [Idempotency](/en/blog/idempotency) · [Domain-driven design (DDD)](/en/blog/domain-driven-design) · [Database query performance](/en/blog/db-query-performance)
> **Companion**: For the two lock styles on concurrent writes, see [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock)
> **Division of labor with locks**: This post stays on **transactions** (ACID / isolation levels / MVCC / distributed transactions). Section 8 only lands the Java code. Lock **comparison / selection / cash-loan cases** all live in [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock) (including the correction that "pessimistic lock ≠ no reads, optimistic lock ≠ no writes"). Read chapters 1–7 here first to understand transactions, then the locks post for locks.
>
> **When you finish, you should be able to answer**:
> 1. What problem does a transaction actually solve? What does each letter of ACID mean, and what implements it?
> 2. How do you write a transaction in backend Java? (raw JDBC + Spring `@Transactional`)
> 3. Why do concurrent transactions produce dirty reads / non-repeatable reads / phantom reads? How do isolation levels stop them?
> 4. Why do backend teammates keep saying "the transaction didn't take"? What is propagation?
> 5. Why is there no transaction across databases / services? How do you fall back?

---

## 0. Before you start: a few frontend analogies

The biggest frontend hurdle with backend ideas is **the vocabulary**. Align the words first:

| Backend idea | Something a frontend already knows | One-line gloss |
|---|---|---|
| Transaction | "A batch of setState either all lands or all is thrown away" | Several SQL statements bundled into one atomic unit |
| Connection | A long-lived WebSocket | A "channel" between the program and the database. **A transaction must be bound to the same connection** |
| Connection pool | A reused pool of axios instances | Connections are expensive (TCP + auth), so you build a pile ahead of time and reuse them |
| SQL row | One record in a JSON list | One row of data in the database |
| undo log | git revert history | Records "what it looked like before", so you can undo |
| redo log | git commit log | Records "what I did", so you can replay after a crash |
| MVCC | `git checkout` an old version to read the code | Reads look at a "historical snapshot", so they are not polluted by someone else's in-progress write |
| Lock | Singleton mutex / `navigator.locks` | "I am changing this row; you wait" |

> The mindset: **the frontend world often gets by on "eventual consistency of events"; the backend world is real money, and a bad intermediate state is a funds loss** — so you need a transaction's "strong guarantee".

---

## 1. Why you need a transaction: start from a production incident

**Scene**: a user places an order. The backend must do two things:

```
① deduct inventory     stock: 10 → 9
② write the order      INSERT INTO order ...
```

Without a transaction, the process crashes after ① and before ② (or ② errors outright because a field is too long):

```
inventory: 9        (deducted, cannot take it back)
order:     none     (the user paid, but there is no order)
```

— user complaint, support roster, postmortem meeting: the classic three-piece set.

**A transaction is what you use against that**: bundle ① and ② so they **either both succeed (COMMIT) or both never happened (ROLLBACK)**.

The formal definition:

> **A transaction is a logical unit of a group of database operations. Operations inside that unit either all take effect or none do. An in-between "half done" state is not allowed.**

---

## 2. The minimum useful knowledge (SQL + Java JDBC)

### 2.0 Layer the concepts: the database does the work; the client sends commands

Clear up a layer that is easy to mix (come back to this after the chapter; it will land better):

> **All "implementation" of a transaction lives in the database; the JDBC / Spring in this chapter is just a "remote".** JDBC implements no transaction logic. It only translates the button you press into a database command.

```
┌──────────────────────────────────────────────┐
│  Client (Java program)                       │
│    Spring @Transactional (annotation, easiest)│
│         ↓ underneath still calls             │
│    JDBC (Java's "database remote" API)       │
│    setAutoCommit(false) / commit / rollback  │
└───────────────────┬──────────────────────────┘
                    │  DB protocol (≈ send BEGIN / COMMIT / ROLLBACK)
                    ▼
┌──────────────────────────────────────────────┐
│  Database (where the transaction is actually implemented) │
│    undo log / redo log / locks / MVCC (chapter 7)         │
└──────────────────────────────────────────────┘
```

- **Database**: defines and implements the transaction — every ACID guarantee is done here.
- **Client (JDBC)**: only three jobs — open a connection, translate the buttons (`setAutoCommit(false)` / `commit()` / `rollback()`) into protocol commands and send them, receive the result.

**Why talk about the client layer at all?** Because someone has to *start* the transaction — **the client draws the boundary** of "which SQL statements are one batch":

| Who draws the boundary | With what |
|---|---|
| You type SQL | `BEGIN ... COMMIT` |
| A Java program | JDBC: `setAutoCommit(false)` ... `commit()` |
| A Python program | DB-API: `conn.begin()` ... `commit()` |
| A Node program | mysql2: `beginTransaction()` |

Different roads, same destination — on the database side they are the same commands. **JDBC is to a transaction what a remote is to a TV: the TV changes the channel; the remote is only the path for the button.**

> A planted hint: why is a transaction "bound to a Connection"? Because the database draws transaction boundaries **per connection** — only SQL after `BEGIN` on that same connection is one batch. `Connection` is both the "channel" and the **carrier of the transaction**. Switch connections = switch transactions. That is the root of chapter 9, "no transaction across databases".

### 2.1 At the SQL layer: only three statements

```sql
BEGIN;                       -- start a transaction (from here, writes on this connection are "booked" and do not take effect yet)
UPDATE account SET balance = balance - 100 WHERE id = 1;
UPDATE account SET balance = balance + 100 WHERE id = 2;
COMMIT;                      -- commit: every write just now takes effect
-- if anything in the middle goes wrong:
ROLLBACK;                    -- roll back: every write just now is discarded
```

**Note**: MySQL defaults to "autocommit" — each SQL statement is its own transaction and takes effect as soon as it runs. To group a transaction by hand, `BEGIN` first (or turn off autoCommit in Java, below).

### 2.2 Raw Java: JDBC (required if you want the mechanism)

In real projects, 99% use Spring (section 3), but **Spring's magic is generating the block below for you**, so look at the raw form first:

```java
// try-with-resources: the connection goes back to the pool when you leave (think React useEffect cleanup)
try (Connection conn = dataSource.getConnection()) {

    conn.setAutoCommit(false);          // ★ turn off autocommit = start a transaction by hand
                                        //   ("do not apply the SQL below until I say so")

    // ① debit
    try (PreparedStatement ps1 = conn.prepareStatement(
            "UPDATE account SET balance = balance - ? WHERE id = ?")) {
        ps1.setBigDecimal(1, new BigDecimal("100"));
        ps1.setInt(2, 1);
        ps1.executeUpdate();            // note: not applied yet! only "booked"
    }

    // ② credit
    try (PreparedStatement ps2 = conn.prepareStatement(
            "UPDATE account SET balance = balance + ? WHERE id = ?")) {
        ps2.setBigDecimal(1, new BigDecimal("100"));
        ps2.setInt(2, 2);
        ps2.executeUpdate();            // also not applied yet
    }

    conn.commit();                      // ★ both succeeded → take effect in one shot

} catch (Exception e) {
    conn.rollback();                    // ★ any step throws → discard everything
    throw new RuntimeException("Transfer failed", e);
}
```

**Line-by-line points**:

1. `setAutoCommit(false)` — the transaction switch. After you open a transaction, every SQL on this connection is "held".
2. **The transaction is bound to the Connection** — every SQL in the same transaction must go out on **the same connection**. Analogy: two WebSockets you opened cannot share local variables.
3. Before `commit()`, other connections **by default cannot see** the data you changed (that is "isolation"; section 5 goes into it).
4. `rollback()` usually lives in the catch — one exception, everything is discarded.

### 2.3 An easy frontend miss: throwing an exception ≠ automatic rollback

JDBC is not that smart: **if an exception happens and you forget to call rollback, the transaction stays open**, holding the connection and the locks, until the pool is drained (a classic production incident). So a hand-written Java transaction must be tight try-catch-finally — that is exactly why Spring transactions exist.

---

## 3. Spring `@Transactional`: how real projects write it

### 3.1 Basic usage

```java
@Service
public class TransferService {

    @Autowired
    private AccountMapper accountMapper;   // data-access layer (think the frontend api layer)

    /**
     * One annotation = the whole JDBC template from the previous section
     * Enter the method: conn.setAutoCommit(false)
     * Return normally: conn.commit()
     * Throw: conn.rollback()
     */
    @Transactional(rollbackFor = Exception.class)
    public void transfer(Long fromId, Long toId, BigDecimal amount) {
        accountMapper.deduct(fromId, amount);   // debit
        int rows = accountMapper.add(toId, amount);  // credit
        if (rows == 0) {
            throw new BizException("Payee account does not exist");  // throw → automatic rollback
        }
    }
}
```

**Two high-frequency parameters**:

```java
@Transactional(
    rollbackFor = Exception.class,           // ① default rollback is only RuntimeException/Error;
                                             //    checked exceptions (e.g. IOException) do NOT roll back! declare it explicitly
    isolation = Isolation.READ_COMMITTED     // ② set the isolation level (section 6)
)
```

### 3.2 Five ways `@Transactional` silently fails (Java interview staple; you will also hit them reading other people's code)

The Spring transaction mechanism is an **AOP dynamic proxy**: Spring generates a "proxy object" for your class, and the transaction logic wraps the proxy. **Whenever you skip the proxy and call the real object, the transaction does not take**.

```java
@Service
public class OrderService {

    // ❌ Scene 1: self-invocation fails
    public void batchCreate() {
        for (...) {
            this.createOne(o);     // this is the real object, not the proxy → createOne's transaction is wasted
        }
    }

    @Transactional
    public void createOne(Order o) { ... }
}
```

| # | Failure scene | Why | Fix |
|---|---|---|---|
| 1 | **Same-class self-call** `this.createOne()` | You bypassed the proxy | Split into another class / inject your own proxy |
| 2 | The method is not `public` | The proxy only enhances public methods | Make it public |
| 3 | The exception is swallowed by `catch` | The proxy never sees an exception, thinks success | Log, then **rethrow** |
| 4 | You threw a checked exception (e.g. IOException) | Default rollback is only RuntimeException | `rollbackFor = Exception.class` |
| 5 | The table engine is MyISAM | The engine does not support transactions | Use InnoDB |

> Frontend analogy: an AOP proxy ≈ a React HOC. If you call `Component` directly instead of `withTransaction(Component)`, the wrapper logic is simply not there.

### 3.3 Propagation: what happens when a transaction wraps a transaction (for reading other people's code)

A transactional method calls another transactional method. What does the inner transaction do? That is **propagation**:

| Propagation | Meaning | Scene |
|---|---|---|
| `REQUIRED` (default) | Join the existing transaction; otherwise start a new one | Ordinary business methods |
| `REQUIRES_NEW` | **Suspend** the current transaction and start a brand-new one | Write an audit log: the main flow rolled back, the log must still stay |
| `NESTED` | A child transaction that can roll back to a savepoint on its own | Main flow failure rolls everything back; child failure rolls back only itself |
| `SUPPORTS` / `NOT_SUPPORTED` / `MANDATORY` / `NEVER` | Follow / suspend / require / forbid an outer transaction | Special cases |

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)  // whether the outer has a transaction or not, I start my own new one
public void writeAuditLog(String action) { ... }
```

> Remember default `REQUIRED` and the common `REQUIRES_NEW` and you can read 90% of business code.

---

## 4. ACID, letter by letter

The four letters are not four peer ideas. They are **one goal + three means**:

```
C (Consistency) ← the goal
   ↑ by
A (Atomicity) + I (Isolation) + D (Durability) ← three means
```

### 4.1 A — Atomicity ("all or nothing")

- **What**: the transfer example in section 1 — two SQL steps live or die together.
- **How it is implemented**: **undo log (rollback log)**. Before any data is changed, the "before" picture is written to the undo log; on ROLLBACK, walk the log backwards to restore.
- **Frontend analogy**: redux-devtools time-travel — record every action; undo is playing them in reverse.

### 4.2 C — Consistency ("the rules still hold")

- **What**: before and after the transaction, the data always satisfies **every constraint** — foreign keys, unique indexes, not-null, and business rules ("total money is unchanged after a transfer").
- **Note**: C is not a database-only guarantee. **Business rules have to be written correctly in your code.** If you only debit and never credit, the most standard transaction is still "inconsistent".
- **The most visible form in code**: an UPDATE violates a unique index → the whole transaction rolls back.

### 4.3 I — Isolation ("concurrency cannot see each other's in-between state")

- **What**: several transactions run at once; they must not see each other's **uncommitted** data.
- **Why it is hard**: full isolation = queue up and run one by one = a huge performance loss. So the database gives you **isolation levels** as a "knob" (sections 5 and 6), a tradeoff between correctness and performance.
- Implemented with **locks + MVCC (Multi-Version Concurrency Control)** (section 7).

### 4.4 D — Durability ("once committed, it is not lost")

- **What**: after `COMMIT` returns success, even if the data center loses power one second later, the data is still there.
- **How it is implemented**: **redo log + WAL (Write-Ahead Logging)** — write the log sequentially first (fast), flush data pages later (slow). After a crash, replay the log to redo modifications that never reached disk.
- **Frontend analogy**: append an operation log to localStorage first, then change the page; on refresh, replay the log to restore state.

---

## 5. The concurrency trio: dirty read, non-repeatable read, phantom read

A single transaction is fine. **Several transactions running at once** is when things break. All three problems use the timeline table below (T1 and T2 are two concurrent transactions).

### 5.1 Dirty read — you read data someone else has **not committed**

| Time | Transaction T1 (transfer) | Transaction T2 (reconciliation report) |
|---|---|---|
| t1 | `UPDATE` account A -100 (**uncommitted**, books temporarily 900) | |
| t2 | | `SELECT` account A → reads **900** ← **dirty read** |
| t3 | Business error, `ROLLBACK`, account A is back to 1000 | |
| t4 | | Report is built from 900 → **the report is wrong** |

**Tell**: what you read is data that "might be rolled back later". **Most harmful; any serious system must prevent it**.

### 5.2 Non-repeatable read — the same row, two reads, two values

| Time | Transaction T1 | Transaction T2 |
|---|---|---|
| t1 | `SELECT` account A balance → **1000** | |
| t3 | | `UPDATE` A -500, **COMMIT** |
| t4 | `SELECT` A again → **500** ← the value changed inside the same transaction | |

**Tell**: the value of **the same row** was changed by another transaction. It hurts logic that "must be consistent across several reads in one transaction" (read the balance, then validate, then deduct).

### 5.3 Phantom read — the row count changed, as if you saw a ghost

| Time | Transaction T1 | Transaction T2 |
|---|---|---|
| t1 | `SELECT COUNT(*) WHERE amount>100` → **2 rows** | |
| t3 | | `INSERT` a 200 order, **COMMIT** |
| t4 | The same COUNT → **3 rows** ← one extra "phantom" row | |

**Tell**: the **number of rows in the result set** changed (insert / delete).

### 5.4 The trio compared (a classic interview question)

| | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| What changed | You read **uncommitted** data | **The value of the same row** | **The row count of the result set** |
| What the other party did | UPDATE then rollback | UPDATE already committed | INSERT / DELETE already committed |
| Lowest isolation that stops it | READ COMMITTED | REPEATABLE READ | SERIALIZABLE (MySQL RR can mostly stop it with gap locks) |

---

## 6. Isolation levels: which knob to turn

### 6.1 The four-level table

| Isolation level | Dirty read | Non-repeatable read | Phantom read | Performance | Notes |
|---|---|---|---|---|---|
| READ UNCOMMITTED | ❌ yes | ❌ yes | ❌ yes | Fastest | Almost nobody uses it |
| READ COMMITTED | ✅ stops | ❌ yes | ❌ yes | Fast | **Oracle / PostgreSQL default** |
| REPEATABLE READ | ✅ stops | ✅ stops | mostly stops* | Medium | **MySQL InnoDB default** |
| SERIALIZABLE | ✅ stops | ✅ stops | ✅ stops | Slowest | Queued execution |

> *MySQL RR uses an MVCC snapshot + Next-Key Lock (record lock + gap lock) to mostly stop phantom reads as well — a MySQL bonus. In short, a gap lock also locks the "query range", so another transaction cannot insert a new row into it.

### 6.2 How to set it in Java

```sql
-- session level (the whole connection)
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

```java
// Spring: set it on the annotation
@Transactional(isolation = Isolation.REPEATABLE_READ)
public Order queryOrder(Long id) { ... }
```

### 6.3 Selection intuition

- **Read committed (RC)**: "I only look at data other people have already committed" — a common internet-company choice; good concurrency.
- **Repeatable read (RR)**: "several reads inside this transaction must agree" — MySQL default; fits "read, then compute, then write".
- **Serializable**: basically only finance-grade strong-consistency scenes; the performance cost is large.

---

## 7. Under the hood: undo log / redo log / locks / MVCC

This section is "why"-level knowledge. A frontend can read it once for intuition. A backend interview needs recitation-level command.

### 7.1 undo log — how atomicity is implemented + the raw material for MVCC

```
UPDATE account SET balance = 900 WHERE id=1;   (was 1000)

undo log records: "row id=1, balance was 1000 before the change"
→ on ROLLBACK: walk the record and change 900 back to 1000
```

It is also MVCC's "warehouse of historical versions" (see 7.4).

### 7.2 redo log + WAL — how durability is implemented

**Problem**: really flushing data to disk (random writes of "data pages") is slow. If every commit waits for the data page to land, performance dies.

**Approach (WAL, write-ahead logging)**:

```
On commit:
  1. Append "what changed" sequentially to the redo log (sequential write, fast)   ← COMMIT returns success at this step
  2. Data pages are flushed later by a background thread (async)

On crash recovery:
  Replay the redo log → fill in modifications that never reached disk → data is not lost
```

- **Frontend analogy**: append "the modification" to a log file first (fast); the real DOM update can wait; on refresh, replay the log.

### 7.3 Locks — mutual exclusion on write conflicts

| Lock | Meaning | Analogy |
|---|---|---|
| Shared lock S (`SELECT ... FOR SHARE`) | Everyone can **read** together | Reading a doc together |
| Exclusive lock X (`SELECT ... FOR UPDATE` / UPDATE comes with one) | **I am writing; other reads and writes wait** | You are editing the doc; others are read-only locked |
| Gap lock (under RR) | Locks a **range** so a new row cannot be inserted (stops phantom reads) | A reserved block of seats |

For detailed usage (ForUpdate row locks, a deadlock demo) see the section 8 code and [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock).

### 7.4 MVCC (Multi-Version Concurrency Control) — the secret of "reads do not eat writes, writes do not eat reads"

> **Full name**: MVCC = **Multi-Version Concurrency Control**.
> **In one line**: keep **several historical versions** of the same row. A transaction reads the "snapshot of the matching old version", so **reads do not block writes, and writes do not block reads**.

**The pain**: if a "read" also has to wait for a "write" to drop its lock, a read-heavy system has every lock eaten by reads.

**The idea**: keep **several versions** of the data. Each transaction reads the version it is supposed to see (a snapshot), not someone else's in-between state.

```
Version chain of the balance row (newest → oldest):

  balance=900   trx_id=104 (transaction 104 is changing it, uncommitted)
      ↑ roll_pointer
  balance=1000  trx_id=101 (committed)
      ↑
  balance=1200 trx_id=98  (committed, earlier)
```

When a transaction reads, it builds a **ReadView**. Simplified:

> "Remember **which transactions are still alive** right now, then walk the version chain to the **first version whose commit timing is legal in my view**, and read that."

Effect:

- Transaction A is changing (uncommitted) → transaction B can still read. **B reads an old-version snapshot**, so no dirty read.
- Under RR, B uses **the same ReadView** for the whole transaction → several reads agree (repeatable read).
- Under RC, B builds a **new ReadView** on every query → it can see values others just committed (non-repeatable read — a property of RC, not a bug).

> **The essential difference between RR and RC is whether ReadView is "one per transaction" or "one per query".**

### 7.5 Snapshot read vs current read (practical; you will hit this in code)

| | Statement | What it reads |
|---|---|---|
| **Snapshot read** | Ordinary `SELECT` | A historical MVCC version, **no lock** |
| **Current read** | `SELECT ... FOR UPDATE/FOR SHARE`, `UPDATE`, `DELETE` | The **latest** value, and **it takes a lock** |

Why is UPDATE always a current read? — a modification must be based on the latest value. Read a historical version and then write, and you overwrite someone else's change.

---

## 8. In practice: concurrent-safe deducts in Java

For lock **comparison / selection / cash-loan cases**, see [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock). Here you only get the Java landing code **in a transaction context**; the lock tradeoffs are not repeated.

### 8.1 Pessimistic lock: lock the row, then change it (hotspots, strong consistency)

```java
@Transactional(rollbackFor = Exception.class)
public void deductWithPessimisticLock(Long accountId, BigDecimal amount) {
    // FOR UPDATE = current read + exclusive row lock
    // other transactions' FOR UPDATE will block on this row until this transaction commits
    Account account = accountMapper.selectForUpdate(accountId);

    if (account.getBalance().compareTo(amount) < 0) {
        throw new BizException("Insufficient balance");   // rollback + release the lock
    }
    accountMapper.deduct(accountId, amount);
}
```

```xml
<!-- SQL in the mapper -->
<select id="selectForUpdate" resultType="Account">
  SELECT * FROM account WHERE id = #{id} FOR UPDATE
</select>
```

### 8.2 Optimistic lock: no row lock; check the version at update (read-heavy, few writes)

```java
@Transactional(rollbackFor = Exception.class)
public void deductWithOptimisticLock(Long accountId, BigDecimal amount) {
    Account account = accountMapper.findById(accountId);     // ordinary SELECT, get version

    int affected = accountMapper.deductWithVersion(
            accountId, amount, account.getVersion());
    // SQL: UPDATE account
    //      SET balance = balance - #{amount}, version = version + 1
    //      WHERE id = #{id} AND version = #{version}

    if (affected == 0) {
        // version mismatch = someone changed it in the gap of your session
        throw new ConcurrencyException("Concurrent conflict, please refresh and retry");
    }
}
```

> Production often wraps this in "retry N times": on conflict, re-read and retry, and pair it with **idempotency** so the retry has no extra side effect.

### 8.3 Deadlock: two locks waiting on each other (for reading error logs)

```java
// Transaction A: lock id=1 first, then id=2
@Transactional
public void transferA() {
    updateAccount(1);          // takes the lock on id=1
    Thread.sleep(100);
    updateAccount(2);          // waits for the lock on id=2 (held by B)
}

// Transaction B: lock id=2 first, then id=1   ← opposite order!
@Transactional
public void transferB() {
    updateAccount(2);          // takes the lock on id=2
    Thread.sleep(100);
    updateAccount(1);          // waits for the lock on id=1 (held by A) → mutual wait = deadlock
}
```

InnoDB has deadlock detection and will sacrifice one transaction (`Deadlock found`), but **the root cause is "inconsistent lock order"** — unify the whole project on "lock by ascending id" and you have a real fix.

---

## 9. Distributed transactions: why they disappear across databases / services

### 9.1 The root of the problem

**A single-database transaction = a group of operations on one Connection**. Split into two services (order service + inventory service) and you have **two database connections**:

```
Service A's connection: UPDATE order DB ...   ← can roll back
Service B's connection: UPDATE inventory DB ...   ← A cannot touch B's connection at all!
```

**There is no "global conn.rollback()"** — that is the problem distributed transactions exist to solve.

### 9.2 Comparing the approaches

| Approach | One line | Consistency | Cost |
|---|---|---|---|
| **2PC (two-phase commit)** | A coordinator first asks everyone "can you commit?" → commits only if all say yes | Strong | Blocking, coordinator is a single point |
| **TCC** | Split the business into Try (reserve) / Confirm / Cancel | Fairly strong | Every operation becomes 3 methods; high intrusion |
| **SAGA** | Each step has a **compensating** action; on failure, compensate in reverse | Eventual | Compensation logic is complex |
| **Local message table + MQ** (most common) | Business and the "message to send" land in **the same local transaction**, then deliver async | Eventual | There is a delay window; you need reconciliation as a backstop |

### 9.3 Local message table in Java (memorize this shape)

```java
@Service
public class OrderService {

    /**
     * Core: business data + the message table land in [the same local transaction]
     * Guarantees "both exist, or neither does"
     */
    @Transactional(rollbackFor = Exception.class)
    public void createOrder(Order order) {
        orderMapper.insert(order);                              // business data
        outboxMapper.insert(new OutboxMessage(
                "OrderCreated", JSON.toJSONString(order), "PENDING"));
    }   // commit together — you never get "the order exists but the message was not recorded"
}

/**
 * A background job polls the outbox and delivers PENDING messages to the MQ
 */
@Scheduled(fixedDelay = 500)
public void publishOutbox() {
    List<OutboxMessage> pending = outboxMapper.selectPending(100);
    for (OutboxMessage msg : pending) {
        try {
            mqProducer.send(msg.getTopic(), msg.getPayload());
            outboxMapper.markSent(msg.getId());   // mark sent only after delivery succeeds
        } catch (Exception e) {
            // stay PENDING on failure; next round retries → the consumer must be idempotent!
        }
    }
}
```

**The closed loop = local message table (do not lose it) + idempotent consume (do not duplicate) + reconciliation (the final backstop)**.

---

## 10. Best-practice checklist (the kind you stick on the desk)

1. **Keep transactions short**: lock hold time = transaction time; a long transaction = blocking others + undo bloat + a held connection.
2. **Never call an external API inside a transaction** (HTTP / RPC / send SMS): an external side effect cannot be rolled back, and it stretches the transaction. To send a message, use a local message table.
3. **Validate first, then enter the transaction**: parameters and business rules outside the transaction, fail fast.
4. Always put `rollbackFor = Exception.class` on `@Transactional` (avoid pitfall 3.2-4).
5. Default isolation is fine (MySQL RR). **Do not reach for SERIALIZABLE**.
6. Concurrent updates: either a short row lock (`FOR UPDATE`) or an optimistic `version` (prefer the latter).
7. Unify **lock order** across the project (e.g. ascending id) to prevent deadlocks.
8. Mentally default to "a retry will happen": **any method with a side effect should think about idempotency first**.

---

## 11. One picture + a glossary

```
        ┌────────────── Four pillars of a transaction ──────────────┐
        │                                                           │
   Atomicity A ──→ undo log (rollback)                              │
   Durability D ──→ redo log + WAL (log first, data pages later)    │
   Isolation I ──→ locks (mutex) + MVCC (snapshot read)             │
   Consistency C ←── A/I/D together + business constraints written right │
                                                                    │
   Concurrency problems: dirty read / non-repeatable read / phantom │
   Counter:     isolation RC (stops dirty) → RR (stops non-repeatable) │
                → SERIALIZABLE (stops all) — performance drops each step │
                                                                    │
   Distributed: a single-DB transaction cannot cover cross-DB       │
   Counter:     2PC for strong consistency / SAGA · local message table for eventual │
              + idempotency + reconciliation as a backstop          │
        └───────────────────────────────────────────────────────────┘
```

| Term | One-line gloss |
|---|---|
| Connection | The program-to-database connection; the carrier of the transaction |
| Autocommit | The default mode where each SQL statement is its own transaction |
| ACID | Atomicity / Consistency / Isolation / Durability |
| Dirty / non-repeatable / phantom | Read uncommitted / same-row value changed / row count changed |
| Isolation levels | UR → RC → RR → SERIALIZABLE |
| undo log / redo log | The undo pill / the replay log |
| WAL | Write the log first, then the data (sequential writes for performance) |
| MVCC (Multi-Version Concurrency Control) | Keep several historical versions of the same row; read a snapshot; reads and writes do not block each other |
| ReadView | The "who can see whom" visibility list built at read time |
| Snapshot read / current read | Ordinary SELECT of history / FOR UPDATE · UPDATE of the latest + a lock |
| Propagation | Strategy when a transaction wraps a transaction (REQUIRED / REQUIRES_NEW) |
| 2PC / TCC / SAGA | The distributed-transaction trio |
| Local message table | Business + message in the same DB, same transaction; async delivery for eventual consistency |

---

## Further reading

- [Optimistic and pessimistic locks](/en/blog/optimistic-pessimistic-lock) — optimistic vs pessimistic, plus the cash-loan case
- [Idempotency](/en/blog/idempotency) — the same operation once or N times must yield the same result
- [Domain-driven design (DDD)](/en/blog/domain-driven-design) — cut boundaries first, then model
- [Database query performance](/en/blog/db-query-performance) — from indexes to sharding
- [Data overload and distributed refactoring](/en/blog/data-overload-distributed) — sharding and distributed transactions overview (supplement)

---

## ChangeLog

| Version | Date | Change |
|---|---|---|
| V1 | 2026-11-01 | First draft |
| V2 | 2026-11-01 | Rewritten for frontend readers: analogy table, JDBC / Spring code, transaction-failure scenes, propagation, MVCC / ReadView detail, local message table in Java |
| V2.1 | 2026-11-01 | Chapter 2 adds "2.0 layer the concepts": clarifies "the database implements the transaction vs the client (JDBC / Spring) sends commands" |
| V2.2 | 2026-11-01 | Filled in the MVCC full name (Multi-Version Concurrency Control) |
| V2.3 | 2026-11-01 | Cleared the split with the locks post: banner adds "division of labor with locks + learning order"; section 8 only lands the Java code |
