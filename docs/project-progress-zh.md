# AIS Dashboard 项目状态汇报

- 更新时间：2026-08-14（Asia/Singapore）
- 汇报对象：项目负责人
- 汇报范围：当前上线状态、已完成工作、费用影响、剩余事项和下一步

> 这是一份给项目负责人的管理汇报。技术实现、测试证据和排障过程记录在[工程实施记录](engineering-record-zh.md)中。

## 一、30 秒结论

项目目前运行正常，**控制面、Private develop Preview 和公开 Production 已全部切换到 V2**：

- PR #6 已正常合并；当前 `main` 与 Production receipt 均为 `1fa55688043deddd69aeabda6ed2cd56d02e0751`。
- 唯一一次切换用 Production deploy 为 `6a7ebce1232712000852c07c`，状态为 `production / main / ready`；没有额外调用 Production Hook，也没有第二次 Production deploy。
- Production manifest 为 schema 2，精确包含 15 个 demo、15 张 card JPG 和 7 个 domain；Raman 现已在 V2 Sheet 改为 Live/Public，但由于 `auto=off` 且同步不发布，仍未进入这份既有 Production artifact。
- Production 产物共 59 个文件，15/15 demo routes、15/15 card paths 和 7/7 domain routes 已验收；公开产物未发现 Registry token、Drive/Sheet ID、Hook URL 或 Apps Script URL。
- Production receipt 为 revision-bound，Registry revision 为 `sha256:1f243f1394fc13317ac5f59b47202051520ff5747ca5ce36d4754bfdb9f922a6`。
- 新 Registry v2 Sheet、V2-only sync、V2 API、新凭据和 V2-bound Apps Script Web App Version 12 均为正式控制面；当前 `develop@9a9fec8`，完整代码测试为 280/280。
- Version 12 在 V11 增量指纹快速路径上合并正常 skip audit 写入；warm run 命中 16/16、零 source parse，用时 27 秒，较原 71 秒中位数减少 61.97%，达到 `≤35 秒 / ≥50%` 目标。代码推送带 `[skip netlify]`，Apps Script 沿用原 deployment / URL，且没有新增 Netlify deploy。
- 当前 V2 Sheet 为 16/16 `Live + Publication ready`，包括已改为 Live/Public 的 Raman；公开 Production 仍是先前的 15-route 快照，二者的差异是预期的待发布内容，不是同步失败。
- 新 V2 项目保留唯一 owner-owned hourly `syncDrive` trigger，`AI4S_AUTO_PUBLISH_TARGET=off`；develop Preview 继续保持 Private，匿名访问返回 HTTP 401。
- V1 Sheet 已移动到 AIS Instrumentation Gym Drive root 下的 `Archive` 文件夹并按日期标记归档；旧 V1 trigger 已为 0、旧 Hook 已删除、旧正式 Apps Script Web App deployment 已停用。
- Netlify 环境已收敛：`REGISTRY_URL` 只保留 Production 与 `branch:develop`，Preview callback secret 只保留 `branch:develop`。
- 切换前 Published deploy `6a7ac80744313c0007499f29` 仍为 ready，保留为现成的原子站点回滚点。

因此，“是否已经全部接入 V2”的答案是：**是，完整切换已经完成。** 下一步不是继续迁移；当前需要由负责人决定何时显式发布已为 Live/Public 的 Raman，并继续 replacement canary 与周期性运行观察。

## 二、管理状态总览

