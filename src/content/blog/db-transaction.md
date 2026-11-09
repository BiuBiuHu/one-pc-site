---
title: 数据库事务：写给前端的数据库一致性学习指南
date: 2026-11-01
excerpt: 用前端能懂的类比，讲清事务 ACID、隔离级别、MVCC、Spring 事务失效，以及跨服务后的兜底思路。
category: 后端
lang: zh
series: 前端转全栈
seriesOrder: 1
---

> **读者**：前端工程师（同一条学习路线〔本文〕→ 锁 → 幂等 → DDD → [查询优化 / 分库分表](/blog/db-query-performance)）
> **系列**：事务 → 锁 → 幂等 → DDD → 查询优化。本文 · [乐观锁与悲观锁](/blog/optimistic-pessimistic-lock) · [幂等](/blog/idempotency) · [领域驱动设计（DDD）](/blog/domain-driven-design) · [数据库查询性能优化](/blog/db-query-performance)
> **配套**：并发写的两种锁见 [乐观锁与悲观锁](/blog/optimistic-pessimistic-lock)
> **与锁的分工**：本篇专心讲**事务**（ACID / 隔离级别 / MVCC / 分布式事务），第 8 节只给 Java 落地；锁的**对比 / 选型 / 现金贷实战案例**统一收在 [乐观锁与悲观锁](/blog/optimistic-pessimistic-lock)（含「悲观锁≠禁读、乐观锁≠禁写」的纠正）。建议先读本篇 1~7 章懂事务，再看锁篇补锁。
>
> **学完你能回答**：
> 1. 事务到底解决什么问题？ACID 每一个字什么意思、靠什么实现？
> 2. 后端 Java 代码里事务怎么写？（JDBC 原生 + Spring @Transactional）
> 3. 并发事务为什么会出脏读/不可重复读/幻读？隔离级别怎么挡？
> 4. 为啥后端同事总说「事务失效」？传播行为是什么？
> 5. 跨库/跨服务为什么没有事务？怎么兜底？

---

## 0. 开始之前：给前端的几个类比

后端概念对前端最大的门槛是**术语**，先对齐词汇：

| 后端概念 | 前端熟悉的东西 | 一句话解释 |
|---|---|---|
| 事务 Transaction | 「一批 setState 整批生效/整批丢弃」 | 多条 SQL 捆成一个原子单元 |
| Connection 连接 | WebSocket 长连接 | 程序和数据库之间的一条「通道」，**事务必须绑定在同一条连接里** |
| 连接池 Connection Pool | 复用的 axios 实例池 | 连接很贵（TCP+鉴权），提前建好一堆复用 |
| SQL 的行 row | JSON 里的一条 record | 数据库里的一行数据 |
| undo log | git 的 revert 记录 | 记「改之前是什么」，用来后悔 |
| redo log | git 的 commit log | 记「我做了什么操作」，崩溃后重放 |
| MVCC | git checkout 旧版本看代码 | 读数据时看「历史版本快照」，不被别人正在改的半成品干扰 |
| 锁 Lock | 单例互斥 / `navigator.locks` | 「这行数据我在改，你等着」 |

> 心法：**前端的世界靠「事件的最终一致」糊弄过去了；后端的世界是真金白银，中间态出错就是资损**，所以需要事务这种「强保证」。

---

## 1. 为什么需要事务：从一个线上事故说起

**场景**：用户下单，后端要做两件事：

```
① 扣库存     stock: 10 → 9
② 写订单     INSERT INTO order ...
```

没有事务时，进程在 ① 后 ② 前崩溃（也可能 ② 因字段超长直接报错）：

```
库存： 9        （扣了，收不回来）
订单： 无       （用户付了钱但没有订单）
```

——用户投诉、客服排班、复盘会议三连。

**事务就是对付这个的**：把 ①② 捆起来，**要么一起成功（COMMIT），要么一起当没发生过（ROLLBACK）**。

事务的正式定义：

> **事务（Transaction）是一组数据库操作组成的逻辑单元，这个单元内的操作要么全部生效，要么全部不生效，不允许出现「做了一半」的中间状态。**

---

