---
title: "手写流式输出"
date: 2026-11-25
excerpt: "SSE 是什么？流式数据怎么从服务器传过来？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 7
---

> 目标：不依赖 ai SDK，用原生 fetch + ReadableStream 手写 SSE 解析，彻底理解 streamText 的底层实现

---

## 背景

第五课我们用 `response.json()` 等待完整响应，体验是：

```
等待 5 秒... → 一次性返回完整文字
```

流式输出只需在请求体里加一个参数 `stream: true`，服务器就会从"一次性返回"变成"持续推送数据帧"：

```
stream: false（默认）：等待全部生成完 → 一次性返回完整 JSON
stream: true：         每生成一个 token → 立刻推送一帧数据
```

---

## SSE 协议：流式数据的格式

`stream: true` 使用的是 **SSE（Server-Sent Events）** 协议，服务器推过来的每一帧长这样：

```
data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"！"},"finish_reason":null}]}
data: [DONE]
```

规律：
- 每行以 `data: ` 开头（固定格式，SSE 协议规定）
- `delta.content` 是这一帧的 token（一个或几个字符）
- 最后一帧是 `data: [DONE]`，表示流结束

---

## 核心一：TextDecoder — 二进制转字符串

网络传输的本质是**字节流**，`fetch` 的 `response.body` 给你的是 `ReadableStream<Uint8Array>`（二进制数据块），不能直接当字符串用：

```typescript
const decoder = new TextDecoder('utf-8');

// 把二进制数据块解码成字符串
buffer += decoder.decode(value, { stream: true });
//                               ↑ 关键参数！
```

**为什么需要 `{ stream: true }`？**

UTF-8 里一个中文字符占 **3 个字节**，但网络数据块可能在字符中间切断：

```
第一块：[228, 189]          ← "你" 的前两个字节，不完整！
第二块：[160, 229, 165, 189] ← "你" 的最后一个字节 + "好" 的完整字节

stream: true  → 缓存不完整的字节，等下一块来了再拼，不会乱码 ✅
stream: false → 遇到不完整字节直接输出乱码 ❌
```

`TextDecoder` 是 **Node.js 18+ 和浏览器的内置 API**，无需安装任何依赖。

---

## 核心二：while 循环 — 持续读取数据流

```typescript
const reader = response.body.getReader();

while (true) {
  const { done, value } = await reader.read(); // 等待下一块数据
  if (done) break;                             // 服务器关闭连接，退出

  // 处理这一块数据...
}
```

和普通 `while` 的区别：**每次 `await reader.read()` 都会暂停等待**，直到服务器推送下一块数据才继续，不会空转占用 CPU。

---

## 核心三：滑动缓冲区 — 处理跨块的数据行

SSE 数据以换行符 `\n` 分隔，但网络数据块的边界不一定和换行符对齐，可能出现"半截行"：

```
第一块数据：'data: {"content":"你"}\ndata: {"con'
                                              ↑ 在这里被截断了！
第二块数据：'tent":"好"}}\n'
```

解决方案：**滑动缓冲区（buffer）**

```typescript
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true }); // 追加新数据

  const lines = buffer.split('\n'); // 按换行符切割

  buffer = lines.pop() ?? ''; // ← 关键！把最后一行（可能不完整）留在 buffer
                               //   其余完整的行放在 lines 里处理

  for (const line of lines) {
    // 处理完整的行...
  }
}
```

**`lines.pop()` 是"消费"机制**，每次循环后 buffer 只保留"当前未处理完的半行数据"，不会无限增长，也不会重复处理。

用具体例子演示：

```
第1次 while：
  buffer = 'data: {"content":"你"}\ndata: {"con'
  split('\n') → ['data: {"content":"你"}', 'data: {"con']
  pop() → buffer = 'data: {"con'  ← 只剩半截！
  for 循环处理第一行 → 打印"你"

第2次 while：
  buffer = 'data: {"con' + 'tent":"好"}}\n'
         = 'data: {"content":"好"}}\n'  ← 拼接完整了！
  split('\n') → ['data: {"content":"好"}}', '']
  pop() → buffer = ''
  for 循环处理第一行 → 打印"好"
```

---

## 核心四：解析 SSE 数据行

```typescript
// 过滤：只处理 data: 开头的行，跳过空行、注释行
if (!trimmedLine.startsWith('data: ')) continue;

// 去掉 "data: " 前缀（6个字符），剩下纯 JSON
const dataStr = trimmedLine.slice(6);

// 流结束标志
if (dataStr === '[DONE]') break;

// 解析 JSON，取出 token
const delta = JSON.parse(dataStr);
const content = delta.choices[0]?.delta?.content;
if (content) onChunk(content); // 立刻推出去！
```

`slice(6)` 的原理：

```
d  a  t  a  :     {  "  c  h  o  i  c  e  s  "  ...
0  1  2  3  4  5  6  ← 从第6位开始截取
                   ↓
{"choices":[...]}  ← 纯 JSON，可以直接 JSON.parse()
```

---

## 完整的 SSE 处理流程

```
服务器持续推送二进制数据块
      ↓
while 循环等待每一块（await reader.read()）
      ↓
TextDecoder 解码成字符串，追加到 buffer
      ↓
split('\n') 切割，pop() 保留半截，其余完整行进入 for 循环
      ↓
过滤非 data: 行，slice(6) 去掉前缀，JSON.parse() 解析
      ↓
取出 delta.content（token）→ onChunk(token) 立刻打印
      ↓
收到 "[DONE]" → 退出循环，流结束
```

---

## 和 ai SDK 的对应关系

第三课用 `ai` SDK 的 `streamText`：

```typescript
const { textStream } = streamText({ model, messages });
for await (const chunk of textStream) {
  onChunk(chunk);
}
```

`for await...of` 就是 `while + reader.read()` 的语法糖，SDK 内部做的事和我们手写的完全一样：

| 我们手写 | ai SDK 封装 |
|---------|------------|
| `stream: true` | 自动加 |
| `TextDecoder` | 内部处理 |
| `while + reader.read()` | `for await...of textStream` |
| `buffer + split + pop` | 内部处理 |
| `slice(6) + JSON.parse` | 内部处理 |
| `delta.content` | 直接给你 chunk |

---

## 完整代码

见 `src/raw/openai-stream.ts`，运行方式：

```bash
npx tsx src/raw/openai-stream.ts
```

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **SSE 协议** | Server-Sent Events，每行以 `data: ` 开头，`[DONE]` 表示结束 |
| **TextDecoder** | Node.js/浏览器内置 API，把二进制字节转成字符串 |
| **`{ stream: true }`** | 告诉 decoder 这不是最后一块，缓存不完整的多字节字符 |
| **while + reader.read()** | 持续读取流，每次 await 等待下一块数据到来 |
| **滑动缓冲区** | buffer 只保留"半截行"，处理完整行后立刻丢弃，不会重复 |
| **`lines.pop()`** | 消费机制，把最后一行（可能不完整）留给下一次循环拼接 |

---

## 下一步

- [ ] **第7课：手写 Agent Loop** — 不用 SDK，手写工具调用的完整循环逻辑
