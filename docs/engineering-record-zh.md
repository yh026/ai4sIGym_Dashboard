# AIS Dashboard 工程实施记录

- 更新时间：2026-08-14（Asia/Singapore）
- 读者：维护者、开发者和后续接手本项目的工程人员

> 本文记录工程事实、外部配置状态、验证证据、已知缺口和验收标准。面向项目负责人的简明汇报请看[项目状态汇报](project-progress-zh.md)。本文禁止记录 token、Build Hook 完整地址、HMAC secret、OAuth 凭证或浏览器登录信息。

## 1. 文档系统

项目文档分为四层：

| 文档 | 用途 | 更新时机 |
| --- | --- | --- |
| `docs/project-progress-zh.md` | 负责人汇报：结论、费用、风险、决策、下一步 | 每个里程碑、Production 发布或管理决策后 |
| `docs/engineering-record-zh.md` | 工程记录：实现、证据、基线、缺口、验收标准 | 每次代码或外部控制面发生实质变化后 |
| `docs/phase3-preview-automation-runbook.md` | Preview 自动化 commissioning、canary、回滚 | 自动 Preview 协议或操作步骤改变后 |
| `README.md` 与 `google-apps-script/README.md` | 项目和操作者使用说明 | 对外行为或操作方式改变后 |

维护规则：

1. 负责人汇报只描述当前状态，不堆积排障过程。
2. 工程记录保留可复核证据，但不保存任何 secret。
3. Production 发布前后都必须更新 Git SHA、Deploy ID 和回滚点。
4. 所有外部配置只能记录状态和脱敏指纹，不能记录实际值。
5. 历史结论变化时，应明确标注“已关闭”或“已被新基线替代”。

## 2. 当前技术基线

### Git 与发布

| 项目 | 当前值 |
| --- | --- |
| Repository | `yh026/ai4sIGym_Dashboard` |
| Repository visibility | Public |
| 当前工作分支 | `develop` |
| `main` | `1fa55688043deddd69aeabda6ed2cd56d02e0751`；PR #6 V2 Production cutover merge |
| `develop` | `9a9fec8126de2673b729d4c1dc1788220fc2b2a1`（V2 sync audit batching；已用 `[skip netlify]` 推送） |
| PR #3 | Merged，`develop → main` |
| PR #3 merge time | 2026-08-11 14:58:13（Asia/Singapore） |
| PR #4 | Merged，CI-only，merge commit 带 `[skip netlify]` |
| PR #4 merge time | 2026-08-11 16:10（Asia/Singapore） |
| PR #5 | Merged，P1 Drive sync safety，merge commit 带 `[skip netlify]` |
| PR #6 | Merged；required `test` 通过；正常 merge 产生唯一 V2 Production deploy |
| 当前 Production Deploy | `6a7ebce1232712000852c07c`；`production/main/ready` |
| Production rollback Deploy | `6a7ac80744313c0007499f29`；切换前 Published deploy，仍 ready |
| Production URL | `https://aisigym.netlify.app` |

PR #6 已把获批的 V2 runtime 正常合并到 `main@1fa55688`。Netlify 只产生一次
Production deploy `6a7ebce1232712000852c07c`，deploy time 182 秒；未调用 Production
Hook，也没有第二次 Production deploy。旧 Published deploy `6a7ac807...` 未删除，
继续作为无需重建的原子回滚点。本轮 `develop@9a9fec8` 推送带 `[skip netlify]`，没有
创建新 deploy；最近一次 `develop@045253c6` Private Branch Deploy 仍用于 Draft 与
内容发布前验收。

### Production 内容基线

| 验证项目 | 结果 |
| --- | --- |
| 首页 | HTTP 200；V2 Production artifact |
| Manifest | HTTP 200；schema 2；15 Live demos、15 card assets、7 domains |
| Demo routes | 15/15 HTTP 200；`raman-spectroscopy` 排除 |
| Card paths | 15/15 HTTP 200，JPEG |
| Domain routes | 7/7 HTTP 200 |
| Production receipt | HTTP 200；`production/main@1fa55688`；deploy `6a7ebce1`；revision-bound |
| Registry revision | `sha256:1f243f1394fc13317ac5f59b47202051520ff5747ca5ce36d4754bfdb9f922a6` |
| Artifact | 59 files；无 Functions/Edge Functions；公开输出无受控 ID、endpoint 或 secret |
| Production indexing | 首页无 `X-Robots-Tag`，保持可索引 |
| Receipt headers | `no-store`、`noindex, nofollow`、`nosniff` |

Production 已从旧 14-route 基线切换为获批的 V2 15-route Live-only artifact；新增
`microclimate-explorer`。该 artifact 构建时 Raman 仍为 Draft，因此没有 Raman；当前
Sheet 中 Raman 已为 Live/Public，正等待另一次明确批准的内容发布。

### Runtime 与测试

| 项目 | 状态 |
| --- | --- |
| Node.js | 24 |
| 完整测试 | 当前 develop 本地 280/280 pass；main 的 required `CI / test` 继续生效 |
| `git diff --check` | clean |
| 工作树 | 本地文档更新中；未 commit/push |
| GitHub Actions | `CI / test`；PR #6 required `test` 通过后合并；main push 已成功完成唯一 Production cutover |

## 3. 当前系统数据流

```text
Registry v2 Sheet ── 新 V2-bound Apps Script Web App Version 12
        │              code + manifest = `develop@9a9fec8`
        │              owner-owned hourly `syncDrive` trigger=1
        ▼
V2-only sync ── Projects + _Registry + _Facets + _Assets + _Audit
        ├── develop Branch Deploy（Private）── onSuccess HMAC callback
        │   `6a7eb82127b60f0008c234ea` ready
        └── Production（Public）
            `6a7ebce1232712000852c07c` / `main@1fa55688` ready

旧 V1 Sheet ── Drive Archive（trigger=0、formal Web App 已停用）
```

Registry v2 已完成新控制面、真实 Private Preview 与公开 Production 验收。
V2-only 最终数据为 Projects 16 / Registry 16 / Facets 50 / Assets 16；当前 16/16 项目
均为 `Live + Publication ready`，Raman 已改为 Live/Public。Phase 13 已记录 accepted /
publish-ready，receipt 为 `verified=true`、`revision_bound=true`，且 request、Registry
revision 与 deploy identity 匹配；Phase 14 缓存构建另以 ready、artifact 清单和匿名 401
完成验收。Phase 16 的 V11 Drive sync fast path 保留 80 秒 cold、41 秒 warm 和 138 秒
自然小时波动记录；Phase 17 的 Version 12 audit batching warm run 为 27 秒并命中 16/16。
新 V2 `AI4S_AUTO_PUBLISH_TARGET=off`，小时同步当前不会自动部署 Preview 或 Production。

维护者操作入口、Drive sync、Sheet projection、Registry API、develop Preview、callback
与公开 Production 均已使用 V2。当前 Sheet 比已发布 Production 多一个 Live Raman：这是
`auto=off` 下的预期待发布差异，不是同步失败。V1 只保留归档 Sheet、Apps Script HEAD 与
immutable version history；旧 trigger、Hook 和正式 Web App deployment 已停用，不再是运行时回退路径。

内容发布与代码发布是两条不同路径：

- 内容发布：Sheet 状态批准为 Live 后，人工确认一次 Production Build Hook。
- 代码发布：批准并合并 PR 到 `main`；Netlify continuous deployment 立即产生 Production deploy。不能再点击 Production Hook。

## 4. 必须保持的工程不变量

1. `production_branch` 必须是 `main`。
2. `preview_branch` 和 `preview_url_branch` 必须是 `develop`。
3. `auto_publish_target` 只允许 `off` 或 `preview`；不存在自动 Production 目标。
4. legacy `auto_publish` 保持 `no`，即使误设 `yes` 也应 fail closed。
5. Production 构建只允许 canonical `Live`；Preview 额外允许 canonical `Draft`。
6. Archived、missing、page unreadable、page empty 和未知状态不得进入任何公开产物。
7. 只有 `CONTEXT=branch-deploy && BRANCH=develop` 可以获得 Preview audience。
8. Production 只能是 `CONTEXT=production && BRANCH=main`；production/develop 必须失败。
9. Preview 回调插件只在 `context.branch-deploy` 加载，运行时再次限制 `develop`。
10. Production 不加载 Preview callback plugin，也不能收到 HMAC callback。
11. Registry URL、Hook 和 secret 不得进入 Git、Sheet 日志、公开 manifest 或 deploy receipt。
12. Production 发布必须先记录当前 Deploy ID、main SHA、内容基线和回滚点。
13. Registry v2 当前必须保持 `registry_mode=production`；任何再次切换数据源或回滚都必须经过负责人明确批准与独立验收。
14. snapshot、page 与 asset 必须绑定同一 revision；任何 stale 或不一致响应都必须 fail closed。
15. Apps Script 远端 blob 读取保持串行；只有带精确 revision 和 audience 的 page/asset 请求可以复用已验证的来源元数据。manifest 必须实时编译，目标 blob 必须保留读取前后 Drive 校验；不得以性能为由引入无界并发。
16. V2 自动收录只接受 Drive root 下的英文直接子文件夹及其可唯一判断的直接子级 HTML；root loose HTML 不自动进入 V2。
17. 自动收录的新项目必须从 `Draft + Preview only + Featured=false` 开始；blocked Draft 不得改变 build revision 或触发 Preview。
18. Card Image 与 Data Source 均可留空；同步不得自动挑选图片，也不得因为同名而猜测新 Drive ID 是旧项目替代品。
19. Drive sync 的增量缓存只能保存版本化输入/输出哈希，不得保存 HTML、图片、解析内容或 credentials；缓存缺失、损坏或服务异常必须安全降级为完整读取。
20. 只有来源 metadata 指纹、现有健康 `file_check` 和机器输出指纹同时匹配时才能跳过 HTML/PROVENANCE blob 读取；恢复、替换、缺失、身份或 inventory 变化必须重新读取。
21. 无变化快速路径仍必须完成最终 Drive contract 与 Sheet 并发复核；只有最终目标状态与当前 workbook 完全相等时才能跳过写入、flush、reopen 和 post-read。
22. 正常 skip audit 可以聚合以减少 Sheet append 往返，但必须保留每个 folder 与 reason：reason 先经过既有 Audit 清洗，再按最多 700 字符的 message 预算打包；单个清洗后仍超过 700 字符的 reason 按最多 600 字符分片，`logEvent_` 保留最终 1000 字符硬上限。不存在按条目数截断；`try/finally` 必须 flush 已收集的 notices。