## 2. 事务的最小可用知识（SQL + Java JDBC）

### 2.0 概念分层：数据库干活，客户端发指令

先澄清一个容易混淆的层次（读完本章再回看一次更有感觉）：

> **事务的「实现」全在数据库里；本章讲的 JDBC / Spring 只是「遥控器」。** JDBC 不实现任何事务逻辑，它只负责把你按下的按钮翻译成数据库指令。

```
┌──────────────────────────────────────────────┐
│  客户端（Java 程序）                           │
│    Spring @Transactional（注解，最省事）        │
│         ↓ 底层还是调用                         │
│    JDBC（Java 的「数据库遥控器」 API）            │
│    setAutoCommit(false) / commit / rollback  │
└───────────────────┬──────────────────────────┘
                    │  数据库协议（≈ 发出 BEGIN / COMMIT / ROLLBACK）
                    ▼
┌──────────────────────────────────────────────┐
│  数据库（事务真正实现的地方）                     │
│    undo log / redo log / 锁 / MVCC（第 7 章）  │
└──────────────────────────────────────────────┘
```

- **数据库**：定义并实现事务——ACID 的保证全部由它完成。
- **客户端（JDBC）**：只做三件事——开一条连接、把按钮（`setAutoCommit(false)`/`commit()`/`rollback()`）翻译成协议指令发过去、接收结果。

**为什么必须讲客户端这层？** 因为事务必须有人来触发——「哪几条 SQL 算一批」这个**边界是客户端划的**：

| 谁来划边界 | 用什么 |
|---|---|
| 直接敲 SQL | `BEGIN ... COMMIT` |
| Java 程序 | JDBC：`setAutoCommit(false)` ... `commit()` |
| Python 程序 | DB-API：`conn.begin()` ... `commit()` |
| Node 程序 | mysql2：`beginTransaction()` |

殊途同归——到了数据库那边都是同样的指令。**JDBC 之于事务，就像遥控器之于电视：换台是电视执行的，遥控器只是按键的通道。**

> 顺势解释一个伏笔：事务为什么「绑定在 Connection 上」？因为数据库以**连接**为单位划分事务边界——同一条连接里 `BEGIN` 之后的 SQL 才算一批，`Connection` 既是「通道」也是**事务的载体**。换一条连接 = 换一个事务，这正是第 9 章「跨库没有事务」的根源。

### 2.1 SQL 层面：只有三句话

```sql
BEGIN;                       -- 开启事务（从此在这个连接上的写操作先「记账」不生效）
UPDATE account SET balance = balance - 100 WHERE id = 1;
UPDATE account SET balance = balance + 100 WHERE id = 2;
COMMIT;                      -- 提交：刚才的写全部生效
-- 中途任何一步出错：
ROLLBACK;                    -- 回滚：刚才的写全部作废
```

**注意**：MySQL 默认是「自动提交」模式——每条 SQL 就是一个独立事务，执行完立刻生效。要手动组事务，先 `BEGIN`（或 Java 里关掉 autoCommit，见下）。

### 2.2 Java 原生写法：JDBC（理解原理必看）

真实工程里 99% 用 Spring（第 3 节），但 **Spring 的魔法就是把下面这段代码自动生成**，所以先看原生写法：

```java
// try-with-resources：连接用完自动归还连接池（类比 React 的 useEffect cleanup）
try (Connection conn = dataSource.getConnection()) {

    conn.setAutoCommit(false);          // ★ 关闭自动提交 = 手动开启事务
                                        //   (「下面这些 SQL 先别生效，等我发话」)

    // ① 扣款
    try (PreparedStatement ps1 = conn.prepareStatement(
            "UPDATE account SET balance = balance - ? WHERE id = ?")) {
        ps1.setBigDecimal(1, new BigDecimal("100"));
        ps1.setInt(2, 1);
        ps1.executeUpdate();            // 注意：还没生效！只是「记账」
    }

    // ② 入账
    try (PreparedStatement ps2 = conn.prepareStatement(
            "UPDATE account SET balance = balance + ? WHERE id = ?")) {
        ps2.setBigDecimal(1, new BigDecimal("100"));
        ps2.setInt(2, 2);
        ps2.executeUpdate();            // 同样还没生效
    }

    conn.commit();                      // ★ 两条都成功 → 一次性生效

} catch (Exception e) {
    conn.rollback();                    // ★ 任何一步抛异常 → 全部作废
    throw new RuntimeException("转账失败", e);
}
```

