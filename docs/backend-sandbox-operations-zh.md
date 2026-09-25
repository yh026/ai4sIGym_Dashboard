# AIS 测试后台维护说明

本说明适用于 Develop 后台，不用于发布 Production。2026-09-25 已将管理表和新版文件迁回原 AISInstrumentationGym；旧站保持原内容，详情见 [迁移记录](drive-migration-20260925-zh.md)。当前 13 个已选择的项目中，11 个三页项目都有完整 Dataset；另有 3 个原项目保留记录和旧版归档。

## 入口

- [管理表与全部项目目录](https://docs.google.com/spreadsheets/d/1LIoR1wJKW-qqaGLePnrQCmqz3YWatPWwZNtrLkEajXI/edit#gid=202609250)
- [AISInstrumentationGym 文件总目录](https://drive.google.com/drive/folders/1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH)
- [独立 Apps Script](https://script.google.com/u/0/home/projects/13vUF9owEebxyjfuHzvMN6Cp3dI9zAQrdkkYCLrS-Syb1abkyeTbuKsy9/edit)
- [受保护的 develop 预览](https://develop--aisigym.netlify.app/)，需要相应 Netlify 团队访问权限。

## 五张日常表

| 工作表 | 可维护内容 | 用途 |
| --- | --- | --- |
| Projects | 标题、简介、分类等原有人工字段 | 一个项目一行；稳定 demo_id 不随标题变化 |
| Versions | Layout、State、Permission、Use in develop | 为每个项目选择一个开发版本 |
| Pages | Role、State、Source file、Dataset 引用和 Route | 对应 Insight、Dataset、Workflow 或 legacy 页面 |
| Resources | 封面与下载文件的链接和输出路径 | 包括 TBB 的 Notebook、ZIP 和 Skill |
| Options | 分类选项 | 保留原有原生下拉表结构 |

Projects 最后的开发版、发布版引用，以及 Versions 的 Snapshot digest / Check 是程序生成的只读字段。下划线开头的隐藏表保存校验结果和审计记录，不作为日常编辑入口。

## 更新已有网页

1. 从 Start here 打开项目的 `develop/<version>/`，更新同一 HTML，或将替换文件上传到同一版本目录后修改 Pages 的 Source file。后台逻辑路径和网页 Route 不随 Drive 目录搬迁而改变。
2. 保持 demo_id、Version ID、Page ID 和 Route 不变。改变显示标题不需要新建项目。
3. 如果该版本已经是 Reviewed，先建立新的 Draft 版本；不能让旧审核摘要继续为修改后的内容背书。
4. 在 Versions 中，每个项目只勾选一个 Use in develop。项目、版本的 Private 权限都会排除该版本。
5. 点击表格菜单 **AIS Sandbox → Validate and sync**。校验通过后生成新的内容快照；内容未变则不重复生成。
6. 使用 **Build develop preview**。等待 Projects 显示 **Preview ready**，再从 Preview URL 打开结果。

本机已经具备 GitHub SSH 推送权限；代码更新可以正常 push 到 develop。仅更新 Drive 网页时不需要 Git 提交，通过同步和 Hook 重建即可。需要签名验收的内容构建由 Sheet 发起；带 `[skip netlify]` 的文档提交不会替换当前预览。

Hook 的 accepted 只说明 Netlify 收到了请求；只有包含匹配内容版本、请求、分支、站点和部署编号的签名回执，才会将状态改为 ready。

完整集合实测构建约 10 分钟，成功回执随后写回表格。等待期间可以继续查看上一次成功的预览，不要重复点击构建。

## Dataset 暂时为空或后续接入

- 未接入：Pages 中 Role 选 dataset，State 选 Placeholder，Source file 留空，仍填写 Dataset ID / Dataset version / Route。构建会显示简洁的待接入页面。
- 接入：将完整 HTML 放到对应项目的 `dataset/<version>/dataset.html`，填写文件链接，将 State 改为 Ready，Route 保持不变。后台映射到原 Dataset 逻辑路径。
- Ready 文件缺失、损坏或读不到会阻止构建，不会自动降级成占位。
- SOH 使用 `calce-cs2-soh@v1`，Curve Shape 使用 `calce-cs2-shape@v1`。两者来自相同原始实验，但分别解释 SOH 序列和电压曲线矩阵，不能再指向同一个页面。
- TBB 使用 `himawari-9-ahi@v2`，旧 v1 在项目的 `archive/2026-09-25/dataset-v1`；输出路径仍是 `datasets/himawari-9-ahi/index.html`。两个基因项目也使用 v2，旧 Dataset 同样归档。
- 以后确实需要共享页面时，相同 Dataset ID / version 必须指向同一源文件；各项目保留自己的导航。
- 共享内容更新时建立新的 Dataset version，可供不同开发版本选择；不能直接覆盖已发布版本绑定的文件。

## 下载资源

资源文件放在对应项目版本的 `resources/` 下。Resources 的 Role 为 download；Route 必须在该项目的 `demos/<slug>/resources/` 下。封面 Role 为 card，使用 `assets/cards/<slug>.jpg` 等受支持的路径。

TBB 保留额外的 `workflow-resources.html`。Notebook、完整工作流和方法 Skill 的现有下载地址随内容版本一起校验。

## 错误与恢复

| 状态 / 错误 | 处理 |
| --- | --- |
| Not synced | 先 Validate and sync |
| Sheet / Source changed | 编辑发生在快照之后；重新同步，避免混合版本 |
| Ready Dataset 无文件 | 补正确的 HTML，或明确改回 Placeholder 并清空源链接 |
| Duplicate role / version | 同一版本每种页面角色一行，每个项目只选一个开发版本 |
| Source outside sandbox / approved project folders | 将开发文件放回 Start here 所指的版本目录，不能指向旧站归档或其他项目 |
| Preview accepted | 等待实际构建和签名回执，不要重复触发 |
| Preview failed / 长期未完成 | 先核对 Netlify 构建日志，确认原任务已失败或取消，再使用 Retry failed / unverified preview |
| Preview replaced | 其他未经请求校验的 Git 部署替换了稳定预览；核对构建状态后重新发起验证 |

同一内容版本最多发起三次受控尝试。失败请求不会每小时自动无限重试。不确定请求是否已被接受时，也不自动补发 Hook。构建内容读取失败会保留上一次本地输出，Netlify 构建失败则不成为新的成功产物。

## 自动化与回退

2026-09-24 已在完整预览验证通过后开启测试后台的每小时同步。内容变化时请求新的 develop 构建；内容不变时不新建快照、不重复构建。也可通过菜单手动同步和构建，不必等下一小时。

**Disable sandbox automation** 仅移除本测试脚本自己的 hourlySandbox 触发器。再次开启时使用 **Enable hourly preview sync**，脚本要求已有验证成功的 develop 回执。原后台的触发器不受这些菜单影响。

回退 develop 构建时先关闭 Sandbox 自动化，再恢复 develop 分支原来的 REGISTRY_URL、AI4S_PREVIEW_CALLBACK_SECRET 和对应旧代码 / 已成功产物，删除对应 AIS_REGISTRY_INSTANCE 配置。Production 的变量不参与 develop 构建回退。若回退的是本次目录迁移，则须遵循迁移记录，原 API 归档兼容代码与文件位置必须配套。

密钥和 Hook 地址只能存于 Apps Script Properties、Netlify Builds 范围的 develop 分支环境变量，或受保护的本地临时配置；不要填写在 Sheet、文档或 Git 中。

## 原后台迁移后的边界

原表的 15 个项目全部保留，两个 Forest 项目和 Raman 没有被 13 项开发集合覆盖。Curve Shape 新增在 Develop 表和原文件总目录内，因此总项目数是 16。

目前保留两张管理表：Develop 表维护新版；原表的 Live / Public 状态、项目 ID、旧网址及人工字段不变，schema 2 接口从日期归档继续服务旧构建。统一所有版本状态到同一管理表和发布新版 Production，仍是后续工作。
