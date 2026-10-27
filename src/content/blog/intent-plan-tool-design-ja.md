---
title: "Intent認識を考え直す：Plan＋Tool設計"
date: 2026-08-31
updated: 2026-10-27
excerpt: "Intent分類の精度を上げ続けるより、Agentアーキテクチャを見直す。PlanとTool設計で、理解はモデルに、実行はコードに任せる。"
category: 考察
lang: ja
---

**Intent認識を何周も回して、ようやく分かった。問題は Intent認識そのものではないかもしれない。** 最近、「スケジュールカレンダー」の Intent認識を回し続けている。

最初は、ただの分類問題だと思っていた。

ユーザーが一文言い、モデルが「何をしたいか」を判断する。

たとえば：

* 「明日の午後3時に会議を入れて」→ 予定作成
* 「明日の予定は？」→ 予定照会
* 「午後3時の会議をキャンセルして」→ 予定削除
* 「4時に変えて」→ 予定更新

簡単に見える。

だが実プロダクトに入れると、とても厄介な問題が出た。

**Bad case が終わらない。**

「明日の午後に会議」を直すと、「明日の午後、2時間空けて」が壊れる。

単発を直すと、複数ターンの確認が壊れる。

Intent分類を直す——モデルは「予定を作りたい」と分かる。だが create-schedule Tool を呼ぶとは限らない。

開発はだんだんこうなった。

> ケースを見つける → プロンプトを変える → テスト → 直す → 新しいケースが出る → またプロンプトを変える……

何周もしたあと、気づき始めた。

**これはもうプロンプトエンジニアリングの問題ではなく、Agentアーキテクチャの問題かもしれない。**

---

## 1. 本当の Intent は、ユーザーの最後の一文にないことが多い

カレンダーは、典型的な複数ターン対話だ。

たとえばユーザーが言う。

> プロダクト議論の予定を入れて。

システムはすぐ作れない。時刻が無い。

だから Agent は聞く。

> いつにしますか？

ユーザーが返す。

> 明日の午後。

Agent が続ける。

> 午後の何時？

ユーザーが返す。

> 3時。

最後の一文「3時」だけを見ても、何がしたいかはほぼ分からない。

本当の Intent は、会話履歴全体に散っている。

```text
User: プロダクト議論の予定を入れて
Assistant: いつにしますか？
User: 明日の午後
Assistant: 午後の何時？
User: 3時
```

最終的に復元したいのは：

```text
Action: CreateEvent

Title: プロダクト議論
Date: 明日
Time: 15:00
```

だから今は、こう傾いている。

**ユーザーメッセージを、早すぎる時点で1件ずつ独立分類しない。**

直近の会話履歴と現在入力をモデルに渡し、判断させる。

> ユーザーは今、実際に何を成し遂げようとしているか？

つまり Intent認識の入力は：

```text
User Message
```

ではなく：

```text
Conversation Context
+
Current User Message
+
System Context
```

これが最初の変更だ。

---

## 2. 「Intent認識」をシステムの中心にしない

最初のやり方は、かなり伝統的だった。

モデルが JSON を出す。

```json
{
  "intent": "create_event",
  "title": "プロダクト議論",
  "date": "tomorrow",
  "time": "15:00"
}
```

プログラムはその JSON に従って動く。

```text
LLM
 ↓
Intent JSON
 ↓
Business Code
 ↓
Calendar API
```

このアーキテクチャは分かりやすい。

だが能力が増えると、重くなる。

現実のリクエストは、いくつかの enum では書き切れない。

たとえば：

> 明日の午後、Alex と私の両方が空いている時間で、1時間くらいプロジェクトの話をしたい。

少なくともこうなる。

```text
understand intent
 ↓
parse date
 ↓
query my calendar
 ↓
query Alex's availability
 ↓
find common free time
 ↓
create event
```

この時点で「Intent」はもう：

```text
CREATE_EVENT
```

ではなく、一連のアクションになる。

だからアーキテクチャを、こう調整していった。

```text
Conversation
      ↓
     LLM
      ↓
   Agent Loop
   ↙   ↓   ↘
   Query  Create  Update ...
Calendar Event Event
```

