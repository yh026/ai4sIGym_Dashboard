# 本地内容工作区

网站源码与通用工具由 Git 管理。Drive 内容、Registry 快照和正在修改的项目保存在
已被 Git 忽略的 `local-content/` 中。项目根目录仍是 `AIS_Dashboard`。

## 目录

| 位置 | 用途 |
| --- | --- |
| `local-content/drive-current/` | 从当前 Drive 与 Registry 校验取得的副本；刷新时整体更新 |
| `local-content/drive-current/inventory.json` | 项目身份、原文件名、Drive 来源、时间、大小和 SHA-256 |
| `local-content/drive-current/registry.snapshot.json` | 本地构建所需的七张 Registry 工作表值；不是凭据文件 |
| `local-content/v2/projects/` | 正在修改的项目，包含 Key Findings、Workflow 和 `project.json` |
| `local-content/v2/datasets/` | 可被多个项目引用的数据集页面 |
| `local-content/source.json` | Drive 根目录和 Registry 表的 ID |
| `local-content/last-refresh.json` | 最近刷新新增、更新、移除的文件清单 |
| `dist/` | 生成的网站，运行构建会重新生成 |

在 `v2/` 修改工作副本。刷新会校验 `drive-current/`，发现其中有本地修改便停止，
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

预览入口为 `http://127.0.0.1:4173/`，包括：

- 本地完整网站，沿用现有首页、分类和项目详情结构；
- 下载的原始项目页面；
- V2 工作区中各页面的独立预览。

这个服务只监听本机地址。关闭终端进程即可停止。端口占用时可以使用
`npm run content:preview -- --port 4174`。

如果终端找不到 `node`，可让 Codex 使用桌面应用自带的 Node；当前应用的运行时路径
由 `load_workspace_dependencies` 提供。也可以把该 Node 所在目录加入当前终端的 PATH。

`content:build` 使用已校验的本地快照，展示健康的 Live 和 Draft 项目，完全不请求
Registry Web App。`--local` 在 Netlify 部署环境中会报错。普通 `npm run build` 和
线上构建继续使用现有 Registry 流程。构建回执中的本地 revision 是快照校验值，
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
6. 成功后替换 `drive-current/`，输出变化清单；保留 `v2/`。

来源变化、缺失主页面、校验失败或可能被截断的目录列表都会阻止替换。
工具对单个目录的 100 项返回上限采取停止处理，届时应增加分页读取再继续。
失败时可检查 `local-content/.incoming-*` 中的暂存文件。

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

## TBB V2 当前状态

三份用户提供的 HTML 已按角色放入 `v2/`，导入时保持字节一致，原文件名及校验值
记录在 `project.json`。Dataset 在项目目录之外，便于后续复用。

本轮完成内容整理和独立预览。Key Findings → Workflow / Dataset 的页面导航、
Workflow 内的旧 Dataset 链接，以及首页进入 Key Findings 的新逻辑，属于下一轮页面改造。
预览入口提供三页直达链接，以便现在就能打开检查。