## 5. 已完成的工程阶段

### Phase 0：仓库与发布基线

完成事项：

- 核验本地仓库、GitHub refs、Netlify Production 和 Sheet 配置。
- 删除旧 `fix/*` 和 `agent/*` 分支。
- 收敛为 `main`、`develop` 两条本地和远程分支。
- 保持旧 Production 不动，并建立 Deploy ID、首页 hash 和路由基线。
- 清理重复 Apps Script trigger，只保留指定 owner 的一个每小时 `syncDrive`。

关键结果：分支和触发器不再重复，后续改造有稳定的比较基线。

### Phase 1：稳定 develop Preview

完成事项：

- Apps Script Preview allowlist 加入精确分支 `develop`。
- 测试和文档统一使用 `develop`。
- Netlify Production branch 保持 `main`，allowed branches 收敛为 `main`、`develop`。
- Sheet `preview_branch`、`preview_url_branch` 和 Branch Deploy URL 统一为 develop。
- 删除旧 Preview Hook 和旧分支活动配置。
- Production 和 Preview Hook 保持独立。

关键结果：所有工具链只认一个稳定 Preview 分支，不再依赖旧 fix 分支。

### Phase 2：Production / Preview 内容安全

完成事项：

- Registry API 引入闭集 `audience=production|preview`。
- 缺省 audience 为 Production，旧 `status=all` 不能绕过内容范围。
- Manifest 和 file endpoint 共用同一 visibility 规则。
- Production 只返回 Live；Preview 返回 Live + Draft；Archived 永久排除。
- missing、unreadable、empty 页面 fail closed。
- build 端再次按 Netlify context 和 status 过滤。
- Production 如果不是 main 直接失败。
- 所有非 Production 输出站点级 `noindex,nofollow`。
- 公开产物去除 Drive IDs、Registry token 和内部字段。

关键结果：即使 Registry URL 或 Sheet 参数误配，Draft/Archived 也不能进入 Production。

### Phase 3：可靠自动 Preview

完成事项：

- Registry 生成 audience-scoped deterministic SHA-256 revision。
- Manifest、file 请求和最终 manifest 复核绑定同一 revision。
- Hook 请求加入严格 envelope：schema、target、branch、revision、request ID、requested time。
- Preview 状态机区分 desired、requested、accepted、ready。
- Hook 2xx 仅表示 accepted，不表示 ready。
- 无变化同步不部署；新增、更新、移出、恢复、Sheet metadata 变化均由 revision 捕获。
- Drive timestamp 改为毫秒级比较，修复 60 秒窗口漏更新。
- 失败请求只在真实网络/非 2xx 时有限重试。
- Accepted 请求不因小时同步或回调延迟重复 POST。
- 15 分钟无完成回调进入 verification-timeout，要求人工重试。
- 构建输出 secret-free `deploy-receipt.json`。

关键结果：自动化从“fire-and-forget”升级为可验证、幂等和 fail-closed 的状态机。

### Phase 4：Private Preview 与认证回调

完成事项：

- Netlify Project Visibility：Production Public、Previews Private。
- 匿名 develop 和 PR Preview 均为 HTTP 401。
- 新增本地 Netlify Build Plugin `netlify/plugins/preview-ready/`。
- `onSuccess` 读取 deploy receipt，并使用 HMAC-SHA256 回调 Apps Script。
- Apps Script `doPost` 在 JSON parse 前验证原始 payload HMAC。
- 回调精确校验 site、request、requested_at、revision、target、audience、context、branch、deploy/build identity。
- ScriptLock 串行更新状态；相同 deploy ID 重放幂等。
- Unverified develop Git deploy 会认证回调并撤销 stale ready。
- 回调传输最多 3 次短重试，每次 10 秒硬超时。
- Production、Deploy Preview 和非 develop 分支零回调。

关键结果：Preview 私有化后仍能无人值守确认部署完成，不需要给 Apps Script Netlify PAT。

### Phase 5：PR #3 审核与 Production 发布

发布前发现并修复：

- 文档错误地把代码 merge 和手动 Production Hook 描述成两个连续步骤。
- Apps Script Help 错误引导用户先设 Live、再看 Preview。
- Runbook 当前 tree 中包含真实归档 Drive IDs。
- `REGISTRY_URL` 未标 Secret 且为 All scopes。
- 非 develop Preview 的 noindex 规则不完整。

修复提交：

- `cca6a47` Resolve PR release safety findings
- `58d24a7` Clarify production release automation
- `df04feb` Guard archived Drive identifiers

发布结果：

- PR #3 从 Draft 转 Ready 并使用普通 merge commit 合入 main。
- T0 后恰好新增 1 个 Production deploy：`6a7ac80744313c0007499f29`。
- 没有调用 Production Hook、Trigger deploy、Retry 或 Clear cache。
- Production 全量路由 21/21 通过。
- Preview 仍为 Private。
- rollback deploy `6a7554bf39cf8b00085699ef` 保持 ready。
- 发布期间 `auto_publish_target` 临时设为 off，验收后恢复 preview。

### Phase 6：Apps Script 说明与单人 CI

完成事项：

- 将完整当前 `Code.gs` 保存到现有 Apps Script 项目。
- 编辑现有活动 deployment，发布 Version 7；Deployment ID、`/exec` URL、执行身份和访问范围不变。该历史版本后来先由 Phase 10 的 Version 9、再由 Phase 11 的 Version 10 替代。
- 未运行 `setup()`、`syncDrive()` 或任何 Preview/Production 发布函数。
- 5 个 Script Properties 键完整保留；仍只有一个 owner-owned hourly `syncDrive` trigger，错误率 0%。
- 原子更新 `Demos!G1` note 与 `Config!C13` 说明；`status` 表头值、`auto_publish_target=preview` 和所有配置值不变。
- 新增 `.github/workflows/ci.yml`：Node 24、`node --test --test-concurrency=1`、`contents: read`、不持久化 checkout credentials、无 secret 引用、无 `pull_request_target`。
- PR #4 的 pull_request check `CI / test` 成功，随后 main push check 再次成功。
- PR 和 merge commit 均含 `[skip netlify]`；相对部署哨兵零新增 Branch Deploy、Deploy Preview 或 Production deploy。
- 原 Web App `/exec` 无 token 只读探测仍返回 HTTP 200 JSON `bad token`，证明 endpoint 可用且鉴权边界未放宽。
- main 合并约 2.5 分钟后再次复核 Netlify，仍然零新增 deploy；Published Production 保持 `6a7ac807` / `a968a07`。

P0 收口结果：

- owner `yh026` 已创建 `Protect Main` Ruleset（ID `20683682`），状态 Active，精确作用于 `refs/heads/main`。
- 规则要求 PR、required approvals=0、GitHub Actions `test` 成功，并禁止 non-fast-forward/force push 与删除。
- 不要求 CODEOWNERS、最后推送者审批或 review thread resolution；允许 merge、squash、rebase。
- GitHub 的 effective rules API 返回同样四项生效规则。公开只读 API按官方安全策略不返回 bypass actors；owner 已按单人维护约定完成现场确认。

### Phase 7：P1 同步安全与 Registry v2 foundation

本阶段的交付边界是“本地代码 + owner-only 影子表”，不是线上切换。

已完成事项：

- 旧 `Demos` 同步不再对现有记录整行 `setValues`；只更新明确的 import、Drive 自动列和 derived 列。
- 写入前重新读取值与公式；扫描期间被人工修改的 title、status、slug 和 metadata 保留，行移动或 `file_id` 改变时在任何现有行写入前 fail closed。
- root folder、root loose file 和 subfolder file 的每条 iterator edge 都重新核验直接 parent；parent/MIME 查询异常停止同步；Drive shortcut 明确跳过。
- 建立 Registry v2 纯 Node compiler 与 Sheet adapter；不依赖 Google API，可用 fixture 精确测试。
- `Projects` 定为 15 个可见英文字段，另有隐藏、受保护的 `demo_id`；排序后依然按 ID 关联，绝不按标题或旧 row number 关联。
- 隐藏表定为 `_Registry`、`_Taxonomy`、`_Facets`、`_Assets`、`_Audit`、`_Config`、`_Schema`。
- `public_permission` 明确由人工拥有；PROVENANCE/Drive 自动化不得把项目授予 Public。
- build v2 只接受闭集 taxonomy、status、permission、audience 和精确字段 allowlist；重复 ID/slug/asset/path、空库和不健康 Live 全部 fail closed。
- build v2 通过私有 `action=asset` 契约取得卡片图片，校验 revision、MIME、扩展名、最大 5 MiB、canonical Base64 和真实图片 magic bytes，再安全写入 `dist/assets/cards`。
- 建立 owner-only 私有影子 Sheet：初始迁入 20 个项目记录、15 个可见字段、隐藏 `demo_id` 与 7 个机器表；无 trigger、Hook、token 或 Netlify 连接。当前清理后的 15-project 状态见 Phase 9。

