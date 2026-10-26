# 本地内容工作区

网站源码与通用工具由 Git 管理。Drive 内容、Registry 快照和正在修改的项目保存在
已被 Git 忽略的 `content/` 中。生成文件和运行资料保存在 `.local/`；项目根目录仍是 `AIS_Dashboard`。

## 目录

| 位置 | 用途 |
| --- | --- |
| `content/sources/drive/` | 从当前 Drive 与 Registry 校验取得的副本；刷新时整体更新 |
| `content/sources/drive/inventory.json` | 项目身份、原文件名、Drive 来源、时间、大小和 SHA-256 |
| `content/sources/drive/registry.snapshot.json` | 本地构建所需的七张 Registry 工作表值；不是凭据文件 |
| `content/projects/` | 正在修改的项目，包含 Insight（或 Key Findings）、Workflow 和 `project.json` |
| `content/datasets/` | 项目对应的数据集页面；当前每个导航包使用独立路由 |
| `content/sources/source.json` | Drive 根目录和 Registry 表的 ID |
| `.local/reports/last-refresh.json` | 最近刷新新增、更新、移除的文件清单 |
| `.local/site/` | 本地构建的网站，包含本地项目页面 |
| `dist/` | 普通构建及 Netlify 使用的输出；与本地试点目录分开 |

在 `content/projects/` 修改工作副本。刷新会校验 `content/sources/drive/`，发现其中有本地修改便停止，
避免覆盖编辑成果。项目清单保留原有 `demo_id` 和公开 slug；工作文件夹可以使用
较短的名称。下载目录中的 `SKILL.md` 和脚本是项目来源材料，不会被刷新工具执行。

原生 Google Docs 保留在清单的 `native_references` 中，使用原链接阅读。
下载覆盖已登记 Live/Draft 项目文件夹内的普通文件和子目录；归档区和未登记的
工具目录会记录为排除项。清单不会把来源中不存在的 Notebook、数据或副页标记为已下载。

## 验证、构建和预览

需要 Node.js 24 或更新版本；无需安装 npm 依赖。

```sh
npm run content:verify
npm run content:build
npm run content:preview
```

预览入口为 `http://127.0.0.1:4173/`，直接展示现有网站首页，使用同一套地图、
卡片、筛选和分类页面。默认展示健康的 Live 项目，以及在本地 `project.json` 中明确设置
`local_preview: true` 的健康 Draft 项目；具体项目由本地清单决定。
原 Registry 的状态不变，下载副本仍包含其余 Draft。
旧的 `/site/index.html` 地址会跳转到新入口。此前额外制作的内容工作台已撤下。

需要检查 Draft 时，运行 `npm run content:build -- --include-drafts`。
恢复默认本地项目范围，重新运行 `npm run content:build`。
自动 NEW 标记和页脚日期按本地构建时间计算，可能与最近一次线上构建不同。

修改 V2 HTML 或导航代码后，重新执行 `npm run content:build` 并刷新浏览器。

这个服务只监听本机地址。关闭终端进程即可停止。端口占用时可以使用
`npm run content:preview -- --port 4174`。

如果终端找不到 `node`，可让 Codex 使用桌面应用自带的 Node；当前应用的运行时路径
由 `load_workspace_dependencies` 提供。也可以把该 Node 所在目录加入当前终端的 PATH。

`content:build` 使用已校验的本地快照，完全不请求 Registry Web App。
`--local` 在 Netlify 部署环境中会报错，生成的内容写入 `.local/site/`。
普通 `npm run build` 和线上构建使用现有 Registry 流程，输出到 `dist/`，
不加载本地 V2 页面。构建回执中的本地 revision 是快照校验值，
不是正式部署的 Registry revision，也不是网站已发布的证明。

## 刷新 Drive 副本

在本项目中告诉 Codex：**刷新本地 Drive 副本，保留 V2 工作区。**

刷新通过已连接的 Google Drive 只读工具完成，无需复制 token 到终端。
执行器是 `scripts/refresh-drive-content.cjs`。它会：

1. 读取当前 Registry 元数据和完整的有界工作表范围，确定 Live/Draft 项目。
2. 遍历相应 Drive 文件夹，保留原文件名和项目身份。
3. 复用来源 ID、修改时间、大小及本地校验值均匹配的文件，下载其余文件到暂存区。
4. 再次读取目录与 Registry，确认下载期间来源没有变化。
5. 校验字节数、HTML 格式和 SHA-256，并试编译 Registry。
6. 成功后替换 `content/sources/drive/`，输出变化清单；保留 `content/projects/` 和 `content/datasets/`。

来源变化、缺失主页面、校验失败或可能被截断的目录列表都会阻止替换。
工具对单个目录的 100 项返回上限采取停止处理，届时应增加分页读取再继续。
失败时可检查 `.local/imports/.incoming-*` 中的暂存文件。

供 Codex 执行的入口（先按 Google Drive / Google Sheets 技能读取相应只读规范）：

```js
const source = await tools.exec_command({
  cmd: "cat scripts/refresh-drive-content.cjs",
  workdir: projectRoot,
  max_output_tokens: 14000,
});
if (source.exit_code !== 0) throw new Error("Cannot read refresh runner");
const module = { exports: {} };
new Function("module", source.output)(module);
await module.exports({ tools, root: projectRoot, report: notify });
```

## 项目页面与资源

`content/collection.json` 将本地项目映射到已有项目身份及稳定网页地址，
`content/projects/` 中的 `project.json` 可以登记 Insight、Workflow、Dataset 和资源目录。
构建校验项目 ID、slug、文件路径及路由，缺失文件或重复身份会使构建失败。
Dataset 页面位于 `content/datasets/<数据集>/index.html`。

本地页面由 `lib/local-project-pages.js` 和 `lib/local-demo-collection.js` 装配共享导航。
嵌入数据和交互脚本来自项目来源文件；构建不重新训练模型，也不修改原件。

`lib/local-workflow-resources.js` 读取可选的方法索引、Notebook 和运行文件，
生成本地下载资源。项目可在索引的 `package` 中设置包 ID、标题与运行说明。
Notebook、skills、原始数据和科研制作工具保存在本机及备份中，不提交 GitHub；
已交付的 Demo 资源另存于 Google Drive。普通云端构建仍读取 Drive / Registry，
不会自动发布本地内容。

科研项目的具体制作说明、复现脚本及审查记录与本地材料一起保留。
修改本地来源后，重新运行 `npm run content:build` 查看效果。