**Intent は、明示的な中間成果物である必要がない。**

モデルが「何をしたいか」を理解したあと、次にどの Tool を呼ぶかを直接決めてよい。

これは：

**Intent Classification**

から：

**Agent Decision Making**

への移動だ。

---

## 3. カレンダー能力を、無限に増える Intent ではなく Tool にする

だからカレンダーの基本能力を Tool として登録し始めた。

いちばん基本は CRUD：

```text
query_calendar
create_event
update_event
delete_event
```

各 Tool には、はっきりしたものがある。

```text
name
description
parameters
return value
error
```

たとえば：

```text
create_event(
  title,
  start_time,
  end_time,
  participants,
  ...
)
```

Agent がこれらの能力を持てば、いつ呼ぶかは自分で決める。

たとえば：

> 明日の午後、空いてるか見て。

Agent：

```text
→ query_calendar()
→ return result
→ answer the user
```

一方：

> 明日の午後3時に、プロダクト議論を入れて。

は：

```text
→ create_event(...)
→ return success
→ tell the user it's created
```

情報が足りなければ：

> プロダクト議論の予定を入れて。

Agent は Tool を呼ばず、直接答える。

> いつにしますか？

ユーザー：

> 明日の午後3時。

2ラウンド目のモデルは、また会話コンテキストを得る。

```text
User: プロダクト議論の予定を入れて
Assistant: いつにしますか？
User: 明日の午後3時
```

情報が揃う。

```text
→ create_event(...)
```

この仕組みのいちばん大きな変化：

**確認そのものが Agent の振る舞いの一部であり、巨大な状態機械を別に要しない。**

---

## 4. Tool呼び出しの失敗は、Agent の失敗ではない

次に、別の現実問題が来た。

Tool は失敗する。

理由も多い。

たとえばモデルが：

```text
create_event(...)
```

を呼ぶ。結果は：

```text
INVALID_ARGUMENT
```

かもしれないし：

```text
TIME_CONFLICT
```

かもしれないし：

```text
DATABASE_TIMEOUT
```

かもしれない。

3つとも「Tool呼び出し失敗」だが、扱いはまったく違う。

だから今は、Tool エラーを構造的に分類する側にいる。

たとえば：

```text
Tool Error
    │
    ├── Parameter Error
    │       ↓
    │    Agent Retry
    │
    ├── Business Error
    │       ↓
    │    Agent Reasoning
    │
    └── System Error
            ↓
       Fail + Observability
```

### パラメータエラー

たとえば：

```text
start_time format invalid
```

このエラーはモデルに返してよい。

モデルは気づくかもしれない。

> つまり Tool は ISO 8601 が欲しい。

パラメータを作り直し、再試行する。

ユーザーは、最初の呼び出しが失敗したことを知る必要がない。

---

### ビジネスエラー

たとえば：

```text
TIME_CONFLICT
```

これはシステムの故障ではない。

Agent は続けられる。

```text
create schedule
 ↓
find conflict
 ↓
query nearby free time
 ↓
recommend alternative times to the user
```

将来は、さらに：

> この時間は週次ミーティングとぶつかります。16:00 と 16:30 が空いています。どちらかに移しますか？

これが本物の Agent reasoning だ。

---

### システムエラー

たとえば：

```text
Database Timeout
Internal Server Error
Network Error
```

モデルはこれを解けない。

ここでは：

```text
stop retrying
+
return user-understandable info
+
write to observability
+
trigger monitoring
```

開発者が trace から特定する。

つまり：

**Agent のリトライは万能リトライではない。エラータクソノミーの上に乗るべきだ。**

---

## 5. そのあと、別の問題が見えた：ReAct は流れる

システム全体がただ：

```text
Think
 ↓
Act
 ↓
Observe
 ↓
Think
 ↓
Act
 ↓
Observe
```

古典的な ReAct ループなら、単純なタスクはとてもうまくいく。

たとえば：

> 明日の午後3時の会議を作成して。

おそらく Tool 呼び出しは1回で足りる。

だがタスクが複雑になると、問題が出る。

たとえば：

