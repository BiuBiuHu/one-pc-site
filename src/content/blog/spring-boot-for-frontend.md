---
title: 从 Spring 到 Spring Boot —— 一套能支撑真实后端业务的框架体系
date: 2026-11-09
excerpt: 用前端认知理解 IoC、Bean、MVC、MyBatis、事务和 AOP，并落到一份可对照的 Spring Boot 分段示例。框架篇。
category: 后端
lang: zh
series: 全栈工程
seriesOrder: 2
---

> **框架篇**。上一篇打通了 [Java 语言](/blog/java-language-for-frontend/)。这一篇把视角从「写 Java」抬到「用框架搭后端」。
>
> 一句话总纲：**Spring Framework 是容器 + MVC + AOP 这些能力；Spring Boot 是在这之上的自动配置、依赖管理和可执行打包。** Boot 不是「只会生成目录的脚手架」。
>
> 文中代码是**脱敏教学示例**，分段示意，不是一份可复制即跑的完整仓库。

---

## 0. Spring Framework 和 Spring Boot

| | Spring Framework | Spring Boot |
|---|---|---|
| 是什么 | IoC、AOP、MVC 等能力的框架 | 基于 Framework 的工程体系：自动配置、starter、依赖 BOM、内嵌容器 |
| 配置 | Java 配置或 XML 都可以 | 约定优于配置 + `application.yml` |
| 打包 | 可以 war 丢进外置 Tomcat | 默认 `java -jar` 内嵌 Tomcat；**也可以打 war** |

Framework **不是必须 XML / war**。Boot 也不是「纯脚手架」：它仍然跑着 Framework，只是帮你把大量样板配置做成条件装配。

```java
@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
```

`@SpringBootApplication` 是三个注解的组合：

- `@SpringBootConfiguration`：这是一个配置类
- `@EnableAutoConfiguration`：按 classpath 上的 starter 自动装配
- `@ComponentScan`：扫描**启动类所在包及其子包**

下文示例按 **Java 17+**、**Spring Boot 4.1.2**（2026-10 前后的稳定线）。版本请用 parent / BOM 锁死，不要写 `3.x.x` 这种不可构建号。

---

## 1. IoC 与依赖注入

**控制反转（IoC）**：谁构造对象、谁管生命周期，从业务代码交给容器。

**依赖倒置（DIP）** 是设计原则：依赖抽象。IoC 是实现手段之一。**不要把 IoC 和 DIP 画等号**。按类型注入「接口」是 DIP 的常见落地，但容器本身还可以注入具体类。

```java
@Service
public class OrderService {
    public void place(String orderId) { /* ... */ }
}

@RestController
public class OrderController {
    private final OrderService orderService;

    // 推荐：构造器注入。只有一个构造器时不必写 @Autowired
    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }
}
```

字段注入能跑，**不推荐**（测试难、循环依赖更藏得住）：

```java
@Autowired
private OrderService orderService; // 能用，日常别当默认
```

前端类比：自己到处 `new` 像层层 props；容器注入更像「从 Context 取已经构造好的依赖」。类比到此为止，**Context 不是 IoC 容器的定义**。

---

## 2. Bean 定义、注解语义、作用域、生命周期

`@Component` 是通用登记。派生注解带**额外框架语义**，不能当成可以任意互换的别名：

| 注解 | 语义 |
|---|---|
| `@Component` | 普通组件 |
| `@Service` | 业务服务（文档/分层约定） |
| `@Repository` | 持久化；在启用异常翻译时，部分数据访问异常会转成 Spring 的 `DataAccessException` |
| `@Controller` | MVC 控制器，返回视图名或配合 `@ResponseBody` |
| `@RestController` | `@Controller` + `@ResponseBody`，方法返回值走 HTTP 消息转换（常见是 JSON） |

默认作用域 **singleton**：每个容器、每个 Bean **定义**一份实例，不是「JVM 全球唯一一份」。`prototype` 是每次向容器 `getBean` 都新造。

**单例实例字段不能存「当前请求的用户」**。多线程会串号。请求数据放方法参数、或 `request` 作用域（见 [Bean 进阶](/blog/spring-bean-for-frontend/)）。

生命周期（心智顺序，代理 / `BeanPostProcessor` 从略）：

