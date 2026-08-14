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

同步只扫描一次 Drive，并直接按 `_Registry.file_id` 与 V2 对账：

- 新的英文直接子文件夹以 `Draft + Preview only + Featured=false` 进入 V2。
- 根目录 loose HTML、shortcut、非英文文件夹和主 HTML 不明确的文件夹不自动入库。
- 相同 Drive file ID 重跑幂等。
- 文件移出边界后保留记录并标为 missing；同一 file ID 恢复后恢复原身份。
- `Projects` 人工字段不被同步覆盖。
- `_Registry`、`_Facets`、`_Assets`、Readiness 和 Preview URL 使用现有并发检查与单批写入。
- 同步事件写入 `_Audit`，不再写 V1 Log。

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
