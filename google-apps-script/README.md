# Registry v2 Apps Script：单一控制面部署说明

[`Code.gs`](./Code.gs) 只用于绑定在正式 Registry v2 Google Sheet 上的 Apps
Script 项目。V2 是唯一 Registry、唯一菜单入口和唯一同步目标；归档后的 V1 不再提供
`Demos`、`Config`、`Log`、发布配置或 Web App 数据。

本文件描述 cutover 后的结构。不要把这版代码部署到 V1 后继续把 V1 当后台，也不要在
V2 上运行旧版 `setup()`。

## 1. 控制面边界

V2 workbook 保存：

- `Projects`：维护者日常编辑的 15 个英文可见字段，以及隐藏 `demo_id`。
- `_Registry`、`_Taxonomy`、`_Facets`、`_Assets`：构建使用的机器数据。
- `_Config`：非敏感站点信息，例如 `schema_version`、`site_title`、
  `site_tagline`、`preview_base_url`。
- `_Audit`：Apps Script 追加的同步和发布事件。
- `_Schema`：字段字典。

以下内容只保存在新 Apps Script 项目的 Script Properties，不得放进 Sheet、Git、截图或
日志：

| Property | 用途 |
| --- | --- |
| `AI4S_DRIVE_FOLDER_URL` | Demo Drive root URL 或 ID |
| `AI4S_REGISTRY_ACCESS_TOKEN` | Registry Web App token |
| `AI4S_NETLIFY_PRODUCTION_BUILD_HOOK` | main Production Hook 基础 URL |
| `AI4S_NETLIFY_PREVIEW_BUILD_HOOK` | develop Preview Hook 基础 URL |
| `AI4S_PRODUCTION_BRANCH` | 必须为 `main` |
| `AI4S_PREVIEW_BRANCH` | 通常为 `develop` |
| `AI4S_PREVIEW_URL` | 真实 Private Branch Deploy URL |
| `AI4S_PREVIEW_URL_BRANCH` | 必须与 Preview branch 一致 |
| `AI4S_AUTO_PUBLISH_TARGET` | `off` 或 `preview`；永远不能自动 Production |
| `AI4S_NETLIFY_SITE_ID` | Preview callback 校验的 Netlify Site ID |
| `AI4S_PREVIEW_CALLBACK_SECRET` | 至少 32 字符的 HMAC secret |

`AI4S_REGISTRY_V2_SPREADSHEET_ID` 由新版 `setup()` 在校验成功后写入。不存在 V1 Config
fallback；V1 被移动、保护或归档后，V2 必须仍能独立运行。

## 2. 为什么需要新的 bound script 和 Web App URL

Google Apps Script 不能把一个已经绑定 V1 Sheet 的 container-bound project 改绑到 V2。
要让 `AI4S dashboard` 菜单出现在 V2，必须在 V2 中通过
`Extensions → Apps Script` 建立新的 bound project，再完整写入：

- `Code.gs`
- `appsscript.json`

新 script project 有自己的 Properties、trigger、授权和 deployment。它不会继承 V1 的
任何这些资源，因此 cutover 会产生一个新的 Web App URL。Netlify 的 `REGISTRY_URL` 只能在
Private Preview 验收新 endpoint 后切换。

## 3. 安全 commissioning 顺序

1. 把旧 V1 和当前 V2 导出备份，记录旧 deployment、trigger、Properties key set 和
   Production 基线。
2. 把自动发布临时设为 `off`。
3. 在旧 V1 Apps Script 项目中删除或停用 hourly `syncDrive` trigger。确认旧 trigger 已经
   停止后再继续；不要让 V1 与 V2 trigger 同时运行。
4. 移动同一个 V2 Sheet 到目标 Drive 文件夹；不要制作副本。确认 Spreadsheet ID 不变，
   并核对目标文件夹的权限继承没有扩大编辑者范围。
5. 从 V2 创建新的 bound Apps Script project，写入完整 code 和 manifest。
6. 在新项目中逐项创建上表 Properties。复制值时不要把值写进操作文档或日志。
7. 运行一次新版 `setup()`。它只会：
   - 校验 V2 六张 compiler input tabs、`_Audit` 和原生 `ProjectsCatalogV2` table；
   - 校验必要 Properties、Hook、分支、Preview URL 和 Drive root；
   - 保存 V2 Spreadsheet ID；
   - 安装当前 owner 的唯一 hourly `syncDrive` trigger；
   - 创建 V2 菜单。
