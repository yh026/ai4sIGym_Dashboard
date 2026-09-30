const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const skillRoot = join(repositoryRoot, "payload-dashboard-kit");
const corePath = join(skillRoot, "scripts", "lib", "payload-v3.mjs");
const fixturePath = join(skillRoot, "references", "payload-v3-pca.fixture.json");

let core;
let fixture;

test.before(async () => {
  core = await import(pathToFileURL(corePath));
  fixture = JSON.parse(await readFile(fixturePath, "utf8"));
});

function payloadCopy() {
  return structuredClone(fixture);
}

test("v3 shell content, acts, weighted columns, and panel display normalize without loss", () => {
  const payload = payloadCopy();
  Object.assign(payload.sections[0], {
    badge: "Ch 08",
    concepts: ["**Ch 08** scree plot · cumulative explained variance"],
    findings: ["Five components retain **91%** of the declared variance."],
    method_notes: [
      { kind: "minimises", text: "squared reconstruction error" },
      { kind: "reports", text: "explained variance and covariance residuals" }
    ],
    caveats: [
      "The fixture values are illustrative.",
      { kind: "scope", text: "The conclusion applies only to this declared cohort." }
    ]
  });
  payload.acts = [{
    id: "act-reduce",
    numeral: "II",
    title: "Reduce",
    short_label: "Act II",
    section_ids: ["pca-section"]
  }];
  payload.figures[0].layout = {
    type: "grid",
    columns: 3,
    rows: 3,
    column_weights: [1.2, 1, 0.8],
    gap: 16
  };
  payload.figures[0].panels[0].display = {
    aspect_ratio: 1.65,
    column_span: 2,
    row_span: 1
  };

  const validation = core.validatePayloadV3(payload);
  assert.deepEqual(validation.errors, []);
  const normalized = core.normalizePayloadV3(payload, { validation });
  assert.deepEqual(normalized.acts, payload.acts);
  assert.equal(normalized.sections[0].badge, "Ch 08");
  assert.deepEqual(normalized.sections[0].method_notes, payload.sections[0].method_notes);
  assert.deepEqual(normalized.figures[0].layout.column_weights, [1.2, 1, 0.8]);
  assert.deepEqual(normalized.figures[0].panels[0].display, payload.figures[0].panels[0].display);
});

test("existing 3.0 payloads remain valid without optional shell fields", () => {
  const validation = core.validatePayloadV3(payloadCopy());
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(core.normalizePayloadV3(payloadCopy(), { validation }).acts, []);
});

test("acts fail closed on unknown and unassigned section references", () => {
  const payload = payloadCopy();
  payload.acts = [{ id: "bad-act", title: "Bad", section_ids: ["missing-section"] }];
  const validation = core.validatePayloadV3(payload);
  assert.ok(validation.errors.some((error) => error.code === "unknown_section_reference" && error.path === "/acts/0/section_ids/0"));
  assert.ok(validation.errors.some((error) => error.code === "unassigned_act_section" && error.path === "/acts"));
});

test("method notes, weighted columns, and panel spans fail closed", () => {
  const duplicateMethod = payloadCopy();
  duplicateMethod.sections[0].method_notes = [
    { kind: "reports", text: "first" },
    { kind: "reports", text: "second" }
  ];
  assert.ok(core.validatePayloadV3(duplicateMethod).errors.some((error) => error.code === "duplicate_method_note"));

  const badWeights = payloadCopy();
  badWeights.figures[0].layout.column_weights = [1, 1];
  assert.ok(core.validatePayloadV3(badWeights).errors.some((error) => error.code === "column_weight_count"));

  const badSpan = payloadCopy();
  badSpan.figures[0].panels[0].display = { column_span: 4 };
  assert.ok(core.validatePayloadV3(badSpan).errors.some((error) => error.code === "column_span_exceeds_layout"));

  const unknownDisplay = payloadCopy();
  unknownDisplay.figures[0].panels[0].display = { css: "grid-column: 1 / -1" };
  assert.ok(core.validatePayloadV3(unknownDisplay).errors.some((error) =>
    error.code === "schema_additional_property" && error.path === "/figures/0/panels/0/display/css"
  ));

});
