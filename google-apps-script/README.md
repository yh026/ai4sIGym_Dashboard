# Google Sheet Apps Script：Preview / Production 使用说明

[`Code.gs`](./Code.gs) 是可以整段粘贴到 **ai4sIGym Demo Registry** 的完整 Apps Script。
它保留原有的 Drive 同步与 Registry API，并把 Netlify 发布拆成两个互不混用的入口：

- **Build preview branch**：只构建经过校验的非生产分支；`main` 和 `master` 会被拒绝。
- **Rebuild production site (main)**：显示确认框，并显式要求 Netlify 构建 `main`。

Google Sheet 按钮只触发构建，不会创建、合并或删除 Git 分支。

## 1. 在 Netlify 准备两个 Build Hook

进入：

`Project configuration → Build & deploy → Continuous deployment → Build hooks`

先把需要预览的分支 push 到 GitHub，并在 Netlify 的 **Branch deploys** 中选择
`All`，或把该分支加入允许列表。让它至少成功部署一次后再创建：

1. `registry production publish`
   - Default branch：`main`
2. `registry preview publish`
   - Default branch：`develop`

复制两个 Hook 的**基础 URL**。格式应为：

```text
https://api.netlify.com/build_hooks/...
```

不要在 URL 后手工添加 `trigger_branch`，脚本会安全地添加并编码该参数。Build Hook URL
相当于发布凭证，不应进入 Git、截图或 Log。

Production branch 必须保持 `main`。`preview_branch` 必须在 Netlify 的 Branch deploys
允许列表中；否则 Hook 可能被接受，但之后的 Deploy 会失败。

## 2. 替换 Apps Script

1. 打开 Google Sheet。
2. 进入 `Extensions → Apps Script`。
3. 备份当前代码或建立一个 Apps Script 版本。
4. 用 [`Code.gs`](./Code.gs) 的全部内容替换编辑器中的旧代码。
5. 保存。
6. 由 **Web App 的部署所有者** 从 Apps Script 工具栏运行一次 `setup()`，按提示授权。
7. 回到 Sheet 并刷新页面，让新菜单出现。

不要让多位编辑者分别运行 `setup()`；每位用户都可能安装一份自己的小时触发器。

`setup()` 还会把当前 Registry Spreadsheet ID 保存到该 Apps Script 项目的
Script Properties。这个步骤不能省略：部署成 Web App 后不存在“当前活动 Sheet”，
`doGet()` 必须通过保存的 ID 重新打开正确的 Registry。

Private Preview 的完成回调还需要在 **Apps Script → Project Settings → Script
Properties** 手工加入两项；不要把它们放进 Sheet 或代码：

| property | value |
| --- | --- |
| `AI4S_NETLIFY_SITE_ID` | Netlify Project ID（Site ID） |
| `AI4S_PREVIEW_CALLBACK_SECRET` | 至少 32 个字符的随机密钥 |

同一个 `AI4S_PREVIEW_CALLBACK_SECRET` 只在 Netlify 的环境变量中再保存一份，Scope
必须是 **Builds**，Deploy context 只给 **Branch deploys**。不要在 Log、截图、聊天
或 Git 中复制它。新版使用独立的 V2 publish state；旧 V1 状态不会被信任或迁移，
commissioning 会从安全的未请求状态重新开始。

`setup()` 会：

- 保留 Demos 数据；
- 保留现有 `access_token`；
- 保留用户自定义的 Config 行；
- 新增 `auto_publish_target=off`，并保留旧 `auto_publish` 行但明确标记为 ignored；
- 添加 Preview / Production 配置。

建议在正式 Sheet 前先用副本执行两次 `setup()`，确认迁移幂等。

## 3. 填写 Config

在 `Config` 标签页填写：

| setting | value |
| --- | --- |
| `netlify_build_hook` | Production Hook 基础 URL |
| `netlify_preview_build_hook` | Preview Hook 基础 URL |
| `production_branch` | `main` |
| `preview_branch` | `develop` |
| `preview_url` | 从 Netlify Deploy 页面复制的真实 Branch Deploy URL |
| `preview_url_branch` | 与上面 URL 对应的完整分支名；通常与 `preview_branch` 相同 |
| `auto_publish_target` | 首次使用保持 `off` |

不要根据包含 `/` 的分支名手工猜 `preview_url`；以 Netlify 显示的地址为准。脚本只有在
`preview_url_branch` 与当前 `preview_branch` 完全相同时才显示预览链接，以免误看旧分支。

`netlify_build_hook`、`netlify_preview_build_hook` 和 `access_token` 都是凭证。
**只有完全可信的人才可以成为这个 Sheet / Apps Script 的编辑者**，不要在截图、聊天或
公开文档中分享 Config。Web App 还会验证文件确实位于配置的 Registry Drive 文件夹或其
直接 demo 子文件夹中，不能只靠手工修改 `file_id` 读取其他 Drive 文件。