| 管理项目 | 状态 | 负责人需要知道的结论 |
| --- | --- | --- |
| 公开网站 | V2 已上线，待下一次内容发布纳入 Raman | `6a7ebce1232712000852c07c` / `main@1fa55688` ready；schema 2，现有 artifact 为 15 个 demo |
| 团队预览 | 已验收 | 最新 `6a7eb82127b60f0008c234ea` ready；16 条 demo 路由；fresh callback E2E 通过；匿名访问返回 401 |
| P1-A Sheet 并发保护 | 已部署 | 同步只更新受管理字段，扫描期间的人工编辑不会被旧快照整行覆盖 |
| P1-B Drive 边界 | 已部署 | 每条直接 parent 关系都会复核；异常时停止同步；shortcut 明确跳过 |
| Registry v2 control plane | 已正式接管 | 新 V2-bound Apps Script 正式 Web App Version 12；V2 Sheet/API/sync/credentials 为唯一日常控制面 |
| V2 发布状态写回 | 已验收 | 当前 16/16 项目均为 `Live + Publication ready`；Raman 已改为 Live/Public，但尚未触发 Production 发布 |
| V2 Drive 同步 | 增量优化已达到目标 | `Projects=16`、`_Registry=16`、`_Facets=50`、`_Assets=16`；Version 12 warm 27 秒，16/16 reused、0 parsed；耗时减少 61.97% |
| Drive 卡片图片 | 已验收 | 16 个项目文件夹均有受控卡片图；Private Preview artifact 包含 16 张，当前 Production artifact 包含 15 张 |
| 自动 Preview | 关闭 | 新 V2 property `AI4S_AUTO_PUBLISH_TARGET=off`；不存在自动 Production 路径 |
| Apps Script trigger | 已单一化 | 旧 V1 trigger=0；新 V2 owner-owned hourly `syncDrive` trigger=1 |
| 测试 | 通过 | 280/280 |
| V1 | 已归档、已停用 | Sheet 位于 `Archive`；trigger=0；旧 Hook 与正式 Web App deployment 已清理 |
| Production 发布控制 | V2 cutover 已完成 | PR #6、required test、恰好 1 次 Production deploy 均已验收 |
| 回滚 | 可用 | 切换前 deploy `6a7ac80744313c0007499f29` 仍 ready，可原子回滚 |
| 当前待办 | V2 稳态运维 | 决定 Raman Production 内容发布时间、replacement canary、小时同步观察和周期性权限/secret 审计 |

## 三、当前版本与部署状态

### 公开 Production

| 项目 | 当前值 |
| --- | --- |
| Production 可见性 | Public |
| Published deploy | `6a7ebce1232712000852c07c`；ready |
| Published commit | `main@1fa55688043deddd69aeabda6ed2cd56d02e0751` |
| Registry revision | `sha256:1f243f1394fc13317ac5f59b47202051520ff5747ca5ce36d4754bfdb9f922a6` |
| Registry schema | v2 |
| Production 内容 | 既有 artifact 为 15 个 demo、15 张 card JPG、7 个学科入口；Raman 虽已在 Sheet 设为 Live/Public，仍待下一次获批内容发布 |
| 路由验收 | demo 15/15、card 15/15、domain 7/7 |
| 产物与安全 | 59 files；无 Functions/Edge Functions；公开产物无受控 ID、endpoint 或 secret |
| 切换次数 | main merge 产生恰好 1 次 Production deploy；未额外调用 Production Hook |
| 原子回滚点 | 旧 deploy `6a7ac80744313c0007499f29` 仍 ready |

结论：公开主站已经由 V2 schema-2 产物接管；Raman 当前已具备 Live/Public 发布资格，但 `auto=off`，所以仍只在 Private Preview 的既有 16-route artifact 中可见。旧 Published deploy 作为无需重建的回滚点保留。

### 私有 develop Preview

| 项目 | 当前值 |
| --- | --- |
| develop commit | `9a9fec8126de2673b729d4c1dc1788220fc2b2a1`；已用 `[skip netlify]` 推送 |
| 最新 Branch Deploy | `6a7eb82127b60f0008c234ea`；ready；deploy time 182 秒 |
| Registry schema | v2 |
| Registry mode | `production`；同一 V2 Registry 继续提供受控 Preview audience |
| 数据与路由 | Projects 16 / Registry 16 / Facets 50 / Assets 16；16 条 demo 路由，包含 `raman-spectroscopy` |
| 当前 Sheet 内容状态 | 16/16 `Live + Publication ready`；Raman 已改为 Live/Public |
| 构建产物 | 61 个文件；16 张从 Drive 本地化的 card JPG；receipt 629 bytes；manifest 42,300 bytes |
| 发布证据 | Fresh V2 callback E2E 已 verified/revision-bound；request、revision 与 deploy 精确绑定 |
| 团队登录访问 | 200，可正常查看 |
| 匿名访问 | 401，不可查看 |
| 卡片图片 | 成功，16/16 个 Drive card asset 已进入本地公开产物路径 |
| 缓存性能基线 | 首次优化验收 deploy time 187 秒；fresh credential E2E 为 182 秒；优化前为 796 秒 |

