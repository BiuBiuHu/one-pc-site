---
title: Java 语言地基与面向对象精髓（前端同学转型版）
date: 2026-11-09
excerpt: 用 TypeScript / JavaScript 当迁移锚点，一次把 Java 语法、面向对象、集合、异常、泛型、Stream 讲成体系。语言篇。
category: 后端
lang: zh
series: 全栈工程
seriesOrder: 1
---

> **语言篇**。面向对象：已经熟练使用 TypeScript / JavaScript 的前端同学，用已有认知当「迁移锚点」，把转型后端必备的 Java 语法与面向对象一次讲成体系。
>
> 一句话总纲：**Java 是强类型、编译期检查的语言；运行时是 JVM，集合替代了日常数组操作，异常更重，还能在运行时反射。** 对照 TypeScript 是为了迁移，不是说两边语义完全等价。
>
> **本四篇**：本文（语言）→ [Spring 框架](/blog/spring-boot-for-frontend/) → [Bean 进阶](/blog/spring-bean-for-frontend/) → [契约](/blog/api-contract-for-frontend/)。专栏里事务 / 锁 / 幂等等文章可以后读。

---

## 0. 认知映射：先换执行环境和类型系统

别把 Java 当成完全陌生的语言。共享的是「用类型约束代码、用对象组织行为」；要换掉的是执行环境和类型规则。

| 前端 | Java | 迁移时怎么理解 |
|---|---|---|
| 浏览器解析并跑 JS | **JVM** | `javac` 把源码编成 `.class` 字节码，再交给 JVM 执行 |
| TypeScript 静态类型 | Java 原生静态强类型 | TS 习惯能迁过来，Java 更「死板」，没有结构性兼容那么松 |
| `number` | `int` / `double` 等 | JS `number` 是 IEEE 浮点；Java 整数和浮点是分开的 |
| `boolean` / `string` | `boolean` / `String` | `String` 是引用类型，不是基本类型 |
| `class` / `constructor` | `class` / 构造器 | 写法接近 |
| TS `interface` | `interface` / 抽象类 | 都是契约；Java 还有「半成品父类」抽象类 |
| `===` | 基本类型用 `==`，对象内容用 `equals` | 对象 `==` 比的是引用 |
| `const` | `final` | 都是「这个名字不能再指向别的」；`final` 引用的对象内部仍可能变 |
| ES module `import` | `package` + `import` | 组织代码的方式 |
| `map` / `filter` / `reduce` | Stream `map` / `filter` / `collect` | 链看起来像，执行模型是惰性的 |

编译路径可以记成：

```
.java  ──javac──►  .class（字节码）  ──JVM──►  运行
```

对照只是辅助。**不要把「TS 编译掉类型」和「JVM 加载字节码」当成同一件事。**

两条心智切换：

1. **类型错误多半在编译期就失败**，更像开了严格模式的 TS，不像裸 JS 跑到那一行才炸。
2. **内存由 GC 管**。你不能 `free`，也少了前端那种「忘了清定时器」的手动回收；泄漏改成「还被静态集合 / 监听器抓着」。

---

## 1. 基本语法

### 1.1 变量

```java
int age = 30;
double price = 9.9;
boolean isOk = true;
String name = "Tom";          // 引用类型
final int MAX = 100;          // 不能再赋值
var other = "局部推断";        // Java 10+ 局部变量类型推断，不是动态类型
```

`var` 只是让编译器在**这一行**把类型写出来：`other` 仍然是 `String`，后面不能赋 `int`。它不是 JS 的运行时变类型。

### 1.2 控制流和块作用域

```java
if (age > 18) {
    // ...
} else if (age > 12) {
    // ...
} else {
    // ...
}

for (int i = 0; i < 10; i++) { /* ... */ }

for (String s : list) { /* 增强 for，接近 for...of */ }

while (running) { /* ... */ }

switch (name) {
    case "a":
        break;
    default:
        break;
}
```

花括号是块作用域。`for` 里声明的 `i` 出了循环就没了。Java 没有 JS 那种函数级 `var` 提升。

---

## 2. 类与对象

```java
public class User {
    private String name;
    private int age;

    public User(String name, int age) {
        this.name = name;
        this.age = age;
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String describe() {
        return name + " / " + age;
    }
}

User a = new User("Ada", 30);
User b = a;           // 复制的是引用，不是深拷贝
b.setName("Bob");     // a.getName() 也变成 Bob
```

字段默认建议 `private`，通过方法进出——这就是封装的最小形态。

Lombok 在**编译期**生成样板，不是运行时魔法：

