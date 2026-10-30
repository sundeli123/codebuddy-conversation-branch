# CodeBuddy Conversation Branch

> 给 **腾讯 CodeBuddy IDE** 补上「从任意一轮对话分叉」的能力 —— 像 DeepSeek Harness 那样，点一下就把某轮及之前的历史复制成一个新对话，原对话完全不动。
>
> Add conversation forking / branching to **Tencent CodeBuddy IDE**: fork any earlier turn into a brand-new conversation, without reloading the window and without interrupting a running agent task.

---

## ⚠️ 先读这一段：这不是一个"装上就能用"的插件

CodeBuddy 的对话历史存在**扩展宿主进程的内存里**。会话列表只会在宿主启动或收到「导入事件」时刷新，而那个事件只有宿主内部能触发。所以：

- **本仓库 = VS Code 扩展（UI + 算法）+ 一个补丁脚本（改 CodeBuddy 自带的 `genie` 扩展）**
- **只装扩展、不打补丁 → 不能用**（会提示"宿主没消费"）
- 补丁的作用：让 CodeBuddy 每 1.2 秒看一眼临时文件，发现待导入归档就调用**它自己的** `importArchiveFromJsonText`，走官方导入链路（写盘 → 更新内存 → 通知界面）
- 因为要改客户端文件，**本工具无法上架 VS Code / Open VSX 市场**，只能本地安装

## v0.2.0 更新了什么（2026-10-30）

| 问题 / 需求 | 修复 |
|---|---|
| **多个 IDE 窗口同时开着时，分支会导进别的工作区**：提示「已生成」，但当前窗口历史里找不到，实际上被另一个窗口的补丁抢走了 | 队列从单个 `pending.json` 改成一任务一文件 `req-<taskId>.json`，任务体带 `__cbbTargetWs`（发起窗口的工作区）；补丁只消费目标等于自己工作区的任务，别的一律跳过 |
| 提示「已生成」是**假报**：旧版只要发现队列文件被拿走就认为成功 | 导入成功/失败都写 `ack-<taskId>.json`，扩展等到回执才提示，失败会显示真实错误 |
| 想按时间认轮次 | 列表第一行加该轮提问时刻 `MM-DD HH:MM`（取该轮第一条 user 消息的 `createdAt`） |
| 已装 v0.1.0 的用户升级 | 重跑 `install.ps1` 会把补丁**原地升级**到 v2，不需要先卸载 |

> 升级后必须**完全退出并重开 CodeBuddy**（补丁和扩展都在扩展宿主里）。如果机器上还开着多个 CodeBuddy 窗口，建议全部重启一次，否则没重启的旧窗口仍可能抢任务。

## 已验证版本

| CodeBuddy IDE | genie 扩展 | 扩展版本 | 状态 |
|---|---|---|---|
| 1.106.1 | 3.10.0 | 0.2.0 | ✅ 已验证可用 |
| 1.106.1 | 3.10.0 | 0.1.0 | ⚠️ 已废弃，多窗口场景会导错工作区 |

其他版本未验证。`install.ps1` 会检查三个补丁锚点是否唯一，**不匹配就中止、不写任何东西**（安全失败）。

## 安装（Windows）