结论：Private Preview 仍是 Draft/内容发布前的验证环境；Production 已由同一 V2 Registry 的 Live-only audience 接管。

### Apps Script 与自动化

| 项目 | 当前值 |
| --- | --- |
| Apps Script project | 新项目，container-bound 到 Registry v2 Sheet |
| 正式 Web App | Version 12；code 与 manifest 精确对应 `develop@9a9fec8`；`Code.gs` SHA-256 为 `5c2c56c2b04dfdea5386c20932be90e08a1220e0e41e6d3e81d793c3fb3b246a`；沿用 V2 deployment / URL，deployment topology 仍为 2 |
| Script Properties / credentials | 在新 V2 项目重新配置；不继承旧 V1；实际值从未记录 |
| 旧 V1 syncDrive trigger | 0 个 |
| 新 V2 syncDrive trigger | 1 个 owner-owned hourly trigger |
| 自动发布目标 | `AI4S_AUTO_PUBLISH_TARGET=off` |
| V1 状态 | 已归档；trigger=0；旧 Hook 已删除；Version 12 正式 Web App deployment 已停用 |

当前正式控制面是新 V2-bound Apps Script Web App Version 12，不再是原 V1 项目的 Version 12。新项目拥有独立 Properties、credentials、trigger、deployment 和 URL，并同时服务 V2 Production 与 Private Preview。自动目标保持 `off`，因此小时同步不会自动创建 Preview，也不存在自动 Production 路径。

## 四、本阶段已经完成的工作

### 1. P1-A：Sheet 并发写保护已经上线

旧同步流程会先读取整张表，再在扫描结束时按整行写回。如果人在扫描期间修改 title、status、slug 或 metadata，旧快照存在覆盖新编辑的风险。

现在已经改为：

- 只写同步程序明确负责的列。
- 写入前比较当前值与公式。
- 保留扫描期间发生的人工字段修改。
- 如果现有行在扫描期间发生移动，系统会在首次写入前停止，避免写错项目。
- 对“扫描期间人工编辑”的情况已有自动测试。

带来的结果：Google Sheet 可以继续作为人工内容后台，自动同步不会随意覆盖人工维护字段。

### 2. P1-B：Drive parent 与 shortcut 边界已经上线

现在 root folder、root loose file 和 subfolder file 都会在使用前核验直接 parent：

- 文件或文件夹被移动到边界外时，不再按旧扫描结果继续处理。
- parent 或 MIME 查询异常时，整次同步停止，不带着不确定数据继续更新。
- shortcut 会根据真实类型跳过，不会因为文件名以 `.html` 结尾而被误认成项目。
- 文件移动、文件夹移动、查询异常和 shortcut 均有测试覆盖。

带来的结果：同步只处理明确位于指定 Drive 边界内的真实文件。

### 3. 历史里程碑：Registry v2 server 首次接通 Private Preview

在旧 bound Apps Script Version 12 的历史 commissioning 阶段，系统已经能够：

- 从英文版 Registry v2 Sheet 生成正式 manifest。
- 按项目提供受控的 HTML 内容。
- 通过 `action=asset` 提供卡片图片。
- 只接受当前可见项目、正确项目文件夹内、非 shortcut 的 Drive 图片。
- 对图片 revision、类型、扩展名、大小和实际图片内容进行核验。
- 第一轮不接受外部图片 URL。

构建端会把通过核验的图片写入 Preview 的 `assets/cards/`，公开产物中不包含 Registry token、Drive ID 或 Apps Script URL。

### 4. 第一张真实 Drive 卡片图片验证成功

本轮选择 Pleiades 项目完成真实 canary：

- 图片由维护者放入该项目的 Drive 文件夹。
- Sheet 只记录简单的相对文件名和英文 Alt Text。
- Apps Script 确认图片属于正确项目和正确文件夹。
- develop 构建下载图片并写入自己的卡片资源目录。
- 卡片在 Private Preview 中正常显示。

这符合第一轮的简单使用方式：维护者只需要准备项目卡片图、放入对应 Drive 文件夹，再在 Sheet 写文件名；不需要填写 Drive ID 或复杂 URL。

### 5. 历史里程碑：首轮 15-project Registry v2 Preview 验收通过

