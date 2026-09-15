# Payload dashboard kit

A dependency-free Node.js 24 renderer and producer CLI for declarative,
standalone HTML dashboards. It accepts Payload v3 packages and legacy 2.2
payloads. This tool is separate from the Drive/Registry website build.

From the repository root:

```sh
node payload-dashboard-kit/scripts/payload.mjs init local-content/new-report
node payload-dashboard-kit/scripts/payload.mjs validate local-content/new-report/payload.json
node payload-dashboard-kit/scripts/payload.mjs render local-content/new-report/payload.json
node payload-dashboard-kit/scripts/payload.mjs conformance local-content/new-report/payload.json
```

The package contains `payload.json` and any declared data sidecars. Rendering
validates field types, references, supported visual operations, sidecar hashes
and file containment before emitting one offline HTML file.

- [Producer guide](PRODUCER_GUIDE.md): package creation and CLI commands.
- [Payload v3 contract](references/payload-v3-contract.md): supported structure.
- [Renderer authoring](references/renderer-authoring.md): implementation guide.
- [Examples](examples/): small generic packages and TESS reference inputs.
- [Skill instructions](SKILL.md): optional agent workflow, exposed through
  relative directory links in `.agents/skills` and `.claude/skills`.

Run all tests from the repository root with `node --test --test-concurrency=1`.
Tests import the kit directly and generate HTML in temporary directories, so
they do not depend on an agent's skill directory or prebuilt dashboard files.

Keep source code, templates, schema files, payloads and verified example
sidecars in Git. Generated HTML, `input/`, `output/`, and delivery ZIPs are
local artifacts. The optional TESS Python analysis requires an explicitly
provided source CSV and its scientific environment; it is not needed to render
the included payloads or run Node tests.