本阶段当时明确未完成：P1 `Code.gs` 尚未发布，v2 snapshot/asset server、
develop Preview 接线和真实 Drive 图片 canary 均不存在。这些缺口后来在 Phase 10
的私有 Preview commissioning 中关闭；Production 切换仍未发生。

提交与 Preview 验收：

- `b6ca817` — Harden Drive sync reconciliation。
- Registry v2 foundation 已推送到 `origin/develop`；后续 English-only 强化见 Phase 8。
- 团队登录可查看 15 个 Preview 项目；匿名访问仍为 HTTP 401。
- Production 仍为 `main@a968a07` / `6a7ac807...`；首页 HTTP 200、94,528 bytes，SHA-256 仍为 `a64a9bd...`。

### Phase 8：English-only Registry Sheet

本阶段继续限定在 owner-only 影子 Sheet 与 develop 代码，不切换 live Apps
Script、main 或 Production。

已完成事项：

- 影子 Sheet 的 11 个标签页完成全量 CJK 扫描，结果为 0；标签名、表头、下拉值、状态、备注和公式显示文字均为英文。
- `Projects` 的人类可见字段统一为 `Status`、`Readiness`、`Preview URL`、`Project Title` 等英文名称，末端字段为 `Public Permission`；隐藏机器键仍为 `demo_id`。
- Sheet adapter 与 Registry compiler 增加 English-only 边界；任何 CJK 内容都会 fail closed，不能继续进入 Preview 或 Production 构建。
- 权限只接受 canonical `Public`、`Preview only`、`Private`；旧别名和近似值不能授予 Public。
- `featured` 与 taxonomy `active` 只接受真实 boolean，不把字符串或近似值当成启用。
- contract tests 与代码/fixture/契约 CJK 扫描均 clean；该历史阶段完整测试 168/168 pass，当前测试基线见 Phase 17（280/280）。

提交与 Preview 验收：

- `fdbf538` — Enforce English-only Registry sheets。
- 该历史阶段本地 develop 与 `origin/develop` 均为 `fdbf53862a...`。
- 当时最新私有 Branch Deploy 为 `develop@fdbf538` / `6a7bddaa04eca20008371f91`，completed（59 秒）；当前基线见 Phase 10。
- Published Production 未变化，仍为 `main@a968a07` / `6a7ac80744313c0007499f29`。

本阶段当时明确未完成的 live adapter、asset server、P1 Apps Script 发布和真实
Drive canary，后来均在 Phase 10 完成。该阶段的 main 和 Production 当时仍未切换到
Registry v2；这项 gate 后来由 Phase 15 关闭。

### Phase 9：Registry v2 项目目录清理

本阶段只修改 owner-only V2 sandbox；没有触发 Drive sync、Netlify Preview 或 Production。

已完成事项：

- 从 `Projects`、`_Registry`、`_Facets` 原子清除五个废弃身份：旧 TBB Draft、两个 missing 的 PCA/UMAP Draft，以及两条 Archived synthetic E2E 记录。
- 保留当前有效的 Live TBB `demo-tbb-cluster-explorer-2`，并继承旧 Draft 的 `sort_order=1`；现有公开兼容 slug 不变。
- 将 `demo-microclimate-explorer` 从 `Draft + Preview only` 提升为 `Live + Public`；由于 Card Summary 仍为空，compiler readiness 正确保持 `blocked`，不会被错误发布。
- 删除 `_Config` 中第二条重复 `created_at`，保留与 sandbox migration audit 对齐的正式创建时间。
- `_Audit` 新增七条操作记录；删除后复核 `Projects=15`、`_Registry=15`、`_Facets=45`，且没有 orphan facet。
- `ProjectsCatalogV2` 原生表范围、conditional formatting、dropdown、Preview links、冻结列和隐藏 `demo_id` 均通过视觉与 API 验收。

阶段边界：清理结束时 V2 为 15 个 Live 项目，仍是未接线的私有 design
sandbox；后续接线见 Phase 10。当前 Production 仍是原 14-project 版本。

### Phase 10：Registry v2 Private Preview commissioning

本阶段把 Registry v2 接入现有 Apps Script Web App 与 develop Private Preview；
变更范围始终受 `registry_mode=private_preview` 约束，没有切换 main 或 Production。

代码与部署：

- `f22be29` 完成 Registry v2 snapshot/asset server、build 接线和 commissioning 主实现。
- `9a457e5` 将 Registry v2 远端读取改为串行，修复 Apps Script ContentService 在并发传输时出现的间歇性 404。
- 现有 Apps Script deployment 原址更新到 Version 9；Deployment ID 和 `/exec` URL 不变，没有创建新 URL。
- 未运行 `setup()`；原有 Script Properties 全部保留，并补充必要的 V2 properties。本文不记录 property 值、完整 Script ID、完整 Sheet ID 或 Drive ID。
- 仍只有 1 个 owner-owned hourly `syncDrive` trigger，现场错误率为 0%。

V2 数据与 canary：

- V2 Sheet 保持私有，`registry_mode=private_preview`；当前 15 个项目均为 canonical `Live + Public`。
- Pleiades 的卡片图使用真实 Google Drive asset，验证页面与图片共用 revision 边界，并且公开产物不泄露 Drive ID 或 Registry credential。
- 第一次 canary `6a7c261...` fail closed：Apps Script ContentService 在并发请求下返回 HTTP 404；失败发生在 delivery 层，不是 Sheet schema、权限或内容校验失败，也没有影响 Production。
- 串行修复后，第二次 canary `6a7c2a8...` 成功，耗时 9 分 30 秒；Netlify 摘要为 25 个 new files、23 个 generated pages 和 2 个 changed assets，15 个项目路由全部通过。图片验收只确认 1 张 Pleiades Drive card image。
- Preview 保持 team-only；团队登录可访问，匿名请求返回 HTTP 401。
- 当时完整 Node 24 测试为 201/201 pass；后续 Phase 11 基线为 215/215。

发布安全复核：

- `auto_publish_target` 在 commissioning 后恢复为 `preview`；legacy `auto_publish` 保持 `no`。
- Published Production 未改变：仍为 deploy `6a7ac807...`、`main@a968a07`。
- Production 首页仍为 HTTP 200、94,528 bytes，SHA-256 仍为 `a64a9bd...`；本轮没有 Production build 或 publish。

Phase 10 结束时仍未完成、后续由 Phase 11 关闭的边界：

- `Readiness` 与 `Preview URL` 的 guarded writer 当时尚未接入 live Sheet；Phase 11 已完成该项。
- replacement revision canary 尚未完成，需要验证替换 Drive 对象后旧 revision 不会被接受。
- 仍需等待并核验一次自然小时 `syncDrive` 产生的 verified receipt，证明非手工触发路径闭环。
- 当前串行读取以正确性优先；性能缓存与批量读取优化留作后续，优化时不得削弱 revision、asset 和权限边界。

### Phase 11：Registry v2 状态写回 commissioning

本阶段把 Registry v2 的编译资格安全写回给维护者查看，不改变 manifest、
Registry revision 或发布状态。

代码与部署：

- `4a3ca09` 新增显式菜单动作 `Refresh Registry v2 status`，提交带
  `[skip netlify]`，没有产生 Branch Deploy 或 Production Deploy。
- 现有 Apps Script deployment 原址更新到 Version 10；Deployment ID 与
  `/exec` URL 不变，没有创建新 endpoint。
- 未运行 `setup()`；Script Properties 的 key set 保持不变；仍只有 1 个
  owner-owned hourly `syncDrive` trigger，错误率为 0%。
- 完整 Node 24 测试为 215/215 pass。

写回契约：

- 只允许写 `Projects.Readiness`、`Projects.Preview URL` 和
  `_Registry.readiness` 三列；其它人工字段和机器字段都不写。
- 两张表都按 `demo_id` 对齐，不依赖标题、显示顺序或旧 `row_number`。
- Preview URL 使用 V2 `_Config.preview_base_url`，并保留
  `HYPERLINK(..., "Open Preview")` 公式。
- 写入前比较完整 values 与 formulas，并在第二次编译后立即做最终 preflight；
  人工字段编辑、目标公式编辑、行移动、缺失或重复 ID 都会在首写前整批停止。
- 只写有身份的物理行；中间空行及其中的公式不会被覆盖。
- handler 不调用 `setup()`、`syncDrive()`、Build Hook、doGet/doPost 写 API，
  也不写 `_Audit`、legacy Log 或 Config。
- handler 在运行时验证写回前后 Registry revision 一致；相同输入重复运行幂等。

现场验收：

- 手动运行 `refreshRegistryV2Status` 成功完成。
- V2 共 15 个唯一项目身份；`Projects` 与 `_Registry` 的 demo ID 集合一致。
- `Projects.Readiness` 为 15/15 `Publication ready`；15/15 Preview URL 公式
  与对应 slug 精确匹配；`_Registry.readiness` 为 15/15 `ready`。