Preview 分支默认允许以下形式：

```text
develop
fix/*
feature/*
preview/*
chore/*
docs/*
test/*
refactor/*
hotfix/*
release/*
staging
dashboard-preview
```

需要其他命名规则时，应先有意识地修改 `PREVIEW_BRANCH_PREFIXES` 或
`PREVIEW_BRANCH_NAMES`；不要取消 `main` 防护。

这里的允许名单只控制 Sheet 是否可以触发某个非生产 Hook。内容可见性更严格：只有
Netlify 的稳定 `branch-deploy + develop` 使用 Preview audience（Live + Draft）；PR 的
Deploy Preview 和其他分支仍按 Production-safe 的 Live-only 规则构建。

## 4. 日常工作流

### 查看代码与 Draft 内容

1. 新 HTML 同步到 Sheet 后会自动成为 `Draft`，不要先改成 Live。
2. 把代码修改 push 到 `develop`；Netlify 通常会自动更新 Branch Deploy。
3. 如果 Registry Sheet / Drive 数据随后发生变化，使用：
   `AI4S dashboard → Build preview branch`。
4. 使用 `Open preview site` 打开稳定预览地址。
5. 在预览中检查首页、项目分类、卡片、Hover、移动端和项目链接。
6. 内容通过审核后，才把对应 Sheet 行改为 `Live`。

项目应设置为 `Private → Previews only`。这样 Production 仍公开，而稳定 Branch Deploy
和 PR Deploy Preview 都要求 Netlify 团队登录。所有非 Production 构建仍发送
`X-Robots-Tag: noindex, nofollow`，但真正的访问边界来自 Netlify 身份验证。

### 上线生产

代码发布：在 GitHub 审查 `develop → main`。只有代码已经可以公开上线时才合并；当前
Netlify Continuous Deployment 会在 merge 后立即创建一次 Production deploy。不要再为
同一版本点击 `Rebuild production site (main)`，否则会多创建一次 Production deploy。

纯 Drive/Sheet 内容发布：无需 Git merge。先在私有 develop Preview 审核 Draft，把批准的
行改为 `Live`，再使用 `AI4S dashboard → Rebuild production site (main)`，并在确认框选择
Yes。该按钮只重建已经位于 `main` 的代码。

Production 按钮不会执行 Git merge；如果尚未合并，它只会重新构建现有的 `main`。

## 5. 自动发布

`auto_publish_target` 可选：

- `off`：推荐默认值；同步 Drive 不自动部署。
- `preview`：同步发现变化时只重建配置的 Preview 分支。

Production 不属于 Apps Script 自动目标。内容发布只能通过带 Yes/No 确认的
`Rebuild production site (main)` 手动触发；代码 merge 在 Netlify Continuous
Deployment 开启时会独立触发 Production。旧配置 `auto_publish=yes` 或旧的
`auto_publish_target=production` 都会在升级后安全回退为 `off`。

Preview 自动化不再只看 `new + updated` 计数，而是比较稳定的 Registry revision，
所以新增、修改、移出文件夹、文件恢复和可发布的 Sheet 元数据变化都会进入同一流程。
Build Hook 返回 2xx 只表示 **accepted**；本地 Netlify Build Plugin 只有在
`branch-deploy + develop` 部署成功后，才把 `dist/deploy-receipt.json` 通过 HMAC
认证回调给 Apps Script，完全匹配当前 request ID、requested_at、Registry revision、
Site ID、分支和 context 后才记为 **ready**。它不会匿名读取 Private Preview URL。

Hook 非 2xx 或网络失败仍按有限退避重试；一旦 Hook 已 accepted，即使完成回调丢失，
小时同步也**不会**重复创建 Branch Deploy。15 分钟后状态显示
`verification-timeout`，必须先查看 Netlify，再由人明确使用 `Build preview branch`
重试。`Preview publish status` 只读状态，不会触发构建。

同一个插件也会报告新的、未验证的 `develop` Git Branch Deploy，用来撤销已过期的 ready
状态。Production、PR Deploy Preview 和其他分支在插件入口即跳过，不发送回调。

## 6. Registry Web App

Preview 和 Production 读取同一个 `REGISTRY_URL`，但每次构建都会覆盖查询范围：

- 缺省或 `audience=production`：只返回健康的 `Live` 项目；
- `audience=preview`：只返回健康的 `Live + Draft` 项目；
- `Archived`、未知 status、`missing`、`unreadable`、`page empty`：两边都不返回。

Manifest 和 file endpoint 使用同一个 audience，因此 Production 无法通过文件接口读取
Draft 页面。构建端还会按相同矩阵二次过滤，即使旧的 `REGISTRY_URL` 曾附带
`status=all`，也会先删除该参数。替换代码不会改变 Sheet ID、token 或现有 Web App URL。

保存代码后，菜单函数会使用新代码。为了让部署的 Registry Web App 也固定到同一版本，建议进入：

