# 给 CodeBuddy（腾讯 CodeBuddy IDE）添加「对话分支」功能 —— 完整实现记录

> 本文是开发过程记录，面向接手的人或 AI。安装使用请看仓库根目录 README.md。
> 记录日期：2026-10-29（2026-10-30 更新到 v0.2.0）
> 环境：Windows 11 / CodeBuddy CN IDE 1.106.1 / genie 扩展 3.10.0 / CodeBuddy Code CLI 2.151.0
> 面向读者：以后接手的 AI 或人。**先读完本文再动手，尤其第 5 节「已确认走不通的路」，不要重复试。**
> 已开源：https://github.com/sundeli123/codebuddy-conversation-branch （本地发布目录 `C:\Users\21078\Desktop\软件\codebuddy-conversation-branch`）

---

## 1. 一句话结论

CodeBuddy 本身没有 DeepSeek Harness 那种「在某一轮对话处分叉出一个新对话」的按钮。本方案通过**给 CodeBuddy 自带的对话扩展打一个小补丁** + **写一个本地 VS Code 扩展**，实现了：

- 按一次快捷键 → 选择某一轮 → **1~2 秒后新分支自动出现在历史列表**；
- **不重载窗口、不重启 IDE、不打断正在跑的 AI 任务**；
- 支持「复制任意消息 → 按快捷键 → 自动定位到那一轮」（方案 A）；
- 分支内容 = 该轮及其之前的全部对话，原对话完全不受影响；
- 列表第一行带**该轮提问时刻** `MM-DD HH:MM`，方便按时间认轮次；
- v0.2.0 起，分支**只会落到发起窗口自己的工作区**（v0.1.0 会导进别的工作区，见 6.1.1）。

### 版本记录

| 版本 | 日期 | 变化 |
|---|---|---|
| v0.1.0 | 2026-10-29 | 首个可用版本：任意轮分叉、剪贴板定位、不打断任务 |
| **v0.2.0** | 2026-10-30 | ① 队列改为 `req-<taskId>.json` + 目标工作区定向，修「分支被别的窗口截胡、导进别的工作区」；② 导入回执 `ack-<taskId>.json`，扩展不再假报「已生成」；③ 列表第一行加提问时间戳；④ `patch-genie.js apply` 支持从 v1 原地升级到 v2 |

---

## 2. 需求原始描述

用户要的是 DeepSeek Harness 的那个交互：**每条消息下方都有「在新对话中分支」**，点哪一条，就把那一条及之前的所有对话复制成一个新会话，后面的不要。

关键约束（都是用户明确提出的）：

1. **绝对不能重载窗口**。重载 = 重启扩展宿主 = 正在跑的 AI 任务被杀掉。
2. 要能对**任意一轮**分叉，不是只能整条会话导出。
3. 越接近「点一下」越好，不要手动导出再导入。

---

## 3. 最终方案架构

```
[用户按 Ctrl+Alt+B]
        │
        ▼
[本地扩展 codebuddy-branch]  ← ~/.codebuddycn/extensions/local.codebuddy-branch-0.2.0
   1. 读当前会话 id
   2. 列出所有轮次（QuickPick，两行展示：轮次｜MM-DD HH:MM｜问题前 30 字）
   3. （方案 A）读剪贴板，匹配到某一轮，置顶加 ★
   4. 用磁盘数据构造「归档 JSON」，写到 %TEMP%\codebuddy-branch\req-<taskId>.json
      （任务体带 __cbbTargetWs = 本窗口工作区）
        │
        ▼
[genie 扩展里的补丁]  ← 每 1.2 秒轮询 req-*.json
   目标工作区不是自己的 → 跳过（交给正主窗口，见 6.1.1）
   是自己的 → 改名取走 → 调用它自己的 importArchiveFromJsonText(text)
        │
        ▼
[CodeBuddy 官方导入链路]
   parseConversationArchive → conversationManager.importConversation
   → 写盘 → conversationMap.set → persistIndex
   → onConversationCreatedEmitter.fire({ setAsCurrent: false })
        │
        ▼
   导入成功/失败写回执 ack-<taskId>.json
   扩展等到回执才提示「已生成」，历史列表立刻多一条，当前对话不切走、任务不中断
```

