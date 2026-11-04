---
title: 二方包详解：从创建到使用
date: 2026-11-04
excerpt: 二方包是公司内跨团队共享的 Java jar；Maven 是让这套内部包生态运转的基建。把接口与 DTO 独立成可发布模块，依赖最少、接口稳定，再 mvn deploy。
category: 后端
lang: zh
---

> **二方包 = 公司内部跨团队共享的 Java jar**（等同前端 `@公司scope/xxx` 私有包）；**Maven 则是让这套内部包生态得以运转的基建**（包管理 + 构建 + 仓库 + 发布）。创建要点＝把「给别人用的部分（接口 + DTO）」独立成有 Maven 坐标的模块/仓库，依赖最少化、接口稳定化，`mvn deploy` 发布到内部私服，别人用 `<dependency>` 引用。
>
> 本文用前端视角类比 Java，方便从 npm / monorepo 世界跨过来。业务与组织信息已脱敏。

## 1. 什么是二方包

业界按「编写方」把依赖分成三类，二方包是其中第二类：

| 分类 | 谁写的 | 例子 | 前端类比 |
|---|---|---|---|
| **一方包** | 本项目内部模块 | 同仓库内的 service / model / web 模块互相依赖 | monorepo 里 `packages/*` 内部包 |
| **二方包** | **公司内部其他团队**发布到内部仓库的 jar | `company-common-utils`、`xxx-facade`、`xxx-boot-starter` | `@公司scope/xxx` 内部私有包 |
| **三方包** | 外部开源社区 | `fastjson`、`logback`、`jakarta.validation-api` | npm 公网包（react、lodash） |

**一句话：二方包 = 公司内跨团队的「私有包」，由 Maven 内部仓库分发。**

用前端命令来对照记忆：

```bash
tnpm install -g @company/cli --registry=https://registry.company-internal.cn
#                             ↑ 内部包名             ↑ 内部 registry     ← 「二方」机制的前端版
```

Java 里的对应物：

```xml
<dependency>
    <groupId>com.company.xxx</groupId>          <!-- 类似 @公司 scope -->
    <artifactId>common-utils</artifactId>        <!-- 类似包名 utils -->
    <version>1.1.0</version>                     <!-- 类似 ^1.2.3 -->
</dependency>
```

**二方包的典型实例：**

- `xxx-facade` —— 下游服务团队提供的「接口定义包」。你只拿到接口与 DTO，实现并不可见，真正调用靠 RPC。
- `common-utils` / `common-log` —— 平台基础团队的通用工具 / 日志包。
- `xxx-boot-starter` —— 平台侧的登录态 / 中间件 starter。

## 2. 二方包与 Maven 的关系

**Maven 不是「和二方包并列的东西」，而是让二方包这套玩法得以运转的基建。** 三层关系：

```
Maven = 包管理器 + 构建工具 + 仓库协议   ← 相当于 npm 全家桶
  ├── pom.xml              ← 类比 package.json（声明依赖）
  ├── 内部私服(registry)    ← 类比内部 npm registry；存二方包
  ├── 依赖解析/传递依赖     ← 类比 node_modules 扁平化 + lock
  └── 生命周期(编译/测试/打包/发布) ← 类比 npm scripts + publish
```

### 前端视角对照表

| 前端世界 | Java / Maven 世界 |
|---|---|
| npm / tnpm | Maven / mvn |
| package.json | pom.xml |
| dependencies + 版本号 | `<dependency>` + `<version>` |
| node_modules | `~/.m2/repository`（本地仓库） |
| 内部 npm registry | 公司内部 Maven 私服 |
| `npm publish` | `mvn deploy`（发布到私服） |
| monorepo 内部包（workspace） | 多模块工程的 module（一方包） |
| `@scope/xxx` 私有包 | 二方包（groupId 反域名，如 `com.company.xxx`） |
| 公网包 react/lodash | 三方包（fastjson/logback） |
| `^1.2.3` 版本范围 | `<version>` + 版本置于 parent 统一管理 |

### 多模块工程结构示意

```
parent (0.0.1-SNAPSHOT, packaging=pom)
 ├── web
 ├── service
 ├── model
 ├── facade   ← 二方包模块（对外发布接口）
 └── (声明依赖: 各 xxx-facade, common-utils, starters…)
```