`Deploy → Manage deployments → Edit → Version: New version → Deploy`

编辑现有 deployment，不要创建无关的新 endpoint；正常情况下 URL 不变，因此 Netlify 的
`REGISTRY_URL` 无需更换。

本版本要求顺序为：**先由部署所有者运行 `setup()` 保存 Sheet ID，再更新 Web App
deployment**。Web App 的访问设置必须允许 Netlify 在**没有登录 Google 账号**时调用；
界面中通常选择 `Anyone`，不要选择只允许 Google 账号的选项。更新后请在无痕窗口打开
Registry URL 验证；如果组织策略禁止匿名 Web App，Netlify 将无法读取此 endpoint。
`doPost?action=preview_callback` 虽然匿名可达，但会先用仅存于 Script Properties 与
Netlify Builds 环境中的共享密钥验证原始 payload 的 HMAC，再解析内部回执。

### Registry v2 的 develop-only 接线

Registry v2 使用独立、owner-only 的 Sheet，但继续复用现有 Web App、access token 和
V1 Config 中的 Drive root。升级现有项目时不要运行 `setup()`，也不要创建第二个 Web App
或第二个 trigger。在 Script Properties 增加：

| property | value |
| --- | --- |
| `AI4S_REGISTRY_V2_SPREADSHEET_ID` | Registry v2 Sheet ID |
| `AI4S_PREVIEW_REGISTRY_SCHEMA` | `2` |

缺失第二项或值不是精确的 `2` 时，Preview 自动化继续使用 V1 revision。Web App 请求没有
`schema=2` 时也继续返回 V1。构建端仅对稳定的 `branch-deploy + develop` 强制
`schema=2`；Production/main 与 PR Deploy Preview 强制 `schema=1`。

现有的唯一 `syncDrive` 同时维护 V1 与 V2，不需要第二个 trigger。V2 自动发现范围刻意保持
简单：Drive root 的英文命名直接子文件夹，且其中有一个可明确选定的直接子 HTML。第一次
发现时，会把项目作为 `Draft`、`Preview only`、`Featured=false` 追加到 `ProjectsCatalogV2`
原生表，并以 `demo-<folder-slug>` 与 Drive `file_id` 建立稳定身份。根目录 loose HTML、
shortcut、非英文文件夹和主页面不明确的多 HTML 文件夹不会自动进入 V2。

新行只把 HTML/`ai4s-meta`/`PROVENANCE.md` 中可精确识别的英文内容作为首次填写建议；
不会猜测 taxonomy，也不会自动升级为 Live 或 Public。之后人工只编辑 `Projects`，同步会按
隐藏的 `demo_id` 更新 `_Registry` 与 `_Facets`。未补完的 Draft 显示 `Action needed`，不会
进入 build-facing manifest、不会改变 Preview revision，也不会触发部署。删除或移出 HTML
只会把机器状态标为 missing 并保留记录；同一 Drive 文件恢复后会恢复。删除后重新上传得到
新的 `file_id` 时不会被猜成原项目，需要人工迁移。

V2 每个项目最多选择一张卡片图片。把图片作为项目 HTML 同一 Drive 文件夹的直接子文件，
在 `Projects → Card Image` 只填写文件名（例如 `card.jpg`），并填写英文 Image Alt Text。
第一轮只支持 Drive 图片；外部 URL 不启用。图片为空时继续使用仓库内匹配的静态预览图。
`action=asset` 会按同一 V2 audience 与 Registry revision 授权，并返回不含 Drive ID 的小型
base64 envelope；构建再把它写入 `dist/assets/cards/`。

发布时编辑**现有** deployment，选择 New version，保持 Deployment ID、URL、execute-as
和访问范围不变。不要运行 `setup()`；唯一的 `syncDrive` trigger 与其他 Script Properties
必须保持不变。

## 7. 出错时检查

- `Preview build was not started`：检查 Preview Hook、分支名以及 Branch Deploy 设置。
- HTTP 404/401/500：查看 Netlify Deploy log；脚本不会再把这些错误显示成成功。
- Preview 能构建但 Registry 失败：确认 Netlify 的 `REGISTRY_URL` 已标记为 secret，Scope
  只包含 `Builds`，并至少提供给 `Production` 与可信的 `develop` Branch Deploy。公共仓库
  的 fork PR 必须 Require approval 或在没有 sensitive variables 的情况下部署，不能让未审批
  的 PR 构建读取 Registry token。
- 状态停在 `verification-timeout`：核对两端的 `AI4S_PREVIEW_CALLBACK_SECRET` 与
  `AI4S_NETLIFY_SITE_ID`；修正后只手动构建一次 Preview，不等待小时同步重复部署。
- Sheet 的 `Log` 不记录 Hook URL 或 token；失败时可能记录经过脱敏、截断的错误文字。
- `Open preview site` 拒绝打开：同时更新 `preview_url` 和 `preview_url_branch`，确保二者
  对应当前 `preview_branch`。
