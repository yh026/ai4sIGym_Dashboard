# 生成工具

| 工具 | 入口 | 用途 |
| --- | --- | --- |
| [Payload Dashboard](payload-dashboard/README.md) | `node tools/payload-dashboard/render.mjs` | 从 JSON payload 与 sidecar 数据生成单文件离线报告 |

Workflow Pipeline 保留在本机的 `tools/pipeline/`，不随本仓库提交。其 `review/` 链接指向本机 `.local/reviews/pipeline/`。旧审查记录保留原始路径和哈希，不自动代表移动后重新取得的审批。

Payload 的旧版 2.2 示例移入 [examples/legacy-v2](payload-dashboard/examples/legacy-v2/README.md)。`.agents` 和 `.claude` 的技能链接仍指向当前工具源码。

从项目根目录生成一个示例报告：

```sh
node tools/payload-dashboard/render.mjs \
  --input tools/payload-dashboard/examples/generic-manufacturing/payload.json \
  --output .local/exports/manufacturing.html
```