**逐行拆解要点**：

1. `setAutoCommit(false)` —— 事务的开关。开了事务之后，这个连接上的所有 SQL 都「暂存」。
2. **事务绑定在 Connection 上** —— 同一个事务里的 SQL 必须从**同一个连接**发出。类比：你开的两个 WebSocket 之间共享不了局部变量。
3. `commit()` 之前，别的连接**默认看不到**你改的数据（这就是「隔离」，第 5 节细讲）。
4. `rollback()` 一般放 catch 里——一个异常，全部作废。

### 2.3 一个容易被前端忽略的点：抛出异常 ≠ 自动回滚

JDBC 没那么智能：**异常发生后如果你忘了调 rollback，事务会一直挂着**，占着连接和锁，最后把连接池耗干（线上事故经典款）。所以 Java 里手写事务必须 try-catch-finally 严丝合缝——这正是 Spring 事务存在的意义。

---

## 3. Spring `@Transactional`：实际工程里的写法

### 3.1 基本用法

```java
@Service
public class TransferService {

    @Autowired
    private AccountMapper accountMapper;   // 数据库访问层（类比前端的 api 层）

    /**
     * 一个注解 = 上一节 JDBC 那一坨模板代码
     * 进入方法：conn.setAutoCommit(false)
     * 正常返回：conn.commit()
     * 抛出异常：conn.rollback()
     */
    @Transactional(rollbackFor = Exception.class)
    public void transfer(Long fromId, Long toId, BigDecimal amount) {
        accountMapper.deduct(fromId, amount);   // 扣款
        int rows = accountMapper.add(toId, amount);  // 入账
        if (rows == 0) {
            throw new BizException("收款账户不存在");  // 抛异常 → 自动回滚
        }
    }
}
```

**两个高频参数**：

```java
@Transactional(
    rollbackFor = Exception.class,           // ① 默认只在 RuntimeException/Error 时回滚，
                                             //    受检异常(如 IOException)不回滚！显式声明最稳
    isolation = Isolation.READ_COMMITTED     // ② 指定隔离级别（第 6 节）
)
```

### 3.2 `@Transactional` 失效的五大场景（Java 面试必考，读别人代码也会撞上）

Spring 事务的原理是 **AOP 动态代理**：Spring 给你的类生成一个「代理对象」，事务逻辑包裹在代理里。**凡是你绕过了代理直接调真实对象，事务就失效**。

```java
@Service
public class OrderService {

    // ❌ 场景1：自调用失效
    public void batchCreate() {
        for (...) {
            this.createOne(o);     // this 是真实对象，不是代理 → createOne 的事务白写
        }
    }

    @Transactional
    public void createOne(Order o) { ... }
}
```

| # | 失效场景 | 原因 | 解法 |
|---|---|---|---|
| 1 | **同类自调用** `this.createOne()` | 绕过了代理对象 | 拆到另一个类 / 注入自身代理 |
| 2 | 方法不是 `public` | 代理只增强 public 方法 | 改 public |
| 3 | 异常被 `catch` 吞掉 | 代理看不到异常，以为成功 | 记录日志后**重新抛出** |
| 4 | 抛了受检异常（如 IOException） | 默认只回滚 RuntimeException | `rollbackFor = Exception.class` |
| 5 | 表引擎是 MyISAM | 引擎不支持事务 | 用 InnoDB |

> 前端类比：AOP 代理 ≈ React 的 HOC/高阶组件。你直接调 `Component` 而不是 `withTransaction(Component)`，包裹的逻辑自然不存在。

### 3.3 传播行为：事务套事务怎么办（看懂别人的代码）

一个事务方法内部又调了另一个事务方法，里层的事务怎么处理？这就是**传播行为（Propagation）**：

