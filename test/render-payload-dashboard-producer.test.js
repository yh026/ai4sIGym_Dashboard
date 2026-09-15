const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(__dirname, "..");
const kitRoot = join(repositoryRoot, "payload-dashboard-kit");
const cliPath = join(kitRoot, "scripts", "payload.mjs");
const corePath = join(kitRoot, "scripts", "lib", "payload-v3.mjs");
const compilerPath = join(kitRoot, "scripts", "render-dashboard.mjs");
const capabilitiesPath = join(kitRoot, "references", "capabilities-v3.json");
const templatePath = join(kitRoot, "templates", "generic-package", "payload.json");
const examples = [
  "generic-manufacturing",
  "generic-clinical",
  "generic-sales"
];

let core;
let compiler;

test.before(async () => {
  [core, compiler] = await Promise.all([
    import(pathToFileURL(corePath)),
    import(pathToFileURL(compilerPath))
  ]);
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runCli(args, options = {}) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || repositoryRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    ...result,
    receipt: options.text ? result.stdout.trim() : JSON.parse(result.stdout)
  };
}

async function allFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await allFiles(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("machine-readable capability catalog matches the closed core registries", async () => {
  const capabilities = await readJson(capabilitiesPath);
  assert.deepEqual(capabilities, core.getPayloadV3Capabilities());
  assert.equal(capabilities.schema_version, "3.0.0");
  assert.deepEqual(
    Object.keys(capabilities.marks).sort(),
    [...core.SUPPORTED_PRIMITIVE_MARKS].sort()
  );
  assert.deepEqual(capabilities.panel_types, [...core.SUPPORTED_PANEL_TYPES]);
  assert.deepEqual(capabilities.recipes, core.defaultRecipeRegistry.list());
  assert.deepEqual(Object.keys(capabilities.coordinates).sort(), ["canvas", "cartesian", "flow", "matrix", "tree"]);
  assert.deepEqual(capabilities.storage.formats, ["json", "jsonl"]);
  assert.deepEqual(capabilities.storage.compressions, ["none", "gzip"]);

  const cli = await runCli(["capabilities", "--json"]);
  assert.deepEqual(cli.receipt, capabilities);
  const human = await runCli(["capabilities"], { text: true });
  assert.match(human.receipt, /Presentation presets: generic, tess/);
  assert.match(human.receipt, /Marks: bar, line, point/);
});

test("domain-neutral starter and every generic example validate and compile offline", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-examples-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const entries = [
    ["starter", templatePath],
    ...examples.map((name) => [name, join(kitRoot, "examples", name, "payload.json")])
  ];

  for (const [name, payloadPath] of entries) {
    const payload = await readJson(payloadPath);
    const validation = core.validatePayloadV3(payload);
    assert.deepEqual(validation.errors, [], name);
    assert.equal(payload.theme.name, "generic", name);
    const outputPath = join(temporaryDirectory, `${name}.html`);
    const receipt = await compiler.buildDashboard({ inputPath: payloadPath, outputPath });
    assert.deepEqual(receipt.warnings, [], name);
    assert.ok(receipt.output_bytes > 0, name);
    assert.deepEqual(compiler.verifyStandaloneHtml(await readFile(outputPath, "utf8")), [], name);
  }
});

test("generic examples prove independent theme, locale, sidecar, and text-only section choices", async () => {
  const manufacturing = await readJson(join(kitRoot, "examples", "generic-manufacturing", "payload.json"));
  const clinical = await readJson(join(kitRoot, "examples", "generic-clinical", "payload.json"));
  const sales = await readJson(join(kitRoot, "examples", "generic-sales", "payload.json"));

  assert.equal(manufacturing.theme.mode, "light");
  assert.equal(manufacturing.presentation.locale, "en-US");
  assert.equal(manufacturing.data[0].storage.kind, "sidecar");
  assert.ok(manufacturing.sections.some((section) => section.figure_ids.length === 0));
  const manufacturingReceipt = await compiler.buildDashboard({
    inputPath: join(kitRoot, "examples", "generic-manufacturing", "payload.json"),
    validateOnly: true
  });
  assert.equal(manufacturingReceipt.sidecar_count, 1);
  assert.equal(manufacturingReceipt.section_count, 2);

  assert.equal(clinical.theme.mode, "dark");
  assert.equal(clinical.presentation.locale, "en-GB");
  assert.ok(clinical.theme.tokens);

  assert.equal(sales.theme.mode, "light");
  assert.equal(sales.presentation.locale, "zh-CN");
  assert.equal(sales.presentation.section_prefix, "步骤");
  const capabilityLabels = (await readJson(capabilitiesPath)).presentation.label_keys;
  assert.deepEqual(Object.keys(sales.presentation.labels).sort(), [...capabilityLabels].sort());
});

