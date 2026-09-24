# Backend Sandbox 实施与验证记录

记录日期：2026-09-24。**独立测试后台首次验收完成；13 项预览成功，每小时同步及去重检查通过。原后台与 Production 未迁移。** 本文保留首次验收时的占位页和测试记录；同日下午已接入九个完整 Dataset 文档，最新内容状态见 [Dataset 接入记录](dataset-page-integration-zh.md)。

## 已建立

- 独立工作分支 `codex/drive-backend-sandbox`，位于 Codex 管理的 worktree。原 AIS_Dashboard 工作区及其未提交页面修改保留。
- 独立 Drive 根目录、原生复制的 Google Spreadsheet、独立绑定 Apps Script。原表的 15 项元数据保留在副本中，测试副本全部为 Draft / Preview only。
- 原生 Versions / Pages / Resources 表及隐藏、受保护的机器索引；下拉框、选择框、只读结果列和菜单已在 Google Sheets 实际界面核验。
- 首批 TBB、Air Quality、SOH、Curve Shape 已实际导入，并完成一次完整 Google 云端校验。
- 首次验收时，13 项完整集合已导入测试 Drive / Sheet，共 36 页、21 个资源，正常状态有 8 个 Dataset 占位，共享 Dataset 接入测试期间暂为 6 个。后续 Dataset 接入已将占位数降为 0。
- 独立 Web API 已部署为 Version 1。Netlify 新增 `AIS Registry V3 sandbox develop` Hook；测试脚本已保存该 Hook，Netlify 仅 develop 的 Registry URL / 回执密钥 / 实例标识已切换。Production 的原有配置保持不变。

## 原环境基线

| 项目 | 实际核对值 |
| --- | --- |
| 原 Sheet | `1oRs8xrszKqbJwQuVQGGOm21aC6aTXPPPrwoys6VSijE`，15 个项目 |
| 原 Drive 根目录 | `1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH` |
| 原 Web App | 实际部署 Version 20 |
| 原定时同步 | 原项目中 hourly syncDrive 存在，未修改 |
| 原自动发布 | `off`，无待完成的有效 Preview 请求 |
| Production deploy | `6aa78719ff58fc00081400cb` |
| main commit | `1626fb1f55391c8c1ba6a91e5a199645d3f3beab` |
| 原 develop commit | `91de4c9354bdcfc6d4f62e30ce0f26d40090d457` |
| Production Registry revision | `sha256:65307e13063379158ecfe9c07837f34b5091dbcc64671aa6595fe823f67588b2` |

已保存本地工作区压缩备份、原表相关单元格、正式 manifest / receipt、原绑定脚本当前 HEAD 源码，以及不含密钥的环境记录。源码备份不能冒称部署 Version 20 的逐字节备份；当前 HEAD 与部署版本的源码一致性尚未完全证明。

Netlify UI 显示 Production 为公开，预览为 Private。试点新部署后，未登录访问 develop 首页、manifest、receipt、电池 Dataset、TBB 网页和 Skill ZIP，以及固定部署的 manifest / ZIP，均为 HTTP 401。

## 已完成的验证

