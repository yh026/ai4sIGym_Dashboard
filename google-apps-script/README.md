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

## 4. 日常工作流

### 查看代码分支效果

1. 把修改 push 到非 `main` 分支。
   本项目的稳定 Preview 分支是 `develop`。
2. Netlify 通常会因为 Git push 自动更新 Branch Deploy。
3. 如果 Registry Sheet / Drive 数据随后发生变化，使用：
   `AI4S dashboard → Build preview branch`。
4. 使用 `Open preview site` 打开稳定预览地址。
5. 在预览中检查首页、项目分类、卡片、Hover、移动端和项目链接。

### 上线生产

1. 在 GitHub 审查并把分支合并到 `main`。
2. 确认 GitHub 的 `main` 已包含需要的提交。
3. 使用 `AI4S dashboard → Rebuild production site (main)`。
4. 在确认框中选择 Yes。

Production 按钮不会执行 Git merge；如果尚未合并，它只会重新构建现有的 `main`。

## 5. 自动发布

`auto_publish_target` 可选：

- `off`：推荐默认值；同步 Drive 不自动部署。
- `preview`：同步发现变化时只重建配置的 Preview 分支。
- `production`：同步发现变化时自动重建 `main`，仅在确实需要时启用。

旧配置 `auto_publish=yes` 不会在升级后自动变成 Production 自动发布。

## 6. Registry Web App

Preview 和 Production 默认读取同一个 `REGISTRY_URL`，并且 Registry API 默认只返回
`Live` 项目。替换发布控制代码不会改变 Sheet ID 或现有 Web App URL。

保存代码后，菜单函数会使用新代码。为了让部署的 Registry Web App 也固定到同一版本，建议进入：

`Deploy → Manage deployments → Edit → Version: New version → Deploy`

编辑现有 deployment，不要创建无关的新 endpoint；正常情况下 URL 不变，因此 Netlify 的
`REGISTRY_URL` 无需更换。

本版本要求顺序为：**先由部署所有者运行 `setup()` 保存 Sheet ID，再更新 Web App
deployment**。Web App 的访问设置必须允许 Netlify 在**没有登录 Google 账号**时调用；
界面中通常选择 `Anyone`，不要选择只允许 Google 账号的选项。更新后请在无痕窗口打开
Registry URL 验证；如果组织策略禁止匿名 Web App，Netlify 将无法读取此 endpoint。

## 7. 出错时检查

- `Preview build was not started`：检查 Preview Hook、分支名以及 Branch Deploy 设置。
- HTTP 404/401/500：查看 Netlify Deploy log；脚本不会再把这些错误显示成成功。
- Preview 能构建但 Registry 失败：确认 Netlify 的 `REGISTRY_URL` Scope 包含 `Builds`，
  并为 `Production`、`Branch deploys`、`Deploy Previews` 三种 Context 使用同一个值。
- Sheet 的 `Log` 不记录 Hook URL 或 token；失败时可能记录经过脱敏、截断的错误文字。
- `Open preview site` 拒绝打开：同时更新 `preview_url` 和 `preview_url_branch`，确保二者
  对应当前 `preview_branch`。