- 15 个项目均进入 manifest。
- 15 条项目路由均可访问。
- Pleiades 卡片图片和英文 Alt Text 正常。
- 团队登录后可以查看 Preview。
- 未登录访问返回 401。
- 页面产物未发现 token、Drive URL 或 Apps Script URL。
- Production deploy、首页内容与首页 SHA-256 均保持不变。

### 6. Registry v2 发布状态写回已经上线

现在可以从菜单手动运行 `Refresh Registry v2 status`，由同一套 V2 编译规则刷新维护者需要看的状态：

- 只写 `Projects.Readiness`、`Projects.Preview URL` 和 `_Registry.readiness` 三列。
- 以隐藏的 `demo_id` 作为唯一身份，不按标题或行号猜测项目。
- 写入前重新核对完整输入、值和公式；人工编辑或行移动会让整次刷新停止。
- `Preview URL` 继续显示为可点击的 `Open Preview` 链接。
- 不运行 `setup()`、不同步 Drive，也不会调用任何 Preview 或 Production Hook。

该历史阶段的首次真实刷新在 31 秒内完成：15/15 项目显示 `Publication ready`，15/15 Preview 链接与项目 slug 匹配，隐藏机器状态为 15/15 `ready`。项目 Status、`demo_id`、trigger 和发布配置均未变化。

### 7. 历史里程碑：第一次失败已用最小改动修复

第一次 Registry v2 canary 构建遇到 Google ContentService 并发读取的偶发 404，因此该 Branch Deploy 安全失败，没有影响 Production。

修复只做了一件事：Registry v2 的远程项目内容改为串行读取；Registry v1 和 Production 原有流程没有改变。第二次 Branch Deploy 随后成功。

这不是系统性故障，也没有增加一套复杂的新机制。当时代价是 v2 构建约需 9 分 30 秒；该历史性能缺口现已由 Phase 14 的 revision-bound cache 关闭。

### 8. 历史里程碑：V2 Drive 自动收录、首次入库 canary 与幂等复跑

`ffea262` 完成第一轮自动收录功能，`eeb4d88` 完成当时现场所需的 Sheets 服务修复；该历史阶段 `develop` 与 `origin/develop` 均为 `eeb4d88`：

- 维护者在指定 Drive root 下创建一个直接子文件夹，文件夹名必须是英文。
- 文件夹内放置一个可唯一判断的直接子级 HTML；根目录 loose HTML 不会自动进入 V2。
- 同步成功后只创建安全默认值：`Draft`、`Preview only`、`Featured=false`，并同时维护 `Projects`、`_Registry` 与 `_Facets`。
- 新 Draft 如果缺少 taxonomy、摘要等人工信息，会显示为 blocked；blocked Draft 不改变 build revision，也不会触发 Preview deploy。
- Card Image 和 Data Source 都是可选项；系统不会自动挑选图片。
- 相同 Drive `file_id` 重复同步是幂等的；文件暂时缺失时保留项目行，恢复后继续使用原身份。
- 如果文件被删除后以新 Drive ID 重建，系统不会猜测它是旧项目的替代品，必须由维护者明确处理。
- 写入前会再次核对 Sheet；如果期间发生人工编辑、公式变化或行移动，本次 V2 写入和 Preview 尝试都会停止。

该历史阶段代码通过 229/229 测试和独立审查，并原址部署为旧 bound Apps Script Version 12；当时 Deployment ID 与 URL 未变，部署代码和 manifest 与 `develop@eeb4d88` 精确匹配。此基线后来由 `c4ff498`、244/244 和新 V2-bound Web App Version 1 替代；Phase 14 又更新为 `045253c6`、257/257 和 Version 8，Phase 16 更新为 `c824588`、276/276 和 Version 11，当前基线见 Phase 17 的 `9a9fec8`、280/280 和 Version 12。

空同步 commissioning 分为两次：Version 11 在 11:47 因 Sheets REST HTTP 403 停止，且在写入前失败，因此 V2 与 Netlify 均为零变化；启用 Advanced Sheets v4 后，Version 12 在 12:02 成功完成空同步。日志记录 legacy `0 new / 0 updated / 0 missing`，以及 V2 `0 added / 15 checked / 0 skipped`。复核结果为 `Projects=15`、`_Registry=15`、`_Facets=45`、`_Assets=1`。