- Netlify deploy 增量为 0；Published Production deploy、main commit、首页
  bytes 与 SHA-256 均保持原基线。

语义边界：Readiness 只表示当前行满足 V2 编译与发布资格，不代表某次 deploy
已经 verified。自然小时 sync receipt 与 replacement revision canary 仍需分别验收。

### Phase 12（历史）：V2 Drive auto-ingest 部署、首个入库 canary 与幂等复跑

本阶段完成代码、测试、独立审查、`develop` 推送及现有 Apps Script deployment
原址升级，并完成空同步及首个真实 Draft 入库；没有创建新 URL，没有改变
V2 Live/Public 行数、Netlify Preview 或 Production。

代码与验证：

- `ffea262` 实现 V2 Drive auto-ingest；`eeb4d88` 补齐 Advanced Sheets v4 配置。相关提交均带 `[skip netlify]`，该阶段当时本地与 `origin/develop` 对齐于 `eeb4d88`。
- 完整 Node 24 测试为 229/229 pass；独立 review 结论为 no blocker。
- 该阶段当时的 Apps Script deployment 已原址更新到 Version 12；Deployment ID 与 `/exec` URL 不变，部署 code 与 manifest 均与 `develop@eeb4d88` 精确匹配。
- 提交没有产生 Netlify deploy。最新成功 Preview 仍为 `develop@9a457e5`；匿名访问仍为 HTTP 401。
- Production 仍为 `main@a968a07` / `6a7ac807...`，HTTP 200，公开内容和回滚点不变。
- 空同步 commissioning 基线完整保持 `Projects=15`、`_Registry=15`、`_Facets=45`、`_Assets=1`；真实 canary 后 `Projects=16`、`_Registry=16`，其中原有 15 项仍为 Live/Public。Raman 初次入库为 blocked Draft/Preview only，补齐内容后的当时状态为 `Draft + Preview ready`。

第一轮 intake 契约：

- 只扫描指定 Drive root 下的英文直接子文件夹；文件夹内必须有一个可唯一判断的直接子级 HTML。root loose HTML 保持 legacy-only。
- 新身份使用确定性的 `demo-<folder-slug>` 与 `<folder-slug>`，但不会用名称覆盖或迁移现有不同 `file_id` 的项目。
- 新项目安全默认值固定为 `Draft`、`Preview only`、`Featured=false`；Card Image 与 Data Source 可空，且不自动选择图片。
- 初次写入以一个原子 Sheets batch 同时扩展原生 `ProjectsCatalogV2` table，并更新 `_Registry` 与 `_Facets`。
- 缺少摘要或 taxonomy 的新 Draft 保持 blocked；blocked Draft 不进入 build-facing manifest、不改变 revision，也不请求 Preview。
- 相同 `file_id` 重跑幂等；文件暂时缺失时保留身份并更新机器健康状态，恢复后继续使用原行。
- 删除后重传产生新 Drive ID 时不做 replacement guessing；维护者必须明确决定迁移或创建新项目。
- 写前进行两次状态核对；并发人工编辑、公式变化、行移动或身份冲突会在首写前停止整批 V2 写入和 Preview 尝试。

现场 commissioning：Version 11 的首次空同步于 11:47 因 Sheets REST HTTP 403 在写入前停止，结果为零写入、零 Netlify deploy。根因是 deployment manifest 未启用所需的 Sheets Advanced Service。启用 Advanced Sheets v4 并发布 Version 12 后，12:02 空同步成功；日志为 legacy `0 new / 0 updated / 0 missing`，V2 `0 added / 15 checked / 0 skipped`。复核数据仍为 `15 / 15 / 45 / 1`，Production 基线不变，develop 匿名访问仍为 HTTP 401。

首个真实入库 canary 随后完成。第一次运行记录 legacy `1 new / 0 updated / 0 missing`，V2 `1 added / 15 checked / 0 skipped`；新项目按 `Draft + Preview only + Featured=false` 写入。第二次运行记录 V2 `0 added / 16 checked / 0 skipped`，没有新增重复身份，证明相同 Drive 对象重跑幂等。由于 Card Summary 与 taxonomy 尚未填写，该行保持 blocked，未改变 build revision，也未请求或产生 Netlify deploy。

首次写入使用了误拼的 `ramam`，随后完成受控迁移。最终 Drive folder 和 V1 slug 均为 `raman-spectroscopy`，V2 demo ID 为 `demo-raman-spectroscopy`，`_Registry` slug 为 `raman-spectroscopy`；身份基值与 HTML 所在项目一致。canary 期间 `auto_publish_target` 临时设为 `off`，确认 blocked 零部署后已恢复 `preview`；legacy `auto_publish=no` 未变。

Raman 内容补齐与同步验收：

- 内容依据为本地 `Raman_Token_Cartography_Demo` HTML 与 PROVENANCE 信息；写入 Sheet 的人类字段全部为英文。
- `Card Summary=Explore how PCA, t-SNE, UMAP and HDBSCAN reveal spectral regions and continuous change across 13 Raman maps—without treating clusters as confirmed chemical identities.`
- `Department=Chemistry`、`Subtopic=Molecular Systems`、`Task Type=Clustering`、`Methods=PCA, t-SNE, UMAP, HDBSCAN`、`Audience=Intermediate`。
- `Data Source=AIS Instrumentation Gym Raman/SERS Sample 1 pilot maps`；Card Image 与 Image Alt Text 留空，符合可选字段契约。
- 14:01 同步记录为 `0 added / 16 checked / 0 skipped`。Raman 从 blocked 转为 `Draft + Preview ready`，Preview URL 已生成；`_Registry` 与 `_Facets` 分别投影 `clustering` 及 `pca → t-sne → umap → hdbscan`，顺序与可见字段一致。
- 完整性复核为 Projects 16、Registry 16、Facets 50、Assets 1；Projects/Registry 身份集合相同，无重复 slug/ID、无 orphan facet/asset，Raman 没有 asset 记录。
- 14:01 同步当下没有 Netlify deploy，Production 内容、指纹和回滚点均未变化；`auto_publish_target` 已恢复为 `preview`，legacy `auto_publish=no`。

本阶段当时尚未完成的 Raman Private develop Preview 已由 Phase 13 关闭；Phase 12 的 Version 12、`eeb4d88`、229/229 和 auto target=preview 均为历史基线。

### Phase 13：V2 control-plane cutover 与 Private Preview 验收

- Git：本地 `develop` 与 `origin/develop` 精确对齐 `c4ff498471e959ee9d3640ed69920dd59b1a6e20`；完整 Node 24 测试 244/244。
- Apps Script：在 Registry v2 Sheet 建立独立 bound project；正式 Web App 为 Version 1，code 与 manifest 精确对应 `c4ff498`。新项目的 Properties、credentials、trigger、deployment 和 URL 均独立重新配置，任何 credential 实际值从未进入本文、Git、Sheet 或日志。
- Trigger：旧 V1 `syncDrive` trigger=0；新 V2 owner-owned hourly `syncDrive` trigger=1。新 V2 `AI4S_AUTO_PUBLISH_TARGET=off`。
- 数据：该历史阶段的 V2-only 最终同步为 Projects 16 / Registry 16 / Facets 50 / Assets 1；当时 15 个 Live 项目为 `Publication ready`，Raman 为 `Draft + Preview ready`。
- Deploy：Private develop deploy `6a7d9386b3f7740008e93c93` 对应 `develop@c4ff498`，17:51 SGT 创建、17:56 completed/ready。产物为 46 个文件、16 条 demo 路由（含 `raman-spectroscopy`）和 1 个从 Drive 本地化的 card asset；匿名 develop 请求仍返回 HTTP 401。
- 回执：Sheet 状态为 accepted / publish-ready；deploy receipt 为 `verified=true`、`revision_bound=true`，request ID、Registry revision 与 deploy identity 精确匹配。
- Production：仍为 `6a7ac807...` / `main@a968a07`，首页 SHA-256 仍为 `a64a9bd...`。V1 尚未归档；V2 Production cutover 仍要求 exact diff、负责人明确批准和恰好 1 次 Production deploy。

Phase 13 的 Version 1、单图 artifact 和 deploy ID 是 2026-08-13 的历史验收
基线；当前状态由 Phase 14 接替。

### Phase 14：16 项卡片资产与 revision-bound 构建缓存

数据与图片结构：

- 16 个 demo 均使用对应项目文件夹内的受控 card JPG；V2 当前为
  Projects 16 / Registry 16 / Facets 50 / Assets 16。
- 最新 Preview artifact 精确包含 16 条 demo route 与 16 张 card JPG，共
  61 个文件；manifest 为 42,300 bytes，deploy receipt 为 629 bytes。

代码与部署：

- `045253c6`（`Cache Registry v2 build snapshots [skip netlify]`）实现
  revision-bound snapshot cache；本地与 `origin/develop` 精确一致，完整测试
  257/257。
- 新 V2-bound Apps Script 正式 Web App 更新到 Version 8；沿用现有 V2
  deployment 与 `/exec` URL，没有创建新 endpoint。
- cache 只保存 blob 读取所需的可序列化来源 metadata，不保存 Drive File handle、
  token、HTML 或图片字节；schema=1、TTL=30 分钟、UTF-8 上限=95 KiB，并按
  audience + revision 隔离。
- opening/closing manifest 均从当前 workbook 与 Drive 状态实时编译。带精确
  `registry_revision` 的 page/asset 请求可命中同一 build view；cache miss、过期、
  malformed、oversized 或 CacheService 异常时回退权威编译，并且只在 revision
  仍匹配时响应。