1. 实例化
2. 注入依赖
3. 初始化（`@PostConstruct`、`InitializingBean`）
4. 可用
5. 销毁（`@PreDestroy`）——**prototype 不会被容器完整跟踪销毁**，调用方自己管

`@PostConstruct` 不是 React `useEffect`：它在 Bean 初始化时跑一次，没有「依赖数组」和卸载对称。

Bean 的「类 vs 实例 vs 容器」下一篇专门挖。

---

## 3. Spring MVC

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable long id,
                        @RequestParam(required = false) String lang) {
        return orderService.find(id, lang);
    }

    @PostMapping
    public OrderDto create(@Valid @RequestBody CreateOrderForm form) {
        return orderService.create(form);
    }
}
```

- GET：路径变量、query。**不要把 GET + JSON body 当成普遍可用的约定**，缓存和中间件经常不理 body。
- POST：`@RequestBody` 映射 JSON。
- 分层：Controller → Service → Repository / Mapper，或 Controller → Manager → RPC 门面。
- **生产请求不要直接用实体当入参**。用 Form / DTO；出参用 DTO / VO。`@Valid` 做参数校验。

---

## 4. 反射（对照，不是 90% 时间都在反射）

```java
Class<?> clazz = Class.forName("demo.User");
Object obj = clazz.getConstructor(String.class).newInstance("Ada");
Method m = clazz.getMethod("getName");
Object name = m.invoke(obj);
```

前端对照是**不同角度**：

| JS | 在对照什么 | 别引申成 |
|---|---|---|
| `obj[key]` | 运行时按名取值 | 「这就是 Spring」 |
| `Reflect.get(target, key, receiver)` | 保留 `receiver`，getter 里的 `this` 才对 | 「Reflect 天然绕过一切代理」 |
| `new Proxy(target, handler)` | 拦截读写 | handler 里 `target[key]` **不必**再套一层递归代理 |

Spring 读注解、选构造器、设字段，确实常用反射；同时还有字节码元数据扫描、工厂方法、AOT 等。**不能说「没有反射，注解就是死注释」**——编译期处理、索引、原生镜像都可能让注解在别的阶段生效。`setAccessible` 还受模块边界限制，不是万能后门。

动态代理两边都要认识：

- **JDK Proxy**：基于接口
- **CGLIB**（以及 Boot 里常见的类代理实现）：子类化具体类

横切的是「经过代理对象的调用」。`final` 方法、`this.foo()` 自调用、不是接口方法的 JDK Proxy，都可能切不到。**不要一刀切「反射一定慢到不能用」**——成本在于量级和是否热路径，不在于「用了反射」四个字。

---

## 5. Maven 对 npm

| Maven | 约等于 | 不等于 |
|---|---|---|
| `pom.xml` 坐标 `groupId:artifactId:version` | package.json 的 name + version | |
| 依赖 + 构建 | npm 脚本 + lock | |
| `mvn package` | 打出 jar/war | |
| `mvn install` | **构建并装进本地 Maven 仓库**（`~/.m2`） | **不是** `npm install` 的等价物 |
| starter | 一组依赖 + 自动配置 | 只是多几个 jar |

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>4.1.2</version>
</parent>
<properties>
  <java.version>17</java.version>
</properties>
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
</dependencies>
```

二方包、私服、facade 模块见 [二方包详解](/blog/maven-second-party-package/)。

---

## 6. 配置

```yaml
# application.yml —— 教学示例，密码用环境变量，不要提交密钥
server:
  port: 8080
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/demo
    username: ${DB_USER}
    password: ${DB_PASSWORD}
app:
  name: order-bff
```

- `@Value("${app.name}")` 注单个值。
- `@ConfigurationProperties(prefix = "app")` 绑一组；需要注册为 Bean（`@EnableConfigurationProperties` 或 `@ConfigurationPropertiesScan` / 配置类上的 `@Component`）。

profile：`application.yml` 放公共项，`application-dev.yml` / `application-prod.yml` 覆盖。后端密钥**不要**打进前端 bundle。

---

## 7. 数据库访问：JDBC / MyBatis / JPA

