---
title: "Second-Party Packages Explained: From Creation to Use"
date: 2026-11-04
excerpt: "A second-party package is a Java jar shared across teams inside a company; Maven is the infrastructure that makes that private package ecosystem work. Split interfaces and DTOs into a publishable module, minimize dependencies, keep APIs stable, then mvn deploy."
category: Engineering
lang: en
series: Frontend to Full-Stack
seriesOrder: 8
---

> **A second-party package is a Java jar shared across teams inside a company** (like a private `@company/scope` package on the frontend). **Maven is the infrastructure that makes that private package ecosystem work** (package management + build + repository + publish). The creation recipe: isolate what others consume (interfaces + DTOs) into a module or repo with Maven coordinates, minimize dependencies, keep the API stable, `mvn deploy` to an internal registry, and let others depend via `<dependency>`.
>
> This piece uses frontend analogies so the jump from npm / monorepo land is easier. Business and org details are anonymized.

## 1. What is a second-party package

Industry practice splits dependencies by who writes them. Second-party is the middle class:

| Class | Who writes it | Examples | Frontend analogy |
|---|---|---|---|
| **First-party** | Modules inside this project | service / model / web modules in the same repo | Internal `packages/*` in a monorepo |
| **Second-party** | **Other teams inside the company**, published to an internal registry | `company-common-utils`, `xxx-facade`, `xxx-boot-starter` | Private `@company/scope` packages |
| **Third-party** | External open source | `fastjson`, `logback`, `jakarta.validation-api` | Public npm packages (react, lodash) |

**In one line: a second-party package is a company-internal private package, distributed through an internal Maven registry.**

A frontend command makes the mapping obvious:

```bash
tnpm install -g @company/cli --registry=https://registry.company-internal.cn
#                             ↑ private package      ↑ internal registry   ← frontend “second-party”
```

The Java counterpart:

```xml
<dependency>
    <groupId>com.company.xxx</groupId>          <!-- like @company scope -->
    <artifactId>common-utils</artifactId>        <!-- like the package name -->
    <version>1.1.0</version>                     <!-- like ^1.2.3 -->
</dependency>
```

**Typical second-party packages:**

- `xxx-facade` — an “interface definition” jar from a downstream service team. You get interfaces and DTOs only; the implementation stays invisible and is reached over RPC.
- `common-utils` / `common-log` — shared utilities / logging from a platform team.
- `xxx-boot-starter` — platform login / middleware starters.

## 2. How second-party packages relate to Maven

**Maven is not a peer concept of “second-party packages”; it is the infrastructure that makes the pattern work.** Three layers:

```
Maven = package manager + build tool + repository protocol   ← roughly the npm stack
  ├── pom.xml                 ← package.json (declare dependencies)
  ├── internal registry       ← private npm registry; stores second-party jars
  ├── resolution / transitive deps ← node_modules flattening + lockfile ideas
  └── lifecycle (compile/test/package/deploy) ← npm scripts + publish
```

### Frontend ↔ Java / Maven cheat sheet

| Frontend world | Java / Maven world |
|---|---|
| npm / tnpm | Maven / mvn |
| package.json | pom.xml |
| dependencies + versions | `<dependency>` + `<version>` |
| node_modules | `~/.m2/repository` (local cache) |
| private npm registry | company Maven registry |
| `npm publish` | `mvn deploy` (to the private registry) |
| monorepo workspace packages | multi-module modules (first-party) |
| `@scope/xxx` private packages | second-party jars (`groupId` reverse-DNS, e.g. `com.company.xxx`) |
| public react/lodash | third-party jars (fastjson/logback) |
| `^1.2.3` ranges | `<version>` + versions centralized in the parent |

### Multi-module sketch

```
parent (0.0.1-SNAPSHOT, packaging=pom)
 ├── web
 ├── service
 ├── model
 ├── facade   ← second-party module (published API)
 └── (depends on other xxx-facade, common-utils, starters…)
```

Second-party versions are often `${xxx.version}` placeholders—standard multi-module + central dependency management (declare versions in the parent’s `properties` / `<dependencyManagement>`), similar to a workspace root owning versions.

## 3. Where the code lives: three shapes

### Shape A: an in-app `facade` module (most common)

```
myapp/                           ← main application repo
├── pom.xml                      (parent: myapp-parent)
└── app/
    ├── facade/                 ← module dedicated to external publishing
    │   ├── pom.xml             (artifactId=xxx-facade, version=${facade.version})
    │   └── src/main/java/com/company/xxx/facade/rpc/
    │       └── OrderService.java   ← interface only
    ├── web/ service/ dal/      ← implementation modules
    └── bootstrap/              ← boot module
```

Three critical details in `facade/pom.xml`:

```xml
<artifactId>xxx-facade</artifactId>
<version>${facade.version}</version>       <!-- ① version independent of the app -->

<java.version>8</java.version>             <!-- ② lower target JDK for downstream compatibility -->

<dependency>
  <groupId>org.projectlombok</groupId>
  <artifactId>lombok</artifactId>
  <scope>provided</scope>                  <!-- ③ provided: not packaged; do not infect consumers -->
</dependency>
```

A pure external interface:

```java
package com.company.xxx.facade.rpc;

/** RPC interface definition */
public interface OrderService {
    String queryStatus(String orderId);
}
```

**Why a separate module and a separate version?** Because **others depend on it**:

- App upgrades must not thrash the facade API.
- Consumers depend on the “interface jar” only—not your whole service and its transitive tree.
- **Interface vs implementation**: facade holds interfaces + DTOs; implementations live in service—that is the RPC contract.