test("generic example trees contain no reference-domain identifiers", async () => {
  const forbidden = /(?:^|[^A-Za-z0-9])(tess|toi|nasa|ais5102)(?:$|[^A-Za-z0-9])/i;
  for (const name of examples) {
    const directory = join(kitRoot, "examples", name);
    for (const path of await allFiles(directory)) {
      if (path.endsWith(".html")) continue;
      const text = await readFile(path, "utf8");
      assert.doesNotMatch(text, forbidden, `${name}: ${path}`);
    }
  }
});

test("init copies a valid starter and refuses to overwrite a non-empty target", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-init-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const target = join(temporaryDirectory, "new-package");
  const initialized = await runCli(["init", target]);
  assert.equal(initialized.receipt.command, "init");
  assert.equal(initialized.receipt.created, target);
  const payload = await readJson(join(target, "payload.json"));
  assert.equal(payload.theme.name, "generic");
  assert.deepEqual(core.validatePayloadV3(payload).errors, []);

  await assert.rejects(
    () => runCli(["init", target]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /refuses to overwrite a non-empty directory/);
      return true;
    }
  );
});

test("sidecar command creates metadata and can safely update one data resource", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-sidecar-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const packageDirectory = join(temporaryDirectory, "package");
  await runCli(["init", packageDirectory]);
  const payloadPath = join(packageDirectory, "payload.json");
  const payload = await readJson(payloadPath);
  const rows = payload.data[0].storage.rows;
  const rawPath = join(packageDirectory, "raw.json");
  await writeFile(rawPath, `${JSON.stringify(rows)}\n`, "utf8");

  const generated = await runCli([
    "sidecar",
    "raw.json",
    "--payload", payloadPath,
    "--data-id", "category-values",
    "--output", "data/category-values.json",
    "--metadata", "data/category-values.storage.json",
    "--write"
  ]);
  assert.equal(generated.receipt.storage.kind, "sidecar");
  assert.equal(generated.receipt.storage.path, "data/category-values.json");
  assert.equal(generated.receipt.storage.format, "json");
  assert.equal(generated.receipt.storage.compression, "none");
  assert.equal(generated.receipt.storage.rows, rows.length);
  assert.match(generated.receipt.storage.sha256, /^[0-9a-f]{64}$/);
  assert.equal(generated.receipt.payload_updated, true);

  const updated = await readJson(payloadPath);
  assert.deepEqual(updated.data[0].storage, generated.receipt.storage);
  assert.deepEqual(await readJson(join(packageDirectory, "data", "category-values.storage.json")), generated.receipt.storage);
  const validated = await runCli(["validate", payloadPath]);
  assert.equal(validated.receipt.valid, true);
  assert.equal(validated.receipt.sidecar_count, 1);
});

test("sidecar rejects escaped writes and mismatched declared paths before creating files", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-containment-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const packageDirectory = join(temporaryDirectory, "package");
  await runCli(["init", packageDirectory]);
  const payloadPath = join(packageDirectory, "payload.json");
  const payload = await readJson(payloadPath);
  await writeFile(join(packageDirectory, "raw.json"), `${JSON.stringify(payload.data[0].storage.rows)}\n`, "utf8");

  const escapedOutput = join(temporaryDirectory, "escaped.json");
  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--payload", payloadPath,
      "--data-id", "category-values",
      "--output", "../escaped.json"
    ]),
    /inside the payload package/
  );
  assert.equal(await pathExists(escapedOutput), false);

  const escapedMetadata = join(temporaryDirectory, "escaped.storage.json");
  const safeOutput = join(packageDirectory, "data", "safe.json");
  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--payload", payloadPath,
      "--data-id", "category-values",
      "--output", "data/safe.json",
      "--metadata", "../escaped.storage.json"
    ]),
    /inside the payload package/
  );
  assert.equal(await pathExists(escapedMetadata), false);
  assert.equal(await pathExists(safeOutput), false);

  const actualOutput = join(packageDirectory, "data", "actual.json");
  const mismatchedOutput = join(packageDirectory, "data", "not-actual.json");
  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--payload", payloadPath,
      "--data-id", "category-values",
      "--output", "data/actual.json",
      "--path", "data/not-actual.json"
    ]),
    /--path must equal the actual package-relative output path/
  );
  assert.equal(await pathExists(actualOutput), false);
  assert.equal(await pathExists(mismatchedOutput), false);

  const outsideDirectory = join(temporaryDirectory, "outside");
  await mkdir(outsideDirectory);
  await symlink(outsideDirectory, join(packageDirectory, "linked-output"));
  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--payload", payloadPath,
      "--data-id", "category-values",
      "--output", "linked-output/escaped-through-symlink.json"
    ]),
    /inside the payload package after canonical resolution/
  );
  assert.equal(await pathExists(join(outsideDirectory, "escaped-through-symlink.json")), false);
});