- 每个目标 page/asset 在读取前后仍重新核验 Drive metadata、parent、MIME、名称和
  modified time；同步会使 production/preview cache marker 失效。缓存因此只减少
  重复全表编译，不改变 permission、boundary、revision 或 stale-response 语义。

真实性能验收：

- 优化前 develop deploy `6a7e980f37447b0008ba74e1` 的 deploy time 为
  796 秒（13 分 16 秒）。
- 优化后 deploy `6a7ea4535173db00081ba4c1` 于 13:14:59 SGT 创建，
  13:18:12 更新为 ready；deploy time 187 秒（3 分 07 秒），wall time
  193.098 秒。
- 同规模构建减少 609 秒，快 76.51%，约为原来的 4.26 倍；无 Functions、
  Edge Functions 或构建错误，匿名 develop 请求仍为 HTTP 401。
- Preview 路由与当前 Production 的路由级 diff 为：Preview-only
  `microclimate-explorer`、`raman-spectroscopy`，Production-only 为空。
  Raman 仍是 Draft，因此正式 Production candidate 预期只新增 Live
  `microclimate-explorer`；cutover 前仍需审核完整标题、排序、状态与卡片资产 diff。
- Production deploy、公开内容和回滚点均未改变。V1 继续作为停用 trigger 的
  回退边界保留，直到一次获批的 V2 Production deploy 完成验收。

### Phase 15：V2 Production cutover 与 V1 退役

- Fresh V2 credentials 先在 `branch:develop` 通过一次新的 Private Preview callback
  E2E：deploy `6a7eb82127b60f0008c234ea` ready，receipt 为 verified、
  revision-bound，V2 `_Audit` 的 request/revision/deploy 三者精确绑定；匿名访问仍为 401。
- PR #6 required `test` 通过后正常合并为
  `main@1fa55688043deddd69aeabda6ed2cd56d02e0751`；没有并行调用 Production Hook。
- Netlify 产生恰好 1 个 main/Production deploy：
  `6a7ebce1232712000852c07c`，state=ready，deploy time 182 秒。receipt 绑定
  Registry revision `sha256:1f243f1394fc13317ac5f59b47202051520ff5747ca5ce36d4754bfdb9f922a6`。
- Production manifest 为 schema 2，精确包含 15 个 Live demo、15 张 card JPG 和
  7 个 canonical domain；Raman Draft 的 manifest/route/card 均排除。59-file artifact
  的 29 个文本文件已做完整安全扫描，未发现 token、Hook、Drive/Sheet 或 Apps Script
  endpoint/ID 泄漏。
- V2 `_Config.registry_mode` 已从 commissioning 标签更新为 `production`。Netlify
  只保留两个 V2 Hooks；`REGISTRY_URL` 只保留 `branch:develop` 与 `production`，
  callback secret 只保留 `branch:develop`。
- V1 Sheet 已改名为 `AI4S Instrumentation Gym Registry v1 — Archived 2026-08-14`
  并移入同一 Drive root 下的 `Archive`。旧 trigger=0，旧 V1 formal Web App deployment
  与旧 Hooks 已删除；V1 Apps Script project、HEAD 和 immutable version history 仅保留审计。
- 切换前 deploy `6a7ac80744313c0007499f29` 仍在 Netlify API 中为 ready，作为原子
  rollback 候选保留。清理阶段新增 Netlify deploy 为 0。

### Phase 16：V11 Drive sync 增量快速路径第一阶段

代码、测试与部署：

- `c82458836176f8b2327426a3a4cc174cf519abec`（`Speed up Registry v2 Drive sync [skip netlify]`）已推送到 `develop`；完整 Node 24 测试为 276/276，`git diff --check` clean。
- `google-apps-script/Code.gs` SHA-256 为 `c40fba7ba77543e1189320e8045e43f3031a39572ae2232faf378401f7465f7b`。
- 新 V2-bound Apps Script 正式 Web App 已在原 deployment 上更新到 Version 11；Deployment ID 与 `/exec` URL 均未改变，没有创建新 endpoint。
- Git 提交使用 `[skip netlify]`；部署前后 Netlify deploy ID 集合不变，新增 Branch Deploy、Deploy Preview 与 Production deploy 均为 0。
- Production 未变化，仍为 `6a7ebce1232712000852c07c` / `main@1fa55688043deddd69aeabda6ed2cd56d02e0751` / schema 2。

同步实现：

- `collectDemos_` 先建立 metadata-only source contract，并为 Drive root、项目文件夹、全部直接 HTML inventory、选定页面、PROVENANCE、图片/说明文件，以及各对象的 ID、名称、MIME、modified time、size 与 parent 生成确定性输入指纹。
- Script Properties 以版本化、按 Sheet/root/page 隔离的 key 保存 `{schema,input_fp,output_fp}`；value 受大小限制，只包含哈希，不含 HTML、图片、解析 metadata、Drive handle、token、Hook 或其它 credentials。
- 快速命中要求：项目已存在、输入指纹匹配、当前 `_Registry.file_check` 健康，且 `file_check` 与 `date_added` 的机器输出指纹匹配。任一条件不满足即调用原有 `readDemo_` 权威读取路径。
- HTML、PROVENANCE、图片 inventory、parent 或身份 metadata 变化都会失效；missing/unreadable/empty、文件恢复、Drive ID 替换、旧缓存损坏或缺失均不能复用旧结果。
- 缓存只在最终 no-op linearization 成功，或真实写入完成且 post-write state 精确验证后提交。Property 读取/写入异常只会让后续运行变为冷路径，不会让同步失败，也不会降低 Drive/Sheet 边界。
- 计划生成后仍重查来源 contract，并执行最终 workbook values/formulas 比较。只有目标状态与当前状态完全相等时，才跳过 batch update、flush、Sheet reopen 与 post-write capture；存在任何变化时仍执行原子写入与写后验证。
- `AI4S_AUTO_PUBLISH_TARGET=off` 时，Preview 状态维护可复用刚通过写后/无变化验证的 snapshot，且 Hook POST 为 0；显式 `publishPreview()` 与 `publishProduction()` 仍实时编译，不使用此捷径。

回归与安全覆盖：

- 覆盖 warm metadata 命中且零 blob download、输出哈希/不健康状态失效、HTML / PROVENANCE / 图片 / parent 变化、missing→recovery、同名不同 Drive ID replacement，以及无变化写入跳过。
- 覆盖 auto target `off` 下复用 post-verified Preview snapshot，同时保留状态 reconciliation；原有并发写保护、Drive parent、revision、permission、asset 和显式发布测试继续通过。
- 该缓存是性能提示而非数据来源；所有冷启动、异常和不确定状态均 fail safe 到权威读取。

性能基线与现场验收：

- Version 11 前最近三次无变化 `syncDrive` 分别为 104 秒、71 秒、56 秒；中位数 71 秒。
- Version 11 现场无变化运行 1（cold）：17:21:23→17:22:43，共 80 秒；summary 为 `0 added / 16 checked / 0 skipped / 0 missing`、`0 unchanged reused / 16 source pairs parsed`、`Sheet already current`。
- Version 11 现场无变化运行 2（warm）：17:22:55→17:23:36，共 41 秒；summary 为 `0 added / 16 checked / 0 skipped / 0 missing`、`16 unchanged reused / 0 source pairs parsed`、`Sheet already current`。
- warm fast path 精确命中 16/16，source parse 为 0；相对优化前 71 秒中位数快 30 秒，耗时减少 42.3%，约为 1.73×。该结果证明增量分支生效，但没有达到预设 `≤35 秒 / ≥50%` 性能门槛；不得把它表述为 50% 或以上改善。
- V11 另有一次自然小时同步用时 138 秒，显示 source parse 消除后仍存在明显固定/平台波动；执行审计指出 Archive、projection、ml-lifecycle 三条正常 `sync-skip` 分别 append，是下一阶段可以安全合并的往返开销。
- 两次运行均为 no-change 且 `Sheet already current`；最终数据仍为 Projects 16 / Registry 16 / Facets 50 / Assets 16。从 `[skip netlify]` push、Version 11 原址部署到现场计时，Netlify deploy ID 集合不变，增量为 0。
- Production 仍为 `6a7ebce1232712000852c07c` / `main@1fa55688043deddd69aeabda6ed2cd56d02e0751` / schema 2。本阶段的部署、正确性和现场计时已完成；性能有明确改善，但数值门槛尚未达到。

### Phase 17：V12 正常 skip audit 聚合

代码、测试与部署：

- `9a9fec8126de2673b729d4c1dc1788220fc2b2a1`（`Batch Drive sync audit notices [skip netlify]`）已推送到 `develop`；完整 Node 24 测试为 280/280，`git diff --check` clean。
- `google-apps-script/Code.gs` SHA-256 为 `5c2c56c2b04dfdea5386c20932be90e08a1220e0e41e6d3e81d793c3fb3b246a`。
- 新 V2-bound Apps Script 正式 Web App 已在原 Deployment ID 与 `/exec` URL 上更新到 Version 12；deployment topology 仍为 2，没有创建新 deployment 或 endpoint。
- Git 提交使用 `[skip netlify]`；从 push、Apps Script 原址部署到 benchmark，Netlify deploy ID 集合不变，新增 Branch Deploy、Deploy Preview 与 Production deploy 均为 0。

实现与安全边界：

