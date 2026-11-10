---
title: "Redis Panorama: From Basics to Production Patterns"
date: 2026-11-09
excerpt: Learn Redis for real work—data structures, TTL/persistence/eviction, replication/Sentinel/Cluster, cache pitfalls and consistency, distributed locks, queues/rate limits, plus a cross-region cache case study and self-check.
category: Engineering
lang: en
series: Full-Stack Engineering
seriesOrder: 10
---

> **Who this is for**: Frontend and backend engineers who have "heard of Redis" and want to actually use it in production.
>
> **Chapter map** (this table is the whole piece — jump around as needed):
>
> | Stage | Chapters | What's inside |
> |---|---|---|
> | Foundation | 1–2 | What it is / how to connect (connections and pools) |
> | Using it | 3 | The five core data structures (String/Hash/List/Set/ZSet) |
> | Internals | 4–7 | TTL · persistence · expiration vs eviction · slow-path debugging |
> | Production topology | 8–9 | Replica/Sentinel/Cluster · proxy vs direct |
> | As a cache | 10–12 | Cache model · three failure modes · consistency |
> | Deeper business | 13–14 | Distributed locks · queues / rate limits / rankings / dedup |
> | Case study | Extra | *Cross-region cache* — a real postmortem |
> | Cheat sheets | 15–17 | Command lookup · troubleshooting path · recap and self-test |
>
> **How to read**: top to bottom on the table; every step is worth typing once in `redis-cli`.
>
> **Scope**: this post is self-contained. It covers connections and pools, the five structures, TTL/persistence, expiration vs eviction, replica/Sentinel/Cluster, the three cache failure modes and consistency, distributed locks, plus classic patterns for queues, rate limiting, rankings, and dedup.

---

## Chapter 1 · What is Redis?

**In one line**: Redis is an **in-memory key-value database** — and because real businesses are messy, it grew into a **data-structure server**.

**Four reasons it is fast** (interview staples):

| # | Reason | Unpack |
|---|---|---|
| 1 | **Pure in-memory ops** | Memory reads/writes ~100ns, disk ~10ms — 100× or more |
| 2 | **Single-threaded (core commands)** | No "multi-thread lock contention", no context switch tax — you skip the *management* cost |
| 3 | **I/O multiplexing** | One thread can watch thousands of connections (epoll) and serve whoever has data ready |
| 4 | **Purpose-built structures** | Each type's storage is tuned for its access pattern (skiplist, ziplist, …) |

> **Why is "single-threaded" an advantage?** The premise is **commands are fast**. Single-thread kills concurrent locking, but it also means one slow command blocks everyone — that is the master key for performance debugging later (see Chapter 7).

### 1.1 Redis vs MySQL: not a replacement, a split of labor

| | MySQL | Redis |
|---|---|---|
| Where data lives | Disk (with a cache) | **Memory** (persistence as a backstop) |
| Strengths | Complex queries, joins, transactions, reports | Hot reads/writes, simple structures, ultra-low latency |
| Latency | milliseconds to tens of ms | **sub-millisecond** |
| Integrity | Strong (ACID) | Weaker (a crash can lose recent writes, depending on persistence) |

> **Split of labor**: MySQL is the ledger; Redis is the sticky notes on the desk — hot data and intermediate results live in Redis; facts and balances live in MySQL.

### 1.2 Typical uses (the five-pack) — each gets its own chapter