test("sidecar command supports deterministic gzip JSONL output", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-jsonl-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const sourcePath = join(temporaryDirectory, "rows.jsonl");
  await writeFile(sourcePath, "{\"id\":1,\"value\":2}\n{\"id\":2,\"value\":4}\n", "utf8");
  await mkdir(join(temporaryDirectory, "data"));
  const result = await runCli([
    "sidecar",
    sourcePath,
    "--package-root", temporaryDirectory,
    "--format", "jsonl",
    "--compression", "gzip",
    "--output", "data/rows.jsonl.gz"
  ]);
  assert.equal(result.receipt.storage.format, "jsonl");
  assert.equal(result.receipt.storage.compression, "gzip");
  assert.equal(result.receipt.storage.rows, 2);
  const compressed = await readFile(join(temporaryDirectory, "data", "rows.jsonl.gz"));
  assert.match(gunzipSync(compressed).toString("utf8"), /"id":2/);
});

test("sidecar without a payload preserves package-root-relative paths", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-root-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await mkdir(join(temporaryDirectory, "data"));
  const rows = [{ id: 1, value: 2 }, { id: 2, value: 4 }];
  await writeFile(join(temporaryDirectory, "data", "rows.json"), `${JSON.stringify(rows)}\n`, "utf8");
  await writeFile(join(temporaryDirectory, "raw.json"), `${JSON.stringify(rows)}\n`, "utf8");

  const existing = await runCli(["sidecar", "data/rows.json"], { cwd: temporaryDirectory });
  assert.equal(existing.receipt.package_root, await realpath(temporaryDirectory));
  assert.equal(existing.receipt.storage.path, "data/rows.json");
  assert.equal(existing.receipt.output, join(await realpath(temporaryDirectory), "data", "rows.json"));

  const canonicalRoot = await realpath(temporaryDirectory);
  const aliasRoot = canonicalRoot.startsWith("/private/")
    ? canonicalRoot.slice("/private".length)
    : canonicalRoot;
  const aliasExisting = await runCli([
    "sidecar", join(aliasRoot, "data", "rows.json"),
    "--package-root", aliasRoot
  ]);
  assert.equal(aliasExisting.receipt.package_root, canonicalRoot);
  assert.equal(aliasExisting.receipt.storage.path, "data/rows.json");

  const aliasCopy = join(aliasRoot, "data", "alias-copy.json");
  const aliasOutput = await runCli([
    "sidecar", join(aliasRoot, "raw.json"),
    "--package-root", aliasRoot,
    "--output", aliasCopy
  ]);
  assert.equal(aliasOutput.receipt.storage.path, "data/alias-copy.json");
  assert.equal(await pathExists(join(canonicalRoot, "data", "alias-copy.json")), true);

  const copied = await runCli([
    "sidecar", "raw.json",
    "--package-root", temporaryDirectory,
    "--output", "data/copied.json"
  ]);
  assert.equal(copied.receipt.storage.path, "data/copied.json");
  assert.equal(await pathExists(join(temporaryDirectory, "data", "copied.json")), true);

  const escapedOutput = join(dirname(temporaryDirectory), "escaped-root.json");
  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--package-root", temporaryDirectory,
      "--output", "../escaped-root.json"
    ]),
    /inside the payload package/
  );
  assert.equal(await pathExists(escapedOutput), false);

  const mismatched = join(temporaryDirectory, "data", "mismatched.json");
  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--package-root", temporaryDirectory,
      "--output", "data/mismatched.json",
      "--path", "mismatched.json"
    ]),
    /--path must equal the actual package-relative output path/
  );
  assert.equal(await pathExists(mismatched), false);
});