```powershell
git clone https://github.com/sundeli123/codebuddy-conversation-branch.git
cd codebuddy-conversation-branch
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会做：

1. 找到 `%LOCALAPPDATA%\Programs\CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js`
2. 备份到 `backup\genie-index-<时间戳>.js`（**这个目录不要提交到 git**）
3. 在三个位置各插入一小段代码（总共约 2.4 KB）
4. 把扩展复制到 `%USERPROFILE%\.codebuddycn\extensions\local.codebuddy-branch-0.2.0\`，并删掉旧版本目录（两个同名扩展会抢快捷键）

补丁状态有三种，脚本都处理：

| 当前状态 | 行为 |
|---|---|
| 没打过 | 检查三个锚点唯一 → 插入 |
| 打过 v0.1.0（`pending.json` 版） | **原地升级**轮询片段到 v2，其它注入点保留 |
| 已是 v0.2.0 | 跳过，只更新扩展文件 |

然后**完全退出 CodeBuddy 再打开**（不是"重新加载窗口"）。

先试运行、不动文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

## 使用

| 操作 | 快捷键 |
|---|---|
| 从某一轮分叉 | `Ctrl+Alt+B`（备用 `Ctrl+Alt+J`） |
| 精确分叉（不想数轮次） | 复制对话里任意一条消息 → `Ctrl+Alt+B` → 该轮会被标记 `★` 并排到第一项 → 回车 |

列表每项两行：

```
第 18 轮（全量）｜10-30 22:26｜[图片 ×1] 我再提一个小小的问题，这个问题不大    ← 第一行：轮次｜提问时刻｜问题前 30 字
[图片 ×1] 我再提一个小小的问题，这个问题不大，就是一个小小的问题。我看…        ← 第二行：完整提问（悬停可看全文）
```

- 时间戳是**这一轮你按下发送的时刻**（`MM-DD HH:MM`，本地时区），不是 AI 回复的开始/结束；磁盘上没有"回复结束"时间，所以给不了耗时
- 可以用键盘输入关键词过滤
- 虚线以下都是同一轮，选中后约 1~2 秒，历史列表里就会多一条 `原标题 · 分支N`
- **当前对话不会切走，正在跑的任务不会中断**
- 分支只会落到**你按快捷键的那个窗口**对应的历史里（v0.2.0 修复；v0.1.0 在多窗口下可能导进别的项目）

命令行方式（不经过界面）：

```powershell
node .\src\branch-cli.js 5 "E:\path\to\your\project"     # 从第 5 轮分叉
```

只生成归档文件（自己到历史页点「导入」）：

```powershell
node .\src\make-archive.js "E:\path\to\your\project" <conversation-id> 3 "out\branch.json"
```

## 它为什么必须这么实现

```
[Ctrl+Alt+B] → 本地扩展读取磁盘会话 → 生成归档 JSON → 写入 %TEMP%\codebuddy-branch\req-<taskId>.json
                                                         （顶层带 __cbbTargetWs = 本窗口工作区）
                                                                          │
                                       genie 补丁每 1.2s 轮询 ─────────────┘
                                                                          ↓
                            目标工作区不是自己的 → 跳过（留给正主窗口）
                            是自己的 → 改名取走 → 调它自己的导入方法
                                                                          ↓
                            CodeBuddy 官方导入链路：
                            parseConversationArchive → conversationManager.importConversation
                            → 写盘 → conversationMap.set → persistIndex
                            → onConversationCreatedEmitter.fire({ setAsCurrent: false })
                                                                          ↓
                            写回执 ack-<taskId>.json（成功/失败）→ 扩展据此提示
                                              历史列表立刻刷新，当前会话不切换
