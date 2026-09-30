const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const kitRoot = join(repositoryRoot, "payload-dashboard-kit");
const rendererPath = join(kitRoot, "scripts", "render-dashboard.mjs");
const minimalPayloadPath = join(kitRoot, "references", "minimal.payload.json");
const realPayloadPath = join(repositoryRoot, "payloads", "payload.json");

let renderer;

test.before(async () => {
  renderer = await import(pathToFileURL(rendererPath));
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("minimal reference payload satisfies the contract", async () => {
  const payload = await readJson(minimalPayloadPath);
  const validation = renderer.validatePayload(payload);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.manifest.act_count, 1);
  assert.equal(validation.manifest.stage_count, 1);
  assert.equal(validation.manifest.artifact_count, 1);
  assert.equal(validation.manifest.artifact_kinds.distribution, 1);
});

test("unknown artifact kinds fail closed with a JSON-pointer location", async () => {
  const payload = await readJson(minimalPayloadPath);
  payload.stages[0].artifacts[0].kind = "surprise_chart";

  const validation = renderer.validatePayload(payload);

  assert.match(validation.errors.join("\n"), /\/stages\/0\/artifacts\/0\/kind: unsupported artifact kind surprise_chart/);
});

test("unsupported schema versions require an explicit adapter", async () => {
  const payload = await readJson(minimalPayloadPath);
  payload.schema_version = "4.0.0";

  const validation = renderer.validatePayload(payload);

  assert.match(validation.errors.join("\n"), /\/schema_version: unsupported schema version 4\.0\.0; expected 2\.2\.x/);
});

test("real TESS payload validates all supported artifacts", async () => {
  const summary = await renderer.buildDashboard({ inputPath: realPayloadPath, validateOnly: true });

  assert.equal(summary.schema_version, "2.2.0");
  assert.equal(summary.act_count, 2);
  assert.equal(summary.stage_count, 8);
  assert.equal(summary.artifact_count, 24);
  assert.deepEqual(summary.artifact_kinds, {
    distribution: 5,
    matrix: 6,
    curve: 7,
    predictions: 4,
    assignments: 1,
    tree_structure: 1
  });
  assert.ok(summary.warnings.some((warning) => warning.includes("rf-reliability")));
});

test("build is deterministic, standalone, and safely embeds hostile text", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-dashboard-test-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const payload = await readJson(minimalPayloadPath);
  const hostileText = "</script><script>alert(1)</script>";
  payload.header.title = `Safe ${hostileText}`;
  payload.stages[0].summary = `**Result:** ${hostileText}`;

  const inputPath = join(temporaryDirectory, "payload.json");
  const firstOutput = join(temporaryDirectory, "first.html");
  const secondOutput = join(temporaryDirectory, "second.html");
  await writeFile(inputPath, JSON.stringify(payload), "utf8");

  const first = await renderer.buildDashboard({ inputPath, outputPath: firstOutput });
  const second = await renderer.buildDashboard({ inputPath, outputPath: secondOutput });
  const html = await readFile(firstOutput, "utf8");

  assert.equal(first.output_sha256, second.output_sha256);
  assert.equal(html, await readFile(secondOutput, "utf8"));
  assert.deepEqual(renderer.verifyStandaloneHtml(html), []);
  assert.ok(!html.includes(hostileText));
  assert.ok(html.includes("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"));
  assert.ok(!/<script\b[^>]*\bsrc\s*=/i.test(html));
  assert.ok(!/<link\b[^>]*\bhref\s*=/i.test(html));
});