8. 保持旧 V1 trigger 停用，确认当前只有新 V2 项目的一个 hourly `syncDrive` trigger，
   再手动运行一次 V2 `Sync Drive folder now`。核对 `Projects`、`_Registry`、`_Facets`、
   `_Assets`、Readiness 和 `_Audit`。
9. 将新项目部署为 Web App：execute as owner，并使用允许 Netlify 无 Google 登录访问的
   access 设置。新 URL 必须先用无痕浏览器验证：无 token 返回 `bad token`；正确 token 的
   manifest 返回 `schema_version: 2`。
10. 在 Netlify Private develop Preview 中临时使用新 `REGISTRY_URL` 做 manifest、HTML、
   asset、路由、权限和 callback canary。
11. 通过后按批准窗口切换正式 Netlify `REGISTRY_URL`；再次确认全局唯一 active trigger
    仍然是 V2 的 `syncDrive`。
12. Production 也固定请求 schema 2，因此最终切换需要一次明确批准的 Production build。
    验收通过后才把 V1 移入 Archive 并设为只读。

不要在新项目运行旧版 setup，不要让新旧 trigger 同时工作，也不要在 Preview canary 前先
归档 V1。

## 4. 日常 V2 工作流

上传一个项目：

```text
configured Drive root/
  english_project_folder/
    english_project_folder.html
    PROVENANCE.md             # recommended
    card.jpg                  # optional
```

然后在 V2 选择：

`AI4S dashboard → Sync Drive folder now`

每次同步都会完整枚举配置的 Drive root，并直接按 `_Registry.file_id` 与 V2 对账：

- 新的英文直接子文件夹以 `Draft + Preview only + Featured=false` 进入 V2。
- 根目录 loose HTML、shortcut、非英文文件夹和主 HTML 不明确的文件夹不自动入库。
- 相同 Drive file ID 重跑幂等。
- 文件移出边界后保留记录并标为 missing；同一 file ID 恢复后恢复原身份。
- `Projects` 人工字段不被同步覆盖。
- `_Registry`、`_Facets`、`_Assets`、Readiness 和 Preview URL 继续使用现有并发检查。
- 同步事件写入 `_Audit`，不再写 V1 Log。

Drive scan 的 skip reason 会先经过与 `_Audit` 写入完全相同的英文净化，再按每条 Audit
detail 的 1,000 字符上限打包。正常的 3 条 notice 只 append 一行；超长单条会带 part 标识
分片，大批 notice 会拆成带 batch 标识的多行，所有净化后的 reason 都会保留。扫描使用
`try/finally` flush 已观察到的 notice，因此后面即使发生 fail-closed Drive 错误，前面已经
观察到的 skip reason 仍会进入 `_Audit`。

增量快路径只省略不必要的 blob 和 workbook I/O，不省略 Drive 安全检查：

- 每次同步仍会验证 demo folder、完整 HTML 清单、`PROVENANCE.md` 和受支持图片的 ID、
  名称、MIME、修改时间、大小和直接父级关系；cache hit 不会绕过这些检查。
- 健康且未变化的现有页面可以复用 Script Properties 中的 v1 fingerprint hint。该 hint
  绑定 Spreadsheet ID、Drive root、页面身份和当前 `_Registry` 输出 hash；cache value 只有
  schema 号与 input/output SHA-256，不保存 HTML、provenance 内容或任何凭据。
- 首次读取、来源变化、cache 损坏、来源不健康、missing/recovery 都不能使用 warm hint；
  对仍存在的来源会重新下载并解析 HTML 和 provenance，missing 记录则保留为 tombstone。
- Script Properties 读取、写入、配额或解析失败只会让本次或下次同步走完整读取路径，
  不会放宽验证，也不会改变正确结果。
- metadata、原生 table 和最终 workbook equality gate 全部通过后，如果目标与起始状态完全
  相同，本次 no-op 会跳过 Sheets batch、`flush()`、重新打开和 post-read。