### Shape B: a dedicated repository (purest second-party)

Shared utilities / SDKs with no business context often get their **own Git repo**:

```
common-utils/                  ← standalone repo
├── pom.xml                    (groupId=com.company, artifactId=common-utils)
└── src/main/java/...
```

### Shape C: fat jar / Spring Boot Starter (advanced)

Packages like `xxx-boot-starter` auto-configure via `spring.factories` / `AutoConfiguration.imports` and light up with near-zero config. Common for platform teams; higher authoring bar.

## 4. How to create a second-party package

Example: `promotion-facade`.

### Step 1: repo and layout

```
promotion-facade/
├── pom.xml
└── src/main/java/com/company/promotion/facade/
    ├── api/PromotionQueryService.java     ← public interface
    └── model/PromotionDTO.java            ← request/response DTO (Serializable)
```

### Step 2: minimal `pom.xml`

```xml
<project>
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.company</groupId>                  <!-- reverse-DNS of the company domain -->
    <artifactId>promotion-facade</artifactId>
    <version>1.0.0-SNAPSHOT</version>               <!-- SNAPSHOT while developing; release as a fixed version -->

    <properties>
        <java.version>8</java.version>              <!-- keep low for maximum downstream reach -->
        <maven.compiler.source>8</maven.compiler.source>
        <maven.compiler.target>8</maven.compiler.target>
    </properties>

    <dependencies>
        <!-- as few as possible; DTOs often only need lombok (provided) -->
        <dependency>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId>
            <scope>provided</scope>
        </dependency>
    </dependencies>
</project>
```

### Step 3: interfaces + DTOs (the strict “door” others see)

```java
package com.company.promotion.facade.api;

/** Promotion query RPC — the only entry consumers should see */
public interface PromotionQueryService {
    PromotionDTO queryById(String id);
}
```

```java
package com.company.promotion.facade.model;

import java.io.Serializable;
import lombok.Data;

/** Query response — RPC serialization needs Serializable */
@Data
public class PromotionDTO implements Serializable {
    private static final long serialVersionUID = 1L;  // serialization compatibility anchor
    private String promotionId;
    private String name;
}
```

## 5. Publish and consume

### Publish to the internal registry

```bash
mvn clean deploy    # package + upload to the internal Maven registry (needs credentials / ACL)
```

Production usually goes through CI:

- Configure a “publish second-party package” job with `mvn release` (SNAPSHOT → release + tag + deploy).
- Registry write access for the `groupId` is typically granted by a team admin.

### How consumers depend

```xml
<dependency>
    <groupId>com.company</groupId>
    <artifactId>promotion-facade</artifactId>
    <version>1.0.0</version>
</dependency>
```

With SOFA RPC, a consumer annotates the interface with `@SofaReference` and at runtime reaches your service-side Bean that `implements PromotionQueryService`—**the interface lives in their code; the implementation runs on your machines**. That is the core value of a facade second-party package + RPC.

## 6. Rules that are special to second-party packages

| Rule | Why | Frontend analogy |
|---|---|---|
| Stable, backward-compatible APIs | Consumers rarely upgrade in lockstep; signature breaks explode downstream | Do not casually change npm package exports |
| Interfaces + DTOs only—never implementations / business logic | Implementation stays server-side; leaking it couples and bloats the jar | Ship `.d.ts` without shipping the implementation |
| Minimize dependencies; prefer `scope=provided` | Your deps become their transitive deps → jar hell | Same spirit as `peerDependencies` |
| `Serializable` + `serialVersionUID` | Hard requirement for cross-process RPC; field churn can break deserialization | Protocol-layer constraints |
| Version discipline: SNAPSHOT → release | Develop on `1.0.0-SNAPSHOT`, lock `1.0.0` when stable | next tag → formal publish |
| Keep `java.version` low (8/11) | Downstream may still run older JVMs | Conservative browserslist for a library |
| Reverse-DNS `groupId` + centralized versions | Unique coordinates; multi-module versions owned by parent | `@scope` + workspace root releases |
| Publish via pipeline + ACL | Private registries run security / compliance checks | npm publish 2FA + scoped permissions |

### The classic production incident: breaking changes

> **Never “upgrade” a second-party package by breaking field or method signatures.** Add fields/methods, deprecate old ones (`@Deprecated`), and delete only after N versions. You do not know how many consumers are running; deleting a method surfaces as a **runtime** `NoSuchMethodError` with no compile-time safety net—the most common second-party incident class.

## 7. Glossary

| Term | One line |
|---|---|
| First-party package | Dependency between modules of this project (same-repo modules) |
| Second-party package | Company-internal shared jar ≈ private `@scope/xxx` |
| Third-party package | External open-source jar (fastjson / logback, …) |
| Maven | Package management + build + repository + publish (≈ npm stack) |
| pom.xml | Maven project descriptor (≈ package.json) |
| groupId:artifactId:version | Package coordinates (≈ scope + name + version) |
| Internal Maven registry | Where second-party jars live (≈ private npm registry) |
| `mvn deploy` | Publish to the registry (≈ `npm publish`) |
| facade module | Module that publishes only interfaces + DTOs |
| SNAPSHOT | Unstable development version (≈ next tag) |
| `@SofaReference` | SOFA RPC annotation for a remote interface reference |
| Transitive dependency | Your dependencies are inherited by consumers (scope controls leakage) |

## Further reading

Related backend engineering posts: [Database transactions](/en/blog/db-transaction) · [Idempotency](/en/blog/idempotency) · [Domain-Driven Design (DDD)](/en/blog/domain-driven-design). Interface and contract boundaries also pair with how DDD exposes domain models.
