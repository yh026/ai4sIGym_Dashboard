# Dataset 页面接入记录

2026-09-24，读取用户提供的 `datasets_upload/` 中 9 个 HTML 的标题、Overview 和 Used by 内容后确认以下对应关系。保留原始正文、图表脚本和已有网址，构建时添加项目导航。只更新独立 Sandbox 和 develop。

| 输入文件 | 对应 Demo | Dataset ID / version |
| --- | --- | --- |
| himawari-9-ahi_dataset.html | TBB cluster explorer | himawari-9-ahi / v2 |
| gaia-edr3-pleiades_dataset.html | Pleiades membership | gaia-edr3-pleiades / v1 |
| uci-superconductivity_dataset.html | Superconductor regression | uci-superconductivity / v1 |
| eurosat-rgb_dataset.html | Satellite image vector quantization | eurosat-rgb / v1 |
| galaxy10-decals_dataset.html | Galaxy rotation augmentation | galaxy10-decals / v1 |
| neurips-bmmc-cite-seq_dataset.html | JAE joint embedding | neurips-bmmc-cite-seq / v1 |
| calce-cs2-soh_dataset.html | Battery SOH forecast | calce-cs2-soh / v1 |
| calce-cs2-shape_dataset.html | Battery curve shape | calce-cs2-shape / v1 |
| nasa-battery-capacity_dataset.html | CEEMDAN battery forecasting | nasa-battery-capacity / v1 |

CALCE 两页描述不同特征集，因此拆分此前共用的占位 Dataset ID。旧 `calce-cs2/v1` 测试文件保留为未登记的测试历史。Gaia 文件名保留 `edr3`，正文明确标记 DR3；接入不改写其科学描述。两个人类基因项目随后更新为下述 v2 Dataset。

## 两个基因 Dataset 的 v2 更新

同日接入用户提供的 `Downloads/ais-gene-project-pages/` 中两份重做的 `dataset.html`：

| 输入子目录 | 对应 Demo | Dataset ID / version | 保留的网址 |
| --- | --- | --- | --- |
| alzheimer-gene-coexpression | Alzheimer's gene co-expression | gse1297-hippocampus / v2 | datasets/gse1297-hippocampus/index.html |
| single-cell-gene-expression | Single Cell Gene Expression | gse84133-human-pancreas / v2 | datasets/gse84133-human-pancreas/index.html |

仅替换 Dataset，包中的 Insight / Workflow 未导入。新版源文件原样保存，包含数据审计、处理步骤和可交互矩阵查看器；导航由现有构建添加。保留原 Dataset ID 和 URL，避免来源文件中较短的 `gse84133-pancreas` 名称改变现有链接。

测试 Drive 为两者新建 `v2/dataset.html`，保留旧 v1。Sandbox 表格仅修改 `Pages!E24`、`G24`、`E30`、`G30` 的源文件链接和 Dataset version；相应链接目标同步更新，其他格式与字段保留。

本地使用 `local-content/v2/datasets/<id>/index.html`；原件副本位于 `datasets_v4/<id>/v2/dataset.html`，旧页面和导入记录位于 `local-content/gene-dataset-import-20260924/`。项目 `project.json` 的 `dataset.version` 记为 v2，测试包导出现在沿用该版本号。两个项目的 Insight / Workflow 源文件哈希保持不变。

Google Drive 文件位于独立测试根目录的 `datasets/<id>/<version>/dataset.html`。TBB 新建 v2，保留旧 v1；其余八项从 Placeholder 改为 Ready。Sheet `Pages` 只更改对应九行的 D:G（State、Source file、Dataset ID、Dataset version），Page ID、Version ID、Route、下拉控件和表格格式保持原样。

首页不再把导入来源当作 Collection 分类，也不在搜索词、卡片属性或公开 manifest 中输出该来源。Department、Method、Data Type 和 Instrument Type 四类筛选保留。

## 本地维护

在包含原有本地内容的工作区执行：

```sh
node scripts/import-dataset-pages.cjs /absolute/path/to/datasets_upload
node build.js --local
```

导入脚本先核对全部文件和项目，再将原始字节复制到 `datasets_v4/<id>/`，更新本地 `demos_v4/collection.json` 的引用；不会修改上传原件。网页内容由 Drive 托管，不需要把大 HTML 提交到 Git。

## 验证

- 502 项自动化测试通过。
- 完整 Registry v3 构建预演：13 个项目、36 个页面、21 个资源、0 个占位页。
- 9 个云端源文件的 SHA-256 和大小逐一匹配用户原件。
- 本地九页可展开内容，导航对应各自 Insight / Workflow，桌面无整页横向溢出；科学脚本原样保留。
- 修改只推送到 develop；原正式后台和 main 不参与此次更新。

## 云端验收

- 功能代码提交：`d1ca85635f16ccb6fa5d01c156e43ea194655d7a`，推送到 develop。
- Netlify 部署：`6ab4c38b33421c0008e442f6`，2026-09-24 14:30:36–14:40:47（新加坡时间），构建成功，10 分 11 秒。
- 内容版本：`sha256:2d1851d570601dcc557c5f91911196b1d15d334c96dbd85699a33d250cef8805`。
- 14:42:03 收到匹配此部署的签名成功回执；Projects 的 13 个选中项目均为 Preview ready。
- 线上逐个打开全部九页并展开内容：标题、项目导航均匹配，无占位内容、整页横向溢出或浏览器错误。
- 原 Production 的 manifest / deploy receipt 与基线逐字节一致；原 Sheet Projects!A1:R20 的值和公式不变。
- develop 与固定部署地址的九项匿名访问检查均为 HTTP 401；原私有预览访问保护保留。

[查看 develop 首页](https://develop--aisigym.netlify.app/#projects)。自动同步在接入期间暂停，成功验收后恢复每小时运行。后续文档提交带 `[skip netlify]`，不替换这次已验收的部署。