- 原来 Archive、projection、ml-lifecycle 三个正常跳过路径会分别调用 `_Audit` append；Version 12 将同一轮扫描的正常 skip notices 汇总为单条 `sync-skip`，减少三次独立 Sheet 写入往返。
- 聚合不删除原因：每个条目仍保留 folder 与 reason。reason 经过既有无条目数上限的 Audit 清洗后，按最多 700 字符的 message 预算打包；单个清洗后仍超过 700 字符的 reason 会按最多 600 字符分片，最终 `logEvent_` 仍执行 1000 字符硬上限。`try/finally` 会 flush 之前积累的 notices；error/conflict 等非正常审计路径不变。
- 此微优化不改变 Version 11 的 metadata fingerprint、source/output hash、cold fallback、最终 Drive contract、Sheet 并发保护、no-op linearization 或 publish 边界。

现场性能与最终状态：

- V12 warm run 于 17:41:10→17:41:37 完成，共 27 秒；可见审计只有一条聚合 `sync-skip`，其中完整保留 Archive、projection 和 ml-lifecycle 三个原因。
- summary 为 `16 unchanged reused / 0 source pairs parsed / Sheet already current`。相对 Version 11 前 71 秒中位数节省 44 秒，耗时减少 61.97%，约为 2.63×，达到 `≤35 秒 / ≥50%` 门槛。
- 最终读回为 Projects 16 / Registry 16 / Facets 50 / Assets 16，且 Projects 为 16/16 `Live + Publication ready`；Raman 已改为 Live/Public。
- `AI4S_AUTO_PUBLISH_TARGET=off`，sync 本身不会发布。Production 因此保持 `6a7ebce1232712000852c07c` / `main@1fa55688043deddd69aeabda6ed2cd56d02e0751` / schema 2 的既有 15-route artifact，Raman 仍未进入 Production。这是预期的待发布状态，不是数据不一致。

## 6. 当前外部控制面状态

### Google Sheet / Apps Script

| 配置 | 当前状态 |
| --- | --- |
| production branch | `main` |
| preview branch | `develop` |
| preview URL branch | `develop` |
| auto publish target | 新 V2 `AI4S_AUTO_PUBLISH_TARGET=off` |
| V1 sync trigger | 0；V1 Sheet 已移入 Drive `Archive` |
| V2 sync trigger | 1 个 owner-owned hourly `syncDrive` |
| Web App | 新 V2-bound endpoint，正式 Version 12；code 与 manifest 精确匹配 `develop@9a9fec8`；原 deployment / URL 不变，topology=2 |
| Preview/Production Hooks | 只保留 V2 develop/main 各 1 个；旧 V1 Hooks 已删除 |
| Registry token | Fresh V2 token 已用于 `branch:develop` 与 Production；旧 V1 formal endpoint 已停用 |
| V2 Sheet | Private；Projects 16 / Registry 16 / Facets 50 / Assets 16；16/16 `Live + Publication ready`，Raman 已为 Live/Public |
| V2 Script Properties / credentials | 新项目独立、fresh configured；实际值从未记录，不继承旧 V1 |

当前控制面是新 V2-bound Web App Version 12，不是原 V1-bound Version 12。新项目使用
独立 URL、deployment、Properties 和 credentials；旧 V1 trigger=0，新 V2 trigger=1。
Private Preview 与 Production 均已闭环，auto target 保持 `off`。V1 Sheet 已归档，旧 formal
deployment 已删除；旧 Apps Script project/HEAD/version history 仅作审计保留。

### Netlify

| 配置 | 当前状态 |
| --- | --- |
| Production branch | `main` |
| Additional branch | `develop` |
| Continuous deployment | On |
| Production visibility | Public |
| Preview visibility | Private |
| `REGISTRY_URL` | Secret + Builds-only；仅 `branch:develop` 与 `production` |
| Untrusted deploy policy | Require approval |
| Preview callback secret | Secret + Builds-only；仅 `branch:develop`；值不记录 |
| Build Hooks | 仅保留 V2 develop/main 各 1 个；旧 V1 hooks=0 |
| Auto recharge | Disabled |
| Latest develop Branch Deploy | `6a7eb82127b60f0008c234ea`，`develop@045253c6`，ready；fresh callback E2E；deploy time 182 秒 |

当前 credit-based 计费规则：Branch Deploy 与 Deploy Preview 本身消耗 0 deployment credits；
每次成功的 Production deploy 消耗 15 credits。Preview 的实际访问仍会产生少量 bandwidth
和 web-request credits；如使用 Functions、Preview Servers 等能力，则相应 compute 另计。
当前 V2 Preview artifact 为静态站，且无 Functions / Edge Functions，因此本次没有独立的
Preview deployment credits。

17:08 的失败记录 `6a7c380...` 为 `branch-deploy/develop@9a457e5`，创建时间
与 17:07:57 开始的时间驱动 `syncDrive` 执行窗口高度吻合，标题也为
`AI4S preview: develop`。但 Netlify 返回的元数据没有 trigger/source 字段，
因此只能记录为强关联，不能写成平台已直接确认来源。

新 V2 control plane 与 develop Branch Deploy 使用 freshly configured credentials；值从未写入本文、Git、Sheet 或日志。新项目不继承旧 V1 Properties。

Registry v2 Preview 仍为 Private：团队登录可访问，匿名访问返回 HTTP 401。当前 artifact
包含 61 个文件、16 条 demo 路由（含 `raman-spectroscopy`）和 16 张 Drive-localized
card JPG；没有 Functions、Edge Functions 或构建错误。前一控制面验收的
accepted、publish-ready、verified、revision-bound 与 request/revision/deploy identity
闭环继续成立；本轮另以 ready 状态、artifact 清单和匿名 401 验收缓存构建。
Published Production 已为 `6a7ebce1232712000852c07c` / `main@1fa55688`；schema 2、
15 个 routes 与 15 张 card JPG 已验收。Sheet 当前比该 artifact 多一个已为 Live/Public
的 Raman；`auto=off` 使其保持待显式发布。旧 `6a7ac807...` 仍 ready，作为现成 rollback
候选保留。

### GitHub 发布治理

| 配置 | 当前状态 |
| --- | --- |
| CI workflow | `.github/workflows/ci.yml` |
| Runtime / command | Node 24；`node --test --test-concurrency=1` |
| Events | PR → `main`；push → `main` |
| Workflow permissions | `contents: read`；无部署 secret 引用 |
| Ruleset | `Protect Main`，Active，仅 `main` |
| PR approval | required approvals = 0 |
| Required check | GitHub Actions `test`（integration `15368`） |
| History protection | 禁止删除和 non-fast-forward/force push |
| CODEOWNERS / second approver | 不要求 |

### Google Drive 历史 ID

两个归档对象 ID 已从当前 public tree 删除，但仍存在于旧 Git commit 历史。两对象均核验为 owner-only、未共享，因此 ID 本身不能授予访问权限。当前不改写 Git 历史；如果未来改变分享权限，需重新评估或更换对象。

## 7. 测试与安全覆盖

当前完整命令：

```text
node --test --test-concurrency=1
```

结果：当前本地 develop 为 280 tests / 280 pass / 0 fail；main 的
required `CI / test` 规则继续生效。

覆盖范围：

- Preview branch allowlist 与 main/master 拒绝。
- Production/main context lock。
- Hook URL base-only 校验与 preview/production 分离。
- legacy auto switch fail closed。
- Registry token URL encoding 和 Web App Sheet reopen。
- Registry audience、status、file boundary 和 revision。
- Draft/Live/Archived/missing/unreadable/empty 状态矩阵。
- Production 与 develop Preview mock integration。
- Hook envelope、revision stale、file/final recheck。
- HMAC callback、constant-time comparison、幂等、错站和超时。
- Accepted 状态去重、失败退避和 verification timeout。
- Netlify plugin context、入口导出和 Production zero-callback。
- secret-shape 和公开产物扫描。
- Runbook 真实 ID 回归保护。
- 操作者必须先 Draft Preview、避免重复 Production deploy 的文档约束。
- 扫描期间人工编辑、公式空值、并发排序与只写管理列。
- root/subfolder/file parent edge、parent/MIME 异常和 shortcut 跳过。
- Registry v2 20-row Sheet adapter、隐藏 `demo_id`、反向排序和 guarded writeback。
- Registry v2 taxonomy/facet/readiness/permission 严格契约与公开 allowlist。
- Registry v2 Sheet/compiler English-only fail-closed 边界与全表 CJK 扫描。
- canonical permission 闭集；alias 不得授予 Public。
- `featured` 与 taxonomy `active` 的 strict boolean 校验。
- 卡片 asset revision、MIME、大小、Base64、magic bytes、路径冲突及真实落盘。
- Apps Script v2 snapshot/asset 串行传输与 ContentService 404 回归保护。
- Registry v2 opening/closing manifest 实时编译、revision-bound page/asset cache hit、
  cold/expired cache fallback、audience 隔离、Sheet/Drive stale 检测、malformed /
  unavailable / oversized cache 降级和 sync marker invalidation。