| Use | Structure | Core commands | Details |
|---|---|---|---|
| **① Cache** (this post's main thread) | String / Hash | SET GET · EXPIRE · DEL | Ch. 10–12 |
| **② Tasks / queues (MQ)** | List (Bull in production) | LPUSH / BRPOP / LRANGE | 3.3 · 14.1 |
| **③ Distributed lock** | String (`SET NX EX`) | SET NX EX · Lua atomic unlock | 3.1 · 13 |
| **④ Counters / rate limits** | String INCR (atomic) · ZSet (sliding window) | INCR / ZADD / ZREMRANGEBYSCORE | 3.1 · 14.2 |
| **⑤ Leaderboards / dedup** | ZSet (scored order) / Set (dedup) | ZADD ZREVRANGE · SADD SINTER | 3.5 · 14.3 / 14.4 |

> After Chapter 3 (the five structures), come back to this table — "which structure to pick" and "whether this use case is even possible" are **the same question**.

## Chapter 2 · How to connect (connections and connection pools)

```bash
redis-cli -h 127.0.0.1 -p 6379          # command-line client
redis-cli PING                          # PONG = you're in
```

Connecting from code (Node.js ioredis):
```js
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 6379 });   // one global instance (pool built-in)
await redis.set('hello', 'world');
await redis.get('hello');             // 'world'
```

### 2.1 Why connections are "expensive": a stateful private channel

A connection is a **stateful, dedicated TCP channel** between the client process and the database. The key difference from HTTP:

> **HTTP is stateless** — each request stands alone; the server does not "remember" you (auth is a token on every call).
> **A database connection is stateful** — the server really *does* remember autocommit, isolation level, temp tables on *this* connection.

Analogy: **HTTP is sending letters (each independent). A database connection is a phone call (once you're through, the other side remembers you for the whole conversation). Hang up and you have to dial again.**

Opening a connection is three steps, and each costs time:

```
① TCP three-way handshake     (network RTT; slower across DCs)
② Auth / handshake            (credentials, optional TLS)
③ Session setup               (autocommit / charset / isolation, allocate buffers)
```

### 2.2 Connection pool: pre-build, borrow, return, reuse

Under high concurrency you cannot open a new connection per request, so you use a **pool**: pre-build N connections, **borrow** on a request, **return** when done (don't close).

```
client ──borrow──▶ pool [C1 idle][C2 lent✔][C3 idle] ──hand off──▶ database
   ▲                  │
   └──────return──────┘   (return what you borrowed; pool full → wait → timeout)
```

- **Why a global singleton**: an ioredis instance *is* a pool. One instance = one pool; one instance per module = pool explosion and connection storms.
- **Pitfall 1 · leaks**: borrow and never return (forgot close/release) — the pool drains slowly.
- **Pitfall 2 · kicked connections**: idle connections get dropped by the server; you need validate/reconnect.
- **Pool exhausted**: wait, then timeout — "pool exhausted" is a classic production incident.
- **Capacity (Little's Law)**: connections needed ≈ `QPS × RTT / 1000`. Example: 500 QPS × 2ms → theoretically 1 connection; in practice 5–20 is safer (a single Redis node does 50k–100k QPS, so 500 QPS is light).

> For MySQL, this channel also carries **transaction boundaries and session state**: SQL after `BEGIN` on one connection is one batch (switch connection = switch transaction — that's why there is no global transaction across databases). An uncommitted transaction is **rolled back** if the connection drops. Deeper: [database transactions](/en/blog/db-transaction).

> Proxy vs direct vs cluster: Chapter 9. Connection incidents (churn / pool exhaustion): Chapter 7, "sin 5".

---

## Chapter 3 · The five core data structures (using them)

> Mnemonic: **Redis is not "a cache that stores strings". It is "a specialized, optimized container for each shape of data"**. Pick the right structure and even unoptimized commands work; pick the wrong one and no optimization saves you.

### 3.1 String — "the most general key-value pair"

> The most underrated structure: it looks like get/set, but **cache, counters, locks, rate limits, and check-in bitmaps all ride on it**. This section goes deep: command map and three identities of a value → full SET options → four high-frequency patterns → String vs Hash → pitfall list.

#### 3.1.1 Command map + three identities of one value

| Group | Commands | In one line |
|---|---|---|
| Read/write | `SET / GET / GETDEL(6.2+) / GETEX(6.2+) / APPEND / STRLEN` | GETEX = read and change TTL in one go |
| Conditional write | `SET key val [NX\|XX] [GET] [EX\|PX\|KEEPTTL]` | next subsection — **pitfall king** |
| Batch | `MSET` (atomic) / `MGET` | N round-trips collapsed to 1 |
| Atomic count | `INCR / DECR / INCRBY / DECRBY / INCRBYFLOAT` | in-place integer +1, O(1), no race |
| Bit ops | `SETBIT / GETBIT / BITCOUNT / BITPOS` | treat the String as a bit array (Bitmap) |
| Simple TTL | `SETEX key seconds value` | atomic `SET ... EX`; after 2.6.12 prefer the fuller `SET ... EX` |

Redis stores a value as **one of three things** depending on content (`OBJECT ENCODING key` to check) — this is the key to String:

| Value content | Internal encoding | Meaning |
|---|---|---|
| Pure integer `"12345"` | **int** | 8-byte integer underneath; INCR is in-place integer add |
| Short string (≤44 bytes, 3.2+) | **embstr** | object header + SDS in **one contiguous alloc** (one malloc saved, contiguous memory); **read-only**, one mutation turns it into raw |
| Long string / JSON / any bytes | **raw** | SDS simple dynamic string, binary-safe |

Three consequences:

1. **INCR's atomicity does not need a lock** — single thread + in-place add. The "read, +1, write back" race simply does not exist (echoes self-test Q1 in Chapter 17).
2. **INCR only accepts "strings that look like integers"** — once a counter key is `SET` to some other string, later INCR throws `WRONGTYPE` and the whole path breaks.
3. **SDS stores length and does not stop at `\0`**, so JSON and serialized bytes are fine — that does *not* mean you should stuff huge objects (see pitfall 4).

```bash
SET k 1234
OBJECT ENCODING k        # "int"
SET k hello
OBJECT ENCODING k        # "embstr"
APPEND k world
OBJECT ENCODING k        # "raw" — embstr is read-only; mutate once and it becomes raw
```

#### 3.1.2 Full SET options: half of production "ghost bugs" come from here

```
SET key value [NX | XX] [GET] [EX seconds | PX milliseconds | KEEPTTL]
```

| Option | Semantics | Typical use |
|---|---|---|
| `NX` | write only if missing | distributed lock (Ch. 13), idempotent write |
| `XX` | write only if present | update existing cache, don't accidentally create |
| `GET` (4.0+) | set new value and **atomically return the old** | replace-style update; avoids GET-then-SET races |
| `EX` / `PX` | TTL at write time | **every key with TTL should be written this way** |
| `KEEPTTL` (6.0+) | keep the existing TTL | update value, leave expiry alone |

> ⚠️ **#1 pitfall: a bare `SET key value` with no options silently clears that key's TTL**.
> "Ghost" incidents — a cache becoming a permanent key, a counter that never resets, a lock that never releases — often trace back to an update that forgot `EX`. Habit: always pass `EX` when updating, or use `KEEPTTL`.

Historical footnote: `SETNX` + `EXPIRE` were two commands (before 2.6.12); if the process died in between you got a **permanent lock**. `SET key val NX EX 30` as one command closed that hole (full lock selection and watchdog: Chapter 13).

#### 3.1.3 Four high-frequency patterns (copy-paste ready)

**① Cache JSON — store whole, fetch whole**

```bash
SET user:1 '{"name":"张三","age":18}' EX 300   # expire in 300s
GET user:1
```

Good for small objects that are always read/written as a whole, with no concurrent field updates. Need field-level I/O → Hash (comparison in 3.1.4).

**② Atomic counter — the real question is who owns TTL**

```bash
# create the bucket: only the first write succeeds (NX), and creation already has TTL
SET rl:api:1001 0 EX 60 NX
# every later request only increments; INCR does not clear TTL
INCR rl:api:1001        # > 100 → rate-limited (full scheme in 14.2)
```

Anti-pattern: `INCR` then `if (c == 1) EXPIRE key 60` is two non-atomic steps — crash in the middle and the key never expires, rate limiting dies.
For a never-expiring counter (page views) just `INCR article:100:views`; multi-instance concurrency still doesn't lose counts.

**③ Bitmap — String as a bit array**

```bash
SETBIT sign:1001:202611 10 1     # checked in on Nov 11 (offset = day - 1)
GETBIT sign:1001:202611 10       # checked in today? → 1
BITCOUNT sign:1001:202611        # days checked in this month
```

"Active today" flags for 100 million users ≈ 12MB — Boolean check-ins crush Set on memory (selection cheat sheet: 3.6).

**④ MSET / MGET — batching**

```bash
MSET a 1 b 2 c 3        # atomic write
MGET a b c              # missing keys come back as nil placeholders
```

N keys, one round-trip, N−1 RTTs saved vs looping GET. In Cluster, multi-key ops must share a slot (hash tag, Chapter 8).

#### 3.1.4 String object vs Hash: one table to decide

| Dimension | String (JSON text) | Hash |
|---|---|---|
| Read the whole object | ✅ one deserialize, fastest | also possible; field names cost extra memory |
| Change/read a few fields | ❌ read-modify-write the whole blob | ✅ `HGET/HSET` per field |
| Per-field atomic count | ❌ | ✅ `HINCRBY` |
| Concurrent updates to different fields | ❌ whole-blob overwrites | ✅ fields don't collide |
| Large-object risk | one fat string → big key (Ch. 7) | naturally split by field |
| Expiry | ✅ `SET ... EX` | ✅ key-level EXPIRE (per-field TTL needs HEXPIRE in 7.4+) |

> In one line: **whole-read / whole-write → String; many fields, many writers → Hash**.

#### 3.1.5 Pitfall list

1. **Bare SET clears TTL** (the #1 pitfall in 3.1.2) → permanent key / dead lock.
2. **INCR without EXPIRE** → permanent counter: memory growth + broken rate limits.
3. **Cache write-back race**: two clients fetch the same old JSON, each `SET`s back, last write wins → use `SET key newval GET` (4.0+, atomic swap and return old) or Lua.
4. **Large values**: String max is 512MB, but anything over ~10KB should be treated as a big-key risk (Ch. 7, sin 1); put image/file bodies in object storage, Redis only stores URLs.
5. **INCRBYFLOAT for money**: internal long double (fixed 17 significant digits) has precision traps; store money as integer **cents** with `INCR`.

**Condensed "when to use it"**: cache JSON, atomic counters / rate-limit ticks, distributed locks (`SET NX EX`), check-in / activity bitmaps, captcha / one-shot tokens (`SET ... EX` + `GETDEL` on verify), global ID segment allocation (`INCR ... BY n`, often replaced by snowflake IDs now).

### 3.2 Hash — "many fields under one key" (objects by field)

```bash
HSET user:1 name 张三 age 18
HGET user:1 name           # one field — no whole-object deserialize
HGETALL user:1
HINCRBY user:1 age 1       # per-field atomic increment
```

**When**: partial object I/O (e.g. nickname only), many fields but you only touch a few each time.
**Pitfall**: `HGETALL` on a large Hash is O(N) and blocks — page with `HSCAN`.

### 3.3 List — "ordered, blockable list" (born to be a queue)

```bash
LPUSH task:queue '{"id":1}'     # left in
RPOP task:queue                 # right out (FIFO)
BRPOP task:queue 30             # blocking: wait up to 30s (worker staple)
LRANGE task:queue 0 9           # first 10 (page large lists)
LLEN task:queue                 # queue length
```

**When**: task queues (Bull's substrate), latest-N feeds, todo pools.
**Pitfall**: don't use it for "delete at an arbitrary index" (O(N)); don't scatter BRPOP across processes without ack (tasks vanish) — use Bull / Redis Stream / similar.

### 3.4 Set — "unordered, unique collection"

```bash
SADD fans:user:1 u2 u3 u4
SINTER fans:user:1 fans:user:2     # mutual follows (intersection)
SISMEMBER fans:user:1 u2           # is a follower?
SCARD fans:user:1                  # cardinality
SPOP lottery:pool                  # lottery: pop a random member
```

**When**: dedup (a user cannot enroll twice), membership (already liked?), mutual friends / tag algebra (SINTER/SUNION/SDIFF).

### 3.5 ZSet — "sorted set with scores" (leaderboards / delayed queues)

```bash
ZADD rank:day 9800 user:1         # score = points
ZINCRBY rank:day 5 user:1
ZREVRANGE rank:day 0 9 WITHSCORES  # Top10
ZRANK rank:day user:1              # my rank
ZADD delay:task 1690000000 job:1   # score = execute-at timestamp → delayed queue
```

**When**: leaderboards (hot search, points), **delayed queues** (score = when to run, poll with ZRANGEBYSCORE), sliding-window rate limits.

### 3.6 Three-minute selection cheat sheet

| Need | Use |
|---|---|
| Cache one JSON | String |
| Partial object I/O | Hash |
| Task queue / latest N | List |
| Dedup / boolean relation / lottery | Set |
| Leaderboard / delayed queue | ZSet |
| Counter / distributed lock | String (INCR / SET NX) |
| Monthly check-in | Bitmap |
| Boolean stats (million-scale unique count) | HyperLogLog |
| People nearby | Geo |

---

## Chapter 4 · TTL and key hygiene

- `EXPIRE key 300` / `SET ... EX 300`: how long the key lives.
- When it expires, Redis **does not delete it instantly**. Two mechanisms cooperate (table in Chapter 6):
  - **Lazy deletion**: delete on access if expired.
  - **Periodic deletion**: 10 times a second, randomly sample 20 expired keys.
- **Never walk the whole keyspace with `KEYS *`** (blocks everyone). Use cursor-style `SCAN 0 MATCH user:* COUNT 100`.

**Key naming** (team convention): `biz:object:id:field`, e.g. `order:detail:1001:base`. Readable, and easy to bulk-clean / count by prefix.

## Chapter 5 · Persistence: getting memory onto disk

> All Redis data lives in memory — **kill the process and memory is gone**. Persistence is the only way to come back after a crash. Three modes in one table; details in 5.1–5.5:

| Mode | How | Pros | Cost |
|---|---|---|---|
| **RDB** | Periodic **snapshot** of memory to a file (BGSAVE forks a child) | Small file, fast restore | **Crash between snapshots loses data**; fork stalls (Ch. 7, sin 3) |
| **AOF** | Append every write command to a log | Lose at most 1 second (`everysec`) | Larger file, slower restore |
| **Hybrid** (4.0+) | RDB full dump + incremental AOF | Best of both | A bit more complex |

### 5.1 RDB: timed snapshots

**How**: dump the **entire key-value state at one instant** as a compact binary `dump.rdb`. Restore = load the whole file into memory — hence **fast restore**.

**How is a snapshot triggered?** Three paths:

```bash
# ① Automatic: config fires on "change frequency" (default policy)
save 900 1        # at least 1 key changed in 900s
save 300 10       # at least 10 keys in 300s
save 60 10000     # at least 10000 keys in 60s
# ② Manual: BGSAVE forks a child (does not block serving — preferred)
redis-cli BGSAVE
# ③ Backstop: SHUTDOWN dumps once on a clean stop; full replica sync also makes the primary generate an RDB
```

**The real story is fork + copy-on-write (COW)** — whether RDB is "fast" lives here:

```
BGSAVE → fork() a child → parent and child share the same physical pages
       → child walks pages and writes dump.rdb
       → parent keeps serving!
       parent mutates a page → that page is copied for the parent (COW)
```

Two consequences:
1. **fork itself stalls the parent**: what is copied is the **page table** (not the data). Bigger instance → bigger page table → longer stall (rule of thumb: GB-class instances start at tens of ms, worse as they grow) — root of Chapter 7 "sin 3 persistence blocking".
2. **Memory can nearly double in the extreme**: heavier writes during the snapshot → more COW copies. Plan **30%–50% headroom** for persistence (`maxmemory` does not include this).

> If startup logs warn `Transparent Huge Pages (THP) enabled`, turn THP off — huge pages make COW copy 2MB at a time and make memory and latency worse.

**30-second hands-on**:

```bash
redis-cli BGSAVE                       # background save
ls -la dump.rdb                        # see the file
redis-check-rdb dump.rdb               # integrity check
```

### 5.2 AOF: append-only write log

RDB is a "result snapshot". AOF takes another path — **record every write in order**, replay from the start on restore, and state comes back.

```bash
# enable: appendonly yes
SET name zhangsan
# AOF records a readable protocol command (Redis 6 and earlier):
# *3\r\n$3\r\nSET\r\n$4\r\nname\r\n$8\r\nzhangsan\r\n
```

**One core knob: `appendfsync`** — how fast commands are actually flushed to disk:

| Policy | Behavior | Loss window | Fit |
|---|---|---|---|
| `always` | fsync every command | essentially none | painfully slow, almost unused |
| `everysec` (default ⭐) | background thread fsyncs once a second | **lose at most 1 second** | almost all cases |
| `no` | leave it to the OS | unknown (maybe seconds) | fast, not safe |

> Advanced: under `everysec`, if the disk is so slow that background fsync takes more than 2 seconds, the main thread **blocks waiting** when it writes AOF — so "everysec does not block" assumes the disk is not terrible.

**AOF only grows → rewrite**: the 100th `INCR counter` is 100 log lines, but current state is one `SET counter 100`. AOF rewrite **emits the minimal command set from current memory**, flattening the dirty history:

```bash
redis-cli BGREWRITEAOF        # manual; day-to-day uses auto policy:
auto-aof-rewrite-percentage 100   # fire when file is 100% bigger than last rewrite
auto-aof-rewrite-min-size 64mb    # and at least 64mb, or it is not worth it
```

Rewrite also forks (same stall + COW memory issues). New writes during rewrite go to a buffer and are appended after — nothing lost.

**Hands-on**:

```bash
redis-cli CONFIG SET appendonly yes
redis-cli SET foo bar
cat appendonly.aof            # you can see the command you just typed (6.x); 7.x uses incr files under appendonlydir/
```

> Redis 7 splits AOF into Multi-Part: `base` (foundation) + `incr` (delta) + `manifest` under `appendonlydir/` — same idea, different on-disk shape.

### 5.3 Hybrid persistence (4.0+, on by default): RDB head + AOF tail

RDB restores fast but loses more; AOF loses less but replays slowly. **Hybrid persistence stitches both into one file** (`aof-use-rdb-preamble yes`, default since 5.0):

- On AOF **rewrite**, current full state is written as an RDB binary preamble; later incremental commands still append as AOF text;
- On restore: **fast-read the RDB head + replay only the small tail** — restore speed close to RDB, durability close to AOF.

### 5.4 How to choose (decision table) + if both are on, which wins?

| Scene | Recommend | Why |
|---|---|---|
| Pure cache (rebuildable from DB) | RDB, or even `appendonly no` + `save ""` | chase max performance; miss → DB |
| Task queue / locks (e.g. Bull) | **AOF + everysec** (RDB on top is fine) | losing one lock/task is an incident; losing 1 second is OK |
| Data is the source of truth (Redis as the DB) | Hybrid + replicas + Sentinel | single-node persistence is not enough; HA backstop (Ch. 8) |

> If both RDB and AOF are on, **AOF wins on restart** (it is more complete). A damaged AOF can be repaired with `redis-check-aof --fix`.

**Ops step people skip — off-box backup**: persistence files sit on the same machine as Redis, **a dead disk kills both**. Periodically copy RDB/AOF off-box (crontab + scp / object storage) — that is a complete "on disk" story.

### 5.5 Common persistence pitfalls

1. **fork is one of the three big stalls**: BGSAVE, AOF rewrite, and full replica sync all fork — don't step on two at once (e.g. schedule both `BGSAVE` and `BGREWRITEAOF` at peak).
2. **No memory headroom**: COW spikes RAM → maxmemory eviction or even OOM. Size as "expected data + 30%–50%".
3. **Thinking everysec = no data loss**: it is "lose at most 1 second", and a slow disk can still block the main thread; if you truly cannot lose, use `always` + SSD + replicas.
4. **AOF only grows**: auto rewrite forgotten (turned down / off) → file unbounded, restore slower and slower.

> **Cache-scene recap**: a pure cache can drop AOF, keep RDB, or skip persistence entirely for max speed; **task queues / locks must use AOF + everysec**.

## Chapter 6 · Expiration vs eviction (two different things — don't mix them)

| | Expiration | Eviction |
|---|---|---|
| Trigger | key has a TTL and time is up | **memory is full** (hit maxmemory) |
| Mechanism | **lazy delete** (check on access) + **periodic delete** (10×/s, sample 20; if >25% expired, another round) | according to `maxmemory-policy` |
| Policy | only the above (both on by default) | **8 policies** |

> **Corollary (the key to breakdown / avalanche, Ch. 11)**: expired ≠ gone immediately — the window of "logically expired, physically still there" is exactly where breakdown and avalanche live.
> Two notes on expiration: periodic delete is a cheap random sample. "Redis is slow because it expires too much" is usually a misread — start from your own TTL and access frequency.

**8 eviction policies** (`maxmemory-policy`; 5 you actually use):

| Policy | Meaning |
|---|---|
| noeviction (default) | memory full → error, delete nothing |
| allkeys-lru | among **all** keys, drop least-recently-used (cache default) |
| volatile-lru | LRU only among keys **that have a TTL** |
| allkeys-lfu / volatile-lfu | same, by **access frequency** (4.0+) |
| allkeys-random / volatile-random | random drop |

> **Which one for cache?** Pure cache: `allkeys-lru`. Clear hot/cold split (some keys reread constantly, some rarely): `allkeys-lfu` fits better. Only allowed to drop "anyway-expiring" keys: `volatile-*`.

## Chapter 7 · Redis is slow? A troubleshooting list (path + six sins)

> Single-thread is the master key: **one big key or slow command = everyone blocked**. First the path, then the six sins.

### 7.1 Build a troubleshooting path (don't guess)

When Redis feels slow, split "slow" into three: **network slow**, **Redis execution slow**, or **client processing slow**:

```
  1. redis-cli --latency -h host       # ① network RTT
  2. redis-cli SLOWLOG GET 10          # ② server slow commands
  3. redis-cli INFO cpu                # ③ server CPU
  4. redis-cli INFO memory             # ④ memory / eviction pressure
  5. redis-cli INFO persistence        # ⑤ RDB/AOF in progress?
  6. redis-cli CLIENT LIST | wc -l     # ⑥ connection count weird?
  7. redis-cli --bigkeys               # ⑦ any big keys?
```

> **Client timing** matters too: split "network / Redis exec / deserialize". Often `JSON.parse` ate 50ms and people blame Redis.

### 7.2 Six sins (each: symptom / how to check / fix)

**Sin 1 · Big key**
- Symptom: one read is uniquely slow; network is fine.
- Typical: a Hash with 100k fields, a String > 10MB, a List with a million entries.
- Check: `redis-cli --bigkeys`.
- Fix: split (`user:1:profile` / `user:1:settings`), Hash fields on demand, compress large values (gzip).

**Sin 2 · Slow commands (single-thread amplifier)**
- Symptom: one read suddenly slow, then a wave of requests all slow.
- Essence: Redis **executes commands on one thread** — one slow command blocks everything behind it.

| Command | Complexity | Risk |
|---|---|---|
| `KEYS *` | O(N) | ❌ never in production |
| `HGETALL big_hash` | O(N) | too much returned |
| `LRANGE big_list 0 -1` | O(N) | full dump |
| `SMEMBERS big_set` | O(N) | same |

- Fix: `SCAN` instead of `KEYS`; page collections (`ZRANGEBYSCORE + LIMIT`); watch `slowlog-log-slower-than`.

**Sin 3 · Persistence blocking**
- Symptom: a read "suddenly" jumps in latency (you happened to hit a dump).
- Cause: `BGSAVE` is a child process, but **fork stalls the parent** (worse with more RAM); AOF rewrite also writes a lot of disk.
- Check: `INFO persistence`.
- Fix: don't fire RDB/AOF at peak; use SSD; **keep a single instance not too large (suggest <10GB)**.

**Sin 4 · Network latency / bandwidth**
- Symptom: Redis itself is fast; end-to-end is not.
- Cause: client and Redis in different DCs, public internet, bulk export saturating the pipe.
- Check: `redis-cli --latency`, `iftop`.
- Fix: **same DC / same AZ, private network** — cross-region is milliseconds vs same-DC sub-millisecond (in the real case this step took 200ms to 2ms).

**Sin 5 · Bad connection / pool config**
- Symptom: high latency and jitter; every call is "a bit extra".
- Cause: new connection per request (TCP handshake 0.5–3ms, TLS worse), no pool, TIME_WAIT pile-up.
- Check: `CLIENT LIST` — are connections being rebuilt constantly?
- Fix: share one pool (ioredis `lazyConnect`, `maxConnections` 10–30); sane timeouts; details in Chapter 2.

**Sin 6 · Client serialize / deserialize**
- Symptom: Redis took 2ms; total was 50ms.
- Cause: `JSON.parse` of a fat JSON, or you fetched fields you didn't need.
- Fix: split client timings; switch to **MessagePack / Protobuf**; Hash fields **on demand** (`HGET user:1 name`), don't pull everything.

### 7.3 Attribution: after an optimization works, how to recap "why it was slow"

> A working fix ≠ you can reverse-engineer a unique cause. Use **elimination**:

| Evidence | Points to "our own path" | Points to "external contention" |
|---|---|---|
| High network latency | ✅ | ❌ |
| Connection churn | ✅ | ❌ |
| Redis CPU high | ❌ | ✅ |
| SLOWLOG has slow commands | ❌ | ✅ |
| Other services also slow | ❌ | ✅ |

Real-case conclusion: **the pool removed connect cost (3000→200ms); same-region deploy removed cross-continent RTT (200→2ms)** — we were walking an inefficient path, not "someone else stole our resources". To claim contention you need evidence like high `INFO cpu` and a busy SLOWLOG.

> A dedicated Redis instance / sharding can isolate "someone else stealing resources" — that is **capacity planning**. Fixing your own path first is still the **best ROI**.

---

## Chapter 8 · Topology evolution (what each shape solves)

```
① Standalone     ────────► too many reads, no backup if it dies
② Replication    ────────► primary writes, replicas read (8.1–8.3)
③ Sentinel       ────────► primary dies → auto-elect a new one (HA, 8.4)
④ Cluster        ────────► data sharded by slot (16384) → horizontal capacity
```

### 8.1 Why replicas: two standalone pains

| Pain | What replicas fix |
|---|---|
| **Too many reads, one node can't hold** | primary writes, **replicas read** → horizontal read scale |
| **Primary dies with no backup** | a replica can be promoted → HA |

```
            ┌─▶ replica A (read)
primary(write) ──┤
            └─▶ replica B (read)
primary "syncs" every write to replicas = replication
```

> Complements sharding: **sharding splits data horizontally; replication adds copies vertically** — one splits data, one scales reads and backup. Often used together.

### 8.2 Replication in one sentence: binlog

The primary records every write in a **binlog (binary log)**; the replica pulls and **replays** locally:

```
primary write → write binlog → replica IO thread pulls binlog → replica SQL thread replays → replica catches up
```

> Redis is the same idea (PSYNC / replication feed, not the word "binlog"). **Replication is async** — that is the root of the next section's "replica lag".

### 8.3 Replica lag (the biggest pitfall) and read/write split

Replica data is slightly older than the primary → write-then-immediately-read can miss.

**Fixes**:
- **On a read/write split, sensitive "read-your-writes" go to the primary** (e.g. place an order, then immediately fetch it → force primary);
- Acceptable-lag scenes (list pages / reports) can hit replicas;
- One primary + one replica can go **semi-sync** to shrink the lag window.

At the code layer (middleware routing, or you pick the datasource):

```java
@ReadDataSource   // pseudo-annotation: query → replica
public Order getOrder(Long id) { ... }

@WriteDataSource  // write → primary
public void update(Order o) { ... }
```

> Mental model: **primary writes, replicas read, accept a little lag; consistency-sensitive ops force the primary**. Replicas **do not solve write pressure** — writes still only hit the primary.

### 8.4 High availability: what if the primary dies

**Failover**: primary dies → Sentinel / HA middleware detects → promote a replica (or restore from backup) → app talks to the new primary.

- **Redis Sentinel**: watch the primary, vote a new one, tell clients the new address (Redis's own HA).
- **MySQL**: MHA / MGR / promote a replica + retarget connections.
- During the cutover, writes may be briefly unavailable (a small availability tax).

- **Sentinel**: watch the primary, vote a new one, tell clients the new address (Redis's own HA).

### 8.5 Cluster

- **Cluster**: 16384 hash slots spread across many primaries; `key` routes by CRC16 — **both capacity and write throughput scale out**, but you accept "multi-key ops / transactions are limited" (only keys in the same slot; hash tags `{user1}:a` fix that).

> ⚠️ Transactions / locks / queues (e.g. Bull) have extra Cluster constraints: **multi-key must share a slot** (put `{hashTag}` in the key); the client must speak Cluster (ioredis `Redis.Cluster`), not a standalone connection.

## Chapter 9 · Proxy vs direct (the typical cloud-Redis choice)

| | **Proxy** | **Direct** |
|---|---|---|
| Topology / routing | proxy handles it (MOVED/ASK invisible) | **client maintains it** (slot map) |
| Connection management | proxy's built-in pool | client configures it |
| Network path | client → proxy → node | client → node (shorter) |
| Stability | stable, low jitter | handled badly, it is slower |

**Four ways direct gets slow**:
1. Client doesn't handle **MOVED/ASK redirects** correctly (timeouts, hitting the wrong node over and over).
2. **Slots refresh too often** (`slotsRefreshTimeout` large → someone on first paint waits 10s).
3. **Bull is not Cluster-aware by nature** — a standalone `{ host, port }` dumps everything onto one node (hotspot + slow redirects):
   ```ts
   // ✅ Bull wants an ioredis Cluster instance, not { host, port }
   const queue = new Queue('email', { connection: redisCluster });
   ```
4. No pool → new connection per job (TCP + auth + slot init).

> **The secret of a 6ms proxy is not a faster network** — it is "a smart gateway eating all the complexity for you". After going direct, "we got slower" is not a reason to retreat; **fill in the missing pool / retry / same-region deploy** (done well, you can beat the proxy — Extra *Cross-region cache* 3000→200→2ms).

> Troubleshooting tip: you lowered `commandTimeout` on direct and still stall 30s? Common cause: `maxRetriesPerRequest: null` infinite retries × timeout stacking — you need a total timeout / circuit breaker.

---

> Cache is Redis's most common — and most commonly misused — scene. Chapters 10–12 go from **model to engineering**: why it is fast, where to put it, how to stop the three failure modes (with code), how to keep cache and DB consistent, and a complete implementation that strings it all together.

## Chapter 10 · Why cache + the cache model and three layers

### 10.1 Why cache: not an "optimization", a hardware law

**In one line**: storage speed differs by orders of magnitude. Putting hot data in a faster place is **paying a one-time cost for long-term read speed**.

```
CPU cache (~ns) → memory (~100ns) → SSD (~0.1ms) → disk (~10ms) → network/DB (tens of ms+)
```

> Frontend intuition: `memoize` expensive results, HTTP-cache static assets — same idea. Backend just caches "expensive DB reads" into "cheap Redis / memory".

**Key premise: locality** — a small hot set takes most of the traffic (Pareto). Cache only works on data that *has* locality.

### 10.2 Basic model and two metrics

```
  client
   │  ① look up cache
   ▼
 Redis ──hit──▶ return immediately   (fast)
   │ ② miss
   ▼
   DB query → ③ fill cache → return
```

- **Hit rate** = hits / total lookups, higher is better (aim >90%).
- **Penetration rate** = among misses, the share that "DB also has nothing" (see 11.1 penetration).

### 10.3 Where to put cache: three layers (and their pits)

| Layer | Carrier | Trait | Typical pit |
|---|---|---|---|
| **Local cache** | in-process `Caffeine/LRU Map` | fastest, zero network | each instance has its own copy — **inconsistent**; RAM |
| **Distributed cache** | Redis | shared across instances, the mainstream | one network hop; Redis down = all gone (needs HA) |
| **Browser / CDN** | user side, edge | static assets, closest to the user | expiry / aggressive cache policy |

> Production typical: **local (L1) → Redis (L2) → DB**, each layer a backstop. L1/L2 consistency is extra work (local goes stale easily).

### 10.4 Three read/write patterns (Cache-Aside is not the only one)

| Pattern | Read | Write | Fit |
|---|---|---|---|
| **Cache-Aside (sidecar)** ⭐ | cache first → miss then DB and fill | **delete/write cache, then write DB** (order matters, 12.2) | 90% of business |
| Read/Write-Through | app only talks to cache; cache syncs DB | synchronous write-through | when you have a mature cache layer |
| Write-Behind (async flush) | write cache first, **async batch** to DB | writes are very fast, risk of loss | counters, clicks, likes |

> 🎯 Interview staple: **why does everyone use Cache-Aside?** — simple, clear ownership (cache is a copy, DB is source of truth); paired with **"delete cache after writing DB"**, consistency collapses to "rebuild on read".
>
> **What does rebuild-on-read mean?** Writers only **delete** cache, never compute the new value into it. After Cache-Aside deletes, cache is "empty"; the next read miss goes to DB for the live truth and fills — the new value is **rebuilt on the spot from current DB**, so it is naturally consistent, and writers never have to "get cache right". DEL is idempotent: a mistaken delete is at worst one extra miss, far cheaper than "update cache on write" drifting from DB.

## Chapter 11 · Three failure modes: penetration / breakdown / avalanche (theory + code)

**One table to tell them apart (memorize this)**:

| | Who gets hit | Essence |
|---|---|---|
| Penetration | DB (the key never existed) | querying data that does not exist |
| Breakdown | DB (one hot key) | the instant a hot key expires |
| Avalanche | DB (lots of it) | a pile of keys expire together / Redis dies |

> The key is earlier: expiration is "lazy + periodic" (Ch. 6). **expired ≠ physically gone** — breakdown / avalanche windows are exactly "logically expired, physically lagging".

### 11.1 Cache penetration — looking up a key that never existed, every request hits DB

**Symptom**: a key is in neither cache nor DB (malicious `userId=-1`, `id=99999999`). Every lookup misses → **falls through to DB**. An attacker loops nonexistent IDs → DB is punched for free.

```
request -id missing- → cache miss → DB miss → next request misses again → DB again (the isolation is pierced)
```

**Fix 1: cache empty results** (simple, most used)
```java
// when the query does not exist, also put "null" in cache with a short TTL
Order o = redis.get(key);
if (o == null) {
    o = dao.findById(id);
    if (o == null) {
        redis.setex(key, 60, "NULL");   // empty cache, 60s; return "none"
    } else {
        redis.setex(key, 300, o);
    }
}
```
> Don't cache empties too short (penetration again) or too long (real data arrives and you still miss it).

**Fix 2: Bloom filter** (intercept *before* cache)
A bitmap in front of cache answers "might this key exist?" — **"does not exist" is certain; "exists" may be a false positive**:
```
hash each real key several times, set those bits to 1
lookup: if every bit is 0 → definitely missing → reject, don't hit Redis/DB
        if at least one bit is 1 → maybe there → let it through (some false positives)
```
```java
BloomFilter<Long> bloom = BloomFilter.create(Funnels.longFunnel(), 1_000_000, 0.01);
// warmup: add every existing id; before a query, bloom.mightContain(id) to block
```
> Bloom traits: **tiny memory (bitmap) + cannot delete members**; **false positives, no false negatives**.

### 11.2 Cache breakdown — one "hot key" expires, all traffic hits DB

**Symptom**: an **extremely hot** key (flash-sale stock, a hot SKU) just expired. Normally 10k requests, only a few miss to DB; **the instant it expires**, the thousands that used to hit cache all miss and pile onto **the same row** → DB explodes.

**Fix 1: mutex (only one rebuilds)**
Put a distributed lock around "query DB + fill cache": **only the first request that grabs the lock hits DB**; others spin briefly, then hit the filled cache — DB is queried once (lock details: Ch. 13):
```java
public String getHot(String key) {
    Object v = redis.get(key);
    if (v != null) return v;
    // grab lock: only one thread rebuilds, others wait
    if (redis.setnx("lock:" + key, "1", 5_000)) {
        try {
            v = dao.query(key);            // rebuild
            redis.setex(key, 300, v);      // fill
        } finally {
            redis.del("lock:" + key);
        }
        return v;
    } else {
        Thread.sleep(50);
        return getHot(key);                // missed the lock, retry until someone else built it
    }
}
```
> Cost: **brief blocking** at the breakdown instant (others wait on the lock). Fit for hot keys that must be fresh.

**Fix 2: logical expiry (don't really delete; refresh async)**
Don't set a real TTL (the value physically never disappears, never misses). Store a "logical expire time" inside the value; on read, if logically expired → **return the old value first** (no miss, no block) and **rebuild in the background / under a lock**:
```
value = { data: ..., logicalExpire: 1234567890 }
read: not expired → return
      logically expired → return old value, then async / locked rebuild
```
> Pros: **reads don't block** (DB not broken, and you still serve old data). Cons: briefly stale. Fit for "stock before a flash sale" — a little staleness is OK, the peak is not.

### 11.3 Cache avalanche — a large batch expires at once OR Redis as a whole is down

**Symptom**: lots of keys expire **at the same instant** → a wave of requests all hit DB; or the Redis cluster is unavailable → all traffic lands on DB.

**Fixes**:
1. **Jitter TTL**: `expire = base + random(0..1000)`, so a batch doesn't die together.
2. **Multi-level cache**: if Redis is down / miss, a **local L1** still serves reads.
3. **Rate limit / circuit break**: if DB can't hold, shed load first; don't let DB die.
4. **Redis HA**: Sentinel / Cluster (Ch. 8) — "cache down" should not be normal.

## Chapter 12 · Cache consistency: how to keep cache from going stale after a DB write (full version)

**Problem**: DB is updated, cache is still old (you read dirty data).

### 12.1 Why "update cache first" fails

```
Plan A: write DB, then write cache
if the cache write fails → DB new, cache old → dirty forever
if DB write succeeds and a read hits old cache before the cache update → also inconsistent
```

### 12.2 Cache-Aside (the common sidecar)

```
read: cache first → hit return / miss then DB and fill
write: delete cache (invalidate old) → write DB → next read rebuilds
```

**Why "delete cache, then write DB", not "write DB, then delete cache"?**
- Delete first → even if the DB write fails, cache is empty (next read rebuilds correctly). At worst one extra DB hit, **not dirty**.
- Write DB then delete: if delete fails, it is **old forever**.

**The "delete first + concurrent write" hazard (classic timeline)**:
```
A: delete cache → (about to write DB)
B: cache miss → query DB (old) → fill old cache
A: write DB (new)                            ← result: cache is B's old fill
```
**Fix: delayed double-delete** — after A writes DB, **delete cache again a few hundred ms later**, clearing B's old fill:
```java
public void update(Order o) {
    redis.del(key);              // ① delete cache (invalidate old)
    dao.update(o);               // ② write DB
    Thread.sleep(300);           // ③ let concurrent "fill old cache" requests finish
    redis.del(key);              // ④ delayed double-delete: clear a possible stale fill
}
```
> Delayed double-delete is not perfect (there is still a short window), but it is enough for most business.

### 12.3 When you shouldn't sweat consistency — "cache is just a read snapshot"

Many scenes already allow stale: leaderboards, product copy, counters. **Those only need expire-and-rebuild, not double-delete** — don't spend consistency complexity where you don't need it.

### 12.4 Going further: binlog subscribe and reconciliation as a backstop

- **Advanced**: subscribe to binlog (e.g. canal) to trigger cache deletes — hand "delete cache" reliability to a dedicated component; **don't force binlog subscribe if the complexity doesn't pay**.
- **Backstop**: every scheme has a short inconsistent window → a **reconciliation job** eventually converges.

### 12.5 Combined implementation: SKU detail + stock (penetration + breakdown + avalanche together)

```java
@Service
public class SkuService {
    // read: Cache-Aside + anti-penetration (empty) + anti-breakdown (mutex) + anti-avalanche (jitter TTL)
    public Sku getSku(Long id) {
        String key = "sku:" + id;
        Object v = redis.get(key);
        if (v != null) return v == NULL_SENTINEL ? null : (Sku) v;

        if (redis.setnx("lock:" + key, "1", 3000)) {
            try {
                v = skuDao.findById(id);
                int ttl = 300 + (int)(Math.random() * 60);       // anti-avalanche: jitter
                if (v == null) { redis.setex(key, 60, NULL_SENTINEL); return null; } // anti-penetration
                redis.setex(key, ttl, v);
                return (Sku) v;
            } finally { redis.del("lock:" + key); }              // anti-breakdown: mutex rebuild
        }
        sleepRetry(); return getSku(id);
    }

    // decrement stock: Redis atomic DECR + roll back if not enough
    public boolean decrStock(Long id, int n) {
        Long left = redis.decrBy("stock:" + id, n);              // atomic
        if (left < 0) { redis.incrBy("stock:" + id, n); return false; } // roll back
        return true;
    }
}
```

### 12.6 Common cache pitfalls & interview follow-ups

- **Don't put a mutex on every key "just in case"** — only hot keys; otherwise you serialize high concurrency.
- **Don't cache empties too long** — "data arrived but we can't read it".
- **Bloom filters cannot delete members** — after you take data offline it still false-positives "exists".
- **Local cache + Redis: remember consistency** — L1 going stale is a real pit.

**🎯 Interview staples**:
1. How do you tell penetration / breakdown / avalanche apart? — the table at the start of Ch. 11.
2. Delete cache then write DB — why can it still be inconsistent? Who fills the old value under concurrency? — 12.2 timeline; delayed double-delete.
3. Who gets the anti-breakdown mutex? — only hot keys; lock with `SETNX` (echoes Ch. 13).
4. Do we just live with cache/DB eventually diverging? — a short window is OK + a **reconciliation job** as backstop.

---

## Chapter 13 · Distributed locks: SETNX is enough, but the details will kill you (full version)

### 13.1 Why a distributed lock (vs a process lock)

```
single process: synchronized / ReentrantLock — mutex inside one process
multi-instance: several processes grab the same job / mutate the same resource → in-process locks can't see each other
      → you need a lock "everyone can see and grab" → Redis / ZK / database
```

> When you need it: a business (cron, stock decrement) **runs on multiple instances** and must be "mutex across instances" — the substrate of "don't run this twice".

### 13.2 From naive SETNX to its three pits

**Basic pose**:

```bash
# lock: set only if missing + 30s TTL
SET lock:order:1 <requestId> NX EX 30
# do work...
DEL lock:order:1        # unlock
```

Pits, one after another:

| Problem | What happens | Key fix |
|---|---|---|
| **Another thread's lock gets deleted** | A's lock expires, B grabs it, A `DEL`s B's lock | **check value (owner / thread id) on release**; delete only if yours |
| **Hold time too short** | work isn't done, lock expired, someone else enters | **renewal (watchdog)**, 13.3 |
| **check + delete not atomic** | GET then DEL → expires / stolen in between | Lua so "check + delete" is atomic |

**Unlock must be atomic (Lua)** — only delete your own lock:

```lua
-- delete only if value equals ours — don't delete someone else's lock
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

> Echoes the 3.1.2 footnote: in the `SETNX` + `EXPIRE` two-command era (before 2.6.12), lock *acquisition* could die halfway and leave a **permanent lock**. `SET key val NX EX 30` as one command closed that.

### 13.3 Watchdog: the lock must auto-renew

Problem: lock is 30s, the job needs 60s → the second half has no lock, someone else can enter.

Fix: **watchdog** — while you hold the lock, a background task **renews at about 1/3 of the TTL**; cancel renewal only when the job finishes (then release).

> **Analogy**: you reserved a seat; afraid of timeout, you raise your hand every so often: "still here". That's Redisson's watchdog (default 30s, renew every 10s).

### 13.4 What if the Redis singleton dies: RedLock and how to choose

**Pain**: the lock lives on **one Redis**; it dies → the lock is gone.

| Option | Idea | Recommend? |
|---|---|---|
| **Single Redis + watchdog** | simple enough (pair with Sentinel/Cluster HA, Ch. 8) | ✅ vast majority of cases |
| **RedLock** | write the lock to **several independent Redis**; majority success = acquired | ⚠️ controversial (split-brain / clock drift), high complexity, most teams don't need it |
| **ZooKeeper ephemeral nodes** | session drop auto-releases, sequential nodes for fairness | ✅ when you want strong consistency / fairness |
| **[DB optimistic lock](/en/blog/optimistic-pessimistic-lock) / unique index** | use the DB as the lock | OK at low frequency |

> 🎯 Interview staple: is RedLock always safer? — not necessarily. It brings multi-machine + clock/network complexity, plus "lock split / split-brain" controversy. **A lot of real systems are fine with "single Redis + watchdog + Sentinel HA"**. Choose by consistency needs and how much complexity the team will eat.

### 13.5 How to use it (Redisson-ish pseudocode) — the lock is not the floor, idempotency is

```java
RLock lock = redissonClient.getLock("lock:order:" + orderId);
try {
    // default watchdog 30s, auto-renew every 30/3 seconds
    lock.lock(30, TimeUnit.SECONDS);
    // ... only the instance that got the lock enters ...
} finally {
    if (lock.isHeldByCurrentThread()) lock.unlock();
}
```

> The real point: **after you hold the lock, the business still needs to be [idempotent](/en/blog/idempotency)** — **the lock is an optimization, idempotency is the floor** (locks can expire / fail; idempotency is the backstop).

## Chapter 14 · Other "classic variants": task queues / counters & rate limits / leaderboards & dedup

### 14.1 Task queues (Redis List; Bull in production)

**Why Redis as a queue?** Compare MQ choices:

| Middleware | Complexity | Fit | Deploy |
|---|---|---|---|
| **Redis List** | low | lightweight task queue, fast start | one process, batteries included |
| **BullMQ** (on Redis) | medium | production Node queues | depends on Redis |
| **RabbitMQ** | high | complex routing, many consumer patterns | separate Erlang deploy |
| **Kafka** | very high | huge log streams, event sourcing | ZooKeeper cluster |

Hard reasons to pick Redis: **List is naturally a queue (LPUSH in / BRPOP out), ops are atomic (many workers BRPOP, each task taken by one), cost is tiny** (Redis is often already in the stack).

**Core ops (FIFO + blocking consume)**:

```bash
LPUSH task:queue '{"type":"mail","to":"a@b.c"}'   # produce (left in)
BRPOP task:queue 30                               # consume (right out, block up to 30s)
```

**Why blocking BRPOP instead of RPOP + poll?**
- Polling: empty queue → `sleep(100ms)` spin → wasted CPU + worst case 100ms before you see a new job.
- `BRPOP`: empty queue parks the process; a new job **wakes it immediately** → **zero delay + zero CPU waste**; a 5s timeout lets the worker shut down cleanly (clear `isRunning`).
- Listening to several queues in argument order = **a cheap priority queue** (high-priority first).

**Why is task state a Hash, not a String?** Status / steps / result are local updates every worker wants: String is "GET whole → parse → change → stringify → SET", not atomic, concurrent updates overwrite. Hash does **per-field atomic updates** (`HSET task:abc status running` doesn't touch other fields) — that's 3.2's `HINCRBY/HGET` again.

**Three classic worker self-test questions**:
1. **Worker dies halfway through a job?** After BRPOP the job is already dequeued — **lost**. Native limit. Fix: `BRPOPLPUSH` (pop and move to a processing queue, delete when done), or BullMQ ACK + timeout requeue.
2. **Can two workers take the same job?** No — `BRPOP` is atomic; each job is taken by one worker (single-thread model).
3. **How do you do priority?** `BRPOP [high, normal] 5` checks in argument order; high-priority queue first.

**What do you actually use in production?** Native List works but **has no ack/retry** — production uses **Bull** (underneath it is still LPUSH/BRPOP, plus retry / delay / cron / concurrency / ACK). Under Cluster, pass a `Redis.Cluster` instance (pitfall in Ch. 9).

> Progress push (worker done → frontend sees it live) is SSE + Redis Pub/Sub — another post.

### 14.2 Counters / rate limiting

```bash
INCR api:user:1:20260101        # atomic +1 (safe across instances)
EXPIRE api:user:1:20260101 86400 # valid for the day
```

**Fixed-window rate limit** (simple, has a boundary spike):
```java
Long c = redis.incr(key);                 // requests in this window
if (c == 1) redis.expire(key, 60);        // set TTL only on the first
if (c > 100) throw "rate limited";        // at most 100 per 60s
```

**Sliding-window rate limit** (ZSet, more precise, no boundary spike):
```java
long now = System.currentTimeMillis();
redis.zremrangeByScore(key, 0, now - 60_000);   // ① drop requests outside the window
long count = redis.zcard(key);                  // ② count inside the window
if (count >= 100) throw "rate limited";
redis.zadd(key, now, requestId + ":" + now);    // ③ record this request
redis.pexpire(key, 60_000);
```
> Idea: every request enters the ZSet with a timestamp. **Delete members older than 60 seconds, then count** — the window slides; it is not a rigid calendar minute.

### 14.3 Leaderboards

```bash
ZINCRBY rank:day 5 user:1          # add points
ZREVRANGE rank:day 0 9 WITHSCORES  # Top 10 (high to low)
ZRANK rank:day user:1              # my live rank (O(logN) — the soul of a leaderboard)
```

### 14.4 Dedup

```bash
SADD members:user:1 u2 u3 u4     # add members (auto-dedup)
SISMEMBER members:user:1 u2      # already there?
SINTER a b                       # mutual follows (intersection)
SCARD members:user:1             # cardinality
```

> For billion-scale unique counts on a budget, use **HyperLogLog** (`PFADD/PFCOUNT`, error within 0.81%, fixed 12KB).

---

## Extra · A real case study: *Cross-region cache*

> A real optimization postmortem that walks **every idea in this post** through a business:
> A cross-border C-end product (LatAm users, US-region infra). Home SSR depends on "page structure + delivery data". Users hit it across regions, and two things showed up:
> 1. **Same phone, language flipping at random** (cache key missing a language dimension),
> 2. **API taking 3 seconds** (cross-region network + no connection pool + bad direct-mode config).

**Optimization path** (excerpt; full postmortem is another piece):

| Step | Action | Time spent |
|---|---|---|
| Pool | build a pool, stop connecting every time | **3000ms → 200ms** |
| Placement | run the service and Redis **in the same region**, kill cross-region RTT | **200ms → 2ms** |
| Further | + local LRU, Pipeline, kill big keys | approaching memory speed |

> Three interlocking morals:
> **① The fastest request is the one you never send (local cache); ② The fastest network is the same rack (physical placement); ③ A working optimization ≠ a unique cause you can reverse-engineer (use elimination; don't blame "the other team").**


---

## Chapter 15 · Command cheat sheet (30 common commands)

| Category | Commands |
|---|---|
| String | SET / GET / INCR / DECR / SETEX / MSET / MGET |
| Hash | HSET / HGET / HGETALL / HDEL / HEXISTS / HINCRBY |
| List | LPUSH / RPUSH / LPOP / RPOP / BRPOP / LRANGE / LLEN |
| Set | SADD / SREM / SISMEMBER / SINTER / SUNION / SDIFF / SCARD / SPOP |
| ZSet | ZADD / ZINCRBY / ZRANGE / ZREVRANGE / ZRANK / ZSCORE / ZRANGEBYSCORE |
| Key | EXPIRE / TTL / PERSIST / DEL / EXISTS / SCAN |
| Server | PING / INFO / SLOWLOG GET / CLIENT LIST / DBSIZE / FLUSHDB (dangerous) |

## Chapter 16 · Troubleshooting path (where to look when Redis is slow)

```
feels slow → --latency (network) → SLOWLOG (slow commands) → INFO cpu/memory (load)
           → INFO persistence (dump) → CLIENT LIST (connections) → --bigkeys (big keys)
           → client split timings (serialization)
```

Details: Chapter 7 (six sins) and Chapter 9 (proxy vs direct).

## Chapter 17 · Recap + self-test

**Five sentences to take home**:

1. Redis = **memory + single thread + multiplexing**; it is MySQL's partner, not its rival.
2. Five structures, each a job: String (cache/count/lock) · Hash (object/fields) · List (queue) · Set (dedup) · ZSet (rank/delay).
3. **Single-thread is a double-edged sword**: no lock contention, but one big key / slow command blocks everyone.
4. **Expiration and eviction are two things**: expiration is a key's TTL running out; eviction is "memory full, delete something" (8 policies).
5. **Cache is the most common Redis pose**: Cache-Aside + the three failure modes (penetration / breakdown / avalanche) + consistency (delete cache / double-delete / binlog).

**Self-test**:

1. For a Redis counter, why is `INCR` safer than "read, +1, write back"? — `INCR` is **atomic**; read-modify-write can lose concurrent updates.
2. Why is `KEYS *` dangerous? What instead? — O(N) on a single thread, blocks everyone; use `SCAN` cursor increments.
3. What does a primary-key index buy you (looking back from MySQL)? — details live in query-optimization / indexing posts; Redis's "primary key" is the key itself.
4. Among cache "penetration / breakdown / avalanche", which is "a large area expired"? — **avalanche**; breakdown is "one hot key".
5. In Cluster, can a transaction write `{user:1}:a` and `{user:1}:b` together? — yes (same hash tag, same slot); `{user:1}:a` and `{user:2}:b` no (cross-slot).
6. What structure for a "task queue"? — List (BRPOP blocking read); or ZSet (with execute-at time) for a delayed queue.
7. Why can a Bloom filter "block penetration" without leaking? — it can only false-positive "exists"; "does not exist" is certain, so intercepts don't miss.
8. Which reads faster, logical expiry or a mutex? — logical expiry doesn't block reads (return old + async refresh); mutex waits on the lock.
9. Why do writes usually "delete cache" instead of "update cache"? — avoid concurrent cache-update consistency bugs; delete and rebuild on the next read is the stable path.
10. Why must unlock Lua-check the value? — so A, after its lock expired, doesn't delete the lock B just grabbed.
11. What if the job runs longer than the lock TTL? — the lock vanishes mid-flight, someone else can enter → watchdog auto-renew (13.3).
12. Can a distributed lock fully replace idempotency? — no; locks can expire / fail; idempotency is the backstop (lock is an optimization, idempotency is the floor).
13. Why does `BGSAVE` make reads jitter? — fork stalls the parent + disk I/O (Ch. 7, sin 3).
14. How many connections for 500 QPS? — Little's Law `QPS×RTT/1000` says theoretically 1; in practice 5–20 is safer (Ch. 2).
15. Why might you not see an order you just placed? — replica hasn't caught up (replica lag) → force this "read-your-writes" onto the primary (8.3).
16. Does replication solve write pressure? — basically no; writes still only hit the primary. It solves **read pressure + backup HA**.
17. Worker BRPOPs a job then crashes — where did the job go? — gone (native limit); use BRPOPLPUSH or BullMQ ACK + timeout requeue (14.1).
18. Why not open a new connection on every request? — TCP handshake + auth + session setup is expensive, and connections are stateful; borrow/return from a pool (Ch. 2).

---

## Glossary

| Term | In one line |
|---|---|
| B+ tree / skiplist | Redis implements ZSet with a skiplist |
| Skiplist | ZSet's substrate: an ordered linked list that supports range queries |
| SDS | Redis's dynamic string: O(1) length, binary-safe — String's substrate |
| embstr / raw | String encodings for short/long: ≤44 bytes one alloc (read-only; one mutation → raw) / long strings |
| pipeline | send many commands in one go, cut network RTT |
| hash slot | Cluster sharding: 16384 slots |
| Sentinel | HA component that auto-elects a new primary |
| flock | persistence fork of a child process (stalls the parent) |
| Little's Law | connections ≈ QPS × latency |
| Connection pool | pre-build N connections and reuse them, borrow/return; pool full = classic production incident |
| Session | the "state bundle" on one connection (autocommit / isolation / temp tables); drop the connection and it's all gone |
| binlog | the carrier of replication: primary records every write in a binary log, replica pulls and replays |