| 传播行为 | 语义 | 场景 |
|---|---|---|
| `REQUIRED`（默认） | 有事务就加入，没有就新建 | 普通业务方法 |
| `REQUIRES_NEW` | **挂起**当前事务，开一个全新事务 | 记操作日志：主流程回滚了，日志也要留 |
| `NESTED` | 子事务，可独立回滚到保存点 | 主流程失败整体回滚，子流程失败只回滚自己 |
| `SUPPORTS` / `NOT_SUPPORTED` / `MANDATORY` / `NEVER` | 跟随/挂起/强制要求/禁止外层事务 | 特殊场景 |

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)  // 无论外层有没有事务，我都自己开一个新的
public void writeAuditLog(String action) { ... }
```

> 记住默认的 `REQUIRED` 和 常见的 `REQUIRES_NEW` 就能看懂 90% 的业务代码。

---

## 4. ACID 逐个拆解

四个字母不是并列的概念，而是**一个目的 + 三个手段**：

```
C（一致性） ← 目标
   ↑ 靠
A（原子） + I（隔离） + D（持久） ← 三个手段
```

### 4.1 A — 原子性 Atomicity（「全做或全不做」）

- **是什么**：第 1 节的转账例子——两步 SQL 的生死绑在一起。
- **靠什么实现**：**undo log（回滚日志）**。修改任何数据前，先把「改之前的样子」记到 undo log；一旦 ROLLBACK，按日志反向恢复。
- **前端类比**：redux-devtools 的 time-travel——记录每一步 action，撤销就是反着放一遍。

### 4.2 C — 一致性 Consistency（「规则始终成立」）

- **是什么**：事务前后，数据始终满足**所有约束**——外键、唯一索引、非空，以及业务规则（「转账前后总金额不变」）。
- **注意**：C 不是数据库单方面保证的，**业务规则要靠你的代码写对**。比如你只扣款不入账，事务再标准也「不一致」。
- **代码里最直观的体现**：某个 UPDATE 违反唯一索引 → 整个事务回滚。

### 4.3 I — 隔离性 Isolation（「并发看不见彼此的中间态」）

- **是什么**：多个事务同时跑，互相不能看到对方**未提交**的数据。
- **为什么难**：完全隔离 = 排队执行 = 性能巨大损失。所以数据库提供了**隔离级别**这个「旋钮」（第 5、6 节），让你在正确性和性能之间取舍。
- 依赖 **锁 + MVCC（Multi-Version Concurrency Control，多版本并发控制）** 实现（第 7 节）。

### 4.4 D — 持久性 Durability（「提交了就不会丢」）

- **是什么**：`COMMIT` 返回成功后，哪怕下一秒机房断电，数据还在。
- **靠什么实现**：**redo log + WAL（Write-Ahead Logging，预写日志）**——先顺序写日志（快），再刷数据页（慢）。崩溃后按日志把没落盘的修改「重放」出来。
- **前端类比**：先写 localStorage 的操作日志再改页面，刷新页面后按日志重放恢复状态。

---

## 5. 并发三兄弟：脏读、不可重复读、幻读

单个事务没问题，**多个事务并发跑**才会出事。三类问题都用下面这个时间线表格来看（T1、T2 是两个并发事务）。

### 5.1 脏读（Dirty Read）—— 读到了别人「没提交」的数据

| 时刻 | 事务 T1（转账） | 事务 T2（对账报表） |
|---|---|---|
| t1 | `UPDATE` 甲账户 -100（**未提交**，账面暂为 900） | |
| t2 | | `SELECT` 甲账户 → 读到 **900** ← **脏读** |
| t3 | 业务异常，`ROLLBACK`，甲账户恢复 1000 | |
| t4 | | 用 900 出了报表 → **报表是错的** |

**判断词**：读到的是「将来可能被回滚」的数据。**危害最大，任何正经系统都必须防**。

### 5.2 不可重复读（Non-Repeatable Read）—— 同一行，两次读的值变了

| 时刻 | 事务 T1 | 事务 T2 |
|---|---|---|
| t1 | `SELECT` 甲账户余额 → **1000** | |
| t3 | | `UPDATE` 甲 -500，**COMMIT** |
| t4 | 再 `SELECT` 甲 → **500** ← 同一事务里值变了 | |

**判断词**：**同一行**的值被别的事务改了。影响「事务内多次读要一致」的逻辑（比如先读余额再校验再扣款）。

### 5.3 幻读（Phantom Read）—— 行数变了，像见了鬼

| 时刻 | 事务 T1 | 事务 T2 |
|---|---|---|
| t1 | `SELECT COUNT(*) WHERE amount>100` → **2 行** | |
| t3 | | `INSERT` 一笔 200 的订单，**COMMIT** |
| t4 | 同样的 COUNT 查询 → **3 行** ← 多了一行「幻影」 | |

**判断词**：**结果集的行数**变了（新增/删除）。

### 5.4 三兄弟对比（一道经典面试题）

| | 脏读 | 不可重复读 | 幻读 |
|---|---|---|---|
| 变化的是 | 读到**未提交**数据 | **同一行的值** | **结果集行数** |
| 别人的操作 | UPDATE 后回滚 | UPDATE 已提交 | INSERT/DELETE 已提交 |
| 防住它的最低隔离级别 | READ COMMITTED | REPEATABLE READ | SERIALIZABLE（MySQL RR 下靠间隙锁基本也能防） |

---

## 6. 隔离级别：拧哪个旋钮

### 6.1 四级总表

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | 性能 | 说明 |
|---|---|---|---|---|---|
| READ UNCOMMITTED 读未提交 | ❌ 有 | ❌ 有 | ❌ 有 | 最快 | 几乎没人用 |
| READ COMMITTED 读已提交 | ✅ 防 | ❌ 有 | ❌ 有 | 快 | **Oracle / PostgreSQL 默认** |
| REPEATABLE READ 可重复读 | ✅ 防 | ✅ 防 | 基本防* | 中 | **MySQL InnoDB 默认** |
| SERIALIZABLE 串行化 | ✅ 防 | ✅ 防 | ✅ 防 | 最慢 | 排队执行 |

> *MySQL 的 RR 靠 MVCC 快照 + Next-Key Lock（记录锁+间隙锁）把幻读也基本挡住了，这是 MySQL 的加分实现。间隙锁简单说：把「查询范围」也锁住，别的事务插不进新行。

### 6.2 Java 里怎么设置

```sql
-- 会话级（整个连接生效）
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