```java
@Data
@AllArgsConstructor
@Builder
public class User {
    private String name;
    private int age;
}
```

`@Data` 大约等于 getter/setter/`equals`/`hashCode`/`toString`。你完全可以手写。Java 16+ 的 `record` 适合不可变数据载体，这里不展开成主路径。

---

## 3. 面向对象

### 3.1 封装：存钱只接受正数；金额不要用 `double`

```java
import java.math.BigDecimal;

public class BankAccount {
    private BigDecimal balance = BigDecimal.ZERO;

    public void deposit(BigDecimal amount) {
        if (amount == null || amount.signum() <= 0) {
            throw new IllegalArgumentException("amount must be positive");
        }
        balance = balance.add(amount);
    }
}
```

教学示例用 `BigDecimal` 或「分」这种最小货币单位。**生产里不要用 `double` 做金融金额**：`0.1 + 0.2` 对不上 `0.3`。

### 3.2 四个访问修饰符

| 修饰符 | 本类 | 同包 | 跨包子类 | 其他包路人 |
|---|---|---|---|---|
| `private` | 能 | 不能 | 不能 | 不能 |
| 默认（包可见） | 能 | 能 | **不能** | 不能 |
| `protected` | 能 | 能 | 能（通过自己的类型） | 不能 |
| `public` | 能 | 能 | 能 | 能 |

容易错的两点：

- **默认不是 protected**。别的包里的子类拿不到包可见成员。
- **跨包的 `protected`**：子类能用在自己（`this`、本类类型的引用）上；不能拿着父类类型的「别人的实例」随便摸。

### 3.3 继承与 `@Override`

```java
public class Animal {
    public String speak() { return "..."; }
}

public class Dog extends Animal {
    @Override
    public String speak() { return "woof"; }
}
```

重写时：签名要兼容；返回类型可以协变（子类型）；**不能把可见性收紧**（`public` 不能改成 `protected`）；受检异常不能比父方法更宽。

重载（overload）是同一类里同名不同参数列表，编译期按实参选择，和重写不是一回事。

### 3.4 多态：父类引用、子类实现

```java
public interface PayService {
    void pay(long amountCents);
}

public class AliPayService implements PayService {
    public void pay(long amountCents) { /* 支付宝渠道 */ }
}

public class WechatPayService implements PayService {
    public void pay(long amountCents) { /* 微信渠道 */ }
}

void checkout(PayService pay, long amountCents) {
    pay.pay(amountCents);   // 编译期看接口，运行期走真正的实现
}
```

Java 是**名义类型**：实现了接口才算；TS 更接近结构类型（形状对上就能赋）。不要说「Java 的多态就是鸭子类型」。

---

## 4. 集合

常用接口和实现：

| 接口 | 常见实现 | 怎么记 |
|---|---|---|
| `List` | `ArrayList`（默认）、`LinkedList` | 有序、可重复 |
| `Set` | `HashSet`、`LinkedHashSet` | 去重 |
| `Map` | `HashMap`、`TreeMap` | 键值 |
| `Queue` | `ArrayDeque` | 双端队列，一般别再用遗留 `Stack` |

```java
List<String> names = new ArrayList<>();
names.add("Ada");
names.get(0);
names.size();          // 集合用 size()
names.forEach(System.out::println);

String[] arr = { "a", "b" };
int n = arr.length;    // 数组才是 length，也支持 arr[i]
```

`LinkedList` **按下标找节点是 O(n)**。只有你已经拿着那个节点、或在迭代器上局部改前后指针时，插入删除才是 O(1)。**不要笼统说「中间插入 LinkedList 更快」**——按索引插同样要先走到那。

```java
Map<String, Integer> ages = new HashMap<>();
ages.put("Ada", 30);
ages.get("Ada");
ages.containsKey("Ada");
for (Map.Entry<String, Integer> e : ages.entrySet()) {
    // e.getKey() / e.getValue()
}
```

`HashMap` 的 key 必须同时遵守 **`equals` 与 `hashCode` 契约**：相等的对象哈希必须相同。只改 `equals` 不改 `hashCode` 会让对象「找不回自己」；这是契约违反，**不是「每次运行都必现失败」**。冲突后的链表 / 红黑树是实现细节，这里不展开成源码课。

无序 / 保插入序 / 排序：`HashMap` 不保证顺序；`LinkedHashMap` 保插入（或访问）序；`TreeMap` 按比较器排序。

`map.get(missing)` 得到 `null`。写成 `int age = ages.get("missing");` 会拆箱 NPE。