- 如果目标确实变化，仍使用一次受保护的原子 Sheets batch，随后 `flush()`、按稳定 ID
  重新打开 V2，并对六张输入表做精确 post-write verification。Fingerprint 只会在 no-op
  linearisation point 或这个精确验证成功后提交。

当前已发布的 fast-path 基线为
`develop@9a9fec8126de2673b729d4c1dc1788220fc2b2a1`，`Code.gs` SHA-256 为
`5c2c56c2b04dfdea5386c20932be90e08a1220e0e41e6d3e81d793c3fb3b246a`。正式 Apps Script
Web App 保持原 deployment ID 和 `/exec` URL，代码为 Version 12，deployment topology
仍精确为 2，完整测试为 280/280。该上线步骤触发了 0 次 Netlify deploy，Published
Production 保持不变。

Version 12 现场 warm sync 从 17:41:10 到 17:41:37，`_Audit` 可见耗时 27 秒：16/16
fingerprint reuse、0 个来源重新解析，且 Sheet 已是 current。旧版三次 no-change 样本为
104/71/56 秒，中位数 71 秒；当前减少 44 秒（61.97%），速度为旧基线的 2.63 倍，同时满足
`≤35 秒` 和 `≥50%` 两个目标。最终 V2 Sheet 是 Projects 16（全部 `Live + Publication
ready`）、`_Registry=16`、`_Facets=50`、`_Assets=16`，其中 Raman 在 Sheet 中已是
`Live + Public`；这不表示 Production 已更新：Published Production 仍是此前 15 条 demo
route，Raman 因自动发布为 `off` 且没有 deploy 而尚未出现。

新 Draft 补齐 Card Summary、Department、Subtopic、Task Type 和 Methods 后，才会成为
Preview ready。Card Image 和 Data Source 仍为可选字段；选择图片时，图片必须是项目 HTML
同一文件夹的直接子文件，在 Card Image 填写精确文件名（不是 Drive ID、路径或 URL），并
填写英文 Image Alt Text。同步会自动维护 `_Assets`；同名图片替换后采用新的 Drive ID，
清空 Card Image 会移除对应机器索引。

## 5. Preview 与 Production

- `Build preview branch`：只请求允许的非 Production 分支，使用 V2 Preview audience
  （健康 Live + Draft）。
- `Rebuild production site (main)`：必须人工确认，只请求 `main`，使用 V2 Production
  audience（健康 Live + Public）。
- `AI4S_AUTO_PUBLISH_TARGET=preview`：小时同步只可自动请求 Private Preview。
- Production 永远没有 Apps Script 自动路径。

当 `AI4S_AUTO_PUBLISH_TARGET=off` 时，一次成功同步可以把刚刚完成精确验证的 Preview
snapshot 仅用于 desired revision 与 callback receipt 对账；这条路径不会 POST Build Hook。
人工 `Build preview branch` 和 `AI4S_AUTO_PUBLISH_TARGET=preview` 的自动 Preview 请求都必须
从当前 V2 workbook 重新 live compile，不能复用该 sync snapshot。发布阶段还会重新读取最新
Script Properties 中的 branch、Hook、token 和自动发布开关；同步阶段携带的只是非敏感 Sheet
config base。

Web App 只接受 schema 2。省略 `schema` 等同于 schema 2；显式 `schema=1` 返回错误。构建端
对 Production、stable develop、PR Preview 和其他 Netlify context 也全部请求 schema 2，
不会回退到 V1。

## 6. 回滚

在首次 Production schema-2 验收完成前，保留旧 V1 文件、旧 deployment URL 和导出备份，
但保持旧 trigger 与自动发布关闭。如果新 endpoint canary 失败：

1. 不触发 Production。
2. 将 Netlify Preview 的 `REGISTRY_URL` 恢复为旧 endpoint。
3. 停用新 V2 trigger，恢复旧 trigger 时确保全局仍只有一个 active `syncDrive`。
4. 根据 `_Audit`、Apps Script execution log 和 Netlify build log 修复后重新 canary。

Production 已切到 V2 并验收后，V1 只作为只读历史档案，不再作为运行时回滚数据源。回滚应
使用保留的 Production deploy 和版本化代码，而不是让新代码静默请求 schema 1。