| 验证 | 结果 / 范围 |
| --- | --- |
| 原 schema 2 与现有回归 | 501 项完整自动测试通过；含新增 V3、Google 适配器和回执保护测试 |
| 干净代码副本 | 仅用准备提交的文件重新检出，501 项测试再次通过；不依赖未提交的大型本地网页目录 |
| 完整内容构建演练 | 13 项、36 网页、21 资源、8 Dataset 占位；通过本地 HTTP Registry 驱动实际 build.js |
| 内容完整性 | 36 个输出页面科学脚本不变，21 个资源字节校验一致 |
| 实际 Drive 内容完整性 | 最终云端索引的 49 个源文件 SHA-256 和长度全部与导入包一致，覆盖 28 个真实网页源文件及 21 个资源 |
| 版本隔离 | 单元测试证明修改新 Draft 标题 / Workflow 不改变旧 Published 投影；共享可变源文件被拒绝 |
| 失败保留 | 内容校验失败时保留之前可用的构建目录；Production 误接 Sandbox 时拒绝构建 |
| 身份与访问 | 错误 token / audience / schema、原始 Drive ID 直读、旧 revision、跨实例或错误签名回执被拒绝 |
| 回执与恢复 | 请求去重、最大重试次数、并发锁、重复回执、过期回执、未验证 Git 部署替换 ready 的测试通过 |
| 实际 Google 试点 | 4 项快照成功；修复原生复选框空行及实体行号映射差异 |
| 实际无变化同步 | 16:09:36 返回 No content changes; no new snapshot or build，仍保留同一快照 |
| 完整集合定时入口 | 独立脚本仅一个 hourlySandbox 时间触发器；9 月 24 日 12:44:41–12:46:52 手动执行同一入口，先返回 No content changes，再返回 Existing preview request: ready; no duplicate build |
| 实际 Web API | 正确密钥读出 4 个试点；缺失 / 错误密钥、Production、schema 2、原始 Drive ID、过期 revision 六项请求均被拒绝 |
| 实际大文件读取 | TBB 最大下载资源 22,314,567 字节，长度与 SHA-256 均匹配，实测约 140 秒 |
| Git 推送 | 使用本机已有 Lucca-Chen SSH 身份成功将 develop 更新为 de6ca678deb120add7cdaf5d716a2c231a323d52；main 不变 |
| 实际 Netlify 试点 | deploy 6ab4968d9556a30008b46f38，develop / de6ca67；4 分 30 秒成功；日志确认版本绑定的 Preview 请求 |
| 实际签名回执 | 2026-09-24 03:23:46 UTC 写入 preview-ready，4 个 Projects 行显示 Preview ready |
| 完整集合实际构建 | deploy 6ab4a309ad873500083fa388；13 项、36 页、21 资源；2026-09-24 04:22:57 UTC 收到匹配的签名 ready 回执 |
| 最终占位恢复构建 | deploy 6ab4a737e7c9ff000878eec4，10 分 3 秒成功；04:40:59 UTC 收到 ready 回执；13 项均有 Open Preview，两个电池 Dataset 已实际恢复 Content coming soon |
| 云端浏览器 | TBB 图表及 basemap 交互、Insight / Dataset / Workflow 导航、电池占位页、Air Quality 单页 Tab 正常 |
| 共享 Dataset 接入与更新 | 两个电池由 Placeholder 接入同一临时文件；同 file ID 更新 v1→v2 后，新 SHA-256 同步到两行；真实 Netlify 页面均显示 Connection fixture v2，并返回各自 Workflow |
| 完整首页与基因页面 | 首页 13 项，Yuhan 筛选显示 9/13；单细胞首屏全图 8,569 细胞，Cluster 23 / 恢复全图 / Dataset 跳转正常；AD 核心图可见，PLD2 / TPP2 及疾病阶段切换正常 |
| 实际缺失文件与恢复 | Ready Dataset 清空 Source 后同步被明确拒绝，仍保留之前快照；随后已恢复两个 Placeholder 和空 Source |
| 原后台复核 | 原 Projects 前 16 行值和公式与基线一致；推送后 Production manifest / receipt 字节 hash 仍与基线一致 |
| 最终隔离复核 | 原 Projects!A1:R20 值与公式均未变；最终 Production manifest / receipt 与基线逐字节一致；9 个匿名网页 / 下载 / 固定链接请求均为 HTTP 401 |
| 本地浏览器 | 两个基因页核心图保留；单细胞默认 8,569 全部细胞；Cluster 23 可选择后恢复全图；三页往返正常 |
| 本地响应式抽查 | 手机 AD / 电池 Dataset 占位和中等宽度电池页未出现横向溢出；浏览器尺寸已恢复。此次 Chrome 云端窄屏覆写未实际生效，不额外记为手机验收通过 |

首批快照：`sha256:8a02cff987fd7854ae9054e51868083e4bf4b9143d0fd6d2818e1f0c82b71e35`。

最终快照：`sha256:270aa511f3b709fbfe280644f4b8c12b88f9ccd1f7a980b117d1b2d0572b9c81`，对应最终 deploy `6ab4a737e7c9ff000878eec4`。构建代码为 `de6ca67`；后续验收文档提交使用 `[skip netlify]`，不重复部署相同内容。

## 测试结论及后续范围

独立 Drive / Sheet → 校验快照 → develop Hook → Netlify → 签名 ready 回执的完整链路通过。现在可在测试后台维护页面并手动同步，或等待每小时同步；内容不变时不重复构建。

原后台增量迁移范围见 `backend-original-migration-preflight-zh.md`，本轮不执行该迁移。原 15 项应保留，Curve Shape 为新增项目；不能将测试表整表覆盖回原后台。Production 新版发布另行安排。

本机直连 Google API 在测试中出现过连接超时 / EHOSTUNREACH。完整 13 项 manifest 曾成功直接读取并校验；共享 Dataset 的最终证据采用真实 Netlify 构建、签名回执和两个实际网页，未把失败的直连请求记录为通过。

当前报告不能作为 Production 发布或原 Sheet 迁移的验收通过证明。