```java
// Spring：注解里直接指定
@Transactional(isolation = Isolation.REPEATABLE_READ)
public Order queryOrder(Long id) { ... }
```

### 6.3 选型直觉

- **读已提交（RC）**：「我只看别人提交完的数据」 —— 互联网公司常见选择，并发好。
- **可重复读（RR）**：「我这个事务里多次读必须一致」 —— MySQL 默认，适合「先查再算再写」的业务。
- **串行化（SERIALIZABLE）**：基本只有金融级强一致场景才用，性能代价大。

---

## 7. 底层实现：undo log / redo log / 锁 / MVCC

这一节是「为什么」层面的知识，前端读一遍建立直觉即可，面试后端岗才需要背诵级掌握。

### 7.1 undo log —— 原子性的实现 + MVCC 的原料

```
UPDATE account SET balance = 900 WHERE id=1;   (原值 1000)

undo log 记录： "id=1 这行，改之前 balance=1000"
→ ROLLBACK 时： 按记录把 900 改回 1000
```

它同时是 MVCC 的「历史版本仓库」（见 7.4）。

### 7.2 redo log + WAL —— 持久性的实现

**问题**：数据真实落盘（随机写磁盘的「数据页」）很慢。如果每次提交都等数据页写完，性能崩掉。

**方案（WAL，预写日志）**：

```
事务提交：
  1. 把「改了什么」顺序追加写入 redo log（顺序写，快）   ← COMMIT 在这一步就返回成功
  2. 数据页稍后由后台线程慢慢刷盘（异步）

崩溃恢复：
  重放 redo log → 把没来得及落盘的修改补上 → 数据不丢
```

- **前端类比**：把「修改操作」先 append 进一个日志文件（快），真正的 DOM 更新慢慢来；刷新页面后 replay 日志。

### 7.3 锁 —— 写冲突的互斥

