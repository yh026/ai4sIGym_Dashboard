# AISInstrumentationGym 后台迁移记录 · 2026-09-25

新后台和网页源文件已迁回原 [AISInstrumentationGym 文件夹](https://drive.google.com/drive/folders/1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH)。本次迁移没有发布新版 Production。

## 管理入口

- [新版管理表 / 项目目录](https://docs.google.com/spreadsheets/d/1LIoR1wJKW-qqaGLePnrQCmqz3YWatPWwZNtrLkEajXI/edit#gid=202609250)：Start here 列出全部 16 个登记项目，链接各项目的 develop、dataset 和日期归档。Projects、Versions、Pages、Resources、Options 保留原有列、下拉和格式。
- [原公开网站管理表](https://docs.google.com/spreadsheets/d/1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE/edit#gid=202609251)：保留原 15 个项目和人工字段；新增 Start here 链接新版管理入口。仍控制已公开的旧版内容。
- [迁移前备份](https://drive.google.com/drive/folders/1PSAA3w6vr0bTrBoprftgekiQKle1b0On)：两个 Sheet 的原生副本、文件映射、原公开内容清单及校验值。
- [develop 预览](https://develop--aisigym.netlify.app/) 仍需要 Netlify 访问权限。新版均为 Draft / Preview only。

## 文件组织

```text
AISInstrumentationGym/
  AIS Dashboard — Develop Registry
  AI4S Instrumentation Gym Registry
  <原项目文件夹>/
    develop/<version-id>/
      insight.html / workflow.html / 封面与 resources/
    dataset/<dataset-version>/dataset.html
    archive/2026-09-25/
      原 HTML、封面、说明及附属目录
      dataset-v1/                 # TBB 和两个基因项目的旧 Dataset
  battery-curve-shape-explorer/    # 新增项目，无旧公开版本
  _backend_develop/
    snapshots/                    # 内容快照
    imports/                      # 原导入记录
  Archive/2026-09-25-backend-migration/
```

全部 15 个原项目文件夹保留 ID 和名称。新增 Curve Shape 后总计 16 个项目。13 个项目有已接入的 develop 版本：11 个三页项目、Air Quality 和 Road Speed 两个单页项目。两个 Forest 项目与 Raman 保留原记录和归档内容，尚未制作新版。

根目录另有 `projection-gallery-curator` 和 `ml-lifecycle-explorer` 两个技能工具目录，包含 SKILL.md、scripts、references 等。它们不属于上述登记项目，保留原位置和内容。

旧版共移动 42 个条目，包含 40 个普通文件、1 个 Google 文档和 1 个工具目录，没有删除或覆盖内容。13 个 develop 目录和 11 个 Dataset 目录整体移动，57 个当前网页/资源的文件 ID、逻辑路径、内容 hash 和快照版本不变。已被 v2 替代的三个 Dataset v1 也放入各自项目的日期归档。

## 兼容机制与发布边界

原 V2 后台通过显式日期归档映射读取旧文件。同步保留原项目文件夹 ID，主页面选择、文件元数据和 API 的父目录校验识别同一归档来源。映射外文件、归档移到其他项目、错误文件类型仍会被拒绝。

Develop 后台登记了 24 个目录映射。物理路径改变后，构建仍看到原 `projects/<slug>/<version>` 和 `datasets/<id>/<version>` 逻辑路径；读取时核对目录实际属于指定项目，且项目仍在原 AIS 根目录内。API 没有放宽到整个 Drive。

两个 Apps Script 的 URL、访问令牌、签名回执、Netlify 分支变量和 Hook 不变。原 API 更新至版本 22；Develop API 更新至版本 2。原后台恢复每小时同步，自动发布维持 off。新后台仅允许 develop 构建。现有正式站 HTML 不会因 Drive 文件移动而替换。

目前继续使用两张管理表：新版工作在 Develop 表中进行，旧表保留公开版本控制。尚未把全部状态合并到一张表，也未把原内容转换为 V3 Published 记录。

## 验证

- 506 项本地回归检查通过，覆盖过渡路径、归档 API 元数据、目录移出指定项目时拒绝读取、Dataset 版本路径和多父目录拒绝。
- 原后台真实 syncDrive 成功；15 个原项目 ID、文件 ID、人工字段与 Live / Draft、Public / Preview only 状态保留。
- 2026-09-25 12:22（新加坡时间），云端确认原 Production 内容清单完全一致，40 个归档文件 SHA-256 与迁移前一致。
- 12:14，Develop 云端验证全部 57 个源文件，原快照继续有效：`sha256:725f60dde65b3d72b82dcd59a1ae1fa82b9f11ac37ea007fe4a9f86489694355`。
- 完整本地构建使用迁移后的真实 Drive API，成功生成 13 个 demo，读取并校验 36 个页面、21 个资源，最终快照版本一致；没有调用 Netlify Hook。
- 原 API 外部请求验证通过：11 个公开项目的内容清单不变，实际 HTML 和封面返回内容与迁移前一致。
- 正式站 `manifest.json` 和 `deploy-receipt.json` 字节完全不变。develop 首页、清单、回执、demo、Dataset 和资源下载共 6 类路径匿名访问均为 HTTP 401。
- 原后台 12:23 恢复小时同步，自动发布 off。Develop 后台 12:31 恢复每小时预览同步，现有成功回执继续有效。

已部署源码备份（LF 规范化）的 SHA-256：

| 脚本 | 版本 | SHA-256 |
| --- | --- | --- |
| 原 API | 22 | `8c80fa5f83e85821dea8de75c479724be35263729ba7faf8d2a19d42023d96d8` |
| Develop API | 2 | `2e73e02909b0bd751f962dde614270e485f3ca6c428f5aa4fef229fc8d7b8457` |

原 API 安装时基于实际在线版本增量修改，没有覆盖为本地尚未部署的其他同步修复。仓库 Code.gs 保留这些已有修复并加入本次兼容支持；不能把仓库文件 hash 当作上述部署文件 hash。

## 日常更新与回退

通过 Start here 打开项目，更新 develop 或 dataset 版本内的文件，再在 Pages / Resources 更新源链接，执行 **AIS Sandbox → Validate and sync → Build develop preview**。Sandbox 是保留的菜单及内部环境标识，表示仅开发预览。

`archive/2026-09-25` 是当前公开旧版的来源和回退点，不作日常编辑。`dataset-v1` 是被替换版本；回退 Dataset 时，先将其恢复至对应 dataset 目录，再修改 Pages 的版本、源链接并验证。

目录回退先暂停两个后台各自的定时任务，按迁移映射恢复原父目录和名称，再还原路径映射。原归档恢复到项目根目录后，V2 兼容读取仍支持这一步。不能只降级脚本而把文件留在深层归档。用 Sheet 副本恢复前，核对迁移后的人工编辑，避免覆盖新工作。

密钥、Hook URL 和回执密钥仅保存在原 Script Properties、Netlify 环境变量和被忽略的本地私有配置中。
