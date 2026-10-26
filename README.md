# AIS Dashboard

AIS Instrument Gym 的网站源码和本地项目工作区。项目内容从 `content/` 开始找；网站模板和通用代码在 `site/`、`lib/` 与 `build.js`。

## 去哪里修改

| 要做的事情 | 位置 |
| --- | --- |
| 修改某个项目的 Insight、Workflow、Notebook 或技能资源 | [content/projects](content/projects/)；各项目的来源和修改入口见 [内容导航](content/README.md) |
| 修改 Dataset 页面 | [content/datasets](content/datasets/)，每个数据集只有一个当前 `index.html` |
| 调整本地项目页面映射 | [content/collection.json](content/collection.json) 及项目内的 `project.json` |
| 修改首页、地图、卡片和共享导航 | [site](site/)、[lib](lib/)、[build.js](build.js) |
| 修改 Google Sheets / Drive 后台 | [google-apps-script](google-apps-script/README.md) |
| 生成 Workflow 或 Payload 报告 | [tools](tools/README.md) |
| 查操作方法、设计方案和历史记录 | [docs](docs/README.md) |
| 查旧版资料和整理记录 | 本地 `archive/` |

## 本地预览

需要 Node.js 24。已有本地内容时，在项目根目录运行：

```sh
node scripts/local-content.cjs verify
node build.js --local
node scripts/preview-local.cjs
```

打开 <http://127.0.0.1:4173/>。也可使用原有的 `npm run content:verify`、`npm run content:build` 和 `npm run content:preview`。

本地构建写入 `.local/site/`。修改源文件后重新构建；这里的生成网页不作为编辑源文件。Drive 刷新流程见 [本地内容指南](docs/guides/local-content-workflow.md)。

## 目录约定

- `content/`：当前项目、Dataset 与来源快照；本地内容由 Git 忽略。
- `tools/payload-dashboard/`：已纳入版本管理的 Payload Dashboard 生成工具。
- `tools/pipeline/`、`notebooks/`、`skills/`、`B3W1/`：本地科研与制作资料，保留在本机及备份中，不提交 GitHub；Demo 的 Notebook 和技能交付包另保存在 Drive。
- `.local/`：可再生成的网站、运行依赖、导入记录、检查结果和日志，由 Git 忽略。
- `dist/`：普通构建及 Netlify 的发布输出，继续由 `node build.js` 生成。
- `docs/`：`guides/` 操作说明、`references/` 合同与研究资料、`plans/` 设计方案、`history/` 历史记录。
- `archive/`：历史独有资料与去重索引，由 Git 忽略。

源码目录 `site/`、`lib/`、`scripts/`、`google-apps-script/`、`netlify/`、`test/` 和 `fixtures/` 保留原职责。项目编号和网页地址不随文件夹整理改变。

## 验证与发布

```sh
node --test --test-concurrency=1 test/*.test.js
```

线上构建继续读取 Drive / Registry。本地 `content/` 不会因预览自动发布。网站设置和 Preview / Production 操作见 [Registry 与发布指南](docs/guides/registry-setup.md)。
