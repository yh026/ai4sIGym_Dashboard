# 原后台增量迁移预演

核验日期：2026-09-24。本文件是迁移范围和检查点，不表示已经迁移原后台，也不是 Production 发布授权。

## 当前差异

原表 `Projects!A1:R16` 已重新读取，与 9 月 23 日备份的人工值和公式逐项一致。原表有 15 项，测试集合有 13 项：12 项沿用原有 demo_id，Curve Shape 为新增项目。因此将来迁移后的项目总数应为 16，而不是 13。

| 项目范围 | 后续迁移行为 |
| --- | --- |
| 测试集合中已有的 12 个项目 | 保留原 demo_id、slug、人工元数据和 Live / Draft、Public / Preview only 状态；增加一个独立 Draft 内容版本 |
| Battery Curve Shape Explorer | 新增一行 Draft / Preview only，不发布到 Production |
| Forest Microclimate — Does Canopy Buffer the Day? | 保留原行、内容和状态；不从测试表推导或覆盖 |
| Forest microclimate · a lifecycle explorer | 保留原行、内容和状态；不从测试表推导或覆盖 |
| Raman Token Cartography - spectral regions and continuous change | 保留原行、内容和状态；不从测试表推导或覆盖 |

12 个共用项目为 TBB、Pleiades、Superconductor、Satellite、Single Cell、Galaxy、Alzheimer、JAE、Air Quality、Road Speed、SOH、CEEMDAN。Air Quality 和 Road Speed 保留单页，其余新开发版本使用三页布局。

## 迁移前必须补齐的具体工作

1. 在迁移窗口重新备份原 Sheet 的值、公式、原生 Table、校验和保护规则，记录原脚本实际部署版本、触发器和 Netlify 配置；检查与本预演之间的并发编辑。
2. 实现并验证用于原后台的兼容适配器。当前 Sandbox 脚本明确绑定独立 Sheet / Drive，不能直接改两个 ID 后拿来替换原脚本。
3. 给原站当前公开内容建立受保护的 Published 文件快照，保留全部旧路由和下载。原 schema 2 Production 投影必须与迁移前一致。
4. 增量增加 Versions、Pages、Resources 和所需索引、只读版本引用。只新增确实缺失的结构，不能整表覆盖 Projects / Options。
5. 将已验收的三页内容复制到独立 Draft 版本，取得对应文件映射。保持正式旧版本与开发文件分离；Dataset 共享引用按版本绑定。
6. 在受保护的 develop 验证原后台的新接口、签名回执、Dataset 占位和下载，再决定是否切换日常管理入口。

## 审核和回退点

- 迁移前后比较：原 15 个 demo_id / slug、人工字段、原 Published 文件 hash、旧 schema 2 Production manifest；只有明确批准的新结构和 Draft 行允许变化。
- 正式代码、原脚本部署和 Production Hook 在迁移结构期间不自动发布新版页面。合并 main 与公开新版需要另行安排。
- develop 回退只恢复对应分支的原 Registry URL、回执密钥及旧产物，并停止 Sandbox 自动化。
- 原后台迁移回退使用该次迁移窗口的最新备份；撤销新增结构和指针前核对并发编辑，不能用旧备份覆盖后来的人工作业。

截至本次核验，原 Sheet / Drive / Apps Script 仍未被本轮写入，Production 未切换到 Sandbox。