| | 你写什么 | 别混淆 |
|---|---|---|
| JDBC | SQL + 手工映射 | 最底层 |
| MyBatis | SQL 映射到方法 | **不是**完整 ORM |
| JPA / Hibernate | 实体 + 对象图 | ORM |

MyBatis 示例（脱敏教学）：

```java
@Mapper
public interface UserMapper {
    @Select("SELECT id, name FROM users WHERE id = #{id}")
    UserRow findById(long id);

    @Insert("INSERT INTO users(name) VALUES(#{name})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(UserRow row);
}
```

- `#{id}` 是**参数绑定**（PreparedStatement）。
- `${id}` 是字符串拼接，有 SQL 注入风险，只留给不得不拼标识符的少数场景。
- `@Mapper` 或启动类 `@MapperScan` 会注册 mapper **代理 Bean**。**不必再加 `@Repository` 才能注入。** `@Repository` 也**不能替代** MapperScan。
- SQL 执行会用到解析和缓存，**不是每次语句都从零全量反射**。

### 7.2 事务

```java
@Service
public class TransferService {
    private final AccountMapper accountMapper;

    public TransferService(AccountMapper accountMapper) {
        this.accountMapper = accountMapper;
    }

    @Transactional
    public void transfer(long fromId, long toId, long amountCents) {
        accountMapper.deduct(fromId, amountCents);
        accountMapper.add(toId, amountCents);
    }
}
```

金额用 `long`（分）或 `BigDecimal`，类型写清楚。

要点：

- 这是**本库本地事务**。RPC 出去的副作用，数据库回滚**带不回来**。
- 默认只对 `RuntimeException` / `Error` 回滚；受检异常要 `rollbackFor = Exception.class`。更细的失效场景见 [数据库事务](/blog/db-transaction/)。
- **同类自调用**（`this.foo()`）不会经过代理，**不会新开**事务增强。如果外层已经有事务，这几次 SQL 仍可能待在那条连接里——**不能绝对说「自调用一定没事务」**。推荐拆到另一个 Bean；不要把 `self` 注入当成默认教法。
- 异常被 `catch` 吞掉、或丢到别的线程 / `@Async`，事务边界都会断。

---

## 8. AOP

统一日志、鉴权、事务、耗时，都可以切，**不是只对 `@Service` / `@Repository` 生效**。生效条件是：调用走代理，且切点匹配。

```java
@Aspect
@Component
public class AccessLogAspect {
    @Around("@annotation(demo.Audited)")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        long t0 = System.nanoTime();
        try {
            return pjp.proceed();
        } finally {
            // 异常路径也要记；不要只在 proceed 成功后打点
            long ms = (System.nanoTime() - t0) / 1_000_000;
            log.info("{} {}ms", pjp.getSignature(), ms);
        }
    }
}
```

需要 `spring-boot-starter-aop`（或等价依赖）。JDK / CGLIB 边界同第 4 节：自调用、`final`、接口代理范围。

---

## 9. 响应信封（教学用 `ApiResult<T>`）

不要用一堆互相矛盾的 `success` / `failed` / `unknown` 布尔。用一个三态：

```java
public enum ResultCode { SUCCEEDED, FAILED, UNKNOWN }

public record ApiResult<T>(
        ResultCode resultCode,
        String errorCode,
        String errorMsg,
        T data
) {
    public static <T> ApiResult<T> success(T data) {
        return new ApiResult<>(ResultCode.SUCCEEDED, null, null, data);
    }
    public static <T> ApiResult<T> fail(String errorCode, String errorMsg) {
        return new ApiResult<>(ResultCode.FAILED, errorCode, errorMsg, null);
    }
    public static <T> ApiResult<T> unknown(String errorCode, String errorMsg) {
        return new ApiResult<>(ResultCode.UNKNOWN, errorCode, errorMsg, null);
    }
}
```

`GlobalExceptionHandler` 要把超时、下游未决收成 **UNKNOWN**，不能所有异常都变成 FAILED。HTTP 状态和业务信封是两层：**不是**「永远 200 才叫规范」。契约篇会把前端解包写完整。

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(TimeoutException.class)
    public ResponseEntity<ApiResult<Void>> timeout(TimeoutException e) {
        return ResponseEntity.status(504)
                .body(ApiResult.unknown("TIMEOUT", "downstream timeout"));
    }
}
```

---

## 10. 最小闭环（分段示意）

下面几段放在一起能看出链路，**不是**声称仓库里有完整可复制项目。

```java
public record UserForm(@NotBlank String name) {}
public record UserDto(long id, String name) {}