- V2 auto-ingest 的 direct-folder boundary、Draft 安全默认值、原生 table append、隐藏表原子投影、幂等、缺失/恢复、并发写前停止与 blocked revision 不变。
- V2 sync fingerprint cache 的 warm hit / cold fallback、输出哈希与健康状态校验、HTML / PROVENANCE / image inventory / parent 失效，以及 missing→recovery 与 replacement ID 失效。
- V2 sync 最终无变化路径跳过 batch/flush/reopen/post-read；auto target `off` 时复用 post-verified snapshot 且零 Hook POST；显式 publish 保持 live compile。
- 正常 sync-skip audit 的 700 字符打包、超长 reason 的 600 字符分片、最终 1000 字符 log cap、`try/finally` flush，以及 folder/reason 完整保留。
- 真实 Private Preview canary：25 个 new files、23 个 generated pages、2 个 changed assets、15 个项目路由；其中明确验收 1 张 Pleiades Drive card image。
- 当前 V2 cache Private Preview：61 个 artifact files、16 条 demo routes（含
  `raman-spectroscopy`）、16 张 Drive-localized card JPG、无 Functions/Edge/errors、
  匿名 401；deploy time 187 秒。

## 8. 账单与历史部署审计

Netlify team 当前为 Pro Credit-based：

| 指标 | 当前值 |
| --- | --- |
| Billing period | 2026-07-22 至 2026-08-21 |
| Plan credits | 3,000 |
| Remaining | 2,443.1 |
| Total consumed | 556.9 |
| Production deploy usage | 34 deploys / 510 credits（team aggregate） |
| Bandwidth | 43 credits |
| Web requests | 3.9 credits |
| Auto recharge | Disabled |

历史 deploy `6a799c9878ba773e23d4e427`：

- 2026-08-10 17:40 Repo linked 时触发 `main@6c5488d` Production。
- 构建成功并短暂成为 Published deploy。
- 17:43 从该 deploy 回滚到 `6a7554bf39cf8b00085699ef`。
- 成功 Production 消耗 15 credits；rollback 本身 0 credits。
- 一次性影响，无持续费用，审计事项关闭。

## 9. 后续工程工作

### P0：下一次 Production 前 — 已全部完成（2026-08-11）

#### A. 发布最新 Apps Script 帮助文字 — 已完成

目的：线上 Help 与 Git 一致，明确 `Draft → Private Preview → approval → Live`；区分内容 Hook 和代码 merge 发布。

验收标准：

- 更新现有 Apps Script deployment，新 URL 不创建。
- 保留全部 Script Properties。
- 不运行 `setup()`。
- 唯一 `syncDrive` trigger 不变。
- Help 和 status note 与当前 `Code.gs` 一致。

#### B. GitHub main 分支保护 — 已完成

目的：为单人维护提供防误操作保护，不引入第二人审批流程。

验收标准：

- 禁止直接 push main。
- 只允许 PR 合并。
- Required approvals 设为 0；维护者可以在 CI 通过后自行合并。
- 不配置 CODEOWNERS 或指定第二位审批人。
- 要求 CI `test` 成功。
- 禁止 force push 和删除 main。
- 管理员仅保留 PR 内的紧急 bypass，不允许日常直接 push。
- 不启用与当前单人规模无关的复杂规则。

#### C. GitHub Actions CI — 已完成

目的：把当前本地 67 项测试变成 PR 必过检查。

验收标准：

- Node 24 workflow。
- `node --test --test-concurrency=1`。
- PR 和 main push 均运行。
- Branch protection 要求该 check。
- 不向 fork PR 暴露 Netlify/Registry secret。

现场证据：

- PR #4 `CI / test (pull_request)` 成功，8 秒。
- main merge commit `7c648da` 的 `CI` push run 成功，9 秒。
- Netlify 在 develop push、PR 创建和 main merge 后均没有新增 deploy；Published Production 保持 `6a7ac807` / `a968a07`。

P0 关闭结论：A、B、C 均已满足验收标准；没有遗留的 P0 操作。

### P1：扩大 Drive 自动化前

#### A. Sheet 并发写保护 — 已发布，当前 V2 Web App Version 12

旧线上现状：sync 先读整表，末尾按整行写回；扫描窗口内的人工作业可能被旧快照覆盖。

验收标准：

- 只写自动管理列，或写前使用乐观并发检查。
- 人工 title、status、slug 和 metadata 不被覆盖。
- 增加“扫描期间人工编辑”测试。

实现结果：同步只写明确管理列；写前比较值与公式；并发人工字段保留；行移动在首个现有行写入前停止。该能力最初在旧 deployment 上线，现由新 V2-bound Web App Version 12 的 `9a9fec8` 精确代码继续提供。

边界：V2 `Readiness` 与 `Preview URL` 使用另一套显式 guarded writer，已在 Phase 11 上线；它不会由 legacy sync 自动调用。

#### B. Drive parent 与 shortcut 边界 — 已发布，当前 V2 Web App Version 12

旧线上现状：下载端有边界校验，但 collect iterator 未对每条 root/subfolder/file edge 复核即时 parent。

验收标准：

- root folders、root loose files、subfolder files 均核验直接 parent。
- parent lookup 异常时整次 sync fail closed。
- shortcut 明确跳过，不按 `.html` 文件名误识别。
- 移动文件和文件夹测试覆盖。

实现结果：三类 edge 都复核 parent；parent 或 MIME lookup 异常 fail closed；shortcut 不按文件名误识别。该能力最初在旧 deployment 上线，现由新 V2-bound Web App Version 12 的 `9a9fec8` 精确代码继续提供。

#### C. Drive 图片端到端链路 — Private Preview E2E 已完成

原现状：Apps Script v1 能返回 picture file，但 `build.js` 未把 Drive 图片下载到 dist。

验收标准：

- Registry API → 下载图片 → 安全写入 `dist/assets`。
- 卡片使用本地公开路径。
- 公开产物无 Drive ID/token。
- Production 和 Preview integration test。

当前结果：v2 build 客户端、Apps Script `action=asset`、Sheet adapter 与真实 Google Drive → Private Preview 已完成。当前 V2 有 16 条 `_Assets` 记录；最新 Preview artifact 精确包含 16 张 Drive-localized card JPG，对应全部 16 个 demo。公开产物未暴露 Drive ID/token。Production E2E 已在 Phase 15 完成：切换当时 15 个 Live 项目的 15 张 card JPG 均已验收，Raman 当时为 Draft 并按契约排除；Raman 当前已为 Live/Public，但尚未显式发布。Phase 10 的 1 张 Pleiades canary 与 `2 assets changed` 是历史证据，不代表当前图片数量。

#### D. 重复 ID、同名文件和替换迁移

验收标准：

- 重复 `file_id`/slug 直接告警并停止发布。
- 主页面选择确定性。
- 新 Drive ID 替换旧文件时，提供受控 status/slug/metadata migration。

当前结果：重复 ID/slug/path 的 fail-closed contract 已有测试；replacement revision 的真实 Drive canary 仍待执行。

Phase 12 补充边界：auto-ingest 遇到已有 slug/demo ID 但不同 `file_id` 时只记录冲突并跳过，不会根据同名自动迁移；当前只支持原 Drive 对象的 in-place 更新。受控 replacement migration 仍是独立待办。

#### E. Demos Sheet schema migration

验收标准：

- 覆盖旧 27 列、当前 30 列、自定义中间列、缺失/重复/乱序 header。
- 值、公式、格式、validation、protection、named ranges 保留。
- Sheet 副本运行两次结果幂等。

#### F. Registry metadata contract — Private Preview adapter 已完成

原现状：README 描述的 department、record type、subtopic、preview image 等字段未全部存在于真实 Apps Script manifest。

验收标准：

- 确定正式字段清单。
- 扩展 Sheet/manifest 或修正文档。
- 真实 `Code.gs` manifest contract test，不再只依赖丰富的 mock fixture。

当前结果：15 个可见英文人类字段、隐藏机器 schema、compiler、Sheet adapter 与 v2 build contract 均已冻结；Registry 当前包含 16/16 `Live + Publication ready` 项目，Raman 已为 Live/Public。V2-bound Web App、Private Preview、verified callback 与 schema-2 Production 均已验收；Production 当前仍是 15-route 快照，Raman 待显式发布。replacement revision canary 仍是独立非发布待办。

#### G. V2 Drive 自动收录 — 历史 Version 12 canary 已由当前 V2 Web App Version 12 接替

实现结果：历史功能提交 `ffea262` 已实现 direct English subfolder → V2 safe Draft；当前基线为 `develop@9a9fec8`、280/280，并由新 V2-bound Web App Version 12 运行。

历史 Version 11/12 commissioning、15→16 intake 与 Raman 内容补齐详见 Phase 12。当前状态以 Phase 17 为准：新 V2 Web App Version 12、auto target `off`、Projects/Registry/Facets/Assets=`16/16/50/16`，且 16/16 项目均为 Live + Publication ready；Drive sync warm 为 27 秒、16/16 reused、0 parsed；V1 已归档并退出运行时。Production 仍是 15-route 快照，Raman 待显式发布。

### P2：运维与长期维护

- 建立 clasp 或受控 API 的可重复 Apps Script 部署；不能自动发布 Production。
- 把 Build Hook URL 从 Sheet 移到 Script Properties。
- 为 verification-timeout、连续网络错误、HMAC 不匹配和 Production deploy 增加通知。
- Registry v2 revision-safe build cache 已完成：同规模 deploy time 从 796 秒降至 187 秒；blob 读取继续串行，manifest、asset、permission、parent 和 stale-response 校验保持不变。后续只观察，不为追求更短时间引入无界并发。
- V2 Drive sync 增量指纹、no-op fast path 与正常 audit batching 已部署并完成现场计时；Version 11 的 80 秒 cold、41 秒 warm 与 138 秒自然小时波动保留为第一阶段证据，Version 12 warm 为 27 秒，较 71 秒旧中位数减少 61.97%（约 2.63×），达到 `≤35 秒 / ≥50%` 门槛。继续观察自然小时运行，不为追求更短时间削弱安全或诊断信息。
- Raman 已在 Sheet 中为 Live/Public，但 `auto=off`，所以 Production 仍为 15-route artifact；负责人批准后才显式发布一次 Production。
- 定期审计 Netlify、Google、GitHub 成员和 secret 生命周期。
- 清理 Preview Server / Agent Runners context 的失效旧 Registry 值。
- 决定是否长期保留 PR Preview。
- 建立 HTML 内容信任模型；评估 CSP、协议限制或 iframe 隔离。

