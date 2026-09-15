const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = resolve(__dirname, "..");
const kitRoot = join(repositoryRoot, "payload-dashboard-kit");
const runtimePath = join(kitRoot, "assets", "dashboard-runtime-v3.js");
const cssPath = join(kitRoot, "assets", "dashboard.css");
const compilerPath = join(kitRoot, "scripts", "render-dashboard.mjs");
const fixturePath = join(kitRoot, "references", "payload-v3-pca.fixture.json");

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.style = {
      setProperty: (name, value) => { this.style[name] = String(value); }
    };
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force === true) classes.add(name);
        else if (force === false) classes.delete(name);
        else if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      }
    };
  }

  get childElementCount() { return this.children.filter((child) => child instanceof FakeNode).length; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function runtimeHooks(payload) {
  const source = require("node:fs").readFileSync(runtimePath, "utf8");
  const marker = "  try {\n    buildDashboard();";
  const markerIndex = source.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, "runtime build marker");
  const instrumented = `${source.slice(0, markerIndex)}
  globalThis.__genericRuntimeHooks = {
    resolvePresentation,
    themeTokenVariables,
    formatNumber,
    createHero,
    createSectionPanel,
    renderFigure
  };
})();`;
  const nodes = {
    "dashboard-payload": { textContent: JSON.stringify(payload) },
    "dashboard-build-meta": { textContent: "{}" },
    "dashboard-root": {}
  };
  const context = {
    document: {
      getElementById: (id) => nodes[id],
      createElement: (tagName) => new FakeNode(tagName),
      createTextNode: (textContent) => ({ textContent: String(textContent) }),
      createElementNS: (_namespace, tagName) => new FakeNode(tagName)
    }
  };
  vm.runInNewContext(instrumented, context, { filename: runtimePath });
  return context.__genericRuntimeHooks;
}

function flattenNodes(node) {
  if (!(node instanceof FakeNode)) return [];
  return [node, ...node.children.flatMap(flattenNodes)];
}

function nodeText(node) {
  if (node == null) return "";
  const own = node.textContent == null ? "" : String(node.textContent);
  const children = Array.isArray(node.children) ? node.children.map(nodeText).join("") : "";
  return `${own}${children}`;
}

function baseRuntimePayload(themeName, presentation = undefined) {
  return {
    schema_version: "3.0.0",
    data: [],
    figures: [],
    sections: [],
    theme: { name: themeName, mode: "light", palette: "colorblind-safe" },
    ...(presentation === undefined ? {} : { presentation })
  };
}

test("generic and TESS presentation defaults remain intentionally different", () => {
  const generic = runtimeHooks(baseRuntimePayload("generic"));
  const genericDefaults = generic.resolvePresentation(baseRuntimePayload("generic"));
  assert.equal(genericDefaults.sectionPrefix, "Section");
  assert.equal(genericDefaults.showFigureTitles, true);
  assert.equal(genericDefaults.showFigureDescriptions, true);

  const tessDefaults = generic.resolvePresentation(baseRuntimePayload("tess"));
  assert.equal(tessDefaults.sectionPrefix, "Stage");
  assert.equal(tessDefaults.locale, "en");
  assert.equal(tessDefaults.showFigureTitles, false);
  assert.equal(tessDefaults.showFigureDescriptions, false);
});