**为什么必须打补丁**：导入的最后一步是在宿主进程内存里 fire 一个事件，外部进程（包括另一个 VS Code 扩展）无法触发。详见第 5 节。

---

## 4. 关键技术事实（全部实测）

### 4.1 会话数据存储位置

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\<uuid-A>\CodeBuddyIDE\<uuid-B>\history\
```

> 同目录下还有 `VSCode\<uuid-B>\history`、`default\CodeBuddyIDE\<...>\history` 等，属于其他产品形态/账号，别改错。
> `<uuid-A>/<uuid-B>` 每次安装/账号可能不同，代码里要遍历发现，不要写死。

每个工作区一个目录，**目录名 = md5(工作区绝对路径，盘符小写)**：

```js
crypto.createHash('md5').update('e:\\mineru\\...\\批量样本_2010-2025_AI提取_第二批').digest('hex')
// => 127e2daa862e6873214ca501b1cdcd9e  ← 与实测目录名一致
```

目录结构：

```
<wsDir>/
    index.json        { conversations:[{id,type,name,createdAt,lastMessageAt,
                                        chatMode,selectedModelId,selectionRevision}], current }
    recent.json       { <convId>: "<ISO 时间>" }
    current.json      { conversationId, lastUpdated }
    <convId>/
        index.json    { messages:[{id,type,role,isComplete}],
                        requests:[{id,type,messages:[<msgId>...],state,startedAt,usage}] }
        messages/<messageId>.json   { role, message, id, extra, createdAt }
        assets/                     图片等
```

要点：

- `messages` 是**线性数组**，按顺序排列，含 `role: user/assistant/tool`；
- 一条消息一个文件，**消息文件里不含 conversationId**，所以复制目录不需要改内容；
- `requests` 一轮一条，`requests[i].messages` 是该轮内的消息 id 列表；
- `index.json` 的 `current` 与 `current.json` 的 `conversationId` 同时存在，改的时候两边都要改。

### 4.2 「轮次」的切分规则

```
一条 role=user 的消息 = 一轮的起点
该轮范围 = 这条 user 消息 到 下一条 user 消息之前（含中间的 assistant / tool）
```

分叉到第 N 轮 = 保留 `messages[0 .. 第N轮的 endIndex]`，`requests` 保留前 N 条并把最后一条的 messages 过滤到保留集合内。

### 4.3 官方「导入」的完整链路（从压缩后的源码逆向）

```
ConversationService.importConversation()
  → vscode.window.showOpenDialog({filters:{"Conversation Archive":["json","zip"]}})
  → 读文件 → importArchiveFromJsonText(text)
      → JSON.parse → parseConversationArchive(ar)    // 严格校验
      → sanitizeConversationToolMarkers
      → conversationManager.importConversation(data)
          → historyStorage.importConversation(data)  // 写盘
          → conversationMap.set(newId, conv)         // 更新宿主内存
          → persistIndex()                           // 更新 index.json
          → onConversationCreatedEmitter.fire({conversation, setAsCurrent:false})  ← 关键