`Set` 去重、`contains` 平均 O(1)（哈希实现），同样依赖 `equals`/`hashCode`。

---

## 5. String 与装箱拆箱

`String` 不可变。循环里反复 `s = s + chunk` 会造很多中间对象，用 `StringBuilder`：

```java
StringBuilder sb = new StringBuilder();
for (int i = 0; i < items.size(); i++) {
    sb.append(items.get(i));
}
String text = sb.toString();
```

**不要说「所有 `+` 都必先新建对象」**，也不要说「JS 引擎会优化、Java 完全不会」。编译器对编译期常量、少量 `+` 会改写成 `StringBuilder`；热循环里自己写仍然更清楚。

```java
int x = 3;
Integer boxed = x;          // 装箱
int y = boxed;              // 拆箱
Integer missing = null;
// int z = missing;         // NPE
```

`List<Integer>` 可以，`List<int>` 不行：泛型参数必须是引用类型。JS 的 `number` 是原始值，**不是「所有 number 都对象化了」**。

---

## 6. 异常

```
Throwable
├── Error          // 一般别捕：OutOfMemoryError 等
└── Exception
    ├── RuntimeException 及子类   // 非受检：NPE、ClassCastException、ArithmeticException
    └── 其它（受检）：IOException、SQLException …
```

受检异常必须 `catch` 或在方法上 `throws`。`RuntimeException` 不强制。

```java
try (InputStream in = Files.newInputStream(path)) {   // try-with-resources，AutoCloseable
    // 读
} catch (FileNotFoundException e) {   // 子类在前
    // ...
} catch (IOException e) {
    // ...
} finally {
    // 关闭以外的收尾；资源本身由 try-with-resources 关
}
```

**`finally` 不是任何情况下都会跑**：JVM 被 `kill -9`、`System.exit`、断电，没有机会执行。正常的 return / 异常路径会进 `finally`。

TS/JS 不强制你 `catch` Promise；Java 受检异常是编译器强制的「违约要处理」。

---

## 7. 泛型

```java
public class Box<T> {
    private T value;
    public T get() { return value; }
    public void set(T value) { this.value = value; }
}

List<String> names = new ArrayList<>();
List<Integer> nums = new ArrayList<>();
```

运行时 `names.getClass() == nums.getClass()`，都是 `ArrayList`——这是**类型擦除**。TS 的类型同样主要在编译期。可以说「两边都偏编译期检查」，**不要先说完全不同，再偷偷当成完全等价**。

擦除不是「一律拿不到泛型」：反射仍能读到部分**声明处**的签名（例如字段 `List<String> tags` 的 `AnnotatedType` / `getGenericType`）。对 `new ArrayList<String>()` 这种用法位置，运行时确实没有 `String`。

---

## 8. 接口、抽象类、SOLID

```java
public interface Payable {
    void pay(long amountCents);

    default String currency() {     // Java 8+
        return "CNY";
    }

    static Payable noop() {         // Java 8+
        return amount -> { };
    }
}
```

Java 9 起接口还可以有 `private` 方法，给 `default` 复用。接口字段默认是 `public static final` 常量。

| | 接口 | 抽象类 |
|---|---|---|
| 继承 | 一个类可实现多个 | 只能单继承 |
| 定位 | 能力契约 | 共同实现的骨架 |
| 状态 | 主要是常量 | 可以有实例字段 |

SOLID 各管一件事，开闭**不是「旧代码永远不许改」**：

| 字母 | 意思 | 落地一句话 |
|---|---|---|
| S | 单一职责 | 一个类一条变化理由 |
| O | 开闭 | 优先扩展，而不是把旧类改成瑞士军刀；合理重构仍要发生 |
| L | 里氏替换 | 子类要能当父类用，别偷偷收紧契约 |
| I | 接口隔离 | 别强迫调用方依赖用不到的方法 |
| D | 依赖倒置 | 依赖抽象（接口），不要依赖具体实现——Spring 注入就是这条的工程化 |

---

## 9. Lambda 与 Stream

只有**一个抽象方法**的接口是函数式接口，才能用 lambda：

```java
@FunctionalInterface
interface Calculator {
    int calc(int a, int b);
}

Calculator add = (a, b) -> a + b;
```

lambda **不是**匿名内部类的语法糖全集：`this` 指向外围类，不是那个「假对象」；捕获的局部变量必须是 effectively final。

```java
List<Integer> nums = List.of(-1, 2, 3);
List<Integer> doubled = nums.stream()
    .filter(n -> n > 0)
    .map(n -> n * 2)
    .collect(Collectors.toList());

int sum = nums.stream().mapToInt(Integer::intValue).sum();
int max = nums.stream().mapToInt(Integer::intValue).max().orElse(0);
```

