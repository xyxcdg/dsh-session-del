# dsh-session-del — 给 DSH 补上「删除会话」

> 一个 DSH（DeepSeek Harness）插件：把「删除对话」做成一条**可回滚、可预演、可恢复**的流水线。
> 顺手解决删除后残留的「索引幽灵」和「归档计数虚高」。

DSH 界面上的会话行菜单只有 **重命名 / 分叉 / 归档 / 置顶** —— 没有「删除会话」；
菜单里的「删除」只对**工作区**生效，不会删掉会话记录。想真正清理会话只能翻目录、改索引，
既不安全也容易把 `workspace.json` 改坏。本插件把这件事收进侧栏面板 + 一组工具 + 同源接口，
**所有破坏性动作都先备份、只移动不删除**，任何一步都能退回去。

---

## 好处

- **补上界面缺失的能力**：真删会话（移到回收区），不再需要手改文件。
- **可回滚，不怕手滑**：删除 = 把会话目录移到 `session-trash/<时间戳>/` 并写 `manifest.json`，
  **从不 rm**；删错了用「回收区 → 恢复」原路搬回。删除前自动备份 `workspace.json`。
- **先预演再动手**：默认 `apply=false`，只打印「将会删哪些、移到哪」，确认后再真删。
- **保护关键会话**：置顶会话默认跳过，要单独勾选才会动。
- **清理索引幽灵**：目录已没、索引里还在的「幽灵 id」一键剔除，解决「删了界面还在」「归档数虚高」。
- **回收区自动溯源**：批次带原始组名与标题，恢复时不用猜它原来属于哪个项目。
- **三种用法任选**：侧栏可视化面板 / Agent 工具 / HTTP 接口（也可用宿主外的 CLI 等价物）。
- **改逻辑不必重启 DSH**：core 走 mtime 版本戳的动态 import，HMR 重载入口即生效。
- **宿主升级不连坐**：所有宿主 API 先探测再调，失败只降级（少个工具/路由），绝不让整个 DSH 起不来。

---

## 安装

作为 DSH 插件（bundle 形态）安装到某个 profile：

```powershell
# 在插件目录内（本仓库根目录）
dsh plugin --profile desktop add .
# 或在插件管理界面里启用 dsh-session-del
```

`cordis.patch.yml` 会把 `dsh-session-del` 注入到 profile 的插件链里。
装好后侧栏多一项 **「会话清理」**（order 22）。

> 也可以直接把本目录 link 进 profile 的 `node_modules`（开发调试时更常用）。

---

## 使用

### 1. 侧栏面板（推荐）

点侧栏 **「会话清理」**：

1. **列出**全部会话：id 前缀、标题、大小、最后修改、可见/归档/置顶/幽灵。
2. 勾选要处理的会话 → 点 **预演** 看计划 → 点 **真删**。
3. 想看历史删除批次 → **回收区**；要还原 → 选批次 → **恢复**。

面板的写操作会自动带 `X-Session-Del: 1` 头（防跨站写入）。

### 2. Agent 工具（让模型直接操作）

装好后会注册 5 个工具：

| 工具 | 作用 |
| --- | --- |
| `session_del_list` | 列出全部会话（可按 `only=all/archived/visible/ghost/unpinned` 过滤） |
| `session_del_delete` | 真删会话（`apply=true` 才执行；`includePinned` 连置顶一起） |
| `session_del_sync_ghosts` | 清理索引幽灵 id（`apply=true` 才写） |
| `session_del_trash` | 看回收区批次 |
| `session_del_restore` | 从回收区恢复（给 `batch`，可选 `names`） |

典型对话：

```
> 帮我把已归档的会话列出来，然后真删掉，删之前先给我看计划
→ session_del_list(only="archived")
→ session_del_delete(ids=[...], apply=false)   # 先预演
→ session_del_delete(ids=[...], apply=true)    # 确认后真删
```

### 3. HTTP 接口（同源）

```
GET  /session-del/api/list
GET  /session-del/api/trash
POST /session-del/api/delete         { ids, apply, includePinned }
POST /session-del/api/sync-ghosts    { apply }
POST /session-del/api/restore        { batch, names }
POST /session-del/api/purge          { apply, minAgeDays }
```

POST 需要请求头 `X-Session-Del: 1`。

### 4. 调度式自动清理（可选，宿主外，不依赖 DSH 运行）

本仓库只包含**插件本体**。如果你还需要「不开 DSH 也能跑」的批处理清理，可用一组同源的
PowerShell 脚本（自行部署，不随本仓库发布）：

- `Session-Manager.ps1 -Action list|show|hide|delete [-Apply]`：预演 → 执行，删除同样移到
  `session-trash`（可恢复）、先备份 `workspace.json`。
- `session-autopurge.ps1 [-Apply]`：按「会话目录整树 7 天未动」阈值批量清理，配
  `session-keep.txt` 白名单保护指定会话、单次上限 200、回收区超 30 天真删。

把它注册成每日计划任务即可无人值守。QQ 机器人的会话在另一个根（`sessions-qqbot`），永不被清。

---

## 删除到底做了什么（可回滚流水线）

1. 备份 `storages/workspace.json` → `workspace.json.bak-sessiondel-<时间戳>`；
2. 把会话目录**移动**到 `<DSH_HOME>/session-trash/<时间戳>/`（**从不 rm**），写 `manifest.json`
   记下原始组名与标题；
3. 把 id 从「工作区归属」「归档集」「置顶集」里剔除；
4. 追加一行日志到 `<DSH_HOME>/logs/session-del.jsonl`。

置顶会话默认跳过（勾「连置顶一起处理」才动）。回收区超期批次可再真删（默认 30 天）。

---

## 三个必须知道的边界

- **storages 是内存权威**：DSH 运行中用脚本改 `workspace.json`，进程下一次写入
  （新建会话/归档/置顶）会整份覆盖回去。判断「改了没生效」要看进程是否重启过，别只看文件内容。
  界面仍有旧条目 = 点「清理幽灵 ID」，或重启 DSH。
- **会被删的是「目录」**：正在被本进程打开的会话目录也能移动（Windows 允许 rename），
  但那个会话之后的写入会失败 —— 删之前先确认不是当前正在用的会话。
- **不谈会话内容**：本插件只动目录与索引，不解析会话正文。

---

## 目录结构

```
dsh-session-del/
├─ index.js            # 宿主半：注册 5 个工具 + /session-del/api/* 路由
├─ client.js           # 客户端半：侧栏「会话清理」面板
├─ lib/core.js         # 唯一核心：列/删/幽灵/回收区/恢复/真删（动态 import + mtime 版本戳）
├─ cordis.patch.yml    # bundle 注入声明
├─ icon.svg            # 面板图标
├─ package.json        # 插件清单（dsh.bundle / dsh.client）
└─ verify-core.mjs     # 自测（全部在临时 DSH_HOME 里跑，不碰真实会话）
```

---

## 自测

```powershell
cd <本目录>
node verify-core.mjs      # 42 项，全部在临时 DSH_HOME 里跑，不碰真实会话
```

覆盖：列表合并、真删、幽灵清理、回收区恢复、超期真删、索引损坏不静默、
标题源回落、`DSH_HOME` / U-DSH 布局推导等。

---

## License

MIT