test("locale drives number formatting and presentation labels drive section chrome", () => {
  const payload = baseRuntimePayload("generic", {
    locale: "de-DE",
    section_prefix: "Schritt",
    labels: { figures: "Diagramme", top: "nach oben" }
  });
  const hooks = runtimeHooks(payload);
  assert.equal(hooks.formatNumber(1234, "integer"), new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(1234));
  assert.equal(hooks.formatNumber(0.014, ".1%"), new Intl.NumberFormat("de-DE", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(0.014));
  assert.equal(hooks.formatNumber(1.2345, ".2f"), new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(1.2345));

  const panel = hooks.createSectionPanel({ id: "intro", title: "Einführung", summary: "Text only.", figure_refs: [] }, 0);
  const nodes = flattenNodes(panel);
  assert.ok(nodes.some((node) => node.className === "stage-number" && node.textContent === "Schritt 01"));
  assert.ok(nodes.some((node) => node.className === "stage-badge" && node.textContent === "0 Diagramme"));
  assert.equal(nodes.some((node) => node.className.includes("v3-section-figures")), false, "text-only section must not append an empty figure grid");
});

test("independent report and section semantic roles are all rendered", () => {
  const payload = {
    ...baseRuntimePayload("generic"),
    report: {
      title: "Operations report",
      summary: "Summary content",
      claim: "Claim content",
      final_verdict: "Verdict content"
    }
  };
  const hooks = runtimeHooks(payload);
  const heroShell = new FakeNode("main");
  hooks.createHero(heroShell);
  const heroText = nodeText(heroShell);
  assert.match(heroText, /Summary content/);
  assert.match(heroText, /Claim content/);
  assert.match(heroText, /Verdict content/);

  const section = hooks.createSectionPanel({
    id: "review",
    title: "Review",
    concepts: ["Declared concept"],
    summary: "Declared section summary",
    figure_refs: []
  }, 0);
  const sectionText = nodeText(section);
  assert.match(sectionText, /Declared concept/);
  assert.match(sectionText, /Declared section summary/);
});

test("theme tokens map only to controlled CSS variables", () => {
  const hooks = runtimeHooks(baseRuntimePayload("generic"));
  const variables = hooks.themeTokenVariables({
    accent: "#123456",
    accent_contrast: "#FFFFFF",
    surface: "#202020",
    radius: 12,
    max_width: 1440,
    arbitrary_css: "display:none"
  });
  assert.equal(variables["--blue"], "#123456");
  assert.equal(variables["--accent-contrast"], "#FFFFFF");
  assert.equal(variables["--panel"], "#202020");
  assert.equal(variables["--card"], "#202020");
  assert.equal(variables["--radius"], "12px");
  assert.equal(variables["--shell-max-width"], "1440px");
  assert.equal(Object.values(variables).includes("display:none"), false);
});

test("generic dark CSS includes readable theme variables and effective density classes", async () => {
  const css = await readFile(cssPath, "utf8");
  assert.match(css, /html\.dashboard-mode-dark\s*\{/);
  assert.match(css, /--ink:\s*#f1f4f7/);
  assert.match(css, /--line:\s*#343d49/);
  assert.match(css, /\.density-compact \.panel-head/);
  assert.match(css, /width:\s*min\(var\(--shell-max-width\)/);
});

test("compiler safely injects locale and localized noscript text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "payload-generic-runtime-"));
  try {
    const payload = JSON.parse(await readFile(fixturePath, "utf8"));
    payload.theme = {
      ...payload.theme,
      name: "generic",
      mode: "dark",
      density: "compact",
      tokens: {
        accent: "#5AA9E6",
        accent_contrast: "#081018",
        background: "#0D1117",
        surface: "#161B22",
        surface_muted: "#21262D",
        text: "#F0F3F6",
        muted_text: "#A7B1BC",
        border: "#30363D",
        radius: 10,
        max_width: 1320
      }
    };
    payload.presentation = {
      locale: "zh-CN",
      section_prefix: "步骤",
      show_section_numbers: true,
      show_figure_titles: true,
      show_figure_descriptions: true,
      show_coverage: false,
      show_build_footer: false,
      labels: {
        javascript_required: "请启用 JavaScript & 继续",
        fold_all: "全部折叠",
        unfold_all: "全部展开",
        figures: "张图"
      }
    };
    const inputPath = join(directory, "payload.json");
    const outputPath = join(directory, "dashboard.html");
    await writeFile(inputPath, `${JSON.stringify(payload)}\n`, "utf8");
    const { buildDashboard } = await import(pathToFileURL(compilerPath));
    const receipt = await buildDashboard({ inputPath, outputPath });
    assert.equal(receipt.warnings.length, 0);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /<noscript>请启用 JavaScript &amp; 继续<\/noscript>/);
    assert.doesNotMatch(html, /__DASHBOARD_[A-Z_]+__/);
    assert.match(html, /"theme":\{"density":"compact","mode":"dark","name":"generic"/);
    assert.match(html, /"presentation":\{"labels":/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