test("render and sidecar refuse protected package files while dashboard overwrite remains legal", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-producer-protected-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const starterDirectory = join(temporaryDirectory, "starter");
  await runCli(["init", starterDirectory]);
  const starterPayload = join(starterDirectory, "payload.json");
  const originalPayload = await readFile(starterPayload);
  const starter = JSON.parse(originalPayload.toString("utf8"));
  await writeFile(join(starterDirectory, "raw.json"), `${JSON.stringify(starter.data[0].storage.rows)}\n`, "utf8");

  await assert.rejects(
    () => runCli(["render", starterPayload, "--output", "payload.json"]),
    /cannot overwrite payload\.json/
  );
  assert.deepEqual(await readFile(starterPayload), originalPayload);

  await assert.rejects(
    () => runCli([
      "sidecar", "raw.json",
      "--payload", starterPayload,
      "--data-id", "category-values",
      "--output", "payload.json",
      "--write"
    ]),
    /cannot overwrite payload\.json/
  );
  assert.deepEqual(await readFile(starterPayload), originalPayload);

  const dashboardPath = join(starterDirectory, "dashboard.html");
  const first = await runCli(["render", starterPayload]);
  const firstDashboard = await readFile(dashboardPath);
  const second = await runCli(["render", starterPayload]);
  const secondDashboard = await readFile(dashboardPath);
  assert.equal(first.receipt.rendered, true);
  assert.equal(second.receipt.rendered, true);
  assert.deepEqual(secondDashboard, firstDashboard);

  const sidecarDirectory = join(temporaryDirectory, "sidecar-package");
  await mkdir(join(sidecarDirectory, "data"), { recursive: true });
  const manufacturingDirectory = join(kitRoot, "examples", "generic-manufacturing");
  const sidecarPayload = join(sidecarDirectory, "payload.json");
  const sidecarPath = join(sidecarDirectory, "data", "quality-summary.json");
  await writeFile(sidecarPayload, await readFile(join(manufacturingDirectory, "payload.json")));
  await writeFile(sidecarPath, await readFile(join(manufacturingDirectory, "data", "quality-summary.json")));
  const originalSidecar = await readFile(sidecarPath);

  await assert.rejects(
    () => runCli(["render", sidecarPayload, "--output", "data/quality-summary.json"]),
    /cannot overwrite declared sidecar "quality-summary"/
  );
  assert.deepEqual(await readFile(sidecarPath), originalSidecar);
  assert.deepEqual(JSON.parse(await readFile(sidecarPayload, "utf8")), await readJson(join(manufacturingDirectory, "payload.json")));
});

test("conformance emits a machine-readable receipt without leaving an artifact", async () => {
  const payloadPath = join(kitRoot, "examples", "generic-sales", "payload.json");
  const dashboardPath = join(dirname(payloadPath), "dashboard.html");
  const before = (await readdir(dirname(payloadPath))).sort();
  const existingDashboard = await pathExists(dashboardPath) ? await readFile(dashboardPath) : null;
  const existingHash = existingDashboard
    ? createHash("sha256").update(existingDashboard).digest("hex")
    : null;
  const result = await runCli(["conformance", payloadPath]);
  assert.equal(result.receipt.command, "conformance");
  assert.equal(result.receipt.conformant, true);
  assert.equal(result.receipt.validation.strict, true);
  assert.equal(result.receipt.offline.single_html, true);
  assert.deepEqual(result.receipt.offline.external_resource_errors, []);
  assert.match(result.receipt.offline.output_sha256, /^[0-9a-f]{64}$/);
  const after = (await readdir(dirname(payloadPath))).sort();
  assert.deepEqual(after, before, "conformance must not add or remove package artifacts");
  if (existingDashboard) {
    const preservedDashboard = await readFile(dashboardPath);
    assert.deepEqual(preservedDashboard, existingDashboard);
    assert.equal(createHash("sha256").update(preservedDashboard).digest("hex"), existingHash);
  } else {
    assert.equal(await pathExists(dashboardPath), false);
  }
});