| 锁 | 语义 | 类比 |
|---|---|---|
| 共享锁 S（`SELECT ... FOR SHARE`） | 大家可以一起**读** | 一起看文档 |
| 排他锁 X（`SELECT ... FOR UPDATE` / UPDATE 自带） | **我在写，其他读写都等着** | 你在编辑文档，别人只读锁定 |
| 间隙锁 Gap Lock（RR 级别下） | 锁住一个**范围**，防止插入新行（防幻读） | 预售座位区 |

详细用法（ForUpdate 行锁、deadlock 演示）见第 8 节代码和 [乐观锁与悲观锁](/blog/optimistic-pessimistic-lock)。

### 7.4 MVCC（Multi-Version Concurrency Control，多版本并发控制）—— 「读不吃写、写不吃读」的秘诀

> **全称**：MVCC = **Multi-Version Concurrency Control**，中文 **多版本并发控制**。
> **一句话**：给同一行数据保存**多个历史版本**，事务读的时候读到「对应老版本的快照」，从而 **读操作不阻塞写、写操作不阻塞读**。

**烦恼**：如果「读」也要等「写」放锁，读多写少的系统会被读把锁全占光。

**思路**：数据保存**多个版本**，每个事务读自己该看的那个版本（快照），而不是别人的中间态。

```
balance 这行的版本链（最新 → 最老）：

  balance=900   trx_id=104 (事务104正在改,未提交)
      ↑ roll_pointer
  balance=1000  trx_id=101 (已提交)
      ↑
  balance=1200 trx_id=98  (已提交, 更早)
```

事务读的时候会生成一个 **ReadView（读取视图）**，简化理解：

> 「记下此刻**哪些事务还活着**，然后沿着版本链找到**第一个「提交时机在我视野内合法」的版本**来读。」

效果：

- 事务 A 在改（未提交）→ 事务 B 照样能读，**B 读到的是旧版本快照**，不会脏读。
- RR 级别下，B 整个事务期间用**同一个 ReadView** → 多次读结果一致（可重复读）。
- RC 级别下，B 每次查询都生成**新的 ReadView** → 能读到别人新提交的值（不可重复读，但这是 RC 无论是特性不是 bug）。

> **RR 和 RC 的本质区别，就是 ReadView 是「一次事务一个」还是「一次查询一个」。**

### 7.5 快照读 vs 当前读（很实用，写代码会撞到）

| | 语句 | 读什么 |
|---|---|---|
| **快照读** | 普通 `SELECT` | 历史 MVCC 版本，**不加锁** |
| **当前读** | `SELECT ... FOR UPDATE/FOR SHARE`、`UPDATE`、`DELETE` | **最新**值，且**加锁** |

为什么 UPDATE 总是当前读？——修改必须基于最新值，读历史版本再改就会覆盖别人的修改。

---

## 8. 实战：Java 里怎么写并发安全的扣款

锁的**对比 / 选型 / 现金贷实战案例**见 [乐观锁与悲观锁](/blog/optimistic-pessimistic-lock)，这里只给「事务语境下」的 Java 落地代码，不再重复讲锁的取舍。

### 8.1 悲观锁：先锁行再改（热点、强一致）

```java
@Transactional(rollbackFor = Exception.class)
public void deductWithPessimisticLock(Long accountId, BigDecimal amount) {
    // FOR UPDATE = 当前读 + 排他行锁
    // 其他事务的 FOR UPDATE 会阻塞在这一行，直到本事务 commit
    Account account = accountMapper.selectForUpdate(accountId);

    if (account.getBalance().compareTo(amount) < 0) {
        throw new BizException("余额不足");   // 回滚 + 释放锁
    }
    accountMapper.deduct(accountId, amount);
}
```

```xml
<!-- Mapper 里的 SQL -->
<select id="selectForUpdate" resultType="Account">
  SELECT * FROM account WHERE id = #{id} FOR UPDATE
</select>
```

### 8.2 乐观锁：不锁行，更新时校验版本（读多写少）