```

**`setAsCurrent: false`** 意味着导入不会切走当前会话 —— 这正好满足「不打断任务」。

### 4.4 归档 JSON 的 schema（自己构造文件时必须完全符合）

```json
{
  "schema": "codebuddy.conversation",
  "schemaVersion": 1,
  "exportedAt": "<ISO>",
  "data": {
    "lastMessageAt": "<ISO>",
    "conversations": [
      {
        "id": "<[a-zA-Z0-9-_]+>",
        "type": "craft",
        "name": "标题",
        "createdAt": "<ISO>",
        "lastMessageAt": "<ISO>",
        "originalId": "<原会话 id>",
        "requests": [
          {
            "id": "<id>",
            "type": "craft",
            "state": "complete",          // running | complete | aborted | canceled
            "messages": [
              {
                "id": "<id>",
                "role": "user",           // user | assistant | tool | system
                "message": "<原始 message 字符串>",
                "status": "active",       // active | deprecate | deleted（可选）
                "extra": "<字符串，可选>",
                "createdAt": "<ISO，可选>"
              }
            ],
            "usage": { }                  // 可选
          }
        ]
      }
    ]
  }
}
```

校验规则（违反任何一条都会被拒）：

- `data.conversations` **必须正好 1 条**；
- 每个 request 的 `id` 唯一，所有 message 的 `id` 全局唯一；
- `state` 必须是那四个值之一；
- 单文件上限 **100 MB**（`MAX_CONVERSATION_ARCHIVE_BYTES = 104857600`）。

> 磁盘上的 `messages/<id>.json` 字段本来就和归档里的 HistoryMessage 对得上（`role/message/id/extra/createdAt`），只差一个 `status`，补 `"active"` 即可。所以「从磁盘会话构造归档」几乎是无损的。

---

## 5. 已确认走不通的路（不要重复试）

按尝试顺序记录，附证据：

### 5.1 直接写盘（复制会话目录 + 改 index.json）→ 列表不刷新

- 复制目录、往 `index.json` 加一条记录，**即使数据完全正确，历史列表也不会出现**。
- 原因：历史列表读的是宿主进程内存里的 `conversationMap`，只有 `loadConversationsFromStorage()`（扩展激活时调用一次）或导入事件才会更新。
- 实测：写了 `分支6`（155 条消息、校验通过），不重载点历史页 **看不到**；重载后能看到。
- 反过来也验证了：`index.json` 不会立刻被内存覆盖（手工条目能留存），所以问题只在「内存没刷新」，不在「磁盘被覆盖」。

### 5.2 想通过另一个扩展调用 genie 的内部 API → 拿不到

`genie/out/extension/index.js` 的入口：

```js
async function activate(ir){ ... await doActivate(ir, rn); }   // 没有 return
```

`activate()` 不返回任何对象，所以 `vscode.extensions.getExtension('tencent-cloud.codingcopilot').activate()` 得到 `undefined`，**外部扩展无法调用 `createConversation` / `importConversation` / `setCurrentConversation`**。

### 5.3 等宿主自己发现文件变化 → 没有监听

- `chokidar` 在 genie 的 bundle 里出现 4 次，全部来自 `nunjucks` 依赖自身的 loader；
- `createFileSystemWatcher` 用于工作区文件（rules/agents），**没有监听 history 目录**。

### 5.4 通过 deeplink 触发导入 → 不支持

deeplink 只注册了 `DeeplinkPrefillPromptCommand`（预填 prompt），不能触发任意命令。

### 5.5 QuickPickItem.tooltip → proposed API，直接抛错

```js
{ label: '...', tooltip: '...' }   // ❌
```

报错原文（会弹通知，且命令直接失败）：

```
Error: Extension 'local.codebuddy-branch' CANNOT use API proposal: quickPickItemTooltip.
Its package.json#enabledApiProposals-property declares: [] but NOT quickPickItemTooltip.
```

**替代做法**：不设 `tooltip`，把完整文本放进 `label` —— VS Code 未指定 tooltip 时默认用 `label`（或 `detail`）做悬停提示。

### 5.6 label 用 `{label, highlights: []}` 对象 → 列表渲染为空

```js
{ label: { label: text, highlights: [] } }   // ❌ 列表一片空白，但 title 显示"共 13 轮"
```

数据都在，就是一条都不渲染。**label 必须用纯字符串**。

### 5.7 其他小坑

| 坑 | 现象 | 解决 |
|---|---|---|
| `package.json.version` 与扩展目录名不一致 | 扩展行为异常 / 加载问题 | 目录名与 version 必须一致（本方案固定 `0.1.0`） |
| PowerShell 用默认编码读 UTF-8 文件 | `ConvertFrom-Json` 报「传入的对象无效」 | 用 `Get-Content -Encoding UTF8` 或改用 node 读 |
| 本机 `NODE_OPTIONS` 注入了 genie 的 safe-delete shim | `fs.rmSync` 走回收站，`spawnSync ... ETIMEDOUT` | 删目录用 PowerShell `Remove-Item -Recurse -Force` |
| 跨扩展调用 `tencentcloud.codingcopilot.chatHistory` | 可能被拦并抛 `CANNOT ...` | 不要从外部扩展调它的命令；激活交给补丁自己做 |

---

## 6. 实现细节

### 6.1 补丁：给 genie 扩展加「自动导入」

文件：`C:\Users\21078\AppData\Local\Programs\CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js`
（约 21 MB 的单行 webpack bundle；改前必须备份）

**三处插入**（脚本见 `patch-genie.js`）：

1. `async getConversationsWithState(){` 后面插 `try{globalThis.__cbbSvc=this;}catch(e){}`
   - 打开历史页时必然经过这里 → 拿到导入服务实例
2. `async importArchiveFromJsonText(ir){` 后面插同样的语句（双保险）
3. `async function doActivate(ir,ar){` 后面插一段 1.2 秒轮询：

```js
setInterval(() => {
  const dir = path.join(os.tmpdir(), 'codebuddy-branch');
  for (const name of fs.readdirSync(dir)) {                  // req-<taskId>.json / 旧 pending.json
    if (!/^(req-.*\.json|pending\.json)$/.test(name)) continue;
    const task = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (norm(task.__cbbTargetWs) !== norm(myWorkspace())) continue;  // 不是本窗口的任务，跳过
    if (Date.now() - fs.statSync(p).mtimeMs < 400) continue;         // 防半截文件
    const svc = globalThis.__cbbSvc;
    if (!svc) { /* 尝试打开一次历史页激活，并提示一次 */ return; }
    fs.renameSync(p, done);                                          // 原子改名，天然防重复
    svc.importArchiveFromJsonText(text)
      .then(() => ack(id, { ok: true }))                              // ← 走官方链路
      .catch((e) => ack(id, { ok: false, error: e.message }));
  }
}, 1200);
```

要点：

- **用的是它自己的 `importArchiveFromJsonText`**，不伪造事件、不手写 `index.json`；
- `renameSync` 是原子的：多窗口同时轮询也只会有一个成功消费；
- **只消费目标工作区等于自己的工作区的任务**，否则多个窗口会互相截胡（6.1.1）；
- 补丁只增 1000 多字符，`node --check` 通过；
- **IDE 升级会覆盖这个文件**，需要重新 apply（`node patch-genie.js apply`；已是 v1 的会原地升级到 v2）。

#### 6.1.1 v2（2026-10-30）：分支被导进了别的工作区 —— 必须按工作区定向

**现象**：按 Ctrl+Alt+B 选完轮次，提示「已生成」，但当前窗口历史列表里没有新分支，index.json 也没新增会话。

**根因**（实测证据，7 次点击全中招）：

| 时间 | 实际落到的工作区目录 | 结果 |
|---|---|---|
| 22:21:38 / 22:22:31 / 22:22:54 / 22:24:05 / 22:25:26 / 22:25:36 | `127e2daa…`（另一个窗口的项目） | 都生成了「… · 分支(全量)」 |
| 22:23:14 | `305f2ae7…` | 「… · 分支5」 |
| 发起操作的窗口 `d4c8c0e7…` | **0 条** | 所以看不到 |

- `%TEMP%\codebuddy-branch\pending.json` 是**全机唯一的队列文件**，而**每个打开的 CodeBuddy 窗口**里都有一份 genie 补丁在每 1.2 秒抢同一个文件 —— 谁先抢到，就由谁（也就是那个窗口的工作区）去执行导入；
- 发起窗口自己的补丁可能还没捕获到导入服务实例（`__cbbSvc` 为空），于是它永远不消费；别的窗口捕获过，于是次次截胡；
- 旧扩展只看「pending.json 还在不在」，文件被任何窗口叼走就立刻弹「已生成」，完全无法区分「真导入了」和「被抢走了」。

**v2 改法**：

1. 队列改成一任务一文件：`%TEMP%\codebuddy-branch\req-<taskId>.json`（不再写 `pending.json`）；
2. 任务体顶层带 `__cbbTargetWs`（发起窗口的工作区绝对路径）+ `__taskId`；
3. 补丁读任务后先比对目标：`norm(__cbbTargetWs) !== norm(本窗口 workspaceFolders[0])` 就直接跳过、**不改名不删除**，留给正主窗口消费；
4. 导入结束写回执 `ack-<taskId>.json`（成功 `{ok:true}`，失败 `{ok:false,error}`），失败另写 `import-error.log` 完整堆栈；
5. 扩展改为等回执（12 秒）再提示，超时区分三种情况：任务还在（补丁没生效）/ 任务被取走但无回执（旧版补丁截胡）/ 有回执（真结果）。

> 顶层 `__cbbTargetWs` / `__taskId` 不会进导入数据：`parseConversationArchive` 只校验并返回 `data`，未知顶层字段被忽略（`_meta` 早已验证过这一点）。

**代价与边界**：

- 所有开着的窗口都要重启一次，旧版补丁才会被换成 v2；在那之前旧窗口仍会截胡任何 `pending.json`（v2 已不写这个文件）。
- 同一项目开两个窗口时两者目标相同，仍可能任选其一消费 —— 但历史目录相同，结果正确。
- 已经误投到别的工作区的会话不会自动清理，需要手工删除。

### 6.2 扩展：`codebuddy-branch`

安装目录：`C:\Users\21078\.codebuddycn\extensions\local.codebuddy-branch-0.2.0\`

文件：

| 文件 | 作用 |
|---|---|
| `package.json` | 两个命令 + 两个快捷键（`ctrl+alt+b`、`ctrl+alt+j`）；`version` 必须与目录名一致 |
| `extension.js` | 命令实现：读当前会话 → 列轮次 → QuickPick → 构造归档 → 写 `req-<taskId>.json`（带目标工作区）→ 等 `ack-<taskId>.json` 再提示 |
| `branch-core.js` | 纯 Node 核心：路径解析、轮次切分、文本提取/清洗、剪贴板定位 |
| `fmtDateTime(iso)`（在 `extension.js` 内） | 该轮提问时刻 → `MM-DD HH:MM`（本地时区），缺失返回空串以省略整段 |

**`branch-core.js` 关键函数**

- `resolveWorkspaceDir(wsPath)`：遍历发现的 history 根，按 md5 命中工作区目录；
- `listRounds(wsDir, convId)`：切轮次，返回 `{round, fromEnd, startIndex, endIndex, userFull, userPreview, assistantPreview, time, msgCount, rawAssistant}`；
- `cleanUserText(text)`：去掉 `<user_info>/<rules>/<additional_data>/<system_reminder>` 块、只取成对的 `<user_query>…</user_query>`、把 `@image:C:\...\x.png` 折成 `[图片 ×N]`；
- `looksLikeCode(text)`：符号密度 > 8% 判为代码片段（用于跳过 AI 摘要里的代码）；
- `locateByClipboard(wsDir, convId, rounds, clip)`：方案 A 的匹配（见 6.4）。

**QuickPick 的展示规则（踩过坑后的最终形态）**

- 只显示「我问的问题」，不显示 AI 回复；
- 第一行：`[★ ]第 N 轮[（全量）]｜MM-DD HH:MM｜<问题前 30 字>`；`label` 必须是**纯字符串**，且**总长必须小于面板可视宽度（实测约 44 字符）**——VS Code 只要发现 label 超宽就会自动加 `…`，无法关闭，一旦超宽第一行末尾永远带省略号；
- 时间戳取**该轮第一条 user 消息的 `createdAt`**（= 用户按下发送的时刻，本地时区），不用 `requests[].startedAt`（那是后端开始处理的时间，通常晚几秒）；`createdAt` 缺失或非法时整段连同分隔符一起省略，不显示空的 `｜`；
  > 磁盘上没有"AI 回复结束"时间戳，界面上的「耗时 16.9s」是 IDE 自己算的、未落盘。所以只能给提问时刻，给不了耗时。
  > 加入 `MM-DD HH:MM`（11 个半角 ≈ 5.5 个汉字宽）后第一行比原来宽约 15%，若某天看到第一行末尾出现省略号，把 `HEAD` 从 30 调到 24~26；
- 第二行：`detail` = **完整问题（从第 1 个字起）**。VS Code 的悬停提示取 detail，所以悬停第二行能看到一字不缺的全文；代价是第二行开头会与第一行前 30 字重复，这是有意为之（用户明确要求「悬停能看到全部」）；
  - 若哪天想改成「两行不重复」，把 `detail` 换成 `full.slice(HEAD)` 即可，但悬停会缺前 30 字；
- `HEAD`（第一行字数）当前为 30，是按用户面板宽度定的安全值；面板拖窄后若又出现省略号，把它调到 25；
- 搜索：`matchOnDetail: true`。

### 6.3 命令行备用入口

```powershell
# 直接从第 5 轮分叉（不经过扩展界面）
node C:\Users\21078\AppData\Roaming\CodeBuddyBranch\branch-cli.js 5 "E:\项目路径"

# 只生成归档文件（手工在历史页点「导入」）
node C:\Users\21078\AppData\Roaming\CodeBuddyBranch\make-archive.js "E:\项目路径" <会话id> 3 "输出.json"
```

### 6.4 方案 A：复制即定位

- 读剪贴板 → 归一化（去空白/标点/markdown）→ 与该轮「用户提问 + 该轮所有 assistant 回复」比对；
- 打分：完整包含 → `1000 + 长度`；否则按 8 字切片命中率 → 最多 700；
- **≥500 才算命中**；剪贴板归一化后 < 8 字直接跳过（防误触发）；
- 命中项加 `★ ` 并置顶，标题提示「剪贴板命中第 N 轮（你的提问/AI 回复），已在第一项，回车即可」；
- 实测：复制提问命中 1035 分、复制 AI 回复开头 1046、中段 1051、无关文本未命中；整轮扫描约 45ms。

---

## 7. 使用手册

### 日常用法

1. 在 CodeBuddy 对话里按 `Ctrl+Alt+B`（或 `Ctrl+Alt+J`）；
2. 列表倒序显示所有轮次，**用内容辨认**（可直接输入关键字过滤）；
3. 选中 → 约 1~2 秒后提示「已生成「xxx · 分支N」」（v2 是等宿主回执后才提示，不再是「文件被叼走就算成功」）；
4. 打开历史列表即可看到新分支，点开继续聊；原对话保持原样、正在跑的任务不受影响。

### 方案 A 用法

1. 在对话里对任意一条消息点「复制」（你的或 AI 的，复制一段也行）；
2. 按快捷键 → 那一条所在轮会被打上 ★ 并置顶；
3. 直接回车。

### 首次使用注意

- 补丁需要拿到导入服务实例，而实例在「历史页第一次被打开」时才捕获。
  第一次按快捷键如果提示"宿主没消费"，补丁会自动帮你打开一次历史页激活，之后正常。

---

## 8. 维护与回滚

### 目录

```
C:\Users\21078\AppData\Roaming\CodeBuddyBranch\
    extension\              ← 扩展源码（改这里，再同步到扩展目录）
        package.json
        extension.js
        branch-core.js
    branch-cli.js           ← 命令行分叉
    make-archive.js         ← 只生成归档
    patch-genie.js          ← 补丁 apply/status/revert
    backup\                 ← genie index.js 的原始备份
    probe.log               ← 诊断日志（每次按快捷键会记录 rounds/items/命中）
    error.log               ← 命令出错时的完整堆栈
    out\                    ← 手工测试用的归档
```

### 常见维护动作

```powershell
cd C:\Users\21078\AppData\Roaming\CodeBuddyBranch

# 看补丁是否还在（IDE 升级后大概率没了）
node patch-genie.js status
node patch-genie.js apply

# 回滚补丁
node patch-genie.js revert "C:\Users\21078\AppData\Roaming\CodeBuddyBranch\backup\<备份文件>.js"

# 改完 extension\ 下的文件后，同步到扩展目录并重启 IDE
Copy-Item "extension\*" "$env:USERPROFILE\.codebuddycn\extensions\local.codebuddy-branch-0.2.0\" -Force
```

> 扩展目录名必须与 `package.json` 的 `version` 一致（`0.2.0` 对应 `local.codebuddy-branch-0.2.0`）。升级版本号时两个一起改，并删掉旧版本目录，否则会出现两个同名扩展抢快捷键。

### 升级后必做

1. `node patch-genie.js status` → 若 `patched: false`，执行 `apply`；
2. 验证 `resources\app\extensions\genie\out\extension\index.js` 里三个锚点还在（版本大改可能变），`apply` 脚本会检查锚点唯一性，不存在会直接报错不会写坏文件；
3. 重启 IDE 一次。

### 出问题怎么查

1. `%APPDATA%\CodeBuddyBranch\error.log` —— 命令异常堆栈；
2. `%APPDATA%\CodeBuddyBranch\probe.log` —— 轮次数、items 数、剪贴板命中情况；
3. `%TEMP%\codebuddy-branch\` —— v2 的队列在这里：`req-<taskId>.json` 迟迟不变名 = 没有窗口认领（目标窗口的补丁没生效，或工作区对不上）；`ack-<taskId>.json` 是结果回执；`import-error.log` 是导入失败的真实堆栈；`imported-*` 是已被取走的任务留档。

> 排查「提示已生成但历史里没有」时，先看 `req-<taskId>.json` 的目标 `__cbbTargetWs`，再去 `%LOCALAPPDATA%\CodeBuddyExtension\Data\*\CodeBuddyIDE\*\<md5>\index.json` 里按名字搜——v1 时代的分支很可能落在**另一个工作区**的历史里。

---

## 9. 安全边界

- 分支只复制**对话历史**，不复制工作区文件。多条分支同时改同一批文件会互相覆盖（这点 Harness 也一样）。
- 补丁改的是 IDE 安装目录下的一个 JS 文件，**升级会覆盖**；有备份可随时回滚。
- 任务文件写在 `%TEMP%\codebuddy-branch\`，导入后被改名为 `imported-<时间戳>-<taskId>.json` 留档；`ack-<taskId>.json` 是回执，读完即删。
- 不涉及任何网络请求，所有操作都在本地（只有发布到 GitHub 时才会联网）。

---

## 10. 一页速查

| 想做什么 | 怎么做 |
|---|---|
| 从某一轮分叉 | `Ctrl+Alt+B` → 选轮次 |
| 精确分叉（不想找轮次） | 复制那条消息 → `Ctrl+Alt+B` → 回车 |
| 不打开 IDE 界面分叉 | `node branch-cli.js <轮次> "<项目路径>"` |
| 只导出某轮为可导入文件 | `node make-archive.js "<项目路径>" <会话id> <轮次> "<输出.json>"` |
| IDE 升级后修分支 | `node patch-genie.js apply`（v1 会原地升到 v2）→ 重启 |
| 彻底卸载 | 删 `~/.codebuddycn/extensions/local.codebuddy-branch-0.2.0` + `patch-genie.js revert <备份>` |
| 把更新发布到 GitHub | 同步 `%APPDATA%\CodeBuddyBranch` 的改动到桌面 `codebuddy-conversation-branch` → `node pub.js publish`（走 REST API，不依赖 git） |
| 分支提示"已生成"但历史里没有 | 看 `%TEMP%\codebuddy-branch\import-error.log`；v1 时代是落到别的工作区了（6.1.1） |
