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

## 已验证版本

| CodeBuddy IDE | genie 扩展 | 状态 |
|---|---|---|
| 1.106.1 | 3.10.0 | ✅ 已验证可用 |

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
3. 在三个位置各插入一小段代码（总共约 1 KB）
4. 把扩展复制到 `%USERPROFILE%\.codebuddycn\extensions\local.codebuddy-branch-0.1.0\`

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
第 18 轮（全量）｜[图片 ×1] 我再提一个小小的问题，这个问题不大，就是一个    ← 第一行：轮次 + 问题前 30 字
[图片 ×1] 我再提一个小小的问题，这个问题不大，就是一个小小的问题。我看…      ← 第二行：完整提问（悬停可看全文）
```

- 可以用键盘输入关键词过滤
- 虚线以下都是同一轮，选中后约 1~2 秒，历史列表里就会多一条 `原标题 · 分支N`
- **当前对话不会切走，正在跑的任务不会中断**

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
[Ctrl+Alt+B] → 本地扩展读取磁盘会话 → 生成归档 JSON → 写入 %TEMP%\codebuddy-branch\pending.json
                                                                          │
                                       genie 补丁每 1.2s 轮询 ─────────────┘
                                                                          ↓
                            CodeBuddy 官方导入链路：
                            parseConversationArchive → conversationManager.importConversation
                            → 写盘 → conversationMap.set → persistIndex
                            → onConversationCreatedEmitter.fire({ setAsCurrent: false })
                                                                          ↓
                                              历史列表立刻刷新，当前会话不切换
```

- 归档格式：`{ schema:"codebuddy.conversation", schemaVersion:1, exportedAt, data:{ lastMessageAt, conversations:[...] } }`
- 单文件上限 100 MB
- 分支 = 该轮及之前的**全部对话历史**，原会话一个字节都不改

## 已知限制

| 限制 | 说明 |
|---|---|
| IDE 升级会覆盖补丁 | 升级后重跑 `install.ps1` 即可（会重新备份 + 打补丁） |
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

**Q：按快捷键没反应 / 提示"宿主没消费"？**
说明补丁没生效：确认安装后**完全退出**过 CodeBuddy；再运行 `install.ps1` 看是否提示"补丁已存在"。

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
   %USERPROFILE%\.codebuddycn\extensions\local.codebuddy-branch-0.1.0\
       package.json  extension.js  branch-core.js
   ```
   `package.json.version` must equal `0.1.0` and must match the directory suffix.

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