@RestController
@RequestMapping("/api/users")
public class UserController {
    private final UserService userService;
    public UserController(UserService userService) { this.userService = userService; }

    @PostMapping
    public ApiResult<UserDto> create(@Valid @RequestBody UserForm form) {
        return ApiResult.success(userService.create(form));
    }
}

@Service
public class UserService {
    private final UserMapper userMapper;
    public UserService(UserMapper userMapper) { this.userMapper = userMapper; }

    @Transactional
    public UserDto create(UserForm form) {
        UserRow row = new UserRow();
        row.setName(form.name());
        userMapper.insert(row);          // useGeneratedKeys → row.id
        return new UserDto(row.getId(), row.getName());
    }
}
```

对应表结构示意：`users(id PK AUTO_INCREMENT, name VARCHAR)`。启动类、`application.yml`、mapper 扫描见上文各节。

---

## 11. 学习路径

JDK 语法 → starter 起服务 → Controller CRUD → 分层 → 配置 / profile → MyBatis → 事务 → 异常与信封 → 再回头看代理和自动配置。Bean 原理见下一篇。

---

## 12. 速记

- Boot = Framework + 自动配置 + starter + 可执行 jar，不是纯脚手架。
- 构造器注入；单例别存请求状态。
- `#{ }` 绑定，`${ }` 拼接。
- 本地事务回滚不了 RPC。
- AOP 看代理，不看注解家族迷信。

---

## 13. 自测

<details>
<summary>1. IoC 解决什么？它等于 DIP 吗？</summary>

解决「谁 new、谁组装、谁管生命周期」。DIP 是依赖抽象的设计原则。IoC 容器常被用来落实 DIP，但两者不是同一个定义。
</details>

<details>
<summary>2. 单例 Bean 里用实例字段存当前登录用户会怎样？</summary>

多请求共享一份实例，会串号。用户状态放参数或 request 作用域。
</details>

<details>
<summary>3. 同类里 <code>this.save()</code> 调带 <code>@Transactional</code> 的方法，一定没有事务吗？</summary>

不会走「新的」事务代理增强。若外层已经在事务里，这些 SQL 仍可能属于那条事务。不能说绝对无事务。
</details>

<details>
<summary>4. Framework 和 Boot 谁必须 XML、谁必须 war？</summary>

都不是。Framework 可用 Java 配置；Boot 默认可执行 jar，也可以 war。
</details>

<details>
<summary>5. AOP 是不是只对 Service / Repository 生效？</summary>

不是。切点匹配且调用走代理即可。Controller、自定义 <code>@Aspect</code> 都能切。自调用、final、JDK Proxy 的接口边界会切不到。
</details>

---

## 14. 术语表

| 术语 | 一句话 |
|---|---|
| IoC / DI | 容器管对象；把依赖交给你 |
| Bean | 容器管理的对象（下一篇展开） |
| `@Component` 家族 | 登记方式不同、框架钩子不同 |
| singleton / prototype | 每定义一份 / 每次 get 一份 |
| `@RestController` | JSON API 控制器 |
| starter | 依赖集合 + 自动配置 |
| `application.yml` / profile | 配置与环境 |
| `@Value` / `@ConfigurationProperties` | 单个值 / 一组属性 |
| MyBatis `@Mapper` | SQL 映射接口，扫描后成为代理 Bean |
| `@Transactional` | 本地事务边界 |
| AOP / 代理 | 横切；JDK 接口代理与类代理 |
| `ApiResult` | 教学用业务信封 |
| `@SpringBootApplication` | 配置 + 自动配置 + 扫描 |
| 反射 | 运行时读结构；不是 Spring 的全部 |

---

上一篇：[Java 语言地基](/blog/java-language-for-frontend/) · 下一篇：[Spring Bean 进阶](/blog/spring-bean-for-frontend/) · 契约：[前后端对接闭环](/blog/api-contract-for-frontend/)
