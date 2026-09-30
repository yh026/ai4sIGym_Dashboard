(() => {
  "use strict";

  const payloadNode = document.getElementById("dashboard-payload");
  const metaNode = document.getElementById("dashboard-build-meta");
  const root = document.getElementById("dashboard-root");
  const payload = JSON.parse(payloadNode.textContent);
  const buildMeta = JSON.parse(metaNode.textContent);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULT_PALETTE = ["#2f63b5", "#df6400", "#00ae7a", "#cf4f8b", "#e7b400", "#8c96a5", "#6f54a5", "#56a9d8"];
  const NAMED_PALETTES = Object.freeze({
    "colorblind-safe": DEFAULT_PALETTE,
    scientific: ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#6f54a5", "#56a9d8", "#cf4f8b"]
  });
  const COLORS = { ink: "#16181d", muted: "#6d7480", grid: "#dfe3e8", axis: "#9aa1ab", surface: "#ffffff" };
  const DEFAULT_LABELS = Object.freeze({
    fold_all: "Fold all",
    unfold_all: "Unfold all",
    report_claim: "Report claim",
    coverage: "Coverage",
    concepts_used: "Concepts used",
    reports: "Reports",
    minimises: "Minimises",
    uses: "Uses",
    produces: "Produces",
    note: "Note",
    top: "top ↑",
    javascript_required: "This dashboard requires JavaScript for its accordion and inline SVG charts.",
    standalone_package: "Standalone visualization package",
    schema: "schema",
    figures: "figures",
    seed: "seed",
    payload_sha256: "payload sha256",
    renderer: "renderer",
    reset: "Reset",
    status_pass: "pass",
    status_warn: "warn",
    status_fail: "fail",
    status_not_applicable: "not applicable"
  });

  function resolvePresentation(payloadValue = payload) {
    const themeName = payloadValue.theme?.name === "generic" ? "generic" : "tess";
    const declared = payloadValue.presentation || {};
    return Object.freeze({
      locale: declared.locale || "en",
      sectionPrefix: declared.section_prefix ?? (themeName === "tess" ? "Stage" : "Section"),
      showSectionNumbers: declared.show_section_numbers ?? true,
      showFigureTitles: declared.show_figure_titles ?? (themeName !== "tess"),
      showFigureDescriptions: declared.show_figure_descriptions ?? (themeName !== "tess"),
      showCoverage: declared.show_coverage ?? true,
      showBuildFooter: declared.show_build_footer ?? true,
      labels: Object.freeze({ ...DEFAULT_LABELS, ...(declared.labels || {}) }),
      themeName
    });
  }

  const presentation = resolvePresentation();
  const labels = presentation.labels;
  const numberFormatters = new Map();

  function localizedNumber(value, options) {
    const key = JSON.stringify(options || {});
    if (!numberFormatters.has(key)) numberFormatters.set(key, new Intl.NumberFormat(presentation.locale, options));
    return numberFormatters.get(key).format(value);
  }

  function themeTokenVariables(tokens = {}) {
    const variables = {};
    const assign = (key, ...names) => {
      if (tokens[key] === undefined) return;
      names.forEach((name) => { variables[name] = tokens[key]; });
    };
    assign("accent", "--blue", "--blue-dark");
    assign("accent_contrast", "--accent-contrast");
    assign("background", "--paper");
    assign("surface", "--panel", "--card", "--nav-bg");
    assign("surface_muted", "--panel-2");
    assign("text", "--ink");
    assign("muted_text", "--muted", "--faint");
    assign("border", "--line", "--line-strong");
    if (tokens.radius !== undefined) variables["--radius"] = `${tokens.radius}px`;
    if (tokens.max_width !== undefined) variables["--shell-max-width"] = `${tokens.max_width}px`;
    return variables;
  }

  function applyTheme(shell) {
    const theme = payload.theme || {};
    const mode = theme.mode === "dark" ? "dark" : "light";
    const density = theme.density === "compact" ? "compact" : "comfortable";
    shell.classList.add(`theme-${presentation.themeName}`, `mode-${mode}`, `density-${density}`);
    document.documentElement.lang = presentation.locale;
    document.documentElement.classList.toggle("dashboard-mode-dark", mode === "dark");
    document.documentElement.classList.toggle("dashboard-mode-light", mode !== "dark");
    const variables = themeTokenVariables(theme.tokens);
    for (const [name, value] of Object.entries(variables)) {
      document.documentElement.style.setProperty(name, value);
      shell.style.setProperty(name, value);
    }
    const computed = getComputedStyle(document.documentElement);
    const color = (name, fallback) => computed.getPropertyValue(name).trim() || fallback;
    COLORS.ink = color("--ink", COLORS.ink);
    COLORS.muted = color("--muted", COLORS.muted);
    COLORS.grid = color("--line", COLORS.grid);
    COLORS.axis = color("--faint", COLORS.axis);
    COLORS.surface = color("--card", COLORS.surface);
  }
  const dataCatalog = Array.isArray(payload.data)
    ? new Map(payload.data.map((entry) => [entry.id, entry]))
    : new Map(Object.entries(payload.data || {}));

  function htmlElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgElement(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function append(parent, ...children) {
    for (const child of children.flat()) if (child !== undefined && child !== null) parent.append(child);
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function formatNumber(value, format) {
    if (!finite(value)) return String(value ?? "—");
    if (format === "none") return "";
    const fixedPercent = typeof format === "string" ? format.match(/^\.(\d+)%$/) : null;
    if (fixedPercent) {
      const digits = Number(fixedPercent[1]);
      return localizedNumber(value, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    const fixedDecimal = typeof format === "string" ? format.match(/^\.(\d+)f$/) : null;
    if (fixedDecimal) {
      const digits = Number(fixedDecimal[1]);
      return localizedNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    if (format === "percent") {
      const digits = Math.abs(value) < 0.01 ? 2 : 1;
      return localizedNumber(value, { style: "percent", minimumFractionDigits: digits === 2 ? 2 : 0, maximumFractionDigits: digits });
    }
    if (format === "integer") return localizedNumber(value, { maximumFractionDigits: 0 });
    if (format === "scientific") return localizedNumber(value, { notation: "scientific", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const absolute = Math.abs(value);
    if (absolute >= 1000) return localizedNumber(value, { maximumFractionDigits: 0 });
    if (absolute === 0) return "0";
    if (absolute < 0.001) return localizedNumber(value, { notation: "scientific", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (absolute < 1) return localizedNumber(value, { maximumFractionDigits: 3 });
    return localizedNumber(value, { maximumFractionDigits: 2 });
  }

  function formatTemporalValue(value, format = "date", utc = false) {
    if (format === "none") return "";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value ?? "—");
    const options = format === "datetime"
      ? { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "2-digit" };
    if (utc) options.timeZone = "UTC";
    return new Intl.DateTimeFormat(presentation.locale, options).format(date);
  }

  function formatValue(value, format, options = {}) {
    if (format === "date" || format === "datetime") return formatTemporalValue(value, format, options.utc === true);
    return formatNumber(value, format);
  }

  function formatLogTick(value) {
    if (!(value > 0)) return formatNumber(value);
    const exponent = Math.log10(value);
    if (Math.abs(exponent - Math.round(exponent)) > 1e-10) return formatNumber(value);
    const superscript = String(Math.round(exponent)).replace(/./g, (character) => ({
      "-": "\u207b", "0": "\u2070", "1": "\u00b9", "2": "\u00b2", "3": "\u00b3", "4": "\u2074",
      "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079"
    })[character]);
    return Math.round(exponent) === 0 ? "1" : `10${superscript}`;
  }

  function resolvePalette(requested) {
    if (requested === undefined || requested === null) return DEFAULT_PALETTE;
    if (Array.isArray(requested) && requested.length) return requested;
    if (typeof requested === "string" && NAMED_PALETTES[requested]) return NAMED_PALETTES[requested];
    throw new Error(`Unknown or empty colour palette: ${String(requested)}`);
  }

  function appendInlineMarkdown(parent, source) {
    const text = String(source ?? "");
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      parent.append(htmlElement(token.startsWith("**") ? "strong" : "code", "", token.slice(token.startsWith("**") ? 2 : 1, token.startsWith("**") ? -2 : -1)));
      cursor = match.index + token.length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function markdownParagraph(source, className = "") {
    const paragraph = htmlElement("p", className);
    appendInlineMarkdown(paragraph, source);
    return paragraph;
  }

  function createSvg(width, height, label) {
    return svgElement("svg", {
      class: "chart-svg v3-chart-svg",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": label || "Scientific chart",
      preserveAspectRatio: "xMidYMid meet"
    });
  }

  function firstFitGridPlacements(panels, columns) {
    if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error(`Invalid grid column count: ${String(columns)}`);
    const occupied = [];
    const placements = [];
    for (const panel of panels || []) {
      const display = panel?.display && typeof panel.display === "object" ? panel.display : {};
      const columnSpan = display.column_span ?? 1;
      const rowSpan = display.row_span ?? 1;
      if (!Number.isInteger(columnSpan) || columnSpan < 1 || columnSpan > columns) {
        throw new Error(`Panel column_span ${String(columnSpan)} does not fit ${columns} grid columns`);
      }
      if (!Number.isInteger(rowSpan) || rowSpan < 1 || rowSpan > 24) {
        throw new Error(`Invalid panel row_span: ${String(rowSpan)}`);
      }
      let placement = null;
      for (let row = 0; row <= occupied.length && !placement; row += 1) {
        for (let column = 0; column + columnSpan <= columns && !placement; column += 1) {
          let available = true;
          for (let rowOffset = 0; rowOffset < rowSpan && available; rowOffset += 1) {
            for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
              if (occupied[row + rowOffset]?.[column + columnOffset]) {
                available = false;
                break;
              }
            }
          }
          if (available) placement = { row: row + 1, column: column + 1, rowSpan, columnSpan };
        }
      }
      if (!placement) throw new Error("Unable to place panel in the declared grid");
      while (occupied.length < placement.row - 1 + rowSpan) occupied.push(Array(columns).fill(false));
      for (let row = placement.row - 1; row < placement.row - 1 + rowSpan; row += 1) {
        for (let column = placement.column - 1; column < placement.column - 1 + columnSpan; column += 1) occupied[row][column] = true;
      }
      placements.push(placement);
    }
    return { placements, requiredRows: occupied.length };
  }

  function panelGridPlacement(panel, figure) {
    const layout = figure?.layout || {};
    if ((layout.type || "grid") !== "grid") return null;
    const columns = layout.columns ?? 1;
    const result = firstFitGridPlacements(figure?.panels || [], columns);
    if (Number.isInteger(layout.rows) && result.requiredRows > layout.rows) {
      throw new Error(`Grid requires ${result.requiredRows} rows but layout declares ${layout.rows}`);
    }
    const panelIndex = (figure?.panels || []).indexOf(panel);
    if (panelIndex < 0 || !result.placements[panelIndex]) throw new Error("Panel is not present in its figure grid");
    return result.placements[panelIndex];
  }

  function panelRenderWidth(panel, figure, fallback = 620) {
    if (finite(panel.display?.width) && panel.display.width > 0) return panel.display.width;
    const layout = figure?.layout || {};
    if ((layout.type || "grid") !== "grid") return fallback;
    const columns = layout.columns ?? 1;
    const placement = panelGridPlacement(panel, figure);
    const gap = finite(layout.column_gap) ? layout.column_gap : finite(layout.gap) ? layout.gap : 16;
    const available = Math.max(240, 1060 - gap * (columns - 1));
    const weights = Array.isArray(layout.column_weights)
      && layout.column_weights.length === columns
      && layout.column_weights.every((weight) => finite(weight) && weight > 0)
      ? layout.column_weights
      : Array.from({ length: columns }, () => 1);
    const columnIndex = placement.column - 1;
    const columnSpan = placement.columnSpan;
    const allocatedWeight = weights.slice(columnIndex, columnIndex + columnSpan).reduce((sum, weight) => sum + weight, 0);
    const allocated = available * allocatedWeight / weights.reduce((sum, weight) => sum + weight, 0)
      + gap * (columnSpan - 1);
    return Math.max(180, Math.floor(allocated));
  }

  function panelRenderHeight(panel, width, fallback) {
    if (finite(panel.display?.height) && panel.display.height > 0) return panel.display.height;
    if (finite(panel.display?.aspect_ratio) && panel.display.aspect_ratio > 0) {
      return Math.max(100, Math.min(1200, Math.round(width / panel.display.aspect_ratio)));
    }
    return fallback;
  }

  function addText(svg, x, y, value, attrs = {}) {
    const node = svgElement("text", { x, y, fill: COLORS.muted, "font-size": 11, ...attrs });
    node.textContent = String(value ?? "");
    svg.append(node);
    return node;
  }

  function dataEntry(reference) {
    const entry = dataCatalog.get(reference);
    if (!entry) throw new Error(`Unknown data_ref: ${reference}`);
    return entry;
  }

  const rowCache = new Map();
  function rowsFor(reference) {
    if (!reference) return [];
    if (rowCache.has(reference)) return rowCache.get(reference);
    const entry = dataEntry(reference);
    const storage = entry.storage || {};
    const value = storage.values ?? storage.rows ?? entry.values ?? entry.rows ?? entry.inline;
    let rows;
    if (Array.isArray(value)) {
      if (value.every((item) => item && typeof item === "object" && !Array.isArray(item))) rows = value.map((item) => ({ ...item }));
      else {
        const fields = (entry.fields || []).map((field) => field.name);
        rows = value.map((item) => Array.isArray(item) ? Object.fromEntries(fields.map((field, index) => [field, item[index]])) : { value: item });
      }
    } else if (value && typeof value === "object") {
      const columns = Object.keys(value);
      const length = Math.max(0, ...columns.map((column) => Array.isArray(value[column]) ? value[column].length : 0));
      rows = Array.from({ length }, (_, index) => Object.fromEntries(columns.map((column) => [column, value[column]?.[index]])));
    } else {
      throw new Error(`Data source ${reference} is not inlined in the compiled payload`);
    }
    rowCache.set(reference, rows);
    return rows;
  }

  function applyTransforms(rows, transforms = []) {
    let result = rows;
    for (const transform of transforms) {
      const operation = transform.type || transform.op;
      if (operation === "filter") {
        const predicate = transform.predicate || (transform.op && transform.op !== "filter" ? { [transform.op]: transform.value } : {});
        result = result.filter((row) => {
          const value = row[transform.field];
          if (Object.hasOwn(predicate, "eq")) return value === predicate.eq;
          if (Object.hasOwn(predicate, "neq")) return value !== predicate.neq;
          if (Array.isArray(predicate.in)) return predicate.in.includes(value);
          if (Array.isArray(predicate.not_in)) return !predicate.not_in.includes(value);
          if (Object.hasOwn(predicate, "lt")) return value < predicate.lt;
          if (Object.hasOwn(predicate, "lte")) return value <= predicate.lte;
          if (Object.hasOwn(predicate, "gt")) return value > predicate.gt;
          if (Object.hasOwn(predicate, "gte")) return value >= predicate.gte;
          if (Object.hasOwn(predicate, "valid")) {
            const valid = value !== null && value !== undefined && (!(typeof value === "number") || Number.isFinite(value));
            return predicate.valid ? valid : !valid;
          }
          return true;
        });
      } else if (operation === "sort") {
        const direction = transform.order === "descending" ? -1 : 1;
        result = [...result].sort((left, right) => direction * stableValueCompare(left[transform.field], right[transform.field]));
      } else if (operation === "sample") {
        const size = Math.min(result.length, transform.size || result.length);
        if (transform.method === "first") result = result.slice(0, size);
        else if (transform.method === "stride") {
          const step = transform.step || Math.max(1, Math.floor(result.length / Math.max(1, size)));
          result = result.filter((_, index) => index % step === 0).slice(0, size);
        } else if (transform.method === "hash") {
          const key = transform.key;
          const hash = (value) => {
            let state = 2166136261;
            const text = String(value);
            for (let index = 0; index < text.length; index += 1) {
              state ^= text.charCodeAt(index);
              state = Math.imul(state, 16777619);
            }
            return state >>> 0;
          };
          result = [...result]
            .map((row, index) => ({ row, index, score: hash(row[key]) }))
            .sort((left, right) => left.score - right.score || left.index - right.index)
            .slice(0, size)
            .sort((left, right) => left.index - right.index)
            .map((item) => item.row);
        } else throw new Error(`Unsupported sample method: ${String(transform.method)}`);
      } else {
        throw new Error(`Unsupported runtime transform: ${String(operation)}`);
      }
    }
    return result;
  }

  function encodingUsesOnlyConstants(encoding) {
    const channels = Object.values(encoding || {});
    return channels.length > 0 && channels.every((channel) => {
      const bindings = Array.isArray(channel) ? channel : [channel];
      return bindings.length > 0 && bindings.every((binding) => binding && Object.hasOwn(binding, "value"));
    });
  }

  function layerRows(panel, layer) {
    const reference = layer.data_ref || panel.data_ref;
    const transforms = [...(panel.transform || []), ...(layer.transform || [])];
    if (encodingUsesOnlyConstants(layer.encoding)) {
      if (!reference) return [{}];
      const transformed = applyTransforms(rowsFor(reference), transforms);
      return [transformed[0] || {}];
    }
    return applyTransforms(rowsFor(reference), transforms);
  }

  function channelValue(row, channel) {
    if (!channel) return undefined;
    if (Object.hasOwn(channel, "value")) return channel.value;
    return row?.[channel.field];
  }

  function unique(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = `${typeof value}:${String(value)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function stableValueCompare(left, right) {
    if (typeof left === "number" && typeof right === "number") return left - right;
    const leftKey = `${typeof left}:${String(left)}`;
    const rightKey = `${typeof right}:${String(right)}`;
    return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
  }

  function numericExtent(values, includeZero = false) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const value of values) {
      if (!finite(value)) continue;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    if (minimum === Infinity) return [0, 1];
    if (includeZero) {
      minimum = Math.min(0, minimum);
      maximum = Math.max(0, maximum);
    }
    if (minimum === maximum) {
      if (includeZero && minimum >= 0) return [0, minimum === 0 ? 1 : minimum * 1.1];
      if (includeZero && maximum <= 0) return [maximum === 0 ? -1 : maximum * 1.1, 0];
      const padding = Math.abs(minimum || 1) * 0.1;
      return [minimum - padding, maximum + padding];
    }
    const padding = (maximum - minimum) * 0.06;
    return [minimum === 0 && includeZero ? 0 : minimum - padding, maximum === 0 && includeZero ? 0 : maximum + padding];
  }

  function rawNumericExtent(values) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const value of values) {
      if (!finite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    return minimum === Infinity ? [0, 1] : [minimum, maximum];
  }

  function niceStep(start, stop, count = 5) {
    const span = Math.abs(stop - start);
    if (!(span > 0) || !Number.isFinite(span)) return 1;
    const raw = span / Math.max(1, count);
    const power = 10 ** Math.floor(Math.log10(raw));
    const error = raw / power;
    const factor = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
    return factor * power;
  }

  function niceLinearDomain(domain, count = 5) {
    if (!Array.isArray(domain) || domain.length !== 2 || !domain.every(finite)) return domain;
    const reversed = domain[1] < domain[0];
    const minimum = reversed ? domain[1] : domain[0];
    const maximum = reversed ? domain[0] : domain[1];
    if (minimum === maximum) return domain;
    const step = niceStep(minimum, maximum, count);
    const nice = [Math.floor(minimum / step) * step, Math.ceil(maximum / step) * step]
      .map((value) => Object.is(value, -0) ? 0 : value);
    return reversed ? nice.reverse() : nice;
  }

  function linearScale(domain, range) {
    const span = domain[1] - domain[0] || 1;
    return (value) => range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
  }

  function bandScale(domain, range, padding = 0.16) {
    const step = (range[1] - range[0]) / Math.max(1, domain.length);
    const width = Math.abs(step) * (1 - padding);
    const index = new Map(domain.map((value, position) => [`${typeof value}:${String(value)}`, position]));
    const center = (value) => range[0] + ((index.get(`${typeof value}:${String(value)}`) ?? 0) + 0.5) * step;
    const scale = (value) => center(value) - width / 2;
    scale.bandwidth = Math.abs(width);
    scale.center = center;
    return scale;
  }

  function ticks(domain, count = 5, log = false) {
    if (log) {
      const first = Math.ceil(Math.log10(domain[0]));
      const last = Math.floor(Math.log10(domain[1]));
      const powers = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => 10 ** (first + index));
      return powers.length ? powers : [domain[0], domain[1]];
    }
    const reversed = domain[1] < domain[0];
    const minimum = reversed ? domain[1] : domain[0];
    const maximum = reversed ? domain[0] : domain[1];
    const step = niceStep(minimum, maximum, count);
    const first = Math.ceil((minimum - step * 1e-12) / step) * step;
    const last = Math.floor((maximum + step * 1e-12) / step) * step;
    const length = Math.max(0, Math.round((last - first) / step) + 1);
    const values = Array.from({ length }, (_, index) => {
      const value = first + index * step;
      return Object.is(value, -0) || Math.abs(value) < step * 1e-12 ? 0 : Number(value.toPrecision(15));
    });
    return reversed ? values.reverse() : values;
  }

  function encodingValues(panel, channelName) {
    const values = [];
    for (const layer of panel.layers || []) {
      const encoding = layer.encoding || {};
      if (layer.mark?.type === "ellipse" && ["x", "y"].includes(channelName)) {
        const centerChannel = encoding[channelName];
        const radiusChannel = encoding[`${channelName}_radius`];
        for (const row of layerRows(panel, layer)) {
          const center = channelValue(row, centerChannel);
          const radius = Math.abs(channelValue(row, radiusChannel));
          if (finite(center) && finite(radius)) values.push(center - radius, center + radius);
        }
        continue;
      }
      const candidates = [channelName, `${channelName}2`, `${channelName}_lower`, `${channelName}_upper`];
      if (channelName === "y") candidates.push("q1", "q3", "median", "whisker_low", "whisker_high");
      if (channelName === "x") candidates.push("x_radius");
      if (channelName === "y") candidates.push("y_radius");
      for (const candidate of candidates) {
        if (!encoding[candidate]) continue;
        const rows = layerRows(panel, layer);
        for (const row of rows) values.push(channelValue(row, encoding[candidate]));
      }
    }
    return values.filter((value) => value !== undefined && value !== null);
  }

  function axisSpec(panel, axis) {
    const candidates = axis === "x"
      ? ["x", "x2", "x_lower", "x_upper"]
      : ["y", "y2", "y_lower", "y_upper", "q1", "q3", "median", "whisker_low", "whisker_high"];
    let fieldFallback = null;
    let constantFallback = null;
    for (const layer of panel.layers || []) {
      for (const name of candidates) {
        const channel = layer.encoding?.[name];
        if (!channel) continue;
        if (channel.scale_id) return channel;
        if (Object.hasOwn(channel, "field")) fieldFallback ||= channel;
        else constantFallback ||= channel;
      }
    }
    return fieldFallback || constantFallback || {};
  }

  function scaleDefinition(figure, channel) {
    if (!channel?.scale_id) return null;
    return (figure?.scales || []).find((scale) => scale.id === channel.scale_id) || null;
  }

  function figureScaleValues(figure, panel, axis, channel) {
    if (!figure || !channel?.scale_id) return encodingValues(panel, axis);
    const values = [];
    const names = axis === "x"
      ? ["x", "x2", "x_lower", "x_upper"]
      : ["y", "y2", "y_lower", "y_upper", "q1", "q3", "median", "whisker_low", "whisker_high"];
    for (const candidatePanel of figure.panels || []) {
      for (const layer of candidatePanel.layers || []) {
        const channels = names.map((name) => layer.encoding?.[name]).filter(Boolean);
        const ownsScale = channels.some((candidate) => candidate.scale_id === channel.scale_id);
        if (!ownsScale) continue;
        const rows = layerRows(candidatePanel, layer);
        for (const candidate of channels) {
          if (candidate.scale_id && candidate.scale_id !== channel.scale_id) continue;
          for (const row of rows) values.push(channelValue(row, candidate));
        }
      }
    }
    return values.filter((value) => value !== undefined && value !== null);
  }

  function transformedScale(domain, range, transform) {
    const transformedDomain = domain.map(transform);
    const base = linearScale(transformedDomain, range);
    return (value) => base(transform(value));
  }

  function createScale(panel, axis, range, figure) {
    const spec = axisSpec(panel, axis);
    const definition = scaleDefinition(figure, spec);
    const values = figureScaleValues(figure, panel, axis, spec);
    const requestedType = definition?.type;
    const categorical = ["band", "point", "ordinal"].includes(requestedType)
      || spec.type === "nominal"
      || spec.type === "ordinal"
      || (!requestedType && values.some((value) => !finite(value)));
    const outputRange = definition?.reverse ? [...range].reverse() : range;
    if (categorical) {
      const domain = definition?.domain || unique(values);
      return { type: "band", domain, map: bandScale(domain, outputRange, requestedType === "point" ? 0.92 : 0.16), spec, definition };
    }
    const temporal = ["time", "utc"].includes(requestedType) || spec.type === "temporal";
    const numericValues = temporal ? values.map((value) => Date.parse(value)).filter(finite) : values;
    const includeZero = requestedType !== "log"
      && (definition?.zero ?? (panel.layers || []).some((layer) => layer.mark?.type === "bar" && layer.mark?.baseline !== "domain"));
    const declaredDomain = definition?.domain;
    let domain;
    if (declaredDomain) domain = temporal ? declaredDomain.map((value) => Date.parse(value)) : declaredDomain;
    else if (requestedType === "log") {
      let minimum = Infinity;
      let maximum = -Infinity;
      for (const value of numericValues) {
        if (!(value > 0)) continue;
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
      domain = minimum === Infinity ? [1, 10]
        : (minimum === maximum ? [minimum / 10, maximum * 10] : [minimum / 1.08, maximum * 1.08]);
    } else {
      domain = numericExtent(numericValues, includeZero);
      if (!requestedType || requestedType === "linear") domain = niceLinearDomain(domain, spec.axis?.ticks || 5);
    }
    let map;
    let type = requestedType || (temporal ? "time" : "linear");
    if (type === "log") {
      if (domain.some((value) => !(value > 0))) throw new Error(`Log scale ${definition?.id || axis} requires a positive domain`);
      map = transformedScale(domain, outputRange, (value) => Math.log10(value));
    } else if (type === "sqrt") {
      if (domain.some((value) => value < 0)) throw new Error(`Sqrt scale ${definition?.id || axis} requires a non-negative domain`);
      map = transformedScale(domain, outputRange, (value) => Math.sqrt(value));
    } else if (type === "symlog") map = transformedScale(domain, outputRange, (value) => Math.sign(value) * Math.log1p(Math.abs(value)));
    else map = linearScale(domain, outputRange);
    const rawMap = map;
    if (temporal) map = (value) => rawMap(finite(value) ? value : Date.parse(value));
    return { type, domain, map, spec, definition, temporal };
  }

  function axisDisplayValue(scale, value) {
    const axisOptions = scale.spec.axis || {};
    if (scale.temporal) {
      if (axisOptions.format === "none") return "";
      const span = Math.abs(scale.domain[1] - scale.domain[0]);
      const temporalFormat = axisOptions.format === "date" || axisOptions.format === "datetime"
        ? axisOptions.format
        : (span < 2 * 24 * 60 * 60 * 1000 ? "datetime" : "date");
      return formatTemporalValue(value, temporalFormat, scale.type === "utc");
    }
    if (scale.type === "log" && !scale.spec.axis?.format) return formatLogTick(value);
    return formatNumber(value, scale.spec.axis?.format);
  }

  function approximateTextWidth(value, fontSize = 10) {
    return [...String(value ?? "")].reduce((width, character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint > 0x2ff) return width + fontSize;
      if (/[WM@#%&]/.test(character)) return width + fontSize * 0.82;
      if (/[ilI1'.,:;|]/.test(character)) return width + fontSize * 0.32;
      return width + fontSize * 0.56;
    }, 0);
  }

  function truncateAxisLabel(value, maximumWidth, fontSize = 10) {
    const text = String(value ?? "");
    if (approximateTextWidth(text, fontSize) <= maximumWidth) return text;
    const ellipsis = "…";
    let visible = "";
    for (const character of text) {
      if (approximateTextWidth(`${visible}${character}${ellipsis}`, fontSize) > maximumWidth) break;
      visible += character;
    }
    return `${visible}${ellipsis}`;
  }

  function categoricalAxisLabelPlan(scale, plotSpan, fontSize = 9) {
    const count = Math.max(1, scale.domain.length);
    const step = plotSpan / count;
    const rawWidth = Math.max(0, ...scale.domain.map((value) => approximateTextWidth(axisDisplayValue(scale, value), fontSize)));
    let angle = scale.spec.axis?.label_angle;
    if (angle === undefined) {
      if (rawWidth <= step * 0.9) angle = 0;
      else if (rawWidth <= step * 1.8) angle = -35;
      else angle = -55;
    }
    const horizontalProjection = Math.max(0.25, Math.abs(Math.cos(angle * Math.PI / 180)));
    const maximumWidth = Math.max(14, Math.min(140, step * 0.88 / horizontalProjection));
    const visibleWidth = Math.min(rawWidth, maximumWidth);
    return {
      angle,
      maximumWidth,
      verticalProjection: Math.abs(Math.sin(angle * Math.PI / 180)) * visibleWidth
    };
  }

  function addAxisText(svg, x, y, value, maximumWidth, attrs = {}) {
    const fontSize = Number(attrs["font-size"]) || 10;
    const fullLabel = String(value ?? "");
    const visibleLabel = truncateAxisLabel(fullLabel, maximumWidth, fontSize);
    const label = addText(svg, x, y, visibleLabel, attrs);
    if (visibleLabel !== fullLabel) {
      label.setAttribute("data-full-label", fullLabel);
      const title = svgElement("title");
      title.textContent = fullLabel;
      label.append(title);
    }
    return label;
  }

  function drawAxes(svg, width, height, margin, xScale, yScale) {
    const plotRight = width - margin.right;
    const plotBottom = height - margin.bottom;
    const xLabelPlan = xScale.type === "band"
      ? categoricalAxisLabelPlan(xScale, plotRight - margin.left, 9)
      : { angle: xScale.spec.axis?.label_angle ?? 0, maximumWidth: 120 };

    function drawAxis(scale, axis) {
      if (scale.spec.axis === false) return;
      const horizontal = axis === "x";
      const axisOptions = scale.spec.axis || {};
      svg.append(horizontal
        ? svgElement("line", { x1: margin.left, y1: plotBottom, x2: plotRight, y2: plotBottom, stroke: COLORS.axis })
        : svgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: plotBottom, stroke: COLORS.axis }));
      const values = scale.type === "band" ? scale.domain : ticks(scale.domain, axisOptions.ticks || 5, scale.type === "log");
      for (const value of values) {
        const position = scale.type === "band" ? scale.map.center(value) : scale.map(value);
        if (horizontal) {
          if (axisOptions.grid !== false) svg.append(svgElement("line", { x1: position, y1: margin.top, x2: position, y2: plotBottom, stroke: COLORS.grid, "stroke-width": 1 }));
          const displayed = axisDisplayValue(scale, value);
          const labelWidth = scale.type === "band" ? xLabelPlan.maximumWidth : 120;
          const label = addAxisText(svg, position, plotBottom + 18, displayed, labelWidth, { "text-anchor": "middle", "font-size": scale.type === "band" ? 9 : 10 });
          const angle = scale.type === "band" ? xLabelPlan.angle : (axisOptions.label_angle ?? 0);
          if (angle) label.setAttribute("transform", `rotate(${angle} ${position} ${plotBottom + 18})`);
        } else {
          if (axisOptions.grid !== false) svg.append(svgElement("line", { x1: margin.left, y1: position, x2: plotRight, y2: position, stroke: COLORS.grid, "stroke-width": 1 }));
          const displayed = axisDisplayValue(scale, value);
          addAxisText(svg, margin.left - 8, position + 4, displayed, Math.max(24, margin.left - 30), { "text-anchor": "end", "font-size": 10 });
        }
      }
      const title = scale.spec.axis?.title || scale.spec.title || scale.definition?.title || scale.spec.field || "";
      if (horizontal) addText(svg, (margin.left + plotRight) / 2, height - 8, title, { "text-anchor": "middle", "font-size": 11 });
      else {
        const label = addText(svg, 13, (margin.top + plotBottom) / 2, title, { "text-anchor": "middle", "font-size": 11 });
        label.setAttribute("transform", `rotate(-90 13 ${(margin.top + plotBottom) / 2})`);
      }
    }
    drawAxis(xScale, "x");
    drawAxis(yScale, "y");
  }

  function resolveContinuousColorDomain(values, explicitDomain, role, scheme) {
    const declaredDiverging = role === "diverging" || scheme === "diverging";
    const declaredSequential = role === "sequential" || scheme === "sequential";
    if (Array.isArray(explicitDomain) && explicitDomain.length === 2) {
      const domain = [...explicitDomain];
      const diverging = declaredDiverging || (!declaredSequential && domain[0] < 0 && domain[1] > 0);
      return { domain, diverging };
    }

    let [minimum, maximum] = rawNumericExtent(values);
    const diverging = declaredDiverging || (!declaredSequential && minimum < 0 && maximum > 0);
    if (diverging) {
      const bound = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
      return { domain: [-bound, bound], diverging: true };
    }
    if (declaredSequential && minimum >= 0) return { domain: [0, maximum || 1], diverging: false };
    if (declaredSequential && maximum <= 0) return { domain: [minimum || -1, 0], diverging: false };
    if (minimum === maximum) {
      const padding = Math.abs(minimum || 1) * 0.1;
      minimum -= padding;
      maximum += padding;
    }
    return { domain: [minimum, maximum], diverging: false };
  }

  function colorScale(panel, figure) {
    const categories = [];
    let explicitDomain;
    let explicitRange;
    let channelType;
    let channelRole;
    let scheme;
    for (const layer of panel.layers || []) {
      const channel = layer.encoding?.color || layer.encoding?.stroke || layer.encoding?.fill;
      if (!channel) continue;
      const definition = scaleDefinition(figure, channel);
      explicitDomain ||= definition?.domain;
      explicitRange ||= definition?.range;
      channelType ||= channel.type;
      channelRole ||= channel.scale_role;
      scheme ||= definition?.scheme;
      for (const row of layerRows(panel, layer)) categories.push(channelValue(row, channel));
    }
    const continuous = channelType === "quantitative" || ["continuous", "sequential", "diverging"].includes(channelRole) || ["sequential", "diverging"].includes(scheme);
    if (continuous) {
      const { domain, diverging } = resolveContinuousColorDomain(categories, explicitDomain, channelRole, scheme);
      const resolveColor = (value) => finite(value) ? interpolateColor(value, domain, diverging, explicitRange) : COLORS.muted;
      resolveColor.domain = domain;
      resolveColor.palette = explicitRange || [];
      resolveColor.continuous = true;
      resolveColor.diverging = diverging;
      return resolveColor;
    }
    if (!explicitDomain && channelRole === "semantic") {
      for (const candidateFigure of payload.figures || []) {
        for (const candidatePanel of candidateFigure.panels || []) {
          for (const candidateLayer of candidatePanel.layers || []) {
            const candidateChannel = candidateLayer.encoding?.color || candidateLayer.encoding?.stroke;
            if (candidateChannel?.scale_role !== "semantic") continue;
            for (const row of layerRows(candidatePanel, candidateLayer)) categories.push(channelValue(row, candidateChannel));
          }
        }
      }
    }
    const domain = explicitDomain || unique(categories.filter((value) => value !== undefined && value !== null))
      .sort(stableValueCompare);
    const palette = resolvePalette(explicitRange || payload.theme?.palette);
    const semantic = payload.theme?.semantic_colors || {};
    const mapping = new Map(domain.map((value, index) => [`${typeof value}:${String(value)}`, semantic[String(value)] || palette[index % palette.length]]));
    const resolveColor = (value, fallbackIndex = 0) => mapping.get(`${typeof value}:${String(value)}`) || palette[fallbackIndex % palette.length];
    resolveColor.domain = domain;
    resolveColor.palette = palette;
    return resolveColor;
  }

  function groupRows(rows, channel) {
    if (!channel) return [["series", rows]];
    const groups = new Map();
    for (const row of rows) {
      const value = channelValue(row, channel);
      const key = `${typeof value}:${String(value)}`;
      if (!groups.has(key)) groups.set(key, [value, []]);
      groups.get(key)[1].push(row);
    }
    return [...groups.values()];
  }

  function barGroups(rows, encoding) {
    return encoding.group ? groupRows(rows, encoding.group) : [["series", rows]];
  }

  function canonicalInteractionTarget(target) {
    if (typeof target === "string") return target;
    if (!target || typeof target !== "object") return "";
    return target.layer_id ? `${target.panel_id}/${target.layer_id}` : target.panel_id;
  }

  function interactionTargetsLayer(interaction, panel, layer) {
    const panelTarget = panel.id;
    const layerTarget = `${panel.id}/${layer.id}`;
    return (interaction.targets || []).some((target) => {
      const canonical = canonicalInteractionTarget(target);
      return canonical === panelTarget || canonical === layerTarget;
    });
  }

  function interactionsFor(figure, type, panel, layer) {
    return (figure?.interactions || []).filter((interaction) => interaction.type === type && interactionTargetsLayer(interaction, panel, layer));
  }

  function tooltipText(row, fields) {
    return fields.map((field) => `${field}: ${formatNumber(row?.[field])}`).join("\n");
  }

  function linkedInteractionKey(row, interaction) {
    return JSON.stringify((interaction.fields || []).map((field) => [typeof row?.[field], row?.[field] ?? null]));
  }

  function decorateMark(element, row, figure, panel, layer) {
    element.classList.add("v3-mark");
    element.dataset.panelId = panel.id;
    element.dataset.layerId = layer.id;
    element.__dashboardVisibility = new Map();
    element.__dashboardInteractionValues = new Map();

    const tooltipInteractions = interactionsFor(figure, "tooltip", panel, layer);
    const declaredFields = unique(tooltipInteractions.flatMap((interaction) => interaction.fields || []));
    const encodedTooltip = Array.isArray(layer.encoding?.tooltip) ? layer.encoding.tooltip : (layer.encoding?.tooltip ? [layer.encoding.tooltip] : []);
    let tooltip = declaredFields.length ? tooltipText(row, declaredFields) : "";
    if (!tooltip && encodedTooltip.length) tooltip = encodedTooltip.map((item) => `${item.title || item.field || "value"}: ${formatValue(channelValue(row, item), item.format)}`).join("\n");
    if (tooltip) element.append(svgElement("title", {}, tooltip));

    for (const interaction of interactionsFor(figure, "legend_filter", panel, layer)) {
      element.__dashboardInteractionValues.set(interaction.id, row?.[interaction.field]);
    }
    for (const interaction of interactionsFor(figure, "parameter", panel, layer)) {
      element.__dashboardInteractionValues.set(interaction.id, row?.[interaction.parameter]);
    }
    for (const interaction of interactionsFor(figure, "linked_highlight", panel, layer)) {
      element.__dashboardInteractionValues.set(interaction.id, linkedInteractionKey(row, interaction));
    }
    if (interactionsFor(figure, "hover", panel, layer).length) element.classList.add("v3-hover-target");
    return element;
  }

  function appendDataMark(target, element, row, figure, panel, layer) {
    target.append(decorateMark(element, row, figure, panel, layer));
    return element;
  }

  function barValueLabelLayout({
    vertical,
    stacked,
    categoryPosition,
    thickness,
    valuePosition,
    baselinePosition,
    plotStart,
    plotEnd,
    label
  }) {
    if (!(finite(categoryPosition) && finite(thickness) && finite(valuePosition) && finite(baselinePosition))) return null;
    if (!label) return null;
    const segmentLength = Math.abs(valuePosition - baselinePosition);
    const center = categoryPosition + thickness / 2;
    const estimate = Math.max(7, String(label).length * 5.2);
    if (stacked) {
      if (thickness < 10 || segmentLength < 13) return null;
      if (vertical) return { x: center, y: (valuePosition + baselinePosition) / 2 + 3, anchor: "middle", inside: true };
      if (segmentLength < estimate + 5) return null;
      return { x: (valuePosition + baselinePosition) / 2, y: center + 3, anchor: "middle", inside: true };
    }
    if (vertical) {
      const above = valuePosition <= baselinePosition;
      return {
        x: center,
        y: above ? Math.max(plotStart + 10, valuePosition - 5) : Math.min(plotEnd - 2, valuePosition + 12),
        anchor: "middle",
        inside: false
      };
    }
    const rightward = valuePosition >= baselinePosition;
    if (rightward && valuePosition + estimate + 7 <= plotEnd) {
      return { x: valuePosition + 5, y: center + 3, anchor: "start", inside: false };
    }
    if (!rightward && valuePosition - estimate - 7 >= plotStart) {
      return { x: valuePosition - 5, y: center + 3, anchor: "end", inside: false };
    }
    return {
      x: valuePosition + (rightward ? -5 : 5),
      y: center + 3,
      anchor: rightward ? "end" : "start",
      inside: true
    };
  }

  function cartesianMargins(panel, figure, width, height) {
    const margin = { top: 24, right: 26, bottom: 58, left: 64 };
    const xScale = createScale(panel, "x", [0, 1], figure);
    const yScale = createScale(panel, "y", [1, 0], figure);

    if (yScale.type === "band" && yScale.spec.axis !== false) {
      const maximumLabelWidth = Math.max(0, ...yScale.domain.map((value) => approximateTextWidth(axisDisplayValue(yScale, value), 10)));
      const desiredLeft = Math.ceil(maximumLabelWidth + 30);
      const maximumLeft = Math.max(margin.left, width - margin.right - 120);
      margin.left = Math.min(maximumLeft, Math.max(margin.left, desiredLeft));
    }

    if (xScale.type === "band" && xScale.spec.axis !== false) {
      const plan = categoricalAxisLabelPlan(xScale, width - margin.left - margin.right, 9);
      const desiredBottom = Math.ceil(40 + plan.verticalProjection);
      const maximumBottom = Math.max(margin.bottom, height - margin.top - 120);
      margin.bottom = Math.min(maximumBottom, Math.max(margin.bottom, desiredBottom));
    }

    return { ...margin, ...(panel.display?.margin || {}) };
  }

  function renderCartesianPanel(panel, figure) {
    const width = panelRenderWidth(panel, figure, 620);
    const height = panelRenderHeight(panel, width, 350);
    const margin = cartesianMargins(panel, figure, width, height);
    const svg = createSvg(width, height, panel.title || panel.id);
    let xScale = createScale(panel, "x", [margin.left, width - margin.right], figure);
    let yScale = createScale(panel, "y", [height - margin.bottom, margin.top], figure);
    if (panel.coordinate?.equal_aspect && xScale.type !== "band" && yScale.type !== "band") {
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const xSpan = Math.abs(xScale.domain[1] - xScale.domain[0]) || 1;
      const ySpan = Math.abs(yScale.domain[1] - yScale.domain[0]) || 1;
      const pixelsPerUnit = Math.min(plotWidth / xSpan, plotHeight / ySpan);
      const usedWidth = xSpan * pixelsPerUnit;
      const usedHeight = ySpan * pixelsPerUnit;
      const xStart = margin.left + (plotWidth - usedWidth) / 2;
      const yBottom = height - margin.bottom - (plotHeight - usedHeight) / 2;
      xScale = createScale(panel, "x", [xStart, xStart + usedWidth], figure);
      yScale = createScale(panel, "y", [yBottom, yBottom - usedHeight], figure);
    }
    drawAxes(svg, width, height, margin, xScale, yScale);
    const color = colorScale(panel, figure);

    function position(scale, value, centered = true) {
      return scale.type === "band" && centered ? scale.map.center(value) : scale.map(value);
    }

    for (const [layerIndex, layer] of (panel.layers || []).entries()) {
      const rows = layerRows(panel, layer);
      const mark = layer.mark || {};
      const encoding = layer.encoding || {};
      const markType = mark.type;
      const layerColorChannel = encoding.color || encoding.stroke || encoding.fill;
      const layerColor = mark.color || color(channelValue(rows[0], layerColorChannel), layerIndex);
      const layerGroup = svgElement("g", { "data-panel-id": panel.id, "data-layer-id": layer.id });
      svg.append(layerGroup);

      if (markType === "bar") {
        const vertical = (mark.orientation || mark.orient) !== "horizontal";
        const categories = vertical ? xScale : yScale;
        const values = vertical ? yScale : xScale;
        const groups = barGroups(rows, encoding);
        const groupWidth = (categories.map.bandwidth || 18) / Math.max(1, groups.length);
        const automaticValueLabels = Boolean(encoding.text);
        groups.forEach(([groupName, group], groupIndex) => {
          group.forEach((row) => {
            const categoryValue = channelValue(row, vertical ? encoding.x : encoding.y);
            const value = channelValue(row, vertical ? encoding.y : encoding.x);
            const encodedBaseline = channelValue(row, vertical ? encoding.y2 : encoding.x2);
            const baselineValue = encodedBaseline ?? (values.type === "log" ? values.domain[0] : 0);
            const categoryStart = categories.type === "band" ? categories.map(categoryValue) : position(categories, categoryValue) - groupWidth / 2;
            const categoryPosition = categoryStart + groupIndex * groupWidth;
            const valuePosition = position(values, value);
            const baseline = position(values, baselineValue);
            const barColorChannel = encoding.color || encoding.fill;
            const fill = mark.color || color(barColorChannel ? channelValue(row, barColorChannel) : groupName, groupIndex);
            const thickness = Math.max(1, groupWidth * 0.88);
            appendDataMark(layerGroup, svgElement("rect", vertical ? {
              x: categoryPosition, y: Math.min(baseline, valuePosition), width: thickness, height: Math.max(1, Math.abs(valuePosition - baseline)), fill, opacity: mark.opacity ?? 0.9
            } : {
              x: Math.min(baseline, valuePosition), y: categoryPosition, width: Math.max(1, Math.abs(valuePosition - baseline)), height: thickness, fill, opacity: mark.opacity ?? 0.9
            }), row, figure, panel, layer);
            if (automaticValueLabels && finite(value) && finite(baselineValue)) {
              const stacked = Boolean(vertical ? encoding.y2 : encoding.x2);
              const labelValue = channelValue(row, encoding.text);
              const label = formatValue(labelValue, encoding.text?.format);
              const placement = barValueLabelLayout({
                vertical,
                stacked,
                categoryPosition,
                thickness,
                valuePosition,
                baselinePosition: baseline,
                plotStart: vertical ? margin.top : margin.left,
                plotEnd: vertical ? height - margin.bottom : width - margin.right,
                label
              });
              if (placement) {
                const valueLabel = addText(layerGroup, placement.x, placement.y, label, {
                  class: "v3-bar-value-label",
                  fill: COLORS.ink,
                  "font-size": 9,
                  "font-weight": 650,
                  "text-anchor": placement.anchor,
                  "paint-order": "stroke",
                  stroke: COLORS.surface,
                  "stroke-width": 2.4,
                  "stroke-linejoin": "round"
                });
                decorateMark(valueLabel, row, figure, panel, layer);
                valueLabel.setAttribute("aria-hidden", "true");
              }
            }
          });
        });
      } else if (markType === "line") {
        const groups = groupRows(rows, encoding.color || encoding.stroke || encoding.group);
        groups.forEach(([groupName, group], groupIndex) => {
          const sorted = [...group].sort((left, right) => position(xScale, channelValue(left, encoding.x)) - position(xScale, channelValue(right, encoding.x)));
          const points = sorted.map((row) => `${position(xScale, channelValue(row, encoding.x))},${position(yScale, channelValue(row, encoding.y))}`).join(" ");
          appendDataMark(layerGroup, svgElement("polyline", { points, fill: "none", stroke: color(groupName, groupIndex), "stroke-width": mark.stroke_width || 2.2, "stroke-dasharray": mark.dash || undefined, opacity: mark.opacity ?? 1 }), sorted[0] || {}, figure, panel, layer);
          if (mark.point) sorted.forEach((row) => appendDataMark(layerGroup, svgElement("circle", { cx: position(xScale, channelValue(row, encoding.x)), cy: position(yScale, channelValue(row, encoding.y)), r: mark.point_size || 3.2, fill: color(groupName, groupIndex), opacity: mark.opacity ?? 1 }), row, figure, panel, layer));
          else if (interactionsFor(figure, "tooltip", panel, layer).length) sorted.forEach((row) => appendDataMark(layerGroup, svgElement("circle", { cx: position(xScale, channelValue(row, encoding.x)), cy: position(yScale, channelValue(row, encoding.y)), r: 8, fill: "transparent", stroke: "none", "pointer-events": "all" }), row, figure, panel, layer));
        });
      } else if (markType === "point") {
        rows.forEach((row, rowIndex) => {
          const colorChannel = encoding.color || encoding.fill;
          const fill = colorChannel ? color(channelValue(row, colorChannel), rowIndex) : layerColor;
          const pointRadius = mark.size || (mark.point_size ? Math.max(1.5, Math.min(9, Math.sqrt(mark.point_size) / 2)) : 3.2);
          const circle = svgElement("circle", { cx: position(xScale, channelValue(row, encoding.x)), cy: position(yScale, channelValue(row, encoding.y)), r: pointRadius, fill, opacity: mark.opacity ?? 0.72, stroke: mark.stroke || "none" });
          appendDataMark(layerGroup, circle, row, figure, panel, layer);
        });
      } else if (markType === "band" || markType === "area") {
        if (mark.role === "annotation") {
          const row = rows[0] || {};
          if (encoding.y && encoding.y2) {
            const first = position(yScale, channelValue(row, encoding.y));
            const second = position(yScale, channelValue(row, encoding.y2));
            appendDataMark(layerGroup, svgElement("rect", { x: margin.left, y: Math.min(first, second), width: width - margin.left - margin.right, height: Math.abs(second - first), fill: layerColor, opacity: mark.opacity ?? 0.12 }), row, figure, panel, layer);
            continue;
          }
          if (encoding.x && encoding.x2) {
            const first = position(xScale, channelValue(row, encoding.x));
            const second = position(xScale, channelValue(row, encoding.x2));
            appendDataMark(layerGroup, svgElement("rect", { x: Math.min(first, second), y: margin.top, width: Math.abs(second - first), height: height - margin.top - margin.bottom, fill: layerColor, opacity: mark.opacity ?? 0.12 }), row, figure, panel, layer);
            continue;
          }
        }
        const groups = groupRows(rows, encoding.color || encoding.fill || encoding.group);
        groups.forEach(([groupName, group], groupIndex) => {
          const horizontal = Boolean(encoding.x2 || encoding.x_lower || encoding.x_upper);
          const sorted = [...group].sort((left, right) => position(horizontal ? yScale : xScale, channelValue(left, horizontal ? encoding.y : encoding.x)) - position(horizontal ? yScale : xScale, channelValue(right, horizontal ? encoding.y : encoding.x)));
          const upper = horizontal
            ? sorted.map((row) => `${position(xScale, channelValue(row, encoding.x_upper || encoding.x2 || encoding.x))},${position(yScale, channelValue(row, encoding.y))}`)
            : sorted.map((row) => `${position(xScale, channelValue(row, encoding.x))},${position(yScale, channelValue(row, encoding.y_upper || encoding.y2 || encoding.y))}`);
          const lower = horizontal
            ? [...sorted].reverse().map((row) => `${position(xScale, channelValue(row, encoding.x_lower || encoding.x || { value: 0 }))},${position(yScale, channelValue(row, encoding.y))}`)
            : [...sorted].reverse().map((row) => `${position(xScale, channelValue(row, encoding.x))},${position(yScale, channelValue(row, encoding.y_lower || encoding.y || { value: 0 }))}`);
          appendDataMark(layerGroup, svgElement("polygon", { points: [...upper, ...lower].join(" "), fill: color(groupName, groupIndex), opacity: mark.opacity ?? 0.18, stroke: "none" }), sorted[0] || {}, figure, panel, layer);
        });
      } else if (markType === "rule") {
        const constantRule = Object.values(encoding).every((channel) => channel && Object.hasOwn(channel, "value"));
        const ruleRows = constantRule ? [rows[0] || {}] : (rows.length ? rows : [{}]);
        for (const [rowIndex, row] of ruleRows.entries()) {
          const xValue = channelValue(row, encoding.x);
          const yValue = channelValue(row, encoding.y);
          const x2Value = channelValue(row, encoding.x2);
          const y2Value = channelValue(row, encoding.y2);
          const ruleColorChannel = encoding.color || encoding.stroke;
          const ruleStroke = mark.color || (ruleColorChannel ? color(channelValue(row, ruleColorChannel), rowIndex) : layerColor);
          if (xValue !== undefined && yValue !== undefined && x2Value !== undefined && y2Value !== undefined) {
            appendDataMark(layerGroup, svgElement("line", { x1: position(xScale, xValue), y1: position(yScale, yValue), x2: position(xScale, x2Value), y2: position(yScale, y2Value), stroke: ruleStroke, "stroke-width": mark.stroke_width || 1.6, "stroke-dasharray": mark.dash || "5 4" }), row, figure, panel, layer);
          } else {
            if (xValue !== undefined) appendDataMark(layerGroup, svgElement("line", { x1: position(xScale, xValue), x2: position(xScale, xValue), y1: margin.top, y2: height - margin.bottom, stroke: ruleStroke, "stroke-width": mark.stroke_width || 1.6, "stroke-dasharray": mark.dash || "5 4" }), row, figure, panel, layer);
            if (yValue !== undefined) appendDataMark(layerGroup, svgElement("line", { x1: margin.left, x2: width - margin.right, y1: position(yScale, yValue), y2: position(yScale, yValue), stroke: ruleStroke, "stroke-width": mark.stroke_width || 1.6, "stroke-dasharray": mark.dash || "5 4" }), row, figure, panel, layer);
          }
        }
      } else if (markType === "vector") {
        rows.forEach((row, rowIndex) => {
          const x1 = position(xScale, channelValue(row, encoding.x));
          const y1 = position(yScale, channelValue(row, encoding.y));
          const x2 = position(xScale, channelValue(row, encoding.x2));
          const y2 = position(yScale, channelValue(row, encoding.y2));
          const colorChannel = encoding.color || encoding.stroke;
          const stroke = colorChannel ? color(channelValue(row, colorChannel), rowIndex) : layerColor;
          appendDataMark(layerGroup, svgElement("line", { x1, y1, x2, y2, stroke, "stroke-width": mark.stroke_width || 2 }), row, figure, panel, layer);
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const head = mark.head_size || 7;
          const points = [[x2, y2], [x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6)], [x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6)]];
          layerGroup.append(svgElement("polygon", { points: points.map((point) => point.join(",")).join(" "), fill: stroke }));
        });
      } else if (markType === "text") {
        const constantText = Object.values(encoding).every((channel) => channel && Object.hasOwn(channel, "value"));
        (constantText ? [rows[0] || {}] : rows).forEach((row, rowIndex) => {
          const fill = encoding.color ? color(channelValue(row, encoding.color), rowIndex) : layerColor;
          const textValue = channelValue(row, encoding.text);
          decorateMark(addText(layerGroup, position(xScale, channelValue(row, encoding.x)) + (mark.dx || 0), position(yScale, channelValue(row, encoding.y)) + (mark.dy || 0), formatValue(textValue, encoding.text?.format), { fill, "font-size": 9, "text-anchor": "middle" }), row, figure, panel, layer);
        });
      } else if (markType === "errorbar") {
        rows.forEach((row, rowIndex) => {
          const stroke = encoding.color ? color(channelValue(row, encoding.color), rowIndex) : layerColor;
          const rowGroup = svgElement("g");
          appendDataMark(layerGroup, rowGroup, row, figure, panel, layer);
          if (encoding.y_lower && encoding.y_upper) {
            const x = position(xScale, channelValue(row, encoding.x));
            const yLow = position(yScale, channelValue(row, encoding.y_lower));
            const yHigh = position(yScale, channelValue(row, encoding.y_upper));
            rowGroup.append(svgElement("line", { x1: x, x2: x, y1: yLow, y2: yHigh, stroke, "stroke-width": mark.stroke_width || 1.6 }));
            rowGroup.append(svgElement("line", { x1: x - 5, x2: x + 5, y1: yLow, y2: yLow, stroke }));
            rowGroup.append(svgElement("line", { x1: x - 5, x2: x + 5, y1: yHigh, y2: yHigh, stroke }));
          } else {
            const y = position(yScale, channelValue(row, encoding.y));
            const xLow = position(xScale, channelValue(row, encoding.x_lower));
            const xHigh = position(xScale, channelValue(row, encoding.x_upper));
            rowGroup.append(svgElement("line", { x1: xLow, x2: xHigh, y1: y, y2: y, stroke, "stroke-width": mark.stroke_width || 1.6 }));
            rowGroup.append(svgElement("line", { x1: xLow, x2: xLow, y1: y - 5, y2: y + 5, stroke }));
            rowGroup.append(svgElement("line", { x1: xHigh, x2: xHigh, y1: y - 5, y2: y + 5, stroke }));
          }
        });
      } else if (markType === "boxplot") {
        rows.forEach((row, rowIndex) => {
          const category = position(xScale, channelValue(row, encoding.x));
          const widthBox = Math.min(28, xScale.map.bandwidth || 24);
          const stroke = encoding.color ? color(channelValue(row, encoding.color), rowIndex) : layerColor;
          const q1 = position(yScale, channelValue(row, encoding.q1));
          const q3 = position(yScale, channelValue(row, encoding.q3));
          const median = position(yScale, channelValue(row, encoding.median));
          const low = position(yScale, channelValue(row, encoding.whisker_low));
          const high = position(yScale, channelValue(row, encoding.whisker_high));
          layerGroup.append(svgElement("line", { x1: category, x2: category, y1: low, y2: high, stroke }));
          appendDataMark(layerGroup, svgElement("rect", { x: category - widthBox / 2, y: Math.min(q1, q3), width: widthBox, height: Math.abs(q3 - q1), fill: stroke, opacity: mark.opacity ?? 0.55, stroke }), row, figure, panel, layer);
          layerGroup.append(svgElement("line", { x1: category - widthBox / 2, x2: category + widthBox / 2, y1: median, y2: median, stroke: COLORS.ink, "stroke-width": 1.5 }));
        });
      } else if (markType === "ellipse") {
        const constantEllipse = [encoding.x, encoding.y, encoding.x_radius, encoding.y_radius].every((channel) => channel && Object.hasOwn(channel, "value"));
        (constantEllipse ? [rows[0] || {}] : rows).forEach((row, rowIndex) => {
          const centerX = position(xScale, channelValue(row, encoding.x));
          const centerY = position(yScale, channelValue(row, encoding.y));
          const radiusXValue = Math.abs(channelValue(row, encoding.x_radius));
          const radiusYValue = Math.abs(channelValue(row, encoding.y_radius));
          const radiusX = Math.abs(position(xScale, channelValue(row, encoding.x) + radiusXValue) - centerX);
          const radiusY = Math.abs(position(yScale, channelValue(row, encoding.y) + radiusYValue) - centerY);
          appendDataMark(layerGroup, svgElement("ellipse", { cx: centerX, cy: centerY, rx: radiusX, ry: radiusY, fill: mark.fill || "none", stroke: encoding.color ? color(channelValue(row, encoding.color), rowIndex) : layerColor, "stroke-width": mark.stroke_width || 1.5, "stroke-dasharray": mark.dash || undefined, opacity: mark.opacity ?? 1 }), row, figure, panel, layer);
        });
      } else if (markType === "polygon") {
        const groups = groupRows(rows, encoding.group || encoding.color);
        groups.forEach(([groupName, group], groupIndex) => {
          const points = group.map((row) => `${position(xScale, channelValue(row, encoding.x))},${position(yScale, channelValue(row, encoding.y))}`).join(" ");
          appendDataMark(layerGroup, svgElement("polygon", { points, fill: mark.fill || color(groupName, groupIndex), stroke: mark.stroke || color(groupName, groupIndex), "stroke-width": mark.stroke_width || 1, opacity: mark.opacity ?? 0.18 }), group[0] || {}, figure, panel, layer);
        });
      } else {
        throw new Error(`Unsupported cartesian mark: ${String(markType)}`);
      }
    }

    for (const annotation of panel.annotations || []) {
      const stroke = annotation.color || "#8c96a5";
      if (annotation.type === "reference-line") {
        if (annotation.axis === "x") svg.append(svgElement("line", { x1: position(xScale, annotation.value), x2: position(xScale, annotation.value), y1: margin.top, y2: height - margin.bottom, stroke, "stroke-width": annotation.stroke_width || 1.5, "stroke-dasharray": annotation.dash || "5 4" }));
        else svg.append(svgElement("line", { x1: margin.left, x2: width - margin.right, y1: position(yScale, annotation.value), y2: position(yScale, annotation.value), stroke, "stroke-width": annotation.stroke_width || 1.5, "stroke-dasharray": annotation.dash || "5 4" }));
      } else if (annotation.type === "identity-line") {
        const lower = Math.max(xScale.domain[0], yScale.domain[0]);
        const upper = Math.min(xScale.domain[1], yScale.domain[1]);
        svg.append(svgElement("line", { x1: position(xScale, lower), y1: position(yScale, lower), x2: position(xScale, upper), y2: position(yScale, upper), stroke, "stroke-width": annotation.stroke_width || 1.5, "stroke-dasharray": annotation.dash || "5 4" }));
      } else if (annotation.type === "reference-band") {
        if (annotation.axis === "x") {
          const left = position(xScale, annotation.from);
          const right = position(xScale, annotation.to);
          svg.append(svgElement("rect", { x: Math.min(left, right), y: margin.top, width: Math.abs(right - left), height: height - margin.bottom - margin.top, fill: annotation.color || "#8c96a5", opacity: annotation.opacity ?? 0.12 }));
        } else {
          const top = position(yScale, annotation.to);
          const bottom = position(yScale, annotation.from);
          svg.append(svgElement("rect", { x: margin.left, y: Math.min(top, bottom), width: width - margin.right - margin.left, height: Math.abs(bottom - top), fill: annotation.color || "#8c96a5", opacity: annotation.opacity ?? 0.12 }));
        }
      } else if (annotation.type === "label") {
        addText(svg, position(xScale, annotation.x), position(yScale, annotation.y), annotation.text, { fill: annotation.color || COLORS.muted, "font-size": annotation.font_size || 10, "text-anchor": annotation.anchor || "start", "font-weight": annotation.weight || 600 });
      } else {
        throw new Error(`Unsupported panel annotation: ${String(annotation.type)}`);
      }
    }
    return svg;
  }

  function renderCanvasPanel(panel, figure) {
    const layer = panel.layers?.[0];
    if (!layer || layer.mark?.type !== "point") throw new Error(`Canvas panel ${panel.id} requires exactly one point layer`);
    const rows = layerRows(panel, layer);
    const encoding = layer.encoding || {};
    const width = panelRenderWidth(panel, figure, 1060);
    const height = panelRenderHeight(panel, width, 380);
    const padding = 22;
    const holder = htmlElement("div", "v3-canvas-holder");
    const canvas = htmlElement("canvas", "v3-canvas");
    canvas.dataset.panelId = panel.id;
    canvas.dataset.layerId = layer.id;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", panel.title || panel.id || "Interactive point map");
    const tooltip = htmlElement("div", "v3-canvas-tooltip");
    tooltip.hidden = true;
    const summary = htmlElement("p", "v3-canvas-summary");
    summary.id = `canvas-summary-${figure.id}-${panel.id}`;
    summary.setAttribute("aria-live", "polite");
    canvas.setAttribute("aria-describedby", summary.id);
    append(holder, canvas, tooltip, summary);

    const xScale = createScale(panel, "x", [padding, width - padding], figure);
    const yScale = createScale(panel, "y", [height - padding, padding], figure);
    const canvasPosition = (scale, value) => scale.type === "band" ? scale.map.center(value) : scale.map(value);
    const colors = colorScale(panel, figure);
    const state = new Map();
    const externalHighlights = new Map();
    const linkedHighlightHandlers = new Map();
    let plotted = [];
    let hovered = -1;

    const targeted = (type) => interactionsFor(figure, type, panel, layer);
    for (const interaction of targeted("parameter")) state.set(interaction.id, interaction.default);
    for (const interaction of targeted("legend_filter")) {
      const values = unique(rows.map((row) => row[interaction.field]));
      state.set(interaction.id, new Set(values.map((value) => `${typeof value}:${String(value)}`)));
    }

    function rowVisible(row) {
      for (const interaction of targeted("parameter")) if (!Object.is(row[interaction.parameter], state.get(interaction.id))) return false;
      for (const interaction of targeted("legend_filter")) {
        const selected = state.get(interaction.id);
        if (!selected.has(`${typeof row[interaction.field]}:${String(row[interaction.field])}`)) return false;
      }
      return true;
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.aspectRatio = `${width} / ${height}`;
      const context = canvas.getContext("2d");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      plotted = [];
      rows.forEach((row, rowIndex) => {
        if (!rowVisible(row)) return;
        const x = canvasPosition(xScale, channelValue(row, encoding.x));
        const y = canvasPosition(yScale, channelValue(row, encoding.y));
        if (!finite(x) || !finite(y)) return;
        const colorChannel = encoding.color || encoding.stroke;
        const fill = colorChannel ? colors(channelValue(row, colorChannel), rowIndex) : DEFAULT_PALETTE[0];
        const pointerSelected = rowIndex === hovered;
        const linkedStates = targeted("linked_highlight")
          .map((interaction) => [interaction, externalHighlights.get(interaction.id)])
          .filter(([, key]) => key !== undefined && key !== null);
        const linkedSelected = linkedStates.length > 0
          && linkedStates.every(([interaction, key]) => linkedInteractionKey(row, interaction) === key);
        const linkedMuted = linkedStates.length > 0 && !linkedSelected;
        const selected = pointerSelected || linkedSelected;
        context.globalAlpha = selected ? 1 : (linkedMuted ? 0.1 : (layer.mark.opacity ?? 0.72));
        context.fillStyle = fill;
        context.beginPath();
        context.arc(x, y, selected ? 5 : Math.max(1.4, layer.mark.point_size ? Math.sqrt(layer.mark.point_size) / 2 : 2.2), 0, Math.PI * 2);
        context.fill();
        plotted.push({ row, rowIndex, x, y, fill });
      });
      context.globalAlpha = 1;
      summary.textContent = `${plotted.length.toLocaleString()} of ${rows.length.toLocaleString()} points shown. Hover the map or use the arrow keys to inspect points.`;
    }

    const tooltipFields = unique(targeted("tooltip").flatMap((interaction) => interaction.fields || []));
    const inspectionFields = tooltipFields.length
      ? tooltipFields
      : unique(targeted("linked_highlight").flatMap((interaction) => interaction.fields || []));
    const hoverEnabled = Boolean(tooltipFields.length || targeted("hover").length);
    const linkedEnabled = targeted("linked_highlight").length > 0;
    if (hoverEnabled || linkedEnabled) {
      canvas.tabIndex = 0;
      canvas.setAttribute("aria-label", `${canvas.getAttribute("aria-label")}. Use arrow keys to inspect visible points; press Escape to clear the selection.`);
    }
    const pointDetails = (point) => inspectionFields.length
      ? tooltipText(point.row, inspectionFields)
      : `Point ${point.rowIndex + 1}`;
    function publishLinkedHighlight(row) {
      for (const interaction of targeted("linked_highlight")) {
        linkedHighlightHandlers.get(interaction.id)?.(row ? linkedInteractionKey(row, interaction) : null, canvas);
      }
    }
    canvas.addEventListener("pointermove", (event) => {
      if ((!hoverEnabled && !linkedEnabled) || !plotted.length) return;
      const bounds = canvas.getBoundingClientRect();
      const cssX = event.clientX - bounds.left;
      const cssY = event.clientY - bounds.top;
      const pointerX = (cssX / bounds.width) * width;
      const pointerY = (cssY / bounds.height) * height;
      let nearest = null;
      let distance = Infinity;
      for (const point of plotted) {
        const squared = (point.x - pointerX) ** 2 + (point.y - pointerY) ** 2;
        if (squared < distance || (squared === distance && point.rowIndex < nearest.rowIndex)) {
          nearest = point;
          distance = squared;
        }
      }
      if (!nearest || distance > 225) {
        if (hovered !== -1) { hovered = -1; publishLinkedHighlight(null); draw(); }
        tooltip.hidden = true;
        return;
      }
      if (hovered !== nearest.rowIndex) { hovered = nearest.rowIndex; publishLinkedHighlight(nearest.row); draw(); }
      const details = pointDetails(nearest);
      tooltip.hidden = !tooltipFields.length;
      tooltip.style.left = `${Math.max(0, Math.min(cssX + 12, bounds.width - 210))}px`;
      tooltip.style.top = `${Math.max(0, Math.min(cssY + 12, bounds.height - 80))}px`;
      tooltip.textContent = details;
      summary.textContent = details.replaceAll("\n", " · ");
    });
    canvas.addEventListener("pointerleave", () => {
      hovered = -1;
      publishLinkedHighlight(null);
      tooltip.hidden = true;
      draw();
    });
    canvas.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hovered = -1;
        publishLinkedHighlight(null);
        tooltip.hidden = true;
        draw();
        return;
      }
      const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1
        : (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0);
      if (!direction || !plotted.length) return;
      event.preventDefault();
      const current = plotted.findIndex((point) => point.rowIndex === hovered);
      const next = current < 0
        ? (direction > 0 ? 0 : plotted.length - 1)
        : (current + direction + plotted.length) % plotted.length;
      const selected = plotted[next];
      hovered = selected.rowIndex;
      publishLinkedHighlight(selected.row);
      tooltip.hidden = true;
      draw();
      summary.textContent = pointDetails(selected).replaceAll("\n", " · ");
    });
    canvas.addEventListener("blur", () => {
      hovered = -1;
      publishLinkedHighlight(null);
      tooltip.hidden = true;
      draw();
    });

    canvas.__dashboardCanvasController = {
      interactionValues(interaction) {
        const field = interaction.type === "parameter" ? interaction.parameter : interaction.field;
        return unique(rows.map((row) => row[field]).filter((value) => value !== undefined));
      },
      setParameter(interaction, value) { state.set(interaction.id, value); hovered = -1; tooltip.hidden = true; publishLinkedHighlight(null); draw(); },
      setLegend(interaction, selected) { state.set(interaction.id, new Set(selected)); hovered = -1; tooltip.hidden = true; publishLinkedHighlight(null); draw(); },
      setLinkedHighlightHandler(interaction, handler) { linkedHighlightHandlers.set(interaction.id, handler); },
      setLinkedHighlight(interaction, key) {
        if (key === undefined || key === null) externalHighlights.delete(interaction.id);
        else externalHighlights.set(interaction.id, key);
        draw();
      }
    };
    draw();
    return holder;
  }

  function interpolateHex(left, right, ratio) {
    const read = (color, offset) => Number.parseInt(color.slice(offset, offset + 2), 16);
    const channelValueAt = (color, offset) => offset === 7 && color.length === 7 ? 255 : read(color, offset);
    const channel = (offset) => Math.round(channelValueAt(left, offset) + (channelValueAt(right, offset) - channelValueAt(left, offset)) * ratio);
    const red = channel(1);
    const green = channel(3);
    const blue = channel(5);
    if (left.length === 9 || right.length === 9) return `rgba(${red},${green},${blue},${(channel(7) / 255).toFixed(3)})`;
    const hex = (value) => value.toString(16).padStart(2, "0");
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
  }

  function interpolateColor(value, domain, diverging, palette) {
    const ratio = Math.max(0, Math.min(1, (value - domain[0]) / (domain[1] - domain[0] || 1)));
    if (Array.isArray(palette) && palette.length >= 2 && palette.every((color) => /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color))) {
      const scaled = ratio * (palette.length - 1);
      const index = Math.min(palette.length - 2, Math.floor(scaled));
      return interpolateHex(palette[index], palette[index + 1], scaled - index);
    }
    if (diverging) {
      if (ratio < 0.5) {
        const t = ratio * 2;
        return `rgb(${Math.round(50 + 205 * t)},${Math.round(105 + 150 * t)},${Math.round(170 + 85 * t)})`;
      }
      const t = (ratio - 0.5) * 2;
      return `rgb(${Math.round(255 - 80 * t)},${Math.round(255 - 210 * t)},${Math.round(255 - 205 * t)})`;
    }
    return `hsl(214 58% ${96 - ratio * 52}%)`;
  }

  function matrixGeometry(panel, figure, xCount, yCount, xLabels = [], yLabels = []) {
    const width = panelRenderWidth(panel, figure, 620);
    const right = 16;
    const bottom = 24;
    const maximumYLabelWidth = Math.max(0, ...yLabels.map((value) => approximateTextWidth(value, 9)));
    const labelledLeft = Math.min(
      Math.max(width < 420 ? 86 : 112, Math.ceil(maximumYLabelWidth + 20)),
      Math.max(86, width - right - 120)
    );
    const tentativeCellWidth = Math.max(1, width - labelledLeft - right) / Math.max(1, xCount);
    const maximumXLabelWidth = Math.max(0, ...xLabels.map((value) => approximateTextWidth(value, 9)));
    const safeXLabelWidth = Math.max(14, Math.min(140, tentativeCellWidth * 0.88 / Math.cos(38 * Math.PI / 180)));
    const labelledTop = Math.min(150, Math.max(64, Math.ceil(18 + Math.sin(38 * Math.PI / 180) * Math.min(maximumXLabelWidth, safeXLabelWidth))));
    const tentativePlotHeight = Math.min(320, Math.max(120, tentativeCellWidth * Math.max(1, yCount)));
    const showXLabels = xCount <= 48 && tentativeCellWidth >= 7;
    const showYLabels = yCount <= 48 && tentativePlotHeight / Math.max(1, yCount) >= 7;
    const margin = { top: showXLabels ? labelledTop : 16, right, bottom, left: showYLabels ? labelledLeft : 16 };
    const plotWidth = Math.max(1, width - margin.left - margin.right);
    const cellWidth = plotWidth / Math.max(1, xCount);
    const preferredPlotHeight = Math.min(320, Math.max(120, Math.min(32, cellWidth) * Math.max(1, yCount)));
    const naturalHeight = Math.max(220, margin.top + preferredPlotHeight + margin.bottom);
    const height = panelRenderHeight(panel, width, naturalHeight);
    const plotHeight = Math.max(1, height - margin.top - margin.bottom);
    const cellHeight = plotHeight / Math.max(1, yCount);
    const showCellText = cellWidth >= 18 && cellHeight >= 14;
    const cellStroke = Math.min(cellWidth, cellHeight) >= 2 ? COLORS.surface : "none";
    const cellStrokeWidth = cellStroke === "none" ? 0 : Math.min(1, Math.min(cellWidth, cellHeight) * 0.08);
    return { width, height, margin, cellWidth, cellHeight, showXLabels, showYLabels, showCellText, cellStroke, cellStrokeWidth };
  }

  function renderMatrixPanel(panel, figure) {
    const layer = (panel.layers || []).find((candidate) => candidate.mark?.type === "rect") || panel.layers?.[0];
    if (!layer) throw new Error(`Matrix panel ${panel.id} has no rect layer`);
    const textLayer = (panel.layers || []).find((candidate) => candidate.mark?.type === "text");
    const rows = layerRows(panel, layer);
    const encoding = layer.encoding || {};
    const xDefinition = scaleDefinition(figure, encoding.x);
    const yDefinition = scaleDefinition(figure, encoding.y);
    const xDomainBase = xDefinition?.domain || unique(rows.map((row) => channelValue(row, encoding.x)));
    const yDomainBase = yDefinition?.domain || unique(rows.map((row) => channelValue(row, encoding.y)));
    const xDomain = xDefinition?.reverse ? [...xDomainBase].reverse() : xDomainBase;
    const yDomain = yDefinition?.reverse ? [...yDomainBase].reverse() : yDomainBase;
    const quantitativeColor = encoding.color?.type === "quantitative";
    const values = quantitativeColor ? rows.map((row) => channelValue(row, encoding.color)).filter(finite) : [];
    const colorDefinition = scaleDefinition(figure, encoding.color);
    const { domain, diverging } = quantitativeColor
      ? resolveContinuousColorDomain(values, colorDefinition?.domain, encoding.color?.scale_role, colorDefinition?.scheme)
      : { domain: null, diverging: false };
    const categoricalColors = quantitativeColor ? null : colorScale(panel, figure);
    const { width, height, margin, cellWidth, cellHeight, showXLabels, showYLabels, showCellText, cellStroke, cellStrokeWidth } = matrixGeometry(panel, figure, xDomain.length, yDomain.length, xDomain, yDomain);
    const categoryKey = (value) => `${typeof value}:${String(value)}`;
    const xIndexByKey = new Map(xDomain.map((value, index) => [categoryKey(value), index]));
    const yIndexByKey = new Map(yDomain.map((value, index) => [categoryKey(value), index]));
    const svg = createSvg(width, height, panel.title || panel.id);
    const layerGroup = svgElement("g", { "data-panel-id": panel.id, "data-layer-id": layer.id });
    svg.append(layerGroup);
    const inlineTextGroup = encoding.text && showCellText
      ? svgElement("g", { "data-panel-id": panel.id, "data-layer-id": layer.id })
      : null;
    if (inlineTextGroup) svg.append(inlineTextGroup);
    if (showXLabels) xDomain.forEach((value, index) => {
      const x = margin.left + index * cellWidth + cellWidth / 2;
      const maximumWidth = Math.max(14, Math.min(140, cellWidth * 0.88 / Math.cos(38 * Math.PI / 180)));
      const label = addAxisText(svg, x, margin.top - 8, value, maximumWidth, { "text-anchor": "middle", "font-size": 9 });
      label.setAttribute("transform", `rotate(-38 ${x} ${margin.top - 8})`);
    });
    if (showYLabels) yDomain.forEach((value, index) => addAxisText(svg, margin.left - 8, margin.top + index * cellHeight + cellHeight / 2 + 3, value, Math.max(24, margin.left - 20), { "text-anchor": "end", "font-size": 9 }));
    for (const row of rows) {
      const xIndex = xIndexByKey.get(categoryKey(channelValue(row, encoding.x)));
      const yIndex = yIndexByKey.get(categoryKey(channelValue(row, encoding.y)));
      if (xIndex === undefined || yIndex === undefined) continue;
      const value = channelValue(row, encoding.color);
      const x = margin.left + xIndex * cellWidth;
      const y = margin.top + yIndex * cellHeight;
      const fill = quantitativeColor
        ? interpolateColor(value, domain, diverging, colorDefinition?.range)
        : categoricalColors(value);
      appendDataMark(layerGroup, svgElement("rect", { x, y, width: cellWidth, height: cellHeight, fill, stroke: cellStroke, "stroke-width": cellStrokeWidth }), row, figure, panel, layer);
      if (encoding.text && showCellText) {
        const labelValue = channelValue(row, encoding.text);
        if (labelValue !== undefined) decorateMark(addText(inlineTextGroup, x + cellWidth / 2, y + cellHeight / 2 + 4, formatValue(labelValue, encoding.text.format), { "text-anchor": "middle", fill: COLORS.ink, "font-size": Math.min(10, cellHeight * 0.34) }), row, figure, panel, layer);
      }
    }
    if (textLayer && showCellText) {
      const textEncoding = textLayer.encoding || {};
      const textGroup = svgElement("g", { "data-panel-id": panel.id, "data-layer-id": textLayer.id });
      svg.append(textGroup);
      for (const row of layerRows(panel, textLayer)) {
        const xIndex = xIndexByKey.get(categoryKey(channelValue(row, textEncoding.x)));
        const yIndex = yIndexByKey.get(categoryKey(channelValue(row, textEncoding.y)));
        if (xIndex === undefined || yIndex === undefined) continue;
        const labelValue = channelValue(row, textEncoding.text);
        if (labelValue === undefined) continue;
        decorateMark(addText(textGroup, margin.left + xIndex * cellWidth + cellWidth / 2, margin.top + yIndex * cellHeight + cellHeight / 2 + 4, formatValue(labelValue, textEncoding.text?.format), { "text-anchor": "middle", fill: COLORS.ink, "font-size": Math.min(10, cellHeight * 0.34) }), row, figure, panel, textLayer);
      }
    }
    return svg;
  }

  function renderTreePanel(panel, figure) {
    const nodeLayer = (panel.layers || []).find((layer) => layer.mark?.type === "node");
    const linkLayer = (panel.layers || []).find((layer) => layer.mark?.type === "link");
    if (!nodeLayer || !linkLayer) throw new Error(`Tree panel ${panel.id} requires node and link layers`);
    const nodes = layerRows(panel, nodeLayer);
    const edges = layerRows(panel, linkLayer);
    const nodeIdField = nodeLayer.encoding?.key?.field || "id";
    const fromField = linkLayer.encoding?.from?.field || "from";
    const toField = linkLayer.encoding?.to?.field || "to";
    const nodeIds = nodes.map((node) => node[nodeIdField]);
    const children = new Map(nodeIds.map((id) => [id, []]));
    const targets = new Set();
    edges.forEach((edge) => {
      children.get(edge[fromField])?.push(edge[toField]);
      targets.add(edge[toField]);
    });
    const rootId = nodeIds.find((id) => !targets.has(id));
    const levels = [];
    const queue = rootId === undefined ? [] : [{ id: rootId, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const item = queue.shift();
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      levels[item.depth] ||= [];
      levels[item.depth].push(item.id);
      for (const child of children.get(item.id) || []) queue.push({ id: child, depth: item.depth + 1 });
    }
    const width = panelRenderWidth(panel, figure, 920);
    const levelGap = 118;
    const height = Math.max(260, levels.length * levelGap + 40);
    const svg = createSvg(width, height, panel.title || panel.id);
    const linkGroup = svgElement("g", { "data-panel-id": panel.id, "data-layer-id": linkLayer.id });
    const nodeGroup = svgElement("g", { "data-panel-id": panel.id, "data-layer-id": nodeLayer.id });
    append(svg, linkGroup, nodeGroup);
    const linkColor = colorScale({ layers: [linkLayer], data_ref: linkLayer.data_ref || panel.data_ref }, figure);
    const positions = new Map();
    levels.forEach((level, depth) => level.forEach((id, index) => positions.set(id, { x: ((index + 1) * width) / (level.length + 1), y: 42 + depth * levelGap })));
    edges.forEach((edge, edgeIndex) => {
      const from = positions.get(edge[fromField]);
      const to = positions.get(edge[toField]);
      if (!from || !to) return;
      const stroke = linkLayer.encoding?.color ? linkColor(channelValue(edge, linkLayer.encoding.color), edgeIndex) : COLORS.axis;
      appendDataMark(linkGroup, svgElement("line", { x1: from.x, y1: from.y + 28, x2: to.x, y2: to.y - 28, stroke, "stroke-width": linkLayer.mark?.stroke_width || 1.5, opacity: linkLayer.mark?.opacity ?? 1 }), edge, figure, panel, linkLayer);
      if (linkLayer.encoding?.text) addText(svg, (from.x + to.x) / 2, (from.y + to.y) / 2, channelValue(edge, linkLayer.encoding.text), { "text-anchor": "middle", "font-size": 9 });
    });
    const nodeColor = colorScale({ layers: [nodeLayer], data_ref: nodeLayer.data_ref || panel.data_ref }, figure);
    nodes.forEach((node, index) => {
      const position = positions.get(node[nodeIdField]);
      if (!position) return;
      const category = channelValue(node, nodeLayer.encoding?.color);
      const fill = nodeLayer.encoding?.color ? nodeColor(category, index) : "#eaf1fb";
      appendDataMark(nodeGroup, svgElement("rect", { x: position.x - 66, y: position.y - 29, width: 132, height: 58, rx: 6, fill, opacity: nodeLayer.mark?.opacity ?? 0.34, stroke: fill, "stroke-width": 1.4 }), node, figure, panel, nodeLayer);
      const declaredTextChannels = Array.isArray(nodeLayer.encoding?.text)
        ? nodeLayer.encoding.text
        : (nodeLayer.encoding?.text ? [nodeLayer.encoding.text] : []);
      const textChannels = declaredTextChannels.length
        ? declaredTextChannels
        : (nodeLayer.encoding?.key ? [nodeLayer.encoding.key] : []);
      const lines = textChannels.map((channel) => channelValue(node, channel));
      lines.filter((value) => value !== undefined).slice(0, 3).forEach((value, lineIndex) => addText(svg, position.x, position.y - 10 + lineIndex * 14, value, { "text-anchor": "middle", fill: COLORS.ink, "font-size": lineIndex === 0 ? 9.5 : 8.5, "font-weight": lineIndex === 0 ? 700 : 400 }));
    });
    return svg;
  }

  function renderFlowPanel(panel, figure) {
    const layer = (panel.layers || []).find((candidate) => candidate.mark?.type === "node");
    if (!layer) throw new Error(`Flow panel ${panel.id} requires a node layer`);
    const rows = layerRows(panel, layer);
    const declaredText = Array.isArray(layer.encoding?.text) ? layer.encoding.text[0] : layer.encoding?.text;
    const labelChannel = declaredText || layer.encoding?.key;
    const width = panelRenderWidth(panel, figure, 540);
    const height = Math.max(210, rows.length * 66 + 30);
    const svg = createSvg(width, height, panel.title || panel.id);
    const nodeGroup = svgElement("g", { "data-panel-id": panel.id, "data-layer-id": layer.id });
    svg.append(nodeGroup);
    const nodeColor = colorScale({ layers: [layer], data_ref: layer.data_ref || panel.data_ref }, figure);
    rows.forEach((row, index) => {
      const y = 20 + index * 64;
      if (index > 0) {
        svg.append(svgElement("line", { x1: width / 2, y1: y - 18, x2: width / 2, y2: y, stroke: COLORS.axis, "stroke-width": 1.5 }));
        svg.append(svgElement("polygon", { points: `${width / 2 - 4},${y - 3} ${width / 2 + 4},${y - 3} ${width / 2},${y + 4}`, fill: COLORS.axis }));
      }
      const encodedColor = layer.encoding?.color ? nodeColor(channelValue(row, layer.encoding.color), index) : null;
      const fill = encodedColor || (index === 0 ? DEFAULT_PALETTE[0] : COLORS.surface);
      const stroke = encodedColor || "#2f63b5";
      appendDataMark(nodeGroup, svgElement("rect", { x: width * 0.2, y, width: width * 0.6, height: 42, rx: 4, fill, stroke, "stroke-width": 1.6, opacity: layer.mark?.opacity ?? 1 }), row, figure, panel, layer);
      addText(svg, width / 2, y + 26, channelValue(row, labelChannel), { "text-anchor": "middle", fill: encodedColor || (index === 0 ? COLORS.surface : COLORS.muted), "font-size": 12, "font-weight": 650 });
    });
    return svg;
  }

  const panelRenderers = {
    cartesian: renderCartesianPanel,
    canvas: renderCanvasPanel,
    matrix: renderMatrixPanel,
    tree: renderTreePanel,
    flow: renderFlowPanel,
    diagram: renderFlowPanel
  };

  function colorbarLegend(channel, domain, diverging, definition, vertical = false) {
    const legend = htmlElement("div", `v3-colorbar${vertical ? " vertical" : ""}`);
    const titleText = channel.legend?.title || channel.title || definition?.title || channel.field || "Colour scale";
    legend.setAttribute("aria-label", titleText);
    const title = htmlElement("span", "v3-colorbar-title", titleText);
    const bar = htmlElement("span", "v3-colorbar-ramp");
    const direction = vertical ? "0deg" : "90deg";
    if (diverging) bar.style.background = `linear-gradient(${direction}, ${interpolateColor(domain[0], domain, true, definition?.range)}, ${interpolateColor((domain[0] + domain[1]) / 2, domain, true, definition?.range)}, ${interpolateColor(domain[1], domain, true, definition?.range)})`;
    else bar.style.background = `linear-gradient(${direction}, ${interpolateColor(domain[0], domain, false, definition?.range)}, ${interpolateColor(domain[1], domain, false, definition?.range)})`;
    const minimum = htmlElement("span", "v3-colorbar-value minimum", formatNumber(domain[0]));
    const maximum = htmlElement("span", "v3-colorbar-value maximum", formatNumber(domain[1]));
    if (vertical) append(legend, title, maximum, bar, minimum);
    else append(legend, title, minimum, bar, maximum);
    return legend;
  }

  function createPanelLegend(panel, figure) {
    const categoricalLegend = (layer, channel) => {
      const explicitLegend = channel.legend === true || (channel.legend && typeof channel.legend === "object");
      if (!Object.hasOwn(channel, "field") && !explicitLegend) return null;
      const colors = colorScale(panel, figure);
      const definition = scaleDefinition(figure, channel);
      const localDomain = definition?.domain || unique(layerRows(panel, layer)
        .map((row) => channelValue(row, channel))
        .filter((value) => value !== undefined && value !== null))
        .sort(stableValueCompare);
      if (!localDomain.length || localDomain.length > 20) return null;
      const legend = htmlElement("div", "v3-legend");
      if (channel.legend?.title || channel.title) legend.append(htmlElement("span", "v3-legend-title", channel.legend?.title || channel.title));
      localDomain.forEach((value, index) => {
        const item = htmlElement("span", "v3-legend-item");
        const swatch = htmlElement("span", "v3-legend-swatch");
        swatch.style.background = colors(value, index);
        append(item, swatch, document.createTextNode(String(value)));
        legend.append(item);
      });
      return legend;
    };
    const coordinate = typeof panel.coordinate === "string" ? panel.coordinate : panel.coordinate?.type;
    if (coordinate === "matrix") {
      const layer = (panel.layers || []).find((candidate) => candidate.mark?.type === "rect");
      const channel = layer?.encoding?.color;
      if (!layer || !channel || channel.legend === false) return null;
      if (["nominal", "ordinal"].includes(channel.type)) return categoricalLegend(layer, channel);
      if (channel.type !== "quantitative") return null;
      const values = layerRows(panel, layer).map((row) => channelValue(row, channel)).filter(finite);
      const definition = scaleDefinition(figure, channel);
      const { domain, diverging } = resolveContinuousColorDomain(values, definition?.domain, channel.scale_role, definition?.scheme);
      return colorbarLegend(channel, domain, diverging, definition, true);
    }

    for (const layer of panel.layers || []) {
      const channel = layer.encoding?.color || layer.encoding?.stroke;
      if (!channel || channel.legend === false) continue;
      if (channel.type === "quantitative") {
        const definition = scaleDefinition(figure, channel);
        const values = layerRows(panel, layer).map((row) => channelValue(row, channel)).filter(finite);
        const { domain, diverging } = resolveContinuousColorDomain(values, definition?.domain, channel.scale_role, definition?.scheme);
        return colorbarLegend(channel, domain, diverging, definition);
      }
      if (!["nominal", "ordinal"].includes(channel.type)) continue;
      if (interactionsFor(figure, "legend_filter", panel, layer).length) return null;
      return categoricalLegend(layer, channel);
    }
    return null;
  }

  function renderPanel(panel, figure) {
    const wrapper = htmlElement("section", "v3-panel");
    wrapper.dataset.panelId = panel.id;
    const coordinate = typeof panel.coordinate === "string" ? panel.coordinate : panel.coordinate?.type || "cartesian";
    wrapper.dataset.coordinate = coordinate;
    const placement = panelGridPlacement(panel, figure);
    if (placement) {
      wrapper.style.gridColumn = `${placement.column} / span ${placement.columnSpan}`;
      wrapper.style.gridRow = `${placement.row} / span ${placement.rowSpan}`;
    }
    if (panel.title) wrapper.append(htmlElement("h5", "v3-panel-title", panel.title));
    if (panel.subtitle) wrapper.append(htmlElement("p", "v3-panel-subtitle", panel.subtitle));
    if (panel.description) wrapper.append(markdownParagraph(panel.description, "v3-panel-subtitle"));
    const renderer = panelRenderers[coordinate];
    if (!renderer) throw new Error(`Unsupported coordinate: ${coordinate}`);
    const visual = renderer(panel, figure);
    const legend = createPanelLegend(panel, figure);
    if (coordinate === "matrix" && legend?.classList.contains("v3-colorbar")) {
      const visualRow = htmlElement("div", "v3-matrix-visual");
      append(visualRow, visual, legend);
      wrapper.append(visualRow);
    } else {
      wrapper.append(visual);
      if (legend) wrapper.append(legend);
    }
    return wrapper;
  }

  function updateMarkVisibility(mark, interactionId, visible) {
    mark.__dashboardVisibility ||= new Map();
    mark.__dashboardVisibility.set(interactionId, visible);
    mark.style.display = [...mark.__dashboardVisibility.values()].every(Boolean) ? "" : "none";
  }

  function updateMarkHighlight(mark, interactionId, matches) {
    mark.__dashboardHighlights ||= new Map();
    if (matches === undefined || matches === null) mark.__dashboardHighlights.delete(interactionId);
    else mark.__dashboardHighlights.set(interactionId, matches);
    mark.classList.toggle("v3-linked-muted", [...mark.__dashboardHighlights.values()].some((value) => !value));
  }

  function marksForInteraction(card, interaction) {
    return [...card.querySelectorAll(".v3-mark")].filter((mark) => mark.__dashboardInteractionValues?.has(interaction.id));
  }

  function canvasesForInteraction(card, interaction) {
    const targets = new Set((interaction.targets || []).map(canonicalInteractionTarget));
    return [...card.querySelectorAll("canvas.v3-canvas")].filter((canvas) => {
      const panelTarget = canvas.dataset.panelId;
      const layerTarget = `${panelTarget}/${canvas.dataset.layerId}`;
      return canvas.__dashboardCanvasController && (targets.has(panelTarget) || targets.has(layerTarget));
    });
  }

  function clearLinkedHighlights(card) {
    for (const clear of card.__dashboardLinkedClearers || []) clear();
  }

  function addLegendFilterControl(container, card, interaction) {
    const marks = marksForInteraction(card, interaction);
    const canvases = canvasesForInteraction(card, interaction);
    const values = unique([
      ...marks.map((mark) => mark.__dashboardInteractionValues.get(interaction.id)),
      ...canvases.flatMap((canvas) => canvas.__dashboardCanvasController.interactionValues(interaction))
    ].filter((value) => value !== undefined));
    if (!values.length) return;
    const group = htmlElement("fieldset", "v3-control-group v3-legend-filter");
    group.append(htmlElement("legend", "v3-control-label", interaction.label || interaction.field));
    const selected = new Set(values.map((value) => `${typeof value}:${String(value)}`));
    const apply = () => {
      clearLinkedHighlights(card);
      marks.forEach((mark) => {
        const value = mark.__dashboardInteractionValues.get(interaction.id);
        updateMarkVisibility(mark, interaction.id, selected.has(`${typeof value}:${String(value)}`));
      });
      canvases.forEach((canvas) => canvas.__dashboardCanvasController.setLegend(interaction, selected));
    };
    values.forEach((value) => {
      const key = `${typeof value}:${String(value)}`;
      const button = htmlElement("button", "v3-filter-chip on", value);
      button.type = "button";
      button.setAttribute("aria-pressed", "true");
      button.addEventListener("click", () => {
        if (interaction.multi === false) selected.clear();
        if (selected.has(key) && (interaction.multi !== false || selected.size === 1)) selected.delete(key);
        else selected.add(key);
        for (const peer of group.querySelectorAll("button")) {
          const peerKey = peer.__dashboardValueKey;
          const active = selected.has(peerKey);
          peer.classList.toggle("on", active);
          peer.setAttribute("aria-pressed", String(active));
        }
        apply();
      });
      button.__dashboardValueKey = key;
      group.append(button);
    });
    container.append(group);
  }

  function addParameterControl(container, card, interaction) {
    const marks = marksForInteraction(card, interaction);
    const canvases = canvasesForInteraction(card, interaction);
    const available = unique([
      ...marks.map((mark) => mark.__dashboardInteractionValues.get(interaction.id)),
      ...canvases.flatMap((canvas) => canvas.__dashboardCanvasController.interactionValues(interaction))
    ].filter((value) => value !== undefined));
    const options = interaction.options?.length ? interaction.options : available;
    if (!options.length) return;
    const group = htmlElement("label", "v3-control-group v3-parameter-control");
    group.append(htmlElement("span", "v3-control-label", interaction.label || interaction.parameter));
    const control = interaction.control === "range" ? htmlElement("input", "v3-range") : htmlElement("select", "v3-select");
    let current = interaction.default;
    if (interaction.control === "range") {
      control.type = "range";
      control.min = interaction.minimum;
      control.max = interaction.maximum;
      control.step = interaction.step;
      control.value = current;
      const output = htmlElement("output", "v3-range-output", current);
      group.append(control, output);
      control.addEventListener("input", () => { current = Number(control.value); output.value = current; apply(); });
    } else {
      const typedValues = new Map();
      options.forEach((value, index) => {
        const key = `option-${index}`;
        typedValues.set(key, value);
        const option = htmlElement("option", "", value);
        option.value = key;
        if (Object.is(value, current)) option.selected = true;
        control.append(option);
      });
      if (!options.some((value) => Object.is(value, current))) current = options[0];
      group.append(control);
      control.addEventListener("change", () => { current = typedValues.get(control.value); apply(); });
    }
    function apply() {
      clearLinkedHighlights(card);
      marks.forEach((mark) => updateMarkVisibility(mark, interaction.id, Object.is(mark.__dashboardInteractionValues.get(interaction.id), current)));
      canvases.forEach((canvas) => canvas.__dashboardCanvasController.setParameter(interaction, current));
    }
    apply();
    container.append(group);
  }

  function addZoomControl(container, card, interaction) {
    const panelIds = new Set((interaction.targets || []).map(canonicalInteractionTarget).map((target) => target.split("/")[0]));
    const panels = [...card.querySelectorAll(".v3-panel")].filter((panel) => panelIds.has(panel.dataset.panelId));
    const svgs = panels.map((panel) => panel.querySelector("svg")).filter(Boolean);
    if (!svgs.length) return;
    const originals = new Map(svgs.map((svg) => [svg, svg.getAttribute("viewBox").split(/\s+/).map(Number)]));
    const group = htmlElement("div", "v3-control-group v3-zoom-control");
    group.append(htmlElement("span", "v3-control-label", interaction.label || "Zoom"));
    const change = (factor) => svgs.forEach((svg) => {
      const current = svg.getAttribute("viewBox").split(/\s+/).map(Number);
      const nextWidth = current[2] * factor;
      const nextHeight = current[3] * factor;
      svg.setAttribute("viewBox", `${current[0] + (current[2] - nextWidth) / 2} ${current[1] + (current[3] - nextHeight) / 2} ${nextWidth} ${nextHeight}`);
    });
    append(group,
      quietButton("+", () => change(0.8)),
      quietButton("−", () => change(1.25)),
      quietButton(labels.reset, () => originals.forEach((box, svg) => svg.setAttribute("viewBox", box.join(" "))))
    );
    container.append(group);
  }

  function wireLinkedHighlights(card, figure) {
    for (const interaction of (figure.interactions || []).filter((item) => item.type === "linked_highlight")) {
      const marks = marksForInteraction(card, interaction);
      const canvases = canvasesForInteraction(card, interaction);
      const applyHighlight = (key) => {
        marks.forEach((mark) => {
          const active = key !== undefined && key !== null;
          updateMarkHighlight(mark, interaction.id, active ? mark.__dashboardInteractionValues.get(interaction.id) === key : null);
        });
        canvases.forEach((canvas) => canvas.__dashboardCanvasController.setLinkedHighlight(interaction, key));
      };
      card.__dashboardLinkedClearers ||= [];
      card.__dashboardLinkedClearers.push(() => applyHighlight(null));
      marks.forEach((mark) => {
        mark.addEventListener("mouseenter", () => applyHighlight(mark.__dashboardInteractionValues.get(interaction.id)));
        mark.addEventListener("mouseleave", () => applyHighlight(null));
      });
      canvases.forEach((canvas) => canvas.__dashboardCanvasController.setLinkedHighlightHandler(interaction, applyHighlight));
    }
  }

  function addInteractionControls(card, figure) {
    const interactions = figure.interactions || [];
    const controls = htmlElement("div", "v3-interaction-controls");
    interactions.forEach((interaction) => {
      if (interaction.type === "legend_filter") addLegendFilterControl(controls, card, interaction);
      else if (interaction.type === "parameter") addParameterControl(controls, card, interaction);
      else if (interaction.type === "zoom") addZoomControl(controls, card, interaction);
    });
    wireLinkedHighlights(card, figure);
    if (controls.childElementCount) card.insertBefore(controls, card.querySelector(".v3-figure-grid"));
  }

  function renderFigure(figure) {
    const card = htmlElement("section", "artifact-card v3-figure-card wide");
    card.dataset.figureId = figure.id;
    card.setAttribute("aria-label", figure.title || figure.id);
    if (presentation.showFigureTitles && figure.title) card.append(htmlElement("h4", "artifact-title v3-figure-title", figure.title));
    if (presentation.showFigureDescriptions && figure.description) card.append(markdownParagraph(figure.description, "artifact-description"));
    const grid = htmlElement("div", "v3-figure-grid");
    const layoutType = figure.layout?.type || "grid";
    const columns = layoutType === "single" ? 1 : Math.max(1, Math.min(figure.layout?.columns || 1, 12));
    grid.style.setProperty("--figure-columns", columns);
    if (Array.isArray(figure.layout?.column_weights) && figure.layout.column_weights.length === columns) {
      grid.style.gridTemplateColumns = figure.layout.column_weights
        .map((weight) => `minmax(0, ${weight}fr)`)
        .join(" ");
    }
    if (layoutType === "flow") grid.classList.add("v3-flow-layout");
    if (figure.layout?.gap) grid.style.gap = `${figure.layout.gap}px`;
    if (figure.layout?.row_gap) grid.style.rowGap = `${figure.layout.row_gap}px`;
    if (figure.layout?.column_gap) grid.style.columnGap = `${figure.layout.column_gap}px`;
    try {
      for (const panel of figure.panels || []) grid.append(renderPanel(panel, figure));
    } catch (error) {
      grid.replaceChildren(htmlElement("div", "render-error", `${figure.id}: ${error.message}`));
      card.dataset.renderError = "true";
    }
    card.append(grid);
    addInteractionControls(card, figure);
    if (figure.caption) card.append(markdownParagraph(figure.caption, "artifact-note v3-figure-caption"));
    for (const note of figure.notes || []) card.append(markdownParagraph(note, "artifact-note"));
    return card;
  }

  function setCollapsed(container, collapsed) {
    container.classList.toggle("collapsed", collapsed);
    const trigger = container.querySelector(".panel-head, .utility-head");
    if (trigger) trigger.setAttribute("aria-expanded", String(!collapsed));
  }

  function bindToggle(container, trigger) {
    trigger.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      setCollapsed(container, !container.classList.contains("collapsed"));
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setCollapsed(container, !container.classList.contains("collapsed"));
    });
  }

  function quietButton(label, action) {
    const button = htmlElement("button", "quiet-button", label);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }

  function allPanels(collapsed) {
    document.querySelectorAll(".panel").forEach((panel) => setCollapsed(panel, collapsed));
  }

  function createNav(shell) {
    const nav = htmlElement("nav", "navbar");
    const home = htmlElement("a", "nav-home", payload.report?.title || payload.header?.title || payload.dataset?.name || "Dashboard");
    home.href = "#top";
    const links = htmlElement("span", "nav-acts");
    const navigationItems = payload.acts?.length ? payload.acts : payload.sections || [];
    for (const item of navigationItems) {
      const link = htmlElement("a", "", item.short_label || item.title || item.id);
      link.href = payload.acts?.length ? `#act-${item.id}` : `#section-${item.id}`;
      if (!payload.acts?.length) link.dataset.sectionLink = item.id;
      links.append(link);
    }
    const tools = htmlElement("span", "nav-tools");
    append(tools, quietButton(labels.fold_all, () => allPanels(true)), quietButton(labels.unfold_all, () => allPanels(false)));
    append(nav, home, links, tools);
    shell.append(nav);
  }

  function createHero(shell) {
    const header = payload.report || payload.header || {};
    const hero = htmlElement("header", "hero");
    hero.id = "top";
    append(hero, htmlElement("h1", "", header.title || payload.dataset?.name || "Scientific report"));
    if (header.subtitle) hero.append(htmlElement("p", "subtitle", header.subtitle));
    if (header.summary) hero.append(markdownParagraph(header.summary, "report-summary"));
    const facts = htmlElement("div", "facts");
    for (const fact of header.facts || []) {
      const item = htmlElement("div", "fact");
      if (fact.label) item.append(document.createTextNode(`${fact.label} `));
      item.append(htmlElement("strong", "", fact.value));
      if (fact.detail) item.append(document.createTextNode(` ${fact.detail}`));
      facts.append(item);
    }
    if (facts.childElementCount) hero.append(facts);
    if (header.claim) {
      const claim = htmlElement("div", "claim");
      claim.append(htmlElement("div", "eyebrow", labels.report_claim));
      claim.append(markdownParagraph(header.claim?.text || header.claim));
      hero.append(claim);
    }
    if (header.final_verdict) {
      const verdict = htmlElement("div", "final-verdict");
      verdict.append(markdownParagraph(header.final_verdict));
      hero.append(verdict);
    }
    shell.append(hero);
  }

  function createCoverage(shell) {
    const section = htmlElement("section", "coverage");
    const top = htmlElement("div", "coverage-top");
    const sectionCount = (payload.sections || []).length;
    const formattedCount = localizedNumber(sectionCount, { maximumFractionDigits: 0 });
    const englishNoun = /^en(?:-|$)/i.test(presentation.locale)
      ? ` ${sectionCount === 1 ? "section" : "sections"}`
      : "";
    top.append(htmlElement("div", "section-label", `${labels.coverage} — ${formattedCount}${englishNoun}`));
    const tools = htmlElement("span", "nav-tools");
    append(tools, quietButton(labels.fold_all, () => allPanels(true)), quietButton(labels.unfold_all, () => allPanels(false)));
    top.append(tools);
    const grid = htmlElement("div", "coverage-grid");
    for (const [index, item] of (payload.sections || []).entries()) {
      const link = htmlElement("a", "coverage-link");
      link.href = `#section-${item.id}`;
      const fallbackNumber = presentation.themeName === "tess" ? index : index + 1;
      if (presentation.showSectionNumbers) link.append(htmlElement("span", "coverage-num", String(item.number ?? fallbackNumber).padStart(2, "0")));
      link.append(htmlElement("span", "coverage-title", item.short_label || item.title || item.id));
      grid.append(link);
    }
    append(section, top, grid);
    shell.append(section);
  }

  const figuresById = new Map((payload.figures || []).map((figure) => [figure.id, figure]));
  function createSectionPanel(section, index) {
    const panel = htmlElement("article", "panel");
    panel.id = `section-${section.id}`;
    panel.dataset.sectionId = section.id;
    const head = htmlElement("div", "panel-head");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", "true");
    const figureRefs = section.figure_ids || section.figure_refs || [];
    const top = htmlElement("a", "to-top", labels.top);
    top.href = "#top";
    head.append(htmlElement("span", "chev"));
    if (presentation.showSectionNumbers) {
      const fallbackNumber = presentation.themeName === "tess" ? index : index + 1;
      const number = String(section.number ?? fallbackNumber).padStart(2, "0");
      head.append(htmlElement("span", "stage-number", `${presentation.sectionPrefix}${presentation.sectionPrefix ? " " : ""}${number}`));
    }
    append(head,
      htmlElement("span", "stage-title", section.title || section.id),
      htmlElement("span", "stage-badge", section.badge || `${figureRefs.length} ${figureRefs.length === 1 && labels.figures === DEFAULT_LABELS.figures ? "figure" : labels.figures}`),
      top
    );
    const body = htmlElement("div", "panel-body");
    if (section.concepts?.length) {
      const concepts = htmlElement("div", "concepts");
      concepts.append(htmlElement("span", "section-label", labels.concepts_used));
      section.concepts.forEach((concept, conceptIndex) => {
        if (conceptIndex > 0) concepts.append(document.createTextNode(" · "));
        const item = htmlElement("span", "concept-item");
        appendInlineMarkdown(item, concept);
        concepts.append(item);
      });
      body.append(concepts);
    }
    if (section.summary) body.append(markdownParagraph(section.summary, "summary"));
    if (section.metrics?.length) {
      const metrics = htmlElement("div", "metric-strip");
      section.metrics.forEach((metric) => {
        const item = htmlElement("span", "metric-pill");
        append(item, document.createTextNode(`${metric.name} `), htmlElement("strong", "", formatNumber(metric.value)), metric.unit ? document.createTextNode(` ${metric.unit}`) : null);
        metrics.append(item);
      });
      body.append(metrics);
    }
    if (section.checks?.length) {
      const checks = htmlElement("div", "check-list");
      section.checks.forEach((check) => {
        const status = labels[`status_${check.result}`] || check.result;
        const chip = htmlElement("span", `check-chip ${check.result === "pass" ? "pass" : check.result === "fail" ? "fail" : "other"}`, `${check.label || check.id}: ${status}`);
        if (check.detail) chip.title = check.detail;
        checks.append(chip);
      });
      body.append(checks);
    }
    let figureGrid = null;
    if (figureRefs.length) {
      figureGrid = htmlElement("div", "artifact-grid v3-section-figures");
      for (const reference of figureRefs) {
        const figure = figuresById.get(reference);
        if (!figure) throw new Error(`Section ${section.id} references unknown figure ${reference}`);
        figureGrid.append(renderFigure(figure));
      }
    }
    const figuresAfterFindings = section.figure_position === "after_findings";
    if (!figuresAfterFindings && figureGrid) body.append(figureGrid);
    const findings = [...(section.findings || []), ...(section.narrative || [])];
    if (findings.length) {
      const narrative = htmlElement("div", "narrative");
      findings.forEach((paragraph) => narrative.append(markdownParagraph(paragraph, "finding")));
      body.append(narrative);
    }
    if (figuresAfterFindings && figureGrid) body.append(figureGrid);
    if (section.method_notes?.length) {
      const notes = htmlElement("div", "method-notes");
      section.method_notes.forEach((note) => {
        const item = htmlElement("div", `method-note ${note.kind}`);
        append(item, htmlElement("strong", "", note.label || labels[note.kind] || labels.note), document.createTextNode(" "));
        appendInlineMarkdown(item, note.text);
        notes.append(item);
      });
      body.append(notes);
    }
    if (section.caveats?.length) {
      const caveats = htmlElement("div", "caveats");
      section.caveats.forEach((caveat) => {
        const text = typeof caveat === "string" ? caveat : caveat.text;
        const paragraph = markdownParagraph(text);
        if (typeof caveat === "object") paragraph.dataset.caveatKind = caveat.kind;
        caveats.append(paragraph);
      });
      body.append(caveats);
    }
    append(panel, head, body);
    bindToggle(panel, head);
    if (section.initial_state === "closed") setCollapsed(panel, true);
    return panel;
  }

  function createActGroup(act, sectionIndex) {
    const group = htmlElement("section", "act");
    group.id = `act-${act.id}`;
    const heading = htmlElement("div", "act-heading");
    const label = [act.numeral, act.title].filter(Boolean).join(" · ");
    const top = htmlElement("a", "to-top", labels.top);
    top.href = "#top";
    append(heading, htmlElement("h2", "", label || act.id), top);
    group.append(heading);
    for (const sectionId of act.section_ids || []) {
      const section = (payload.sections || []).find((candidate) => candidate.id === sectionId);
      if (!section) throw new Error(`Act ${act.id} references unknown section ${sectionId}`);
      group.append(createSectionPanel(section, sectionIndex.get(sectionId)));
    }
    return group;
  }

  function createFooter(shell) {
    const footer = htmlElement("footer", "build-footer");
    const hash = buildMeta.payload_sha256 ? buildMeta.payload_sha256.slice(0, 16) : "unknown";
    const details = [
      labels.standalone_package,
      `${labels.schema} ${payload.schema_version || payload.source_schema_version}`,
      `${localizedNumber(buildMeta.figure_count ?? payload.figures?.length ?? 0, { maximumFractionDigits: 0 })} ${labels.figures}`,
      payload.run?.seed !== undefined ? `${labels.seed} ${payload.run.seed}` : null,
      `${labels.payload_sha256} ${hash}…`,
      `${labels.renderer} ${buildMeta.generator_version}`
    ].filter(Boolean);
    footer.append(htmlElement("div", "", details.join(" · ")));
    if (payload.provenance?.notes) footer.append(htmlElement("div", "build-provenance", payload.provenance.notes));
    shell.append(footer);
  }

  function buildDashboard() {
    const sourceVersion = payload.schema_version || payload.source_schema_version;
    if (!/^3\./.test(sourceVersion || "")) throw new Error(`v3 runtime received unsupported schema ${String(sourceVersion)}`);
    const shell = htmlElement("main", "shell v3-shell");
    if (!presentation.showSectionNumbers) shell.classList.add("no-section-numbers");
    applyTheme(shell);
    createNav(shell);
    createHero(shell);
    if (presentation.showCoverage) createCoverage(shell);
    const sectionIndex = new Map((payload.sections || []).map((section, index) => [section.id, index]));
    if (payload.acts?.length) payload.acts.forEach((act) => shell.append(createActGroup(act, sectionIndex)));
    else (payload.sections || []).forEach((section, index) => shell.append(createSectionPanel(section, index)));
    if (presentation.showBuildFooter) createFooter(shell);
    root.replaceChildren(shell);
    root.dataset.dashboardStatus = root.querySelector("[data-render-error='true'], .render-error") ? "error" : "ready";
  }

  try {
    buildDashboard();
  } catch (error) {
    root.replaceChildren(htmlElement("div", "render-error", `Dashboard render failed: ${error.message}`));
    root.dataset.dashboardStatus = "error";
    throw error;
  }
})();