首次真实入库 canary 随后通过：第一次同步记录 V2 `1 added / 15 checked / 0 skipped`，将 Raman 项目以 `Draft + Preview only + Featured=false` 收录；第二次同步记录 `0 added / 16 checked / 0 skipped`，没有重复行，证明同一 Drive 对象重跑幂等。此时新项目因 Card Summary 和 taxonomy 未填写而 blocked，build revision 未改变，也没有请求或产生 Netlify deploy。

首次写入后还完成了受控身份修正：把误拼的 `ramam` 迁移为 `raman`。Drive folder 与当时的 V1 slug 均为 `raman-spectroscopy`，V2 demo ID 为 `demo-raman-spectroscopy`，`_Registry` slug 为 `raman-spectroscopy`，四处身份一致。该历史 canary 期间 `auto_publish_target` 临时设为 `off`，当时验收后曾恢复为 `preview`；新 V2 控制面的当前 property 为 `off`。

随后以本地 Raman HTML 与 PROVENANCE 信息为内容依据，补齐了以下英文 Sheet 字段：

- Card Summary：`Explore how PCA, t-SNE, UMAP and HDBSCAN reveal spectral regions and continuous change across 13 Raman maps—without treating clusters as confirmed chemical identities.`
- Department：`Chemistry`；Subtopic：`Molecular Systems`；Task Type：`Clustering`。
- Methods：`PCA, t-SNE, UMAP, HDBSCAN`；Audience：`Intermediate`。
- Data Source：`AIS Instrumentation Gym Raman/SERS Sample 1 pilot maps`。
- Card Image 与 Image Alt Text：留空；图片为可选字段，不影响本轮 Preview readiness。

14:01 的历史同步得到 `0 added / 16 checked / 0 skipped`。Raman 由 blocked 转为 `Draft + Preview ready`，Preview URL 已写回；`_Registry` 与 `_Facets` 的 taxonomy 投影一致，16 个 Projects 与 16 个 Registry 身份完整对应，没有重复或 orphan。该次同步没有产生 Netlify deploy，公开 Production 与回滚点均未变化；当时 auto target 曾恢复为 `preview`，现已由新 V2 property 的 `off` 基线替代。

### 9. 历史：V2 控制面 cutover 与首轮 Private Preview 验收

- `develop` / `origin/develop` 对齐于 `c4ff498471e959ee9d3640ed69920dd59b1a6e20`；完整测试 244/244。
- 新 V2-bound Apps Script 的正式 Web App Version 1 精确部署 `c4ff498`；使用独立的新 Properties、credentials、trigger、deployment 和 URL，credential 实际值从未记录。
- 旧 V1 trigger=0，新 V2 hourly `syncDrive` trigger=1；新 V2 `AI4S_AUTO_PUBLISH_TARGET=off`。
- 该历史阶段的 V2-only 最终同步为 Projects 16 / Registry 16 / Facets 50 / Assets 1；当时 15 个 Live 为 `Publication ready`，Raman 为 `Draft + Preview ready`。
- Private develop deploy `6a7d9386b3f7740008e93c93` 在 17:51 SGT 创建、17:56 ready；产物 46 个文件、16 条 demo 路由（含 `raman-spectroscopy`）和 1 个 Drive-localized card asset。
- Sheet 为 accepted / publish-ready；receipt `verified=true`、`revision_bound=true`，request、revision 与 deploy identity 匹配；匿名 develop 仍为 401。
- Production 与首页指纹不变。V1 未归档，必须等待 exact diff、负责人明确批准和恰好 1 次 Production deploy。

以上是 2026-08-13 的控制面 cutover 基线。该基线先由下一节的 Version 8、
16 张卡片图与缓存优化 Preview 接替，之后由第 12 节的 Version 11 接替，当前进一步由第 13 节的 Version 12 接替；
本节的 Version 1、单图产物和 deploy ID 继续作为历史证据保留。

### 10. 16 项卡片图片与 V2 构建缓存优化已验收

- 16 个 demo 均已有对应项目文件夹和受控的 Drive card JPG；V2 当前为
  `Projects=16 / _Registry=16 / _Facets=50 / _Assets=16`。
- `045253c6` 引入 revision-bound build snapshot cache，完整测试为 257/257；
  新 V2-bound Apps Script 正式 Web App 已更新到 Version 8，URL 不变。
- manifest 请求仍实时编译 Sheet 与 Drive 全局状态；只有带精确
  `registry_revision` 的 page/asset 请求可复用同一 audience 的缓存来源元数据。
