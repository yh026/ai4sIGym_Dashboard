**Drive 三页后台：独立测试、develop 验证与原后台迁移计划**

日期：2026-09-23。状态：方案阶段。本轮仅核对仓库与官方文档、编写计划，未新建或修改线上 Sheet、Drive 文件、Apps Script、Netlify 配置或部署。

**1. 目标与完成边界**

先建立一个独立测试后台，让一个项目的 Insight、Dataset、Workflow 都能由 Google Drive 和 Google Sheets 管理，并在受访问保护的 develop 中验证。验证通过后，再把已验证的结构增量迁移到原后台。正式发布是最后一个独立步骤。

本轮后端开发的完成条件是：测试后台能完整驱动 develop；更新网页、Dataset 占位、共享 Dataset、旧版单页、下载资源和失败恢复都经过验证；原后台及 Production 没有被本轮测试改动。

当前本地基线有 13 个项目：9 个 Yuhan demo、2 个自定义基因 demo、2 个旧版单页。11 个项目已有三页导航，其中 8 个 Dataset 为占位页；TBB 另外保留 Notebook / Skill 页面和下载资源。这个数量只代表本地，迁移时不能用它覆盖正式后台可能存在的其他项目。

已核对的现有实现：

- 正式构建从 Apps Script Registry API 读取内容，Netlify 执行 `node build.js`，输出 `dist/`。
- Registry v2 当前为一个项目提供一个主 HTML `file_id`，不能直接表达三页及其版本关系。
- 当前 `build.js` 和 Preview callback 仅将 `branch-deploy + develop` 识别为开发预览；`main + production` 使用正式内容规则。
- 本地三页实现通过 `--local` 加载，不会自动回写 Drive，也不参与普通 Netlify 构建。
- 仓库里的线上版本、部署记录是历史证据；实际实施前必须重新读取真实配置，不能把本地 `Code.gs` 当作已部署版本。

**2. 测试环境隔离**

“新开一个 Sheet”采用新的 Google Spreadsheet 文件，拥有独立 Spreadsheet ID。仅在原文件里新增 tab 不足以隔离脚本、触发器和发布配置。

| 部分 | 测试环境 | 现有环境在测试期间的状态 |
| --- | --- | --- |
| Google Sheets | 新建 `AIS Dashboard — Backend Sandbox`，复制表格结构和必要元数据 | 保留原 Spreadsheet ID、人工字段及发布状态 |
| Drive | 新建独立测试根目录，放在原扫描根目录之外 | 原网页、文件 ID、目录及权限保持原样 |
| HTML 与资源 | 复制到测试目录，取得新的 Drive file ID | 更新测试页不会覆盖旧站使用的源文件 |
| Apps Script | 独立绑定测试 Sheet 的项目、Web App 和配置 | 原部署、原 token、原 trigger 不参与测试写入 |
| 初始化 | 新增 Sandbox 初始化入口，校验测试 Sheet / Drive 根目录 | 不直接运行正式 `setup()` |
| 发布配置 | 初始自动发布为 off；只配置指定 develop Preview 目标 | 不给测试脚本配置 Production Hook |
| 凭据 | 测试 Registry token、回调 secret 独立保存 | 保留 Production 的现有凭据和环境变量 |
| Git | 保存当前未提交成果后，从核验的基线建立后端功能分支 | 不将当前工作区的其他改动批量推送到 main |

现有 `setup()` 包含正式环境校验和 hourly trigger 安装，不能直接照搬到测试 Sheet。Sandbox 初始化需要显式拒绝正式 Sheet ID、正式 Drive 根目录和 Production 发布目标；测试发布函数即使被误调用，也必须拒绝 Production。