```

- 归档格式：`{ schema:"codebuddy.conversation", schemaVersion:1, exportedAt, data:{ lastMessageAt, conversations:[...] } }`
- 单文件上限 100 MB
- 分支 = 该轮及之前的**全部对话历史**，原会话一个字节都不改
- `__cbbTargetWs` / `__taskId` 是顶层字段，导入时被忽略（`parseConversationArchive` 只取 `data`）

## 已知限制

| 限制 | 说明 |
|---|---|
| IDE 升级会覆盖补丁 | 升级后重跑 `install.ps1` 即可（会重新备份 + 打补丁） |
| 多个 CodeBuddy 窗口 | v0.2.0 起任务按工作区定向，别的窗口不会抢；但**所有**窗口都要升到 0.2.0 并重启过，否则没升级的旧窗口仍可能抢走任务 |
| 只复制对话，不复制文件 | 分支之间共享同一份工作区文件，同时改同一批文件会互相覆盖；要隔离请配合 `git worktree` |
| 必须重启一次才生效 | 补丁和扩展都住在扩展宿主进程里，改完必须重启 CodeBuddy |
| 悬停提示位置 | VS Code 只给 `description` / `detail` 元素绑定悬停提示，`label` 永远没有。所以"看全文"必须悬停第二行（自定义 `tooltip` 是提案 API，普通扩展一用就报错） |
| 中文版/英文版 | 界面文案目前是中文，功能与语言无关 |

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

会用 `backup\` 里最新的备份恢复原始文件，并删除扩展目录。然后重启 CodeBuddy。

## 常见问题

**Q：按快捷键没反应 / 提示"任务文件已生成，但本窗口的宿主补丁没有取走它"？**
说明补丁没生效：确认安装后**完全退出**过 CodeBuddy；再运行 `install.ps1` 看是否提示"补丁已是 v2 / 已升级"。

**Q：提示「已生成」，但历史列表里就是找不到？**
- v0.2.0：先看 `%TEMP%\codebuddy-branch\` —— 有 `import-error.log` 就是导入真的失败（里面是宿主抛出的原始错误）；`req-*.json` 迟迟不变名说明没有窗口认领（目标窗口补丁没生效）。
- v0.1.0：分支很可能被**另一个 CodeBuddy 窗口**抢走、导进了那个窗口的项目历史。去 `%LOCALAPPDATA%\CodeBuddyExtension\Data\*\CodeBuddyIDE\*\<md5>\index.json` 里按名字搜 `· 分支`。升级到 0.2.0 可根治。

**Q：想按时间找某一轮？**
列表第一行第二段就是该轮提问时刻；它在 `label` 里，所以直接输入 `10-30` 就能过滤出来。

**Q：列表是空的？**
历史版本出现过这个问题，原因是 `label` 用了 `{label, highlights}` 对象。当前版本用纯字符串，如果仍为空请提 issue 并附 `%APPDATA%\CodeBuddyBranch\probe.log`。

**Q：会不会影响官方功能？**
补丁只新增一个 1.2 秒的定时器和两行赋值，不改任何原有逻辑。理论上无副作用；但修改客户端有风险，**不放心就别装**。

---

## For AI agents

If you are an AI assistant asked to install this for a user, follow these steps **exactly** and stop on any failure.

1. **Verify OS**: Windows only. `node --version` is optional (scripts use PowerShell + Node only where noted).

2. **Locate the target file**:
   ```
   %LOCALAPPDATA%\Programs\CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js
   ```
   If missing, also try `%ProgramFiles%\CodeBuddy CN\...`. If none exist, STOP — the user is not on CodeBuddy IDE.

3. **Dry run first**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
   ```
   - Exit code `0` → anchors found, safe to continue.
   - Exit code `2` → **version mismatch. STOP.** Do not attempt manual string replacement; tell the user their CodeBuddy version is unsupported.

4. **Apply**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

5. **Verify** the patch landed: the target file must contain the literal string `__cbbSvc`, and its size should be roughly original + 1.3 KB. Backup exists at `backup\genie-index-*.js`.

6. **Verify** the extension exists:
   ```
   %USERPROFILE%\.codebuddycn\extensions\local.codebuddy-branch-0.2.0\
       package.json  extension.js  branch-core.js
   ```
   `package.json.version` must equal `0.2.0` and must match the directory suffix. Any `local.codebuddy-branch-<other-version>` folder must be deleted (two copies fight over the same keybinding).

7. **Tell the user to fully quit and reopen CodeBuddy.** Do not substitute "Reload Window" — that does not reload extension code reliably for this case.

8. **Post-install check**: press `Ctrl+Alt+B`. Expected: a quick pick titled `从哪一轮分叉？共 N 轮`. If it errors with `CANNOT use API proposal`, the installed extension is an old build — re-copy `src\extension\*`.

9. **Never commit** `backup/` — it contains Tencent's proprietary code.

10. **Rollback** if anything looks wrong: `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1`.

---

## 免责声明

- 本项目与腾讯云 / CodeBuddy 官方无关，未获其授权或背书。
- 本项目**不包含、不分发**任何腾讯的代码；补丁脚本只对用户本机已安装的文件做字符串替换。
- 修改客户端可能违反 CodeBuddy 的服务条款，可能导致功能异常，**风险由使用者自行承担**。
- 建议同时向官方反馈该需求：CodeBuddy **CLI 版已经支持** `/fork` 与 `/branch`（v2.82.0+），IDE 图形版尚未提供。

## License

MIT（见 `LICENSE`）