- 每个目标 HTML 或图片在读取前后仍重新核验 Drive metadata；缓存缺失、过期、
  损坏、超限或服务异常时回退到权威编译，不能放宽 revision、permission、parent
  或 MIME 边界。
- 优化前 deploy `6a7e980f37447b0008ba74e1` 用时 796 秒（13 分 16 秒）；
  优化后 deploy `6a7ea4535173db00081ba4c1` ready，deploy time 为 187 秒
  （3 分 07 秒），wall time 为 193.098 秒。减少 609 秒，即快 76.51%，约 4.26 倍。
- 最新产物为 61 个文件、精确 16 条 demo 路由、16 张 card JPG、629-byte
  receipt 和 42,300-byte manifest；没有 Functions、Edge Functions 或构建错误，
  匿名 develop 访问仍为 HTTP 401。
- 在该历史 Preview 优化阶段，Production 尚未重建或切换；随后由下一节的正式 cutover 关闭这一 gate。

### 11. Production V2 cutover 与 V1 归档已完成

- exact cutover diff 已审核，PR #6 required `test` 通过后正常合并到 `main@1fa55688`。
- Netlify 只产生一次 Production deploy `6a7ebce1232712000852c07c`；context/branch/state 为 `production/main/ready`，deploy time 182 秒。
- receipt 的 commit、deploy ID 与 Registry revision 精确匹配；Production manifest 为 schema 2。
- Production 精确包含 15 个 Live demo、15 张 card JPG 和 7 个 domain；`raman-spectroscopy` 继续为 Draft，仅在 Private Preview 可见。
- 59-file artifact、全部 demo/card/domain 路径与公开产物 secret 扫描均通过；没有 Functions 或 Edge Functions。
- V1 Sheet 已归档到 Drive `Archive`；旧 V1 trigger、旧 Build Hooks、冗余 Netlify env contexts 与旧 Version 12 正式 Web App deployment 均已清理。
- 切换当时保留 V2 Web App Version 8、唯一 V2 hourly trigger、Production/develop Registry 配置和 develop-only callback secret；Web App 当前版本见下一节。
- 切换前 deploy `6a7ac80744313c0007499f29` 未删除且仍 ready，作为明确的原子回滚点。

### 12. V11 Drive 无变化同步优化第一阶段（历史）

- `develop@c824588`（`Speed up Registry v2 Drive sync [skip netlify]`）已推送；完整测试为 276/276，`Code.gs` SHA-256 为 `c40fba7ba77543e1189320e8045e43f3031a39572ae2232faf378401f7465f7b`。
- 新 V2-bound Apps Script 正式 Web App 已在原 deployment / URL 上更新为 Version 11，没有创建新 endpoint；本次代码推送及部署均没有产生 Netlify deploy。
- 同步先比较 Drive 文件夹、HTML、PROVENANCE、图片等来源的身份与 metadata 指纹。来源没有变化且现有 `_Registry.file_check` 健康、输入与输出指纹均一致时，直接复用已验证结果，不再下载全部 HTML 内容。
- Script Properties 只保存版本化的输入/输出哈希，不保存 HTML、图片、解析文本或凭据。缓存缺失、损坏、输出不健康、文件恢复、Drive ID 替换或任何相关 metadata 变化都会回到完整读取；Property 服务异常只会让下一次同步走冷路径，不会放宽校验。
- 最终 Drive 与 Sheet 防并发复核仍保留。确认目标状态与当前表完全相等后，才跳过批量写入、flush、重新打开工作簿和写后读取；真正有变化的同步仍执行原有写入后验证。
- `AI4S_AUTO_PUBLISH_TARGET=off` 时可复用刚完成验证的 V2 snapshot 来维护 Preview 状态，但不会 POST Hook；显式 Preview / Production 发布仍进行实时编译。
- 优化前最近三次无变化同步分别为 104 秒、71 秒、56 秒，中位数为 71 秒。
- Version 11 第 1 次为 cold run：17:21:23→17:22:43，共 80 秒；摘要为 `0 added / 16 checked / 0 skipped / 0 missing`、`0 unchanged reused / 16 source pairs parsed`、`Sheet already current`。
- Version 11 第 2 次为 warm run：17:22:55→17:23:36，共 41 秒；摘要为 `0 added / 16 checked / 0 skipped / 0 missing`、`16 unchanged reused / 0 source pairs parsed`、`Sheet already current`。
- warm run 相对优化前 71 秒中位数快 30 秒，耗时减少 42.3%，约为 1.73×；快速路径命中 16/16 且没有解析任何 source pair。该结果证明快速路径有效，但没有达到原定 `≤35 秒 / ≥50%` 的性能目标。
- V11 还观察到一次 138 秒的自然小时同步波动；这说明 source parse 已消除后，多个正常 skip audit append 和平台固定开销仍可能主导总时长，并直接促成下一阶段的 audit 聚合。
- 两次运行均未要求 Sheet 写入；V2 仍为 `Projects=16 / _Registry=16 / _Facets=50 / _Assets=16`。从代码推送、Version 11 部署到现场基准，Netlify deploy 增量为 0。