> 明日の午後の会議を全部1時間後ろにずらして。衝突したら近くの空きを探して。重要な会議は動かさないで。

Agent はこうする必要があるかもしれない。

```text
query calendar
→ decide which meetings can move
→ modify A
→ query conflict
→ modify B
→ re-query
→ modify C
→ ...
```

実行鎖が長くなると、モデルはユーザーの元の目標から流れやすい。

これが、その日いちばん大事だった問題だ。

**ReAct ループは、目標ドリフトを起こしやすい。**

モデルは、最新の observation に基づいて毎回決める。

5、6ステップ進むと、元の制約の一部を忘れていることがある。

たとえば：

> 「重要な会議は動かさないで。」

実行の後半で弱まる。

だから Planner の話になった。

---

## 6. Planner の実装は3つ

今のところ、典型は3つだと思う。

## 選択肢1：Agent ループに Planner を内蔵する

最初のラウンドで plan 生成を強制する。

```text
User
 ↓
Plan
 ↓
ReAct
 ↓
Tool
 ↓
Observation
 ↓
ReAct
```

たとえば：

```text
Goal:
明日の午後の会議を調整する

Plan:
1. 明日の午後の会議を全部照会する
2. どれを動かしてよいか判断する
3. 各会議を1時間ずらす
4. 衝突を確認する
5. 衝突したら最も近い空きを探す
6. 重要な会議は変更しない
```

そのあと、ReAct ループ全体がこの plan を持ち歩く。

いちばんの価値：

**Agent の注意を、元の目標へ引き戻し続けること。**

---

## 選択肢2：独立した Planner Agent

Planner と Executor を完全に分ける。

```text
             ┌─────────────┐
User ───────→│ Planner     │
             └──────┬──────┘
                    ↓
                  Plan
                    ↓
             ┌─────────────┐
             │ Executor    │
             └──────┬──────┘
                    ↓
                  Tools
```

Planner の責任：

```text
What should be done?
```

Executor の責任：

```text
How to execute it?
```

責任はとてもはっきりしていて、複雑な Agent に向く。

だがコストも明白だ。

**モデル呼び出しが1回以上増える。**

レイテンシ、トークン、システムの複雑さが全部上がる。

「明日の午後3時に会議を思い出させて」には、明らかに過剰だ。

---

## 7. 3つ目が、今いちばん好きな形：Planner を Tool にする

面白い設計がある。

**Planner 自体を Tool として登録する。**

たとえば：

```text
Tools:
- query_calendar
- create_event
- update_event
- delete_event
- create_plan
```

Agent が受け取る。

> 明日の午後3時に会議を思い出させて。

とても単純だと判断する。

```text
create_event()
```

直接実行する。

Planner は要らない。

だがユーザーがこう言ったら：

> 来週のプロジェクトA関連の会議を全部整理して。できるだけ火曜と水曜に寄せて。ただし確定済みの重要な会議は動かさないで。

モデルは判断する。

> このタスクは複雑だ。

だから：

```text
create_plan()
```

そして得る。

```text
1. 来週の会議を照会する
2. プロジェクトAを絞り込む
3. 動かせない会議を印付ける
4. 火曜・水曜の空きを照会する
5. 移動案を作る
6. 衝突を確認する
7. ユーザー確認を取る
8. 変更を実行する
```

それから ReAct ループに入る。

全体のアーキテクチャはこうなる。

```text
                 User
                   ↓
                 Agent
              ↙     ↓     ↘
         Simple   Complex   Clarify
           ↓        ↓         ↓
         Tool    Planner    User
                    ↓
                  Plan
                    ↓
                  ReAct
                    ↓
                  Tools
```

今これを好きな理由：

**単純なタスクは単純なまま。複雑なタスクだけが計画コストを払う。**

Planner は、Agent フローの固定ステップから、必要になったときの認知能力になった。

---

## 8. 将来：階層プランニング

あとでカレンダー Agent だけではなく、生活アシスタントへ育つなら、計画はさらに層を分ける必要があるかもしれない。

たとえばユーザーが言う。

> 3か月後にハーフマラソンを走りたい。

これはもうカレンダー CRUD ではない。