二方包的版本通常写成 `${xxx.version}` 占位符——这是多模块 + 依赖集中管理的标准做法（版本统一在 parent 的 `properties` / `<dependencyManagement>` 声明），类比 npm workspace 根统一管版本。

## 3. 代码写在哪里：三种形态

### 形态 A：应用内的 `facade` 模块（最常见）

```
myapp/                           ← 主应用仓库
├── pom.xml                      (parent: myapp-parent)
└── app/
    ├── facade/                 ← 专门用于对外发布的模块
    │   ├── pom.xml             (artifactId=xxx-facade, version=${facade.version})
    │   └── src/main/java/com/company/xxx/facade/rpc/
    │       └── OrderService.java   ← 接口定义(纯 interface)
    ├── web/ service/ dal/      ← 主应用的实现模块
    └── bootstrap/              ← 启动模块
```

看 `facade/pom.xml` 的三个关键细节：

```xml
<artifactId>xxx-facade</artifactId>
<version>${facade.version}</version>       <!-- ①版本独立于主应用 -->

<java.version>8</java.version>             <!-- ②压低目标 Java 版本,保证兼容所有下游 -->

<dependency>
  <groupId>org.projectlombok</groupId>
  <artifactId>lombok</artifactId>
  <scope>provided</scope>                  <!-- ③provided: 不打进jar,不让依赖「传染」给下游 -->
</dependency>
```

一个最纯粹的对外接口：

```java
package com.company.xxx.facade.rpc;

/** RPC 接口定义 */
public interface OrderService {
    String queryStatus(String orderId);
}
```

**为什么 facade 单独一个模块、单独定版本？** 因为它**是给别人引的**：

- 主应用升级不影响 facade 的 API 稳定性
- 下游只依赖「接口 jar」，不会把你的整个服务（连同大量三方依赖）拖进来
- **接口与实现分离**：facade 里只有 interface + DTO，实现在 service 模块里——这就是 RPC 的「合同」

### 形态 B：独立仓库（最纯粹的二方包）

公共工具类、SDK 这种「无业务上下文」的包，会起**独立 Git 仓库**：

```
common-utils/                  ← 独立仓库
├── pom.xml                    (groupId=com.company, artifactId=common-utils)
└── src/main/java/...
```

### 形态 C：fat jar / Spring Boot Starter（进阶）

如 `xxx-boot-starter`——starter 形态的二方包，自带自动装配（`spring.factories` / `AutoConfiguration.imports`），引进来零配置生效。平台团队常用，开发门槛更高。

## 4. 如何创建一个二方包

以做一个 `promotion-facade` 为例。

### Step 1：建仓库与目录结构

```
promotion-facade/
├── pom.xml
└── src/main/java/com/company/promotion/facade/
    ├── api/PromotionQueryService.java     ← 对外接口(纯 interface)
    └── model/PromotionDTO.java            ← 出入参 DTO(Serializable)
```

### Step 2：pom.xml（最小骨架）

```xml
<project>
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.company</groupId>                  <!-- 反域名: 公司域名反过来 -->
    <artifactId>promotion-facade</artifactId>
    <version>1.0.0-SNAPSHOT</version>               <!-- SNAPSHOT=开发中, 发布时转正式版 -->

    <properties>
        <java.version>8</java.version>              <!-- 低版本, 最大兼容下游 -->
        <maven.compiler.source>8</maven.compiler.source>
        <maven.compiler.target>8</maven.compiler.target>
    </properties>

    <dependencies>
        <!-- 越少越好! DTO 尽量只依赖 lombok(provided) -->
        <dependency>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId>
            <scope>provided</scope>
        </dependency>
    </dependencies>
</project>
```

### Step 3：写接口 + DTO（给别人看的「门面」，规矩最严）

```java
package com.company.promotion.facade.api;

/** 促销查询 RPC 接口 —— 给下游调用方看的唯一入口 */
public interface PromotionQueryService {
    PromotionDTO queryById(String id);
}
```

```java
package com.company.promotion.facade.model;

import java.io.Serializable;
import lombok.Data;

/** 促销查询出参 —— RPC 序列化要求 Serializable */
@Data
public class PromotionDTO implements Serializable {
    private static final long serialVersionUID = 1L;  // 序列化兼容性的「版本锚点」
    private String promotionId;
    private String name;
}
```