### 13. V12 skip audit 聚合达到同步性能目标

- `develop@9a9fec8126de2673b729d4c1dc1788220fc2b2a1`（`Batch Drive sync audit notices [skip netlify]`）已推送；完整测试为 280/280，`Code.gs` SHA-256 为 `5c2c56c2b04dfdea5386c20932be90e08a1220e0e41e6d3e81d793c3fb3b246a`。
- 新 V2-bound Apps Script 正式 Web App 已在相同 Deployment ID / URL 上更新为 Version 12；deployment topology 仍为 2，没有创建新 deployment 或 endpoint。
- Archive、projection、ml-lifecycle 三类正常跳过不再各做一次 `_Audit` append，而是汇总为一条 `sync-skip`。聚合按 700 字符预算打包；单个清洗后的超长 reason 会切成最多 600 字符的片段，最终 `logEvent_` 仍有 1000 字符硬上限。不存在固定条目数截断，每个 folder / reason 都保留；`try/finally` 还保证先前收集的 notices 会被写出。
- V12 warm run 于 17:41:10→17:41:37 完成，共 27 秒；日志只出现一条聚合后的 `sync-skip`，同时覆盖 Archive、projection 和 ml-lifecycle；同步摘要为 `16 unchanged reused / 0 source pairs parsed / Sheet already current`。
- 相对优化前 71 秒中位数节省 44 秒，耗时减少 61.97%，约为 2.63×，达到原定 `≤35 秒 / ≥50%` 目标。
- 最终读回为 `Projects=16 / _Registry=16 / _Facets=50 / _Assets=16`，且 16/16 项目均为 `Live + Publication ready`。Raman 已在 Sheet 变为 Live/Public，但 `auto=off` 且本次只是同步，因此没有自动发布。
- 从 V12 `[skip netlify]` push、原址部署到 warm benchmark，Netlify deploy 增量为 0。

当前 Production 不受本轮优化影响，仍为 `6a7ebce1232712000852c07c` /
`main@1fa55688043deddd69aeabda6ed2cd56d02e0751` / schema 2，保留 15 个
已发布 demo，尚不包含 Raman。

## 五、费用影响

本次获批 cutover 产生且只产生 1 次成功的 Production deploy；按当前规则计 15 deployment credits。清理 Hook、环境 context、V1 Web App deployment 和 Drive 归档不会触发构建。

| 费用项目 | 本轮结果 |
| --- | --- |
| Production deploy | 1 次：`6a7ebce1232712000852c07c`；15 deployment credits |
| 当前 V2 控制面 Private Preview | 最新 develop Branch Deploy：`6a7eb82127b60f0008c234ea` ready；Branch Deploy 本身为 0 deployment credits |
| 历史 Private Preview commissioning | 曾有一次安全失败和一次成功，已在上文明确标记为历史 |
| Production 页面或流量 | 已切换到 V2 静态产物；带宽与 Web requests 继续按实际使用计费 |
| Auto recharge | 仍为 Disabled |

Netlify 当前 credit-based 规则下，Branch Deploy 和 Deploy Preview 本身均为 0 deployment credits；成功的 Production deploy 才按 15 credits 计费。访问 Preview 产生的带宽和 Web requests 仍按实际用量计费；若站点使用 Functions 等运行时能力，还会产生相应 compute。本次为静态产物且没有 Functions / Edge Functions，因此除极少量访问流量外，没有单独的 Preview 部署费用。当前没有发现需要处理的异常账单。

## 六、还没有完成的工作