## 10. 发布与回滚检查表

### Production 前

- [x] 生成旧 Production 14 routes 与 V2 candidate 15 Live routes 的 exact diff，并逐项说明新增、删除、slug、标题、排序与卡片资产变化。
- [x] 负责人明确批准该 exact diff 和一次 Production V2 cutover。
- [x] 当前分支为 develop，tracked code worktree clean。
- [x] local/remote develop 对齐。
- [x] 记录 remote main SHA 和切换前 Published Deploy ID。
- [x] 记录首页 hash、manifest demo/domain count、关键路由状态。
- [x] 确认 Production branch=main。
- [x] 确认 Production Public、Previews Private。
- [x] 确认新 V2 `AI4S_AUTO_PUBLISH_TARGET=off`，旧 V1 trigger=0、新 V2 trigger=1。
- [x] 运行完整 Node 24 测试（257/257）。
- [x] PR #6 的 required `test` 通过，并由项目负责人明确批准上线。
- [x] Production `REGISTRY_URL` 切换到 fresh V2 endpoint；secret 变更本身未触发 deploy。
- [x] Git merge 与 Production Hook 未同时调用。

### Production 后

- [x] 新 main SHA 与 Production receipt commit 一致。
- [x] T0 后 Production deploy 增量恰好 1。
- [x] Deploy context=production、branch=main、state=ready/published。
- [x] 首页、manifest、全部 demo/domain 路由通过。
- [x] Preview 匿名访问仍为 401。
- [x] 新内容数量符合预期，没有非 Live 内容。
- [x] Phase 15 cutover 的 Production manifest 为 V2；包含当时获批的 15 个 Live 项目，并排除当时仍为 Draft 的 Raman。当前 Raman 已在 Sheet 中为 Live/Public，需另一次获批发布才会进入 Production。
- [x] 公开 artifact 不包含 Registry token、Drive/Sheet ID、Hook URL 或其它 secret。
- [x] 旧 Published Deploy 仍 ready，可回滚。
- [x] 等待队列清空后复查没有第二次 Production deploy。
- [x] 稳定观察后停用旧 V1 endpoint/credential，并归档 V1 Sheet；回滚 deploy 保留。
- [x] 更新负责人汇报和本工程记录。

失败处理原则：如果新 deploy 构建失败但旧 Published 仍正常，不得直接 Retry；先诊断。任何回滚只发布已存在的旧原子 deploy，不创建第二次 build。

## 11. 相关文件

- [负责人项目状态汇报](project-progress-zh.md)
- [Phase 3 Preview 自动化手册](phase3-preview-automation-runbook.md)
- [根 README](../README.md)
- [Apps Script README](../google-apps-script/README.md)
- [Apps Script 源码](../google-apps-script/Code.gs)
- [构建脚本](../build.js)
- [Netlify 配置](../netlify.toml)
- [Preview callback plugin](../netlify/plugins/preview-ready/index.js)
- [Preview automation contract](../fixtures/preview-automation-contract.json)
- [Registry v2 技术契约](registry-v2-contract.md)

## 12. 最近工程变更记录

| 日期 | 变更 | 结果 |
| --- | --- | --- |
| 2026-08-14 | Phase 17 V12 sync audit batching | `develop@9a9fec8`；280/280；`Code.gs` SHA-256 `5c2c56c2...`；V2 Web App Version 12 原 Deployment ID / URL，topology=2；正常 skip audit 按 700 字符打包、超长 reason 按 600 字符分片、最终 1000 字符 cap；warm 27s（16/16 reused / 0 parsed），较 71s 中位数减少 61.97%（2.63×），达到目标；Netlify deploy 增量 0；Sheet 16 Live，Production 15 routes、Raman 待发布 |
| 2026-08-14 | Phase 16 V2 Drive sync 增量快速路径 | `develop@c824588`；276/276；`Code.gs` SHA-256 `c40fba7...`；V2 Web App Version 11 原 deployment / URL；cold 80s（0 reused / 16 parsed），warm 41s（16/16 reused / 0 parsed），较 71s 中位数减少 42.3%（1.73×），未达到原定 ≥50% 门槛；Netlify deploy 增量 0；Production `6a7ebce1` / `main@1fa55688` / schema 2 不变 |
| 2026-08-14 | Phase 15 V2 Production cutover 与 V1 退役 | PR #6 merge `main@1fa55688`；唯一 Production deploy `6a7ebce1232712000852c07c` ready；schema 2，15 Live routes / 15 card JPGs / 7 domains，Raman 排除；V2 `_Config=production`；V1 Sheet 归档，旧 trigger/Hook/formal Web App 停用；旧 deploy `6a7ac807...` 保留回滚；清理零新增 deploy |
| 2026-08-14 | Phase 14 全量卡片资产与 revision-bound cache 验收 | develop/origin `045253c6`；257/257；V2 Web App Version 8；`16/16/50/16`；deploy `6a7ea4535173db00081ba4c1` ready，61 files / 16 routes / 16 card JPGs；deploy time 187s，较 796s 减少 609s（76.51%，4.26×）；匿名 401；Production 不变 |
| 2026-08-13 | Phase 13 V2 control-plane cutover 与 Private Preview 验收 | develop/origin `c4ff498`；244/244；新 V2-bound Web App Version 1；旧 V1 trigger=0、新 V2 trigger=1、auto target=off；`16/16/50/1`；deploy `6a7d9386b3f7740008e93c93` ready，46 files / 16 routes / 1 Drive-localized asset，receipt verified + revision-bound；Production 不变，V1 未归档 |
| 2026-08-13 | Raman 英文元数据补齐与 14:01 同步验收 | 从本地 HTML/PROVENANCE 填入 Card Summary、taxonomy、Audience 与 Data Source；Card Image 留空；`0 added / 16 checked / 0 skipped`；Raman 为 `Draft + Preview ready`，Registry/Facets 一致；该阶段 auto target 曾恢复 preview；零 Netlify deploy；Private Preview 后由 Phase 13 完成 |
| 2026-08-13 | V2 Drive auto-ingest Version 12 commissioning 与首个真实 canary | develop `eeb4d88`（功能历史提交 `ffea262`）；229/229；空同步通过；首次 `1 added / 15 checked`、复跑 `0 added / 16 checked`；Raman 初次以 blocked Draft 安全入库；`ramam` 已统一迁移为 `raman` |
| 2026-08-12 | Registry v2 guarded status write-back | develop `4a3ca09`；Apps Script Version 10 原 URL；215/215；15/15 `Publication ready` 与 Preview links；Netlify/Production 零变化 |
| 2026-08-12 | Registry v2 Private Preview commissioning | Apps Script V9 原 URL；第二次 canary `6a7c2a8...` 成功；201/201；15 routes、23 generated pages、2 changed assets；确认 1 张 Drive card image；Production 不变 |
| 2026-08-12 | 串行化 Registry v2 远端读取 | `9a457e5` 关闭并发 ContentService HTTP 404；保留后续 revision-safe 性能优化项 |
| 2026-08-12 | PR #5 合并 P1 Drive sync safety | main `a036d077...`；`[skip netlify]`；Published Production 仍为 `main@a968a07` |
| 2026-08-12 | Registry v2 项目目录清理 | 5 个废弃项目成组清除；Microclimate 升为 Live/Public；15 Projects、0 orphan；Preview/Production 未触发 |
| 2026-08-12 | Registry v2 English-only Sheet 与代码边界 | 历史基线 168/168；11 tabs CJK=0；develop `fdbf538` Preview completed；main、Production 未切换 |
| 2026-08-11 | P1 同步安全与 Registry v2 foundation | owner-only 影子表；线上 v1、main、Production 均未切换 |
| 2026-08-11 | Apps Script Version 7 原址更新与 Sheet 说明同步 | URL/ID、Properties、唯一 trigger 不变；无发布函数调用；后续由 Version 9 替代 |
| 2026-08-11 | PR #4 引入 Node 24 GitHub Actions CI | PR/main 两次 CI 成功；`[skip netlify]`，零新增 deploy |
| 2026-08-11 | `Protect Main` Ruleset 启用并只读验收 | Active；PR + `test`；审批 0；禁止删除与 force push；P0 正式关闭 |
| 2026-08-11 | PR #3 审核修复与 Production 合并 | 一次 Production deploy，上线验收通过 |
| 2026-08-11 | `REGISTRY_URL` token 轮换、Secret + Builds scope | 旧 token 失效，下一次构建使用新配置 |
| 2026-08-11 | Production Public / Previews Private | 匿名 Preview 401，团队登录可看 |
| 2026-08-11 | HMAC Build Plugin 回调上线 | Private Preview ready 验证闭环 |
| 2026-08-11 | add/update/delete canary | Preview 正确变化，Production 始终无 canary |
| 2026-08-10 | 分支与 Preview 收敛为 main/develop | 旧分支和旧 Hook 清理完成 |

后续每个工程里程碑应追加一行；排障细节写入对应阶段或 runbook，不写入负责人汇报。