## 5. 如何发布与使用

### 发布到内部私服

```bash
mvn clean deploy    # 打包 + 上传到内部 Maven 私服（需内部发布证书/权限）
```

正式环境通常由流水线托管：

- 在 CI / 流水线配置「发布二方包」任务，走 `mvn release`（SNAPSHOT → 正式版 + 打 tag + deploy 一条龙）
- 发布权限需在内部私服申请 groupId 写权限，一般由团队管理员开通

### 下游怎么引

```xml
<dependency>
    <groupId>com.company</groupId>
    <artifactId>promotion-facade</artifactId>
    <version>1.0.0</version>
</dependency>
```

配合 SOFA RPC，下游只要 `@SofaReference` 标注这个接口，运行时就能远程调到你 service 模块里 `implements PromotionQueryService` 的 Bean——**接口在他们的代码里，实现在你的机器上**，这是 facade 二方包 + RPC 的核心价值。

## 6. 二方包的特有要求

| 要求 | 原因 | 前端类比 |
|---|---|---|
| 接口稳定、向后兼容 | 下游引了就不会跟着升级；改签名 = 下游全炸 | npm 包不能随便改导出签名 |
| 只放接口 + DTO，绝不放实现/业务 | 实现在服务端；包里泄漏实现 = 耦合 + 体积膨胀 | 类比只发 `.d.ts` 声明不发实现 |
| 依赖最少化，`scope=provided` | 你的依赖会被「传递依赖」拖给下游，多了 = jar 地狱 | 类似 `peerDependencies` 思想 |
| `Serializable` + `serialVersionUID` | RPC 跨进程序列化硬性要求；防字段增减后反序列化崩 | RPC 协议层要求 |
| 版本纪律：SNAPSHOT → 正式 | 开发期用 `1.0.0-SNAPSHOT`，稳定后转 `1.0.0` 锁死 | 类似 next tag → 正式 publish |
| `java.version` 压低（8/11） | 下游可能仍在低版本 JVM | 类比库的 browserslist 要保守 |
| groupId 反域名 + 版本集中管理 | 唯一坐标不冲突；多模块版本在 parent 统一管 | 类似 `@scope` + workspace 根发版 |
| 发布走流水线 + 权限申请 | 内部私服有安全扫描、合规检查 | 类似 npm publish 2FA + scoped 权限 |

### 最经典的线上事故：破坏性变更

> **升级二方包，绝不能用「改字段 / 改方法签名」这种破坏性变更。** 正确姿势是「加新字段 / 新方法、废弃旧方法（`@Deprecated`）、保留 N 个版本后再删」。因为你不知道多少下游在跑，删了它们的 class 一加载就 `NoSuchMethodError`，且这个错是**运行期**才炸（没有编译期保护）——这是二方包事故最常见的来源。

## 7. 词条墙

| 术语 | 一句话 |
|---|---|
| 一方包 | 本项目内部模块间的依赖（同仓库 module） |
| 二方包 | 公司内部跨团队共享的 jar，等同 `@scope/xxx` 私有包 |
| 三方包 | 外部开源社区的 jar（fastjson / logback 等） |
| Maven | 包管理 + 构建 + 仓库 + 发布的基建（≈ npm 全家桶） |
| pom.xml | Maven 工程描述文件（≈ package.json） |
| groupId:artifactId:version | 二方包的「坐标」（≈ scope + 包名 + 版本） |
| 内部 Maven 私服 | 存二方包的内部仓库（≈ 内部 npm registry） |
| `mvn deploy` | 发布二方包到私服（≈ `npm publish`） |
| facade 模块 | 专门对外发布「接口 + DTO」的模块 |
| SNAPSHOT | 开发中不稳定版本（≈ next tag） |
| `@SofaReference` | SOFA RPC 注解，标注远程接口引用 |
| 传递依赖 | 你的依赖会被下游间接继承（scope 影响它是否外泄） |

## 相关阅读

同属后端工程化：[数据库事务](/blog/db-transaction) · [幂等](/blog/idempotency) · [领域驱动设计（DDD）](/blog/domain-driven-design)。接口与契约边界，也可对照 DDD 里对领域模型外露方式的讨论。