```java
@Transactional(rollbackFor = Exception.class)
public void deductWithOptimisticLock(Long accountId, BigDecimal amount) {
    Account account = accountMapper.findById(accountId);     // 普通 SELECT，拿到 version

    int affected = accountMapper.deductWithVersion(
            accountId, amount, account.getVersion());
    // SQL: UPDATE account
    //      SET balance = balance - #{amount}, version = version + 1
    //      WHERE id = #{id} AND version = #{version}

    if (affected == 0) {
        // version 对不上 = 有人在你会话间隙改过了
        throw new ConcurrencyException("并发冲突，请刷新重试");
    }
}
```

> 生产里常见「重试 N 次」的包装：冲突后重读、重试，配合**幂等**防止重试副作用。

### 8.3 死锁：两把锁互等（看懂报错日志）

```java
// 事务A： 先锁 id=1，再锁 id=2
@Transactional
public void transferA() {
    updateAccount(1);          // 拿到 id=1 的锁
    Thread.sleep(100);
    updateAccount(2);          // 等 id=2 的锁（被 B 拿着）
}

// 事务B： 先锁 id=2，再锁 id=1   ← 顺序相反！
@Transactional
public void transferB() {
    updateAccount(2);          // 拿到 id=2 的锁
    Thread.sleep(100);
    updateAccount(1);          // 等 id=1 的锁（被 A 拿着）→ 互等 = 死锁
}
```

InnoDB 有死锁检测，会牺牲一个事务（报 `Deadlock found`），但**根因是「加锁顺序不一致」**——全项目统一「按 id 升序加锁」即可根治。

---

## 9. 分布式事务：跨库 / 跨服务为什么没有事务了

### 9.1 问题根源

**单库事务 = 一个 Connection 上的操作组**。一旦拆成两个服务（订单服务 + 库存服务），就是**两个数据库连接**：

```
服务A 的连接： UPDATE 订单库 ...   ← 能回滚
服务B 的连接： UPDATE 库存库 ...   ← A 根本管不到 B 的连接！
```

**没有「全局的 conn.rollback()」** —— 这就是分布式事务要解决的问题。

### 9.2 方案对比

| 方案 | 一句话 | 一致性 | 代价 |
|---|---|---|---|
| **2PC 两阶段提交** | 协调者先问全员「能提交吗」→ 都说能才提交 | 强 | 阻塞、协调者单点 |
| **TCC** | 业务层拆 Try(预留)/Confirm(确认)/Cancel(取消) 三方法 | 较强 | 每个操作写 3 个方法，侵入大 |
| **SAGA** | 每步配**补偿**动作，失败反向补偿 | 最终一致 | 补偿逻辑复杂 |
| **本地消息表 + MQ**（最常用） | 业务和「待发消息」**同一个本地事务**落库，异步投递 | 最终一致 | 有延迟窗口，需对账兜底 |

### 9.3 本地消息表 Java 代码（背下来这套思路）

```java
@Service
public class OrderService {

    /**
     * 核心：业务数据 + 消息表 在【同一个本地事务】里落库
     * 保证「要么都有，要么都没有」
     */
    @Transactional(rollbackFor = Exception.class)
    public void createOrder(Order order) {
        orderMapper.insert(order);                              // 业务数据
        outboxMapper.insert(new OutboxMessage(
                "OrderCreated", JSON.toJSONString(order), "PENDING"));
    }   // 一起 commit —— 不会出现「订单有了但消息没记下」
}

/**
 * 后台任务轮询 outbox 表，把 PENDING 消息投递 MQ
 */
@Scheduled(fixedDelay = 500)
public void publishOutbox() {
    List<OutboxMessage> pending = outboxMapper.selectPending(100);
    for (OutboxMessage msg : pending) {
        try {
            mqProducer.send(msg.getTopic(), msg.getPayload());
            outboxMapper.markSent(msg.getId());   // 投递成功才标记
        } catch (Exception e) {
            // 失败留在 PENDING，下轮重试 → 消费端要幂等！
        }
    }
}
```

**闭环 = 本地消息表（保证不丢）+ 幂等消费（保证不重复）+ 对账（最终兜底）**。

---

## 10. 最佳实践清单（贴工位那种）

