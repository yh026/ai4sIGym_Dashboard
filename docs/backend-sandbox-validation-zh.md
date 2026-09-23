# Backend Sandbox 实施与验证记录

记录日期：2026-09-23。**状态：测试 API 与 develop Hook 已配置；等待用户推送代码后进行真实 Netlify 构建验证。未迁移原后台。**

## 已建立

- 独立工作分支 `codex/drive-backend-sandbox`，位于 Codex 管理的 worktree。原 AIS_Dashboard 工作区及其未提交页面修改保留。
- 独立 Drive 根目录、原生复制的 Google Spreadsheet、独立绑定 Apps Script。原表的 15 项元数据保留在副本中，测试副本全部为 Draft / Preview only。
- 原生 Versions / Pages / Resources 表及隐藏、受保护的机器索引；下拉框、选择框、只读结果列和菜单已在 Google Sheets 实际界面核验。
- 首批 TBB、Air Quality、SOH、Curve Shape 已实际导入，并完成一次完整 Google 云端校验。
- 13 项完整集合的独立导入包已上传到测试 Drive，剩余项目尚待试点发布验证后导入。
- 独立 Web API 已部署为 Version 1。Netlify 新增 `AIS Registry V3 sandbox develop` Hook；测试脚本已保存该 Hook，Netlify 仅 develop 的 Registry URL / 回执密钥 / 实例标识已切换。Production 的原有配置保持不变，自动发布仍关闭。

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

Netlify UI 显示 Production 为公开，预览为 Private。未登录访问旧 develop 首页、manifest、TBB 直达路径和旧部署固定链接均为 HTTP 401。新部署后的权限负向测试仍待执行。

## 已完成的验证

| 验证 | 结果 / 范围 |
| --- | --- |
| 原 schema 2 与现有回归 | 501 项完整自动测试通过；含新增 V3、Google 适配器和回执保护测试 |
| 干净代码副本 | 仅用准备提交的文件重新检出，501 项测试再次通过；不依赖未提交的大型本地网页目录 |
| 完整内容构建演练 | 13 项、36 网页、21 资源、8 Dataset 占位；通过本地 HTTP Registry 驱动实际 build.js |
| 内容完整性 | 36 个输出页面科学脚本不变，21 个资源字节校验一致 |
| 版本隔离 | 单元测试证明修改新 Draft 标题 / Workflow 不改变旧 Published 投影；共享可变源文件被拒绝 |
| 失败保留 | 内容校验失败时保留之前可用的构建目录；Production 误接 Sandbox 时拒绝构建 |
| 身份与访问 | 错误 token / audience / schema、原始 Drive ID 直读、旧 revision、跨实例或错误签名回执被拒绝 |
| 回执与恢复 | 请求去重、最大重试次数、并发锁、重复回执、过期回执、未验证 Git 部署替换 ready 的测试通过 |
| 实际 Google 试点 | 4 项快照成功；修复原生复选框空行及实体行号映射差异 |
| 实际无变化同步 | 16:09:36 返回 No content changes; no new snapshot or build，仍保留同一快照 |
| 实际 Web API | 正确密钥读出 4 个试点；缺失 / 错误密钥、Production、schema 2、原始 Drive ID、过期 revision 六项请求均被拒绝 |
| 实际大文件读取 | TBB 最大下载资源 22,314,567 字节，长度与 SHA-256 均匹配，实测约 140 秒 |
| 本地浏览器 | 两个基因页核心图保留；单细胞默认 8,569 全部细胞；Cluster 23 可选择后恢复全图；三页往返正常 |
| 响应式抽查 | 手机 AD / 电池 Dataset 占位和中等宽度电池页未出现横向溢出；浏览器尺寸已恢复 |

首批快照：`sha256:8a02cff987fd7854ae9054e51868083e4bf4b9143d0fd6d2818e1f0c82b71e35`。

## 接下来仍必须完成

1. 用户自行将本次 worktree 的已验证提交推送到 develop。远端 develop 尚未更新；现有提交带 `[skip netlify]`，推送后通过测试 Sheet 的 Hook 发起一次带版本绑定的构建。
2. 完成 4 项 Netlify 构建及匹配的签名 ready 回执。API 与 Hook 配置成功不等于网站已构建成功。
3. 实际共享 Dataset Placeholder → Ready → 恢复的演练，页面 / 文件替换与失败恢复检查。
4. 导入剩余项目，完成 13 项真实云端构建和受保护预览验证。
5. 新 develop 别名、固定部署链接和下载路径的未授权访问测试；对比原 Production 基线。
6. 上述全部通过后，才开启测试自动化和完成原后台增量迁移预演报告。

当前报告不能作为 Production 发布或原 Sheet 迁移的验收通过证明。