Production V2 cutover、V1 归档和旧控制路径清理均已完成，当前没有迁移 blocker。剩余事项只有：

1. 负责人决定何时把已为 Live/Public 的 Raman 发布到 Production；确认后只执行一次显式 Production 内容发布，不能依赖 `syncDrive`。
2. 做一次卡片图片 replacement revision canary，验证旧 revision 失效和新图进入 Private Preview。
3. 观察唯一 V2 hourly `syncDrive` trigger，确认数据不变量和零意外 deploy。
4. 周期性审计 Drive/Sheet 权限、Netlify Hooks、环境 contexts 与 secret 生命周期。

## 七、下一步执行顺序

| 顺序 | 工作 | 目的 | 是否影响 Production |
| --- | --- | --- | --- |
| 1 | 决定并审批 Raman Production 内容发布 | 把 Sheet 中已 Live/Public 的 Raman 纳入公开 artifact | 是；获批后只发布一次 |
| 2 | 观察 V2 hourly sync | 确认 trigger 健康和零意外 deploy | 否 |
| 3 | 做一次 card-v2.jpg replacement canary | 验证图片替换与 revision 失效 | 否 |
| 4 | 后续新内容继续走 Draft → Private Preview → approval → Production | 保持发布可审计且每次只构建一次 | 仅获批发布时 |

## 八、当前风险与处理方式

| 风险或观察项 | 当前影响 | 处理方式 |
| --- | --- | --- |
| V1 归档不等于 owner-level 只读 | V1 已归档并停用控制路径，但由另一账号拥有 | 不再作为日常入口；如需权限级只读，由 V1 owner 调整 |
| 回滚点是旧原子站点产物 | `6a7ac807...` 可直接回滚，但旧 V1 endpoint/Hook 已停用 | 故障时回滚现有 deploy，不通过 V1 重建 |
| 新 Drive ID 不自动迁移 | 删除后重传同名文件不会被猜成旧项目 | 保留旧行并由维护者明确决定迁移或创建新项目 |
| 图片替换尚未真实验证 | 16 张图片首次读取成功，但原址替换流程还缺一次现场证据 | 在 Private Preview 做 replacement canary |
| Sheet 与公开 artifact 暂时有 1 项差异 | Sheet 已有 16 个 Live 项目，Production 仍是 15 项且不含 Raman | 这是 `auto=off` 的预期保护；负责人批准后显式发布一次 Production |
| 同步运行仍有平台波动 | V11 曾出现 138 秒自然小时运行；V12 warm 实测为 27 秒 | 继续观察小时 trigger；用 reused/parsed/audit 摘要区分缓存失效与平台固定开销 |
| HTML 内容仍由受信任编辑者维护 | 有编辑权限的人可以影响项目页面内容 | 继续限制 Drive / Sheet 编辑权限 |

这些事项都不要求停用系统，也不阻塞当前 V2 Production。

## 九、负责人需要记住的发布规则

### 内容更新

1. 新内容先保持 Draft。
2. 在团队私有 develop Preview 检查。
3. 检查通过后再改为 Live / Public。
4. 只有负责人明确批准后，才进行 Production 内容发布。

### 网站代码更新

1. 在 `develop` 开发和测试。
2. 通过当前完整测试并检查 Private Preview。
3. 由负责人明确批准是否合并 `main`。
4. 合并 `main` 只触发一次 Production deploy，不额外手动重建。

## 十、文档入口

- 本文件：负责人状态汇报，只保留结论、费用、风险和需要决策的事项。
- [工程实施记录](engineering-record-zh.md)：技术基线、实施历史、测试证据和详细待办。
- [Phase 3 自动 Preview 验收手册](phase3-preview-automation-runbook.md)：自动 Preview 的操作与回滚步骤。
- [项目 README](../README.md)：项目功能、开发和部署说明。
- [Apps Script 使用说明](../google-apps-script/README.md)：Sheet 与 Apps Script 操作说明。

## 一句话汇报

**V2 已完成全系统切换；当前 `develop@9a9fec8` / Apps Script Version 12 / 280/280，warm no-change 同步为 27 秒（较原中位数减少 61.97%）；Sheet 已有 16 个 Live 项目，Production 仍为 `main@1fa55688` / `6a7ebce1` / schema 2 的 15 项快照，Raman 待显式发布。**