新 Sheet 保留原生 Projects / Options table、下拉验证、字段归属等结构。创建或复制表格后，单独核验绑定脚本、Properties 和触发器，不假定它们会正确继承。Google 官方说明绑定脚本属于其容器，新容器需要核验自身的脚本关系。[Google：绑定脚本](https://developers.google.com/apps-script/guides/bound)

**3. Netlify develop 的连接方式**

实施前先查原后台是否自动触发当前 develop，以及是否有尚未完成的 Preview 请求。

如果当前 develop 没有其他后台自动驱动，可以把该分支的 Registry URL 和 callback secret 指向测试后台。只修改明确的 develop 分支值；不修改全局默认值、Production 值或其他分支配置。Netlify 支持按 deploy context 和具体分支设置环境变量。[Netlify：环境变量作用范围](https://docs.netlify.com/build/environment-variables/overview/)

如果原后台仍在自动驱动当前 develop，不能直接让两套 Registry 共用同一条发布链。测试阶段使用独立 Netlify 测试项目中的 develop Branch Deploy，保留原预览链；测试项目的所有访问受保护，且不配置 Production 发布流程。等迁移窗口再切回原站的 develop。具体采用哪条连接方式由第一阶段的实际配置核验决定，不能为了测试而静默关掉原后台自动化。

develop 的内容规则设为新版本 Draft / Preview only。原项目已经公开的旧版本仍由原后台继续提供，不把原表中的 Live 行改成 Draft。

“develop 不是 Production”和“其他人看不到 develop”要分别验证。分支名或 `noindex` 不构成访问保护；需要确认 Netlify 当前项目的 Private / 登录 / 密码保护范围，并验证未授权访问不能取得 HTML 或资源。Netlify 可为 Production 和预览分别配置访问规则。[Netlify：部署访问保护](https://docs.netlify.com/deploy/protect-deploys/)

**4. 数据结构：一个项目、多种页面、独立版本**

只增加三个文件链接还不够：同一个项目可能需要“旧版继续公开、新版继续测试”。建议引入内容版本，使 develop 更新不会替换 Production 正在使用的文件。

| 表或索引 | 职责 | 主要信息 |
| --- | --- | --- |
| `Projects` | 一个项目一行，保持现有日常管理方式 | 稳定 `demo_id`、slug、标题、分类、项目状态、权限；增加只读的开发版／发布版引用 |
| `Versions` | 管理同一项目的不同内容版本 | `version_id`、`demo_id`、单页／三页模式、Draft / Reviewed / Published 状态、快照摘要 |
| `Pages` | 维护一个版本包含哪些网页 | `version_id`、页面角色、源文件或 Dataset 引用、Ready / Placeholder 状态、检查结果、预览地址 |
| `_Registry` / `_Pages` | 提供经过校验的机器索引 | 页面对应的 Drive ID、文件 hash、大小、修改时间、路由、内容版本 |
| `_Assets` / `_Resources` | 管理封面和附属下载 | 资源归属、文件类型、相对路径、Drive ID、hash；包含 TBB Notebook / Skill |
| `_Audit` | 留下可核对的操作和部署记录 | 同步结果、版本变化、请求 ID、Registry revision、Netlify ready 回执 |

具体字段名在第一版接口合同中固定。机器字段受保护，使用者主要操作 Projects、Versions 和 Pages，不需要手写内部 Drive ID。

版本选择规则：

- develop 读取所选开发版本；Production 只读取已发布版本。
- 版本权限不能绕过项目的 Archived / Private / Public 控制。
- 测试导入的新版本全部为 Draft / Preview only，即使它对应一个已经在线的项目。
- 审核过的快照包含页面、卡片元数据、Dataset 版本及下载资源引用；内容改变后要形成新快照，不能沿用旧审核结果。
- 已发布版本使用受保护的文件快照；开发中的编辑写入 Draft 文件。不能让开发版和发布版指向同一个可变 HTML。
- 更新同一 Draft 文件时保留项目身份；删除再上传时通过明确的版本／角色映射识别替换，禁止自动生成重复项目。

这一层迁移到原后台后，同一个 demo 可以同时保留 Published 旧版和 Draft 新版，无需降低原 Live 项目的状态。

**5. 三页与 Dataset 规则**

三页项目的入口继续是 `/demos/<slug>/index.html`，Workflow 是同目录 `workflow.html`。Dataset 按当前已经存在的路由映射输出：已有 `/datasets/.../` 地址保留，新增占位页继续使用当前的 `/demos/<slug>/dataset.html`。不因为后台升级而更换用户已有链接。

- Insight 和 Workflow 是三页项目的必需内容；缺失、空文件、不可读取或重复角色都不能被当作正常版本发布。
- Dataset 可以明确标记 Placeholder，显示现有简洁占位页。这是有效的 Preview 状态，不冒充数据已经接入。
- Dataset 标记 Ready 后必须有真实可读取的源文件。文件读取失败不能悄悄退回 Placeholder。
- 接入 Dataset 时更新其文件引用／版本和状态，构建后仍使用原地址。
- SOH 和 Curve Shape 可引用同一份 CALCE Dataset，分别输出带正确项目导航的页面。
- 共享 Dataset 的更新先进入开发版本；正在公开的项目继续绑定原 Dataset 快照，直到批准新版本。
- Air Quality 与 Road Speed 继续使用 legacy 单页模式，不要求本轮补造 Insight 或 Workflow。
- TBB 的 Notebook、Skill、ZIP 和附属页面必须随版本一起管理，保留有效下载路径。

建议的测试 Drive 组织方式：

```text
AIS_Dashboard_Backend_Sandbox/
  projects/
    <project-slug>/
      <draft-version>/
        insight.html
        workflow.html
        card.jpg
        resources/
  datasets/
    <dataset-id>/
      <dataset-version>/
        dataset.html
```

旧版单页登记为 legacy 角色。Placeholder 没有实际 Dataset 文件也能登记；文件角色由 Pages 的显式配置确认，不再猜测目录内哪个 HTML 是主页面。测试数据目录与原后台的扫描目录相互独立。

**6. 开发与验证顺序**

**阶段 A：只读核验和基线备份**

读取实际原 Sheet 的完整结构、原生 Tables、人工字段、项目 ID / slug 和源文件清单；记录正式 Apps Script 的已部署版本、触发器 owner / 目标、Properties 键及自动发布模式。记录 Netlify main / develop 的 commit、实际 Published Deploy ID、Registry revision、分支变量和访问保护范围。

保存可恢复的 Sheet 数据、Drive 内容 hash、已部署脚本源码和配置映射。凭据保存在受保护位置，文档和日志不记录 token、Hook URL 或 callback secret。9 月的历史部署记录只用于对照，不直接当作本次基线。

检查当前未提交修改并保存工作区备份，规划后端分支的明确变更集合，保留已完成的页面设计和数据。此阶段的交付物是可复查基线及环境隔离清单。

**阶段 B：创建独立测试后台**

创建新 Spreadsheet、测试 Drive 根目录、独立绑定脚本及 Sandbox 初始化入口。复制必要源文件与资源，不移动原件。先导入小范围试点：TBB、SOH、Curve Shape，以及一个 legacy 项目，覆盖真实 Dataset、共享 Dataset、占位页、下载资源和旧版兼容。

所有导入版本为 Draft / Preview only。自动同步和自动发布初始关闭，先手动同步。核验 Sandbox 写操作只命中新 Sheet 和测试目录，发布功能只能命中选定的 develop 目标。

**阶段 C：实现新的 Registry 合同和同步逻辑**

为新结构制定明确版本的接口，建议 schema 3。新增版本／页面索引及编译器，不在旧 schema 2 响应里静默改变含义。新版构建支持 schema 2 和 schema 3；迁移原后台时，兼容 API 继续为旧构建提供原 schema 2 数据。

同步程序验证项目身份、版本归属、页面角色、文件类型、Drive 父目录范围、共享 Dataset 引用和下载资源路径。排序、重命名显示标题、同文件更新、删除恢复和安全重新上传都必须保持正确身份。

Registry revision 需要覆盖角色映射、三个页面的 hash、Placeholder 状态、资源及相关元数据。只改 Workflow、只补 Dataset 或只更新下载资源，都应产生正确的新开发快照。没有变化时不重复写表或触发构建。

构建开始、读取文件及结束校验应绑定同一 revision。中途内容改变时拒绝混合版本。API 根据环境、audience、项目权限和所选内容版本验证文件访问，不能仅凭猜到 Drive file ID 就读取未发布内容。

**阶段 D：让 Netlify 使用同一套页面装配逻辑**

将当前本地的导航、Dataset 占位模板和必要的资源处理整理成可复用模块，使本地构建与正式构建读取不同来源、使用同一份三页输出逻辑。build 从 Registry 的页面角色读取 HTML，不把 `demos_v4` 本地路径作为线上必需条件。

保留首页、学科分类、筛选、封面、稳定 slug 和一个项目一张卡片的约定。公开输出不携带内部 Drive ID、Sheet ID、私密源路径或凭据；受保护的构建接口可使用必要内部标识。

只有通过选定环境和 branch-deploy / develop 校验的测试构建才能读测试 Registry。若检测到 Production 构建误指向 Sandbox，则直接失败，不回退成“照常发布”。

先验证手动同步 → 手动 Preview 构建 → 正确页面与回执，再开启测试环境自己的自动 Preview。复用现有 accepted / ready 区分、签名回调与请求幂等机制，并绑定新 Registry 实例、Site ID、develop 分支和独立 secret。Hook 返回 2xx 不算验收成功。

**阶段 E：试点通过后接入完整开发集合**

导入其余 Yuhan 页面、两个自定义基因项目和剩余 legacy 项目，形成当前本地 13 个项目对应的测试集合：11 套三页导航、其中 8 个 Dataset 占位，另有 2 个 legacy 单页及 TBB 附属资源。

对新增文件检查科学 payload / 脚本完整性，重点确认基因页面当前的默认全图、精简结果和交互没有被通用模板覆盖。源内容本轮不重新训练或改写分析结论。

运行下面的验收矩阵并保存记录、部署回执、截图及必要的文件 hash。完成后提供一份可供维护者操作的 Google Sheets 后台说明。

**7. 验收矩阵**

| 测试 | 合格条件 |
| --- | --- |
| 环境隔离 | Sandbox 操作没有写入正式 Sheet / 原 Drive 文件，也没有产生本轮 Production 发布事件 |
| 原站回归 | 原公开网址、项目身份和内容与实施前基线一致；外部并发修改单独识别，不归因于测试 |
| 页面映射 | 一项目一张卡片；Insight / Dataset / Workflow 往返正确；已有链接保持有效 |
| Dataset 占位 | 明确 Pending，导航正常；不会被误报为已接入 |
| Dataset 接入 | Placeholder → Ready 后原地址展示源页；同一 CALCE 源页在两个电池项目中返回正确 |
| 版本隔离 | 更新 Draft HTML / Dataset / 资源只影响 develop，Published 旧版本及其快照不变 |
| 身份和字段 | 排序、改标题和同文件更新不新增 demo；人工字段和稳定 ID 不被同步覆盖 |
| 缺失与冲突 | 必需页缺失、Ready Dataset 丢失、重复角色、跨目录文件、非法路径被明确阻止，不能以占位掩盖 |
| 旧版兼容 | 原 schema 2 夹具和 legacy 项目仍正常；不把旧单页误拆成多个项目 |
| 幂等与并发 | 无变化同步不重复写表／发布；并发编辑、revision 变化和失效缓存不会产生混合快照 |
| 发布回执 | 一次逻辑请求对应一次 Preview，收到匹配 revision / request / site / branch 的 ready 回执 |
| 失败恢复 | 构建失败保留上一次可用预览；重试受控，没有无穷或重复 Hook 调用 |
| 内容完整性 | 科学 payload 保留，图表与关键交互正常，TBB 下载资源可读取且 hash 匹配 |
| 布局 | 桌面、手机及中间宽度导航正确，无横向撑破；Dataset 占位简洁清楚 |
| 访问控制 | 未授权访问 develop 别名、部署固定链接及直接 HTML / manifest / 下载路径不能取得受保护内容 |
| API 访问控制 | 错误 token / audience、旧回调重放、跨 Registry 回调和未发布文件直读被拒绝 |
| 回退演练 | 能恢复 Preview 的旧配置及上次成功产物，且不需要改动 Production |

自动测试包含已有回归测试与新合同、同步、构建和回调用例；实际 Google / Netlify 验证负责补齐本地夹具无法证明的权限、触发器、原生 Table 和访问保护行为。

开发版 ready 用 Netlify 状态和签名回执确认；未授权请求只用于访问保护的负向测试，不用它绕过登录读取私密内容。

**8. 全部通过后，如何改原后台**

先生成迁移预演报告，列出新增表／列、项目和版本对应关系、保留字段、文件复制、新增路由及回退点。重新读取正式后台最新状态，检查它与预演起点一致。不能把测试 Sheet 整表覆盖回去，也不能把本地 13 项当作正式表的完整清单。

建议采用以下增量顺序：

1. 在迁移窗口备份原后台最新数据和脚本部署；保留原 Spreadsheet ID。
2. 部署已在测试环境验证的兼容脚本，使它能读取旧结构和可选新索引，继续提供原 schema 2 响应。
3. 增加版本／页面表和必要字段，原 Projects 人工信息保持不变。
4. 将正式站当前使用的内容登记为现有 Published 版本；现有 Live / Public 状态不被测试 Draft 覆盖。
5. 将已验证的新三页版本作为 Draft 导入；新增 Curve Shape 等真正新项目仍为 Draft / Preview only。
6. 将 develop 指向原后台的新版本接口，再验证一次完整链路。测试后台保留用于对照和回退。
7. 对比旧 schema 2 的 Production 投影，确认旧构建仍能取得原内容；在迁移过程中不自动升级 Production 页面。

迁移后台结构与发布新网站是两件事。以后发布新版时，再确认具体内容版本和代码版本，并协调一次明确的 Production 发布。合并 main 会触发 Netlify 连续部署，因此不能把 main 合并当作“只是保存代码”，也不能为同一发布再重复触发 Hook。

**9. 回退方案**

| 出问题的阶段 | 回退动作 |
| --- | --- |
| 独立后台测试 | 停止测试环境自动化，保留审查记录；原后台无需恢复，因为没有被改动 |
| 原站 develop 切换 | 恢复该分支之前的 Registry URL、callback secret 及上次可用预览；Production 环境值保持不变 |
| 原 Sheet 结构迁移 | 用迁移前快照撤销本轮表／列和版本指针变更，恢复对应脚本部署；不删除或重建原 Sheet |
| 未来 Production 发布 | 先恢复先前成功的 Netlify 产物，再恢复匹配的 Published 版本和配置，避免下一次重建再次带入问题 |

回退前核对并发编辑，不能用陈旧快照覆盖他人的新改动。所有旧源文件和版本在验收窗口内保留；清理是单独的后续操作。

**10. 交付物与执行顺序**

依次交付：基线记录 → 独立测试 Sheet / Drive / Apps Script → V3 页面与版本合同 → 本地回归通过的同步和构建代码 → 受保护的 develop 试点 → 完整 13 项验收报告 → 原后台迁移预演与回退说明。

当前建议先执行阶段 A–E，达到测试后台完整可用。阶段 8 的原后台迁移以完整验收报告为前提；Production 发布另行安排。这样每次推进都有可检查的结果，而不是一次性切换所有层。

本计划依据仓库的 `build.js`、`lib/registry-v2.js`、`lib/registry-v2-sheet-adapter.js`、`google-apps-script/Code.gs`、`netlify/plugins/preview-ready/`、`docs/registry-v2-contract.md` 和本地三页集成现状。历史 runbook 的原环境升级步骤不直接用于初始化这个独立 Sandbox。