1. **事务要短**：锁持有时间 = 事务时间；长事务 = 阻塞别人 + undo 膨胀 + 连接占用。
2. **绝不在事务里调外部接口**（HTTP/RPC/发短信）：外部副作用回滚不了，还会把事务拖得巨长。要发消息用本地消息表。
3. **先校验后进事务**：参数、业务规则在事务外验证，快失败。
4. `@Transactional` 一定带 `rollbackFor = Exception.class`（避坑 3.2-4）。
5. 隔离级别默认即可（MySQL RR），**不要随手 SERIALIZABLE**。
6. 并发更新要么行锁（FOR UPDATE，短），要么乐观锁 version（首选）。
7. 全项目统一**加锁顺序**（如按 id 升序）防死锁。
8. 心里默认「重试一定发生」：**任何有副作用的方法先考虑幂等**。

---

## 11. 一图总结 + 术语表

```
        ┌────────────── 事务的四个支柱 ──────────────┐
        │                                            │
   原子性 A ──→ undo log（回滚）                       │
   持久性 D ──→ redo log + WAL（先写日志后落盘）        │
   隔离性 I ──→ 锁（互斥） + MVCC（快照读）             │
   一致性 C ←── A/I/D 共同保证 + 业务约束写对            │
                                                    │
   并发问题: 脏读 / 不可重复读 / 幻读                   │
   对策:    隔离级别 RC(防脏读) → RR(防不可重复读)      │
            → SERIALIZABLE(全防) —— 性能逐级下降        │
                                                    │
   分布式:  单库事务管不到跨库                          │
   对策:    2PC 强一致 / SAGA·本地消息表 最终一致        │
          + 幂等 + 对账 兜底                            │
        └────────────────────────────────────────────┘
```

| 术语 | 一句话解释 |
|---|---|
| Connection | 程序与数据库的连接，事务的载体 |
| 自动提交 | 每条 SQL 独立成事务的默认模式 |
| ACID | 原子/一致/隔离/持久 |
| 脏读 / 不可重复读 / 幻读 | 读未提交 / 同行值变 / 行数变 |
| 隔离级别 | UR → RC → RR → SERIALIZABLE |
| undo log / redo log | 后悔药 / 重放日志 |
| WAL | 先写日志再写数据（顺序写换性能） |
| MVCC（Multi-Version Concurrency Control，多版本并发控制） | 给同一行存多个历史版本，读快照、读写互不阻塞 |
| ReadView（读取视图） | 读时生成的「谁能看见谁」的可见性名单 |
| 快照读 / 当前读 | 普通SELECT 历史 / FOR UPDATE·UPDATE 最新+加锁 |
| 传播行为 | 事务套事务时的策略（REQUIRED/REQUIRES_NEW） |
| 2PC / TCC / SAGA | 分布式事务三件套 |
| 本地消息表 | 业务+消息同库同事务，异步投递保最终一致 |

---

## 延伸阅读

- [乐观锁与悲观锁](/blog/optimistic-pessimistic-lock) — 乐观锁/悲观锁对比与现金贷案例
- [幂等](/blog/idempotency) — 同一操作执行一次和执行 N 次，结果必须一样
- [领域驱动设计（DDD）](/blog/domain-driven-design) — 先切边界再建模
- [数据库查询性能优化](/blog/db-query-performance) — 从索引到分库分表
- [数据过载与分布式改造](/blog/data-overload-distributed) — 分库分表与分布式事务概览（补充）

---

## ChangeLog

| 版本 | 日期 | 修改 |
|---|---|---|
| V1 | 2026-11-01 | 初版创建 |
| V2 | 2026-11-01 | 面向前端读者重写：补充类比表、JDBC/Spring 代码、事务失效场景、传播行为、MVCC/ReadView 详解、本地消息表 Java 实现 |
| V2.1 | 2026-11-01 | 第 2 章新增「2.0 概念分层」：澄清「数据库实现事务 vs 客户端(JDBC/Spring)发指令」的层次关系 |
| V2.2 | 2026-11-01 | 补齐 MVCC 全称（Multi-Version Concurrency Control，多版本并发控制） |
| V2.3 | 2026-11-01 | 与锁篇明确分工：篇首补充「与锁的分工 + 学习顺序」；第 8 节只给 Java 落地 |