システムはこう分解するかもしれない。

```text
Goal
 ↓
Plan
 ↓
Tasks
 ↓
Calendar Actions
```

たとえば：

```text
ハーフマラソンを完走する
        ↓
12週の訓練計画を作る
        ↓
週4回訓練する
        ↓
ユーザーの空きを探す
        ↓
具体的な予定を作る
```

この時点で：

```text
Goal Planner
     ↓
Task Planner
     ↓
Calendar Agent
     ↓
Tools
```

Planner は、単純な Tool から階層プランナーへ自然に育つ。

だがそれは後の話だ。

Agentアーキテクチャには、大事な原則があると感じている。

> **最終形の全体を先に作らない。問題が出るたびに、複雑さを層として足す。**

---

## 9. 「Intent認識」を見直す：分類器ではないかもしれない

ここまで来て、元の問題を振り返ると面白い。

最初に解きたかったのは：

> Intent認識の精度をどう上げるか？

だから足し続けた。

```text
Intent
Prompt
Rules
Examples
Few-shot
Bad Case
```

だが今は、こう感じている。

Agentプロダクトにおいて、「Intent認識」はたぶん、これだけではない。

```text
User Input
      ↓
Intent Classifier
      ↓
CREATE / QUERY / UPDATE / DELETE
```

より妥当な構造は、こうかもしれない。

```text
Conversation Context
          ↓
    Agent Reasoning
          ↓
 ┌────────┼─────────┐
 ↓        ↓         ↓
Answer  Clarify   Action
                   ↓
              ┌────┴────┐
              ↓         ↓
            Simple    Complex
              ↓         ↓
            Tool      Planner
                        ↓
                      ReAct
                        ↓
                      Tools
```

Intent認識は、独立モジュールから Agent reasoning の一部になった。

これが、最近のカレンダー Agent 作業でいちばん大きな認知の変化だ。

---

## 10. Bad case が終わらないときは、止まってアーキテクチャを見る

AIプロダクトを作っていると、陥りやすい状態がある。

Bad case が出る。だからプロンプトを変え続ける。

もちろん、それは役に立つ。

だがこうなったら：

> **1件直すと、別の言い回しがまた壊れる。**

それが続くなら、止まって1つ聞く価値がある。

**モデル能力の問題を解いているのか。それともプロンプトでアーキテクチャの穴を塞いでいるのか。**

これはまったく別物だ。

今の判断基準は：

問題が、こんなものを増やし続けるなら：

```text
if the user says this……
if the last round was this……
if this field doesn't exist……
if there's a conflict……
if the tool fails……
if……
```

たぶん意味するのは：

**ここに、新しいアーキテクチャ抽象が現れるべきだ。**

たとえば：

```text
Tool
Memory
Planner
State
Workflow
Error Taxonomy
Observability
```

プロンプトの87番目のルールではない。

---

## 結び

最近の Agent 作業でいちばん強い感覚：

**Agentエンジニアリングの本当に難しいところは、LLM を「賢くする」ことではない。LLM がたまに賢くなくても、システムが安定して動くアーキテクチャを設計することだ。**

会話がその文脈を復元する。

System prompt が境界を与える。

Tools が行動能力を与える。

構造化エラーが回復を与える。

Planner が目標を保つ。

Observability が、開発者に系統問題を見つけさせる。

Memory が、このユーザーをだんだん理解させる。

最後に形になるのは、「Intent認識モジュール」ではない。

それは：

```text
Context
   ↓
Reasoning
   ↓
Planning
   ↓
Action
   ↓
Observation
   ↓
Recovery
   ↓
Memory
```

**これは完成した Agent ループだ。**

だからもう一度聞かれたら：

> 「カレンダー Agent の Intent認識はどうやるべき？」

答えは、こうなるかもしれない。

**Intent認識だけをやらない。**

ユーザーが成し遂げようとしていることを Agent に理解させ、十分に明確な Tool、制約、計画、エラー回復を渡し、「Intent」が次に選ぶアクションの中に自然に現れるようにする。

増え続ける Intent分類器を保守するより、それが Agentプロダクトの最終形に近い。