记住四件事：

1. 中间操作**惰性**，碰到终止操作（`collect` / `sum` / `forEach`）才跑。
2. 一条流**只能消费一次**。
3. Stream **不是**天然纯函数，也不是深度不可变快照。
4. **不要依赖「中间操作一定执行」来做副作用**（打日志、改外部变量）；需要副作用就用终止操作，并接受并行流时顺序不保证。

---

## 10. 练习

**练习 A**：`Book(title, price, author)`。`List<Book>` 筛 `price > 50`，按价格排序，再收成 `Map<title, Book>`。标题重复时要有策略：例如后者覆盖，或直接失败。

```java
Map<String, Book> byTitle = books.stream()
    .filter(b -> b.getPrice().compareTo(new BigDecimal("50")) > 0)
    .sorted(Comparator.comparing(Book::getPrice))
    .collect(Collectors.toMap(Book::getTitle, b -> b, (a, b) -> b)); // 重名：后者覆盖
```

**练习 B**：`Payable` 两个实现，用接口类型传入同一个结算方法——就是第 3 节的多态。

---

## 11. 自测

<details>
<summary>1. <code>new String("hi")</code> 两次，<code>==</code> 和 <code>equals</code> 分别怎样？JS 呢？</summary>

两个引用 <code>==</code> 为 false（堆上两个对象），<code>equals</code> 为 true（内容相同）。JS 原始字符串 <code>===</code> 按值；对象（<code>new String('hi')</code> 那种包装，日常不要用）<code>===</code> 按身份。
</details>

<details>
<summary>2. HashMap 的 key 只改 <code>equals</code> 不改 <code>hashCode</code>，一定每次都失败吗？</summary>

违反契约。常见后果是 put 进去 get 不出来。哈希碰巧撞到同一桶时「看起来还能用」，所以不是绝对每次失败——这正是这类 bug 难查的原因。
</details>

<details>
<summary>3. <code>Integer x = null; int y = x;</code> 会怎样？</summary>

拆箱 NPE。
</details>

<details>
<summary>4. <code>PayService p = new AliPayService(); p.pay(1);</code> 编译期和运行期分别看谁？</summary>

编译期按 <code>PayService</code> 检查有没有 <code>pay</code>；运行期走 <code>AliPayService</code> 的实现。
</details>

<details>
<summary>5. <code>list.stream().filter(x -&gt; { System.out.println(x); return true; })</code> 没有终止操作，会打印吗？</summary>

不会。中间操作惰性，没有 <code>collect</code> / <code>forEach</code> 等终止操作就不执行。
</details>

---

## 12. 术语表

| 术语 | 一句话 |
|---|---|
| JVM | 跑字节码的虚拟机 |
| JDK | 开发工具包（编译器 + JVM + 标准库） |
| bytecode | `.class` 里的指令，不是源码也不是具体 CPU 指令 |
| 封装 / 继承 / 多态 | 藏细节 / 复用并特化 / 同一调用走不同实现 |
| 重写 / 重载 | 运行期替换实现 / 编译期按参数列表选方法 |
| 接口 / 抽象类 | 能力契约 / 可带骨架的单继承父类 |
| 泛型与擦除 | 编译期约束；运行时多数类型参数被擦掉，声明处仍可能可读 |
| 装箱拆箱 | `int` ↔ `Integer`；拆 `null` 会 NPE |
| 受检 / 非受检异常 | 编译器强制处理 / `RuntimeException` 一族 |
| Stream / Lambda | 惰性管道 / 函数式接口的简写 |
| HashMap / ArrayList | 哈希表 / 动态数组 List |
| StringBuilder | 可变字符串缓冲区 |
| 不可变 | 对象内容不能改（`String`）。**不可变 ≠ 任何复合使用都自动线程安全**（你仍可能用可变集合把它们装在一起乱改） |
| Lombok | 编译期生成样板 |
| SOLID | 五条设计原则；D 是 IoC 的哲学来源 |

---

## 下一篇

语言能力齐了。下一篇把视角抬到框架：[从 Spring 到 Spring Boot](/blog/spring-boot-for-frontend/)（框架篇）。随后是 [Bean 进阶](/blog/spring-bean-for-frontend/) 和 [前后端契约](/blog/api-contract-for-frontend/)。Maven 坐标和二方包见专栏已有的 [二方包详解](/blog/maven-second-party-package/)。
