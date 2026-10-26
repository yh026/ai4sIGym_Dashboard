(() => {
  "use strict";

  const payloadNode = document.getElementById("dashboard-payload");
  const metaNode = document.getElementById("dashboard-build-meta");
  const root = document.getElementById("dashboard-root");
  const payload = JSON.parse(payloadNode.textContent);
  const buildMeta = JSON.parse(metaNode.textContent);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const palette = ["#2f63b5", "#df6400", "#00ae7a", "#cf4f8b", "#e7b400", "#8c96a5"];
  const ink = "#16181d";
  const muted = "#6d7480";
  const grid = "#dfe3e8";

  function htmlElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgElement(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    return node;
  }

  function append(parent, ...children) {
    for (const child of children.flat()) {
      if (child !== undefined && child !== null) parent.append(child);
    }
    return parent;
  }

  function formatNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return String(value ?? "—");
    const absolute = Math.abs(value);
    if (absolute >= 1000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
    if (absolute === 0) return "0";
    if (absolute < 0.001) return value.toExponential(2);
    if (absolute < 1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function humanize(value) {
    return String(value || "artifact")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function truncate(value, length = 34) {
    const text = String(value ?? "");
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  function appendInlineMarkdown(parent, source) {
    const text = String(source ?? "");
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("**")) {
        parent.append(htmlElement("strong", "", token.slice(2, -2)));
      } else {
        parent.append(htmlElement("code", "", token.slice(1, -1)));
      }
      cursor = match.index + token.length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function markdownParagraph(source, className = "") {
    const paragraph = htmlElement("p", className);
    appendInlineMarkdown(paragraph, source);
    return paragraph;
  }

  function linearScale(domainMin, domainMax, rangeMin, rangeMax) {
    const span = domainMax - domainMin || 1;
    return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
  }

  function extent(values) {
    const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    return finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 1];
  }

  function paddedExtent(values, fraction = 0.08) {
    let [minimum, maximum] = extent(values);
    if (minimum === maximum) {
      const padding = Math.abs(minimum || 1) * 0.1;
      return [minimum - padding, maximum + padding];
    }
    const padding = (maximum - minimum) * fraction;
    return [minimum - padding, maximum + padding];
  }

  function ticks(minimum, maximum, count = 5) {
    if (count <= 0) return [];
    if (minimum === maximum) return [minimum];
    return Array.from({ length: count + 1 }, (_, index) => minimum + ((maximum - minimum) * index) / count);
  }

  function addSvgText(svg, x, y, value, attrs = {}) {
    const node = svgElement("text", { x, y, fill: muted, "font-size": 11, ...attrs });
    node.textContent = String(value);
    svg.append(node);
    return node;
  }

  function createSvg(width, height, label) {
    return svgElement("svg", {
      class: "chart-svg",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": label,
      preserveAspectRatio: "xMidYMid meet"
    });
  }

  function drawNumericAxes(svg, config) {
    const { width, height, margin, xDomain, yDomain, xLabel, yLabel, xTickCount = 5, yTickCount = 5 } = config;
    const x = linearScale(xDomain[0], xDomain[1], margin.left, width - margin.right);
    const y = linearScale(yDomain[0], yDomain[1], height - margin.bottom, margin.top);
    const xTicks = ticks(xDomain[0], xDomain[1], xTickCount);
    const yTicks = ticks(yDomain[0], yDomain[1], yTickCount);

    for (const tick of yTicks) {
      const yPosition = y(tick);
      svg.append(svgElement("line", { x1: margin.left, y1: yPosition, x2: width - margin.right, y2: yPosition, stroke: grid, "stroke-width": 1 }));
      addSvgText(svg, margin.left - 8, yPosition + 4, formatNumber(tick), { "text-anchor": "end" });
    }
    for (const tick of xTicks) {
      const xPosition = x(tick);
      svg.append(svgElement("line", { x1: xPosition, y1: margin.top, x2: xPosition, y2: height - margin.bottom, stroke: grid, "stroke-width": 1 }));
      addSvgText(svg, xPosition, height - margin.bottom + 18, formatNumber(tick), { "text-anchor": "middle" });
    }
    svg.append(svgElement("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, stroke: "#9aa1ab" }));
    svg.append(svgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, stroke: "#9aa1ab" }));
    addSvgText(svg, (margin.left + width - margin.right) / 2, height - 8, xLabel || "", { "text-anchor": "middle", "font-size": 12 });
    const yText = addSvgText(svg, 14, (margin.top + height - margin.bottom) / 2, yLabel || "", { "text-anchor": "middle", "font-size": 12 });
    yText.setAttribute("transform", `rotate(-90 14 ${(margin.top + height - margin.bottom) / 2})`);
    return { x, y };
  }

  function semanticColor(label, index = 0) {
    const value = String(label || "").toLowerCase();
    if (value.includes("false") || value === "fp" || value === "fa") return "#df6400";
    if (value.includes("planet") || value === "cp" || value === "kp") return "#2f63b5";
    if (value.includes("train")) return "#2f63b5";
    if (value.includes("test") || value.includes("held")) return "#e7b400";
    if (value.includes("chance") || value.includes("floor") || value.includes("perfect")) return "#9299a4";
    return palette[index % palette.length];
  }

  function renderDistribution(artifact, figure, notes) {
    if (Array.isArray(artifact.categories) && Array.isArray(artifact.counts)) {
      const categories = artifact.categories;
      const values = artifact.counts;
      const width = 640;
      const rowHeight = 34;
      const height = Math.max(220, categories.length * rowHeight + 70);
      const margin = { top: 18, right: 52, bottom: 42, left: 210 };
      const svg = createSvg(width, height, artifact.description || artifact.id);
      const maximum = Math.max(1, ...values);
      const x = linearScale(0, maximum, margin.left, width - margin.right);
      for (const tick of ticks(0, maximum, 5)) {
        const position = x(tick);
        svg.append(svgElement("line", { x1: position, y1: margin.top, x2: position, y2: height - margin.bottom, stroke: grid }));
        addSvgText(svg, position, height - margin.bottom + 18, formatNumber(tick), { "text-anchor": "middle" });
      }
      categories.forEach((category, index) => {
        const y = margin.top + index * rowHeight + 5;
        const value = values[index];
        const barWidth = Math.max(value === 0 ? 1.5 : 2, x(value) - margin.left);
        addSvgText(svg, margin.left - 10, y + 16, truncate(category, 38), { "text-anchor": "end" });
        svg.append(svgElement("rect", { x: margin.left, y, width: barWidth, height: 20, fill: semanticColor(category, index), opacity: 0.95 }));
        addSvgText(svg, margin.left + barWidth + 6, y + 15, formatNumber(value), { fill: muted });
      });
      addSvgText(svg, (margin.left + width - margin.right) / 2, height - 7, artifact.variable || "count", { "text-anchor": "middle", "font-size": 12 });
      figure.append(svg);
      return;
    }

    if (Array.isArray(artifact.samples)) {
      const samples = artifact.samples;
      const width = 640;
      const height = 230;
      const margin = { top: 25, right: 30, bottom: 48, left: 62 };
      const [xMin, xMax] = paddedExtent(samples, 0.12);
      const svg = createSvg(width, height, artifact.description || artifact.id);
      const { x } = drawNumericAxes(svg, { width, height, margin, xDomain: [xMin, xMax], yDomain: [0, 1], xLabel: artifact.variable || "sample", yLabel: "", yTickCount: 0 });
      samples.forEach((sample, index) => {
        const y = height - margin.bottom - 25 - (index % 4) * 20;
        svg.append(svgElement("circle", { cx: x(sample), cy: y, r: 5, fill: "#2f63b5", opacity: 0.82 }));
      });
      const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
      svg.append(svgElement("line", { x1: x(mean), y1: margin.top, x2: x(mean), y2: height - margin.bottom, stroke: "#df6400", "stroke-width": 2, "stroke-dasharray": "5 4" }));
      addSvgText(svg, x(mean) + 5, margin.top + 12, `mean ${formatNumber(mean)}`, { fill: "#b14e00" });
      figure.append(svg);
      notes.push(`${samples.length} samples shown as a deterministic dot strip; no density smoothing applied.`);
      return;
    }

    throw new Error("distribution requires categories/counts or samples");
  }

  function renderCoefficientMatrix(artifact, figure, notes) {
    const rows = artifact.row_labels;
    const values = artifact.values.map((row) => row[0]);
    const ranked = rows.map((label, index) => ({ label, value: values[index] }))
      .sort((left, right) => Math.abs(right.value) - Math.abs(left.value));
    const shown = ranked.slice(0, Math.min(20, ranked.length));
    const width = 720;
    const rowHeight = 25;
    const height = shown.length * rowHeight + 80;
    const margin = { top: 20, right: 58, bottom: 42, left: 250 };
    const maximum = Math.max(0.01, ...shown.map((item) => Math.abs(item.value)));
    const x = linearScale(-maximum, maximum, margin.left, width - margin.right);
    const svg = createSvg(width, height, artifact.description || artifact.id);
    for (const tick of ticks(-maximum, maximum, 6)) {
      const position = x(tick);
      svg.append(svgElement("line", { x1: position, y1: margin.top, x2: position, y2: height - margin.bottom, stroke: tick === 0 ? "#9aa1ab" : grid, "stroke-width": tick === 0 ? 1.5 : 1 }));
      addSvgText(svg, position, height - margin.bottom + 18, formatNumber(tick), { "text-anchor": "middle" });
    }
    shown.forEach((item, index) => {
      const y = margin.top + index * rowHeight + 2;
      const zero = x(0);
      const end = x(item.value);
      addSvgText(svg, margin.left - 10, y + 15, truncate(item.label, 38), { "text-anchor": "end", "font-size": 10 });
      svg.append(svgElement("rect", { x: Math.min(zero, end), y, width: Math.max(1.5, Math.abs(end - zero)), height: 17, fill: item.value >= 0 ? "#2f63b5" : "#df6400", opacity: 0.9 }));
      addSvgText(svg, end + (item.value >= 0 ? 5 : -5), y + 14, formatNumber(item.value), { "text-anchor": item.value >= 0 ? "start" : "end", "font-size": 9 });
    });
    addSvgText(svg, (margin.left + width - margin.right) / 2, height - 7, artifact.col_labels[0] || "value", { "text-anchor": "middle", "font-size": 12 });
    figure.append(svg);
    if (shown.length < rows.length) notes.push(`Showing the ${shown.length} largest absolute values of ${rows.length}; the payload retains the full matrix.`);
  }

  function renderLeakProbe(artifact, figure, notes) {
    const labels = artifact.col_labels;
    const values = artifact.values[0];
    const width = 650;
    const height = 230;
    const svg = createSvg(width, height, artifact.description || artifact.id);
    const absolute = values.slice(0, 2);
    const [minimum, maximum] = paddedExtent(absolute, 0.25);
    const margin = { top: 42, right: 55, bottom: 55, left: 85 };
    const { x } = drawNumericAxes(svg, { width, height, margin, xDomain: [minimum, maximum], yDomain: [0, 1], xLabel: "balanced accuracy", yLabel: "", yTickCount: 0 });
    const y = 105;
    svg.append(svgElement("line", { x1: x(absolute[0]), y1: y, x2: x(absolute[1]), y2: y, stroke: "#9aa1ab", "stroke-width": 4 }));
    absolute.forEach((value, index) => {
      svg.append(svgElement("circle", { cx: x(value), cy: y, r: 9, fill: palette[index] }));
      addSvgText(svg, x(value), y - 18, truncate(labels[index], 22), { "text-anchor": "middle", "font-size": 10 });
      addSvgText(svg, x(value), y + 30, formatNumber(value), { "text-anchor": "middle", fill: ink, "font-weight": 700 });
    });
    addSvgText(svg, width / 2, 25, `${truncate(labels[2], 24)}: ${formatNumber(values[2])}`, { "text-anchor": "middle", fill: values[2] >= 0 ? "#007d5a" : "#b14e00", "font-size": 13, "font-weight": 700 });
    figure.append(svg);
    notes.push("Absolute scores and the delta use separate visual roles; the delta is not treated as a third score.");
  }

  function renderHeatmap(artifact, figure) {
    const rows = artifact.row_labels;
    const columns = artifact.col_labels;
    const values = artifact.values;
    const cellWidth = Math.min(78, Math.max(48, 440 / Math.max(1, columns.length)));
    const cellHeight = Math.min(44, Math.max(30, 260 / Math.max(1, rows.length)));
    const margin = { top: 88, right: 28, bottom: 35, left: 155 };
    const width = margin.left + columns.length * cellWidth + margin.right;
    const height = margin.top + rows.length * cellHeight + margin.bottom;
    const svg = createSvg(width, height, artifact.description || artifact.id);
    const flat = values.flat().filter((value) => typeof value === "number");
    const [minimum, maximum] = extent(flat);
    const span = maximum - minimum || 1;
    columns.forEach((label, index) => {
      const x = margin.left + index * cellWidth + cellWidth / 2;
      const text = addSvgText(svg, x, margin.top - 10, truncate(label, 24), { "text-anchor": "start", "font-size": 9 });
      text.setAttribute("transform", `rotate(-38 ${x} ${margin.top - 10})`);
    });
    rows.forEach((label, rowIndex) => {
      const y = margin.top + rowIndex * cellHeight;
      addSvgText(svg, margin.left - 8, y + cellHeight / 2 + 4, truncate(label, 25), { "text-anchor": "end", "font-size": 9 });
      columns.forEach((_, columnIndex) => {
        const value = values[rowIndex][columnIndex];
        const ratio = (value - minimum) / span;
        const lightness = 96 - ratio * 46;
        const fill = `hsl(214 58% ${lightness}%)`;
        const x = margin.left + columnIndex * cellWidth;
        svg.append(svgElement("rect", { x, y, width: cellWidth, height: cellHeight, fill, stroke: "#ffffff", "stroke-width": 1 }));
        addSvgText(svg, x + cellWidth / 2, y + cellHeight / 2 + 4, formatNumber(value), { "text-anchor": "middle", fill: ratio > 0.58 ? "#fff" : ink, "font-size": 9, "font-weight": 650 });
      });
    });
    figure.append(svg);
  }

  function renderMatrix(artifact, figure, notes) {
    if (artifact.id === "leak-probe-matrix" && artifact.values?.length === 1 && artifact.values[0]?.length >= 3) {
      renderLeakProbe(artifact, figure, notes);
      return;
    }
    if (artifact.col_labels?.length === 1 && artifact.row_labels?.length > 8) {
      renderCoefficientMatrix(artifact, figure, notes);
      return;
    }
    renderHeatmap(artifact, figure);
  }

  function linePath(xValues, yValues, xScale, yScale) {
    return xValues.map((value, index) => `${index === 0 ? "M" : "L"}${xScale(value).toFixed(2)},${yScale(yValues[index]).toFixed(2)}`).join(" ");
  }

  function renderCategoricalCurve(artifact, figure, notes) {
    const categories = artifact.series[0]?.x || [];
    const width = 720;
    const height = 350;
    const margin = { top: 34, right: 35, bottom: 95, left: 72 };
    const allValues = artifact.series.flatMap((series) => [...series.y, ...(series.y_lower || []), ...(series.y_upper || [])]);
    let [minimum, maximum] = paddedExtent(allValues, 0.12);
    if (minimum >= 0 && maximum <= 1.1) {
      minimum = Math.max(0, minimum);
      maximum = Math.min(1, maximum);
    }
    const y = linearScale(minimum, maximum, height - margin.bottom, margin.top);
    const xStep = (width - margin.left - margin.right) / Math.max(1, categories.length);
    const x = (index) => margin.left + xStep * (index + 0.5);
    const svg = createSvg(width, height, artifact.description || artifact.id);
    for (const tick of ticks(minimum, maximum, 5)) {
      const position = y(tick);
      svg.append(svgElement("line", { x1: margin.left, y1: position, x2: width - margin.right, y2: position, stroke: grid }));
      addSvgText(svg, margin.left - 8, position + 4, formatNumber(tick), { "text-anchor": "end" });
    }
    categories.forEach((category, index) => {
      const position = x(index);
      const label = addSvgText(svg, position, height - margin.bottom + 18, truncate(category, 24), { "text-anchor": "end", "font-size": 10 });
      label.setAttribute("transform", `rotate(-32 ${position} ${height - margin.bottom + 18})`);
    });
    artifact.series.forEach((series, seriesIndex) => {
      const color = semanticColor(series.name, seriesIndex);
      const isReference = /floor|null|chance|perfect/i.test(series.name);
      if (isReference && series.y.every((value) => value === series.y[0])) {
        const position = y(series.y[0]);
        svg.append(svgElement("line", { x1: margin.left, y1: position, x2: width - margin.right, y2: position, stroke: color, "stroke-width": 1.8, "stroke-dasharray": "6 4" }));
        addSvgText(svg, width - margin.right, position - 5 - seriesIndex * 2, truncate(series.name, 28), { "text-anchor": "end", fill: color, "font-size": 9 });
        return;
      }
      series.y.forEach((value, index) => {
        const xPosition = x(index) + (seriesIndex - (artifact.series.length - 1) / 2) * 8;
        if (series.y_lower && series.y_upper) {
          svg.append(svgElement("line", { x1: xPosition, y1: y(series.y_lower[index]), x2: xPosition, y2: y(series.y_upper[index]), stroke: color, "stroke-width": 2 }));
          svg.append(svgElement("line", { x1: xPosition - 4, y1: y(series.y_lower[index]), x2: xPosition + 4, y2: y(series.y_lower[index]), stroke: color }));
          svg.append(svgElement("line", { x1: xPosition - 4, y1: y(series.y_upper[index]), x2: xPosition + 4, y2: y(series.y_upper[index]), stroke: color }));
        }
        svg.append(svgElement("circle", { cx: xPosition, cy: y(value), r: 5.5, fill: color }));
        addSvgText(svg, xPosition, y(value) - 10, formatNumber(value), { "text-anchor": "middle", fill: color, "font-size": 9 });
      });
    });
    addSvgText(svg, margin.left - 50, 18, artifact.y_name || "score", { fill: muted, "font-size": 11 });
    figure.append(svg);
    if (artifact.series.some((series) => series.y_lower)) notes.push("Vertical whiskers reproduce the lower/upper values provided by the payload.");
  }

  function renderReliabilityCurve(artifact, figure, notes) {
    const countSeries = artifact.series.find((series) => /rows per bin|count/i.test(series.name));
    const lineSeries = artifact.series.filter((series) => series !== countSeries);
    const width = 720;
    const height = 470;
    const topMargin = { top: 28, right: 35, bottom: 235, left: 70 };
    const bottomMargin = { top: 295, right: 35, bottom: 52, left: 70 };
    const svg = createSvg(width, height, artifact.description || artifact.id);
    const top = drawNumericAxes(svg, { width, height, margin: topMargin, xDomain: [0, 1], yDomain: [0, 1], xLabel: "", yLabel: artifact.y_name || "observed frequency" });
    lineSeries.forEach((series, index) => {
      const color = semanticColor(series.name, index);
      svg.append(svgElement("path", { d: linePath(series.x, series.y, top.x, top.y), fill: "none", stroke: color, "stroke-width": 2.4, "stroke-dasharray": /perfect/i.test(series.name) ? "6 4" : "" }));
      if (!/perfect/i.test(series.name)) series.x.forEach((value, pointIndex) => svg.append(svgElement("circle", { cx: top.x(value), cy: top.y(series.y[pointIndex]), r: 4, fill: color })));
    });
    addSvgText(svg, width - 40, 21, lineSeries.map((series) => series.name).join(" · "), { "text-anchor": "end", "font-size": 9 });
    if (countSeries) {
      const maximum = Math.max(...countSeries.y, 1);
      const bottom = drawNumericAxes(svg, { width, height, margin: bottomMargin, xDomain: [0, 1], yDomain: [0, maximum * 1.08], xLabel: artifact.x_name || "predicted probability", yLabel: "rows per bin", xTickCount: 5, yTickCount: 3 });
      const barWidth = (width - bottomMargin.left - bottomMargin.right) / Math.max(12, countSeries.x.length) * 0.75;
      countSeries.x.forEach((value, index) => {
        const yPosition = bottom.y(countSeries.y[index]);
        svg.append(svgElement("rect", { x: bottom.x(value) - barWidth / 2, y: yPosition, width: barWidth, height: bottom.y(0) - yPosition, fill: "#a8afb8", opacity: 0.8 }));
      });
    }
    figure.append(svg);
    notes.push("Bin counts are rendered on a separate lower axis so they cannot flatten the 0–1 calibration curve.");
  }

  function renderNumericCurve(artifact, figure, notes) {
    if (artifact.id === "rf-reliability") {
      renderReliabilityCurve(artifact, figure, notes);
      return;
    }
    const allX = artifact.series.flatMap((series) => series.x);
    const allY = artifact.series.flatMap((series) => [...series.y, ...(series.y_lower || []), ...(series.y_upper || [])]);
    const isRoc = artifact.id === "roc-curves";
    let xDomain = isRoc ? [0, 1] : paddedExtent(allX, 0.04);
    let yDomain = isRoc ? [0, 1] : paddedExtent(allY, 0.08);
    if (!isRoc && yDomain[0] >= -0.05 && yDomain[1] <= 1.05) {
      yDomain = [Math.max(0, yDomain[0]), Math.min(1, yDomain[1])];
    }
    const width = 720;
    const height = isRoc ? 500 : 370;
    const margin = { top: 35, right: 35, bottom: 58, left: 72 };
    const svg = createSvg(width, height, artifact.description || artifact.id);
    const scales = drawNumericAxes(svg, { width, height, margin, xDomain, yDomain, xLabel: artifact.x_name, yLabel: artifact.y_name });
    artifact.series.forEach((series, index) => {
      const color = semanticColor(series.name, index);
      if (series.y_lower && series.y_upper) {
        const upper = series.x.map((value, pointIndex) => `${pointIndex === 0 ? "M" : "L"}${scales.x(value)},${scales.y(series.y_upper[pointIndex])}`).join(" ");
        const lower = [...series.x].reverse().map((value, reverseIndex) => {
          const pointIndex = series.x.length - 1 - reverseIndex;
          return `L${scales.x(value)},${scales.y(series.y_lower[pointIndex])}`;
        }).join(" ");
        svg.append(svgElement("path", { d: `${upper} ${lower} Z`, fill: color, opacity: 0.13 }));
      }
      svg.append(svgElement("path", { d: linePath(series.x, series.y, scales.x, scales.y), fill: "none", stroke: color, "stroke-width": /chance/i.test(series.name) ? 1.6 : 2.4, "stroke-dasharray": /chance|floor|null|perfect/i.test(series.name) ? "6 4" : "" }));
      if (series.x.length <= 24 && !/chance|floor|null|perfect/i.test(series.name)) {
        series.x.forEach((value, pointIndex) => svg.append(svgElement("circle", { cx: scales.x(value), cy: scales.y(series.y[pointIndex]), r: 3.7, fill: color })));
      }
    });
    const legendX = margin.left + 10;
    artifact.series.forEach((series, index) => {
      const y = margin.top + index * 17;
      svg.append(svgElement("line", { x1: legendX, y1: y, x2: legendX + 22, y2: y, stroke: semanticColor(series.name, index), "stroke-width": 3, "stroke-dasharray": /chance|floor|null|perfect/i.test(series.name) ? "5 3" : "" }));
      addSvgText(svg, legendX + 28, y + 4, truncate(series.name, 42), { "font-size": 9 });
    });
    figure.append(svg);
    if (artifact.series.some((series) => series.y_lower)) notes.push("The shaded ribbon uses payload-provided lower and upper values.");
  }

  function renderCurve(artifact, figure, notes) {
    const categorical = artifact.series.some((series) => series.x.some((value) => typeof value !== "number"));
    if (categorical) renderCategoricalCurve(artifact, figure, notes);
    else renderNumericCurve(artifact, figure, notes);
  }

  function renderPredictions(artifact, figure, notes) {
    const classes = artifact.classes || [...new Set(artifact.y_true)];
    const bins = 20;
    const grouped = classes.map((className) => ({ className, counts: Array(bins).fill(0) }));
    artifact.y_score.forEach((score, index) => {
      const classIndex = Math.max(0, classes.indexOf(artifact.y_true[index]));
      const bin = Math.min(bins - 1, Math.max(0, Math.floor(score * bins)));
      grouped[classIndex].counts[bin] += 1;
    });
    const width = 720;
    const height = 350;
    const margin = { top: 35, right: 30, bottom: 58, left: 66 };
    const maximum = Math.max(1, ...grouped.flatMap((group) => group.counts));
    const svg = createSvg(width, height, artifact.description || artifact.id);
    const scales = drawNumericAxes(svg, { width, height, margin, xDomain: [0, 1], yDomain: [0, maximum * 1.08], xLabel: `score for ${classes[1] || "positive class"}`, yLabel: "held-out rows", xTickCount: 5, yTickCount: 5 });
    const plotWidth = width - margin.left - margin.right;
    const binWidth = plotWidth / bins;
    grouped.forEach((group, groupIndex) => {
      const color = semanticColor(group.className, groupIndex);
      group.counts.forEach((count, binIndex) => {
        const x = margin.left + binIndex * binWidth + groupIndex * (binWidth / grouped.length);
        const y = scales.y(count);
        svg.append(svgElement("rect", { x, y, width: Math.max(1, binWidth / grouped.length - 0.8), height: scales.y(0) - y, fill: color, opacity: 0.78 }));
      });
      const legendX = margin.left + groupIndex * 180;
      svg.append(svgElement("rect", { x: legendX, y: 12, width: 12, height: 12, fill: color, opacity: 0.8 }));
      addSvgText(svg, legendX + 17, 22, `true ${group.className}`, { "font-size": 10 });
    });
    figure.append(svg);
    const correct = artifact.y_true.reduce((total, value, index) => total + (value === artifact.y_pred[index] ? 1 : 0), 0);
    const recalls = classes.map((className) => {
      let total = 0;
      let truePositive = 0;
      artifact.y_true.forEach((value, index) => {
        if (value === className) {
          total += 1;
          if (artifact.y_pred[index] === className) truePositive += 1;
        }
      });
      return total ? truePositive / total : 0;
    });
    const balancedAccuracy = recalls.reduce((sum, value) => sum + value, 0) / Math.max(1, recalls.length);
    notes.push(`${artifact.y_score.length} aligned rows · accuracy ${formatNumber(correct / artifact.y_true.length)} · balanced accuracy ${formatNumber(balancedAccuracy)}.`);
    notes.push(`Compatibility rule: y_score is interpreted as the score for classes[1] (${classes[1] || "unspecified"}).`);
  }

  function renderAssignments(artifact, figure, notes) {
    const counts = new Map();
    artifact.labels.forEach((label) => counts.set(label, (counts.get(label) || 0) + 1));
    const summary = htmlElement("div", "assignment-summary");
    for (const [label, count] of counts) {
      const stat = htmlElement("div", "assignment-stat");
      append(stat, htmlElement("strong", "", formatNumber(count)), htmlElement("span", "", label));
      summary.append(stat);
    }
    const total = htmlElement("div", "assignment-stat");
    append(total, htmlElement("strong", "", formatNumber(artifact.labels.length)), htmlElement("span", "", "aligned rows"));
    summary.append(total);
    figure.append(summary);
    const ribbon = htmlElement("div", "assignment-ribbon");
    ribbon.setAttribute("aria-label", "Deterministic sample of assignment order");
    const blocks = Math.min(160, artifact.labels.length);
    for (let index = 0; index < blocks; index += 1) {
      const sourceIndex = Math.min(artifact.labels.length - 1, Math.floor((index / blocks) * artifact.labels.length));
      const block = htmlElement("span");
      block.style.background = semanticColor(artifact.labels[sourceIndex], [...counts.keys()].indexOf(artifact.labels[sourceIndex]));
      ribbon.append(block);
    }
    figure.append(ribbon);
    notes.push("The ribbon deterministically samples row order; the full aligned row_ids and labels remain embedded in the payload.");
  }

  function renderTree(artifact, figure, notes) {
    const nodesById = new Map(artifact.nodes.map((node) => [node.id, node]));
    const children = new Map(artifact.nodes.map((node) => [node.id, []]));
    const targets = new Set();
    artifact.edges.forEach((edge) => {
      children.get(edge.from)?.push(edge);
      targets.add(edge.to);
    });
    const rootNode = artifact.nodes.find((node) => !targets.has(node.id)) || artifact.nodes[0];
    const levels = [];
    const queue = [{ id: rootNode.id, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      if (!levels[current.depth]) levels[current.depth] = [];
      levels[current.depth].push(current.id);
      for (const edge of children.get(current.id) || []) queue.push({ id: edge.to, depth: current.depth + 1 });
    }
    const width = 920;
    const levelGap = 112;
    const height = Math.max(260, levels.length * levelGap + 40);
    const svg = createSvg(width, height, artifact.description || artifact.id);
    const positions = new Map();
    levels.forEach((level, depth) => {
      level.forEach((id, index) => {
        positions.set(id, { x: ((index + 1) * width) / (level.length + 1), y: 35 + depth * levelGap });
      });
    });
    artifact.edges.forEach((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return;
      svg.append(svgElement("line", { x1: from.x, y1: from.y + 29, x2: to.x, y2: to.y - 29, stroke: "#aeb4bd", "stroke-width": 1.5 }));
      addSvgText(svg, (from.x + to.x) / 2 + (edge.label === ">" ? 8 : -8), (from.y + to.y) / 2, edge.label, { "text-anchor": "middle", "font-size": 9 });
    });
    artifact.nodes.forEach((node) => {
      const position = positions.get(node.id);
      if (!position) return;
      const planetFraction = node.class_fractions?.planet ?? 0;
      const color = node.majority_class === "planet" ? "#dce9fb" : "#fbe6d5";
      svg.append(svgElement("rect", { x: position.x - 62, y: position.y - 29, width: 124, height: 58, rx: 6, fill: color, stroke: node.majority_class === "planet" ? "#2f63b5" : "#df6400", "stroke-width": 1.2 }));
      const splitLabel = node.split_feature ? `${truncate(node.split_feature, 15)} ≤ ${formatNumber(node.threshold)}` : `leaf: ${node.majority_class}`;
      addSvgText(svg, position.x, position.y - 8, splitLabel, { "text-anchor": "middle", fill: ink, "font-size": 9, "font-weight": 700 });
      addSvgText(svg, position.x, position.y + 7, `planet ${formatNumber(planetFraction)}`, { "text-anchor": "middle", "font-size": 8 });
      addSvgText(svg, position.x, position.y + 20, `rows ${formatNumber(node.samples_fraction)}`, { "text-anchor": "middle", "font-size": 8 });
    });
    figure.append(svg);
    notes.push(`${artifact.nodes.length} nodes and ${artifact.edges.length} edges; thresholds are displayed exactly as stored.`);
  }

  const renderers = {
    distribution: renderDistribution,
    matrix: renderMatrix,
    curve: renderCurve,
    predictions: renderPredictions,
    assignments: renderAssignments,
    tree_structure: renderTree
  };

  function artifactIsWide(artifact) {
    if (["assignments", "predictions", "tree_structure"].includes(artifact.kind)) return true;
    if (artifact.kind === "matrix" && (artifact.row_labels?.length > 8 || artifact.col_labels?.length > 5)) return true;
    if (artifact.kind === "curve" && (artifact.series?.length > 2 || artifact.series?.some((series) => series.x.length > 40))) return true;
    return artifact.id === "rf-reliability";
  }

  function renderArtifactCard(artifact) {
    const card = htmlElement("section", `artifact-card${artifactIsWide(artifact) ? " wide" : ""}`);
    card.dataset.artifactId = artifact.id;
    append(card, htmlElement("h4", "artifact-title", artifact.title || humanize(artifact.id)));
    if (artifact.description) card.append(htmlElement("p", "artifact-description", artifact.description));
    const figure = htmlElement("div", `artifact-figure${artifactIsWide(artifact) ? "" : " compact"}`);
    const notes = [];
    try {
      const renderer = renderers[artifact.kind];
      if (!renderer) throw new Error(`Unsupported artifact kind: ${artifact.kind}`);
      renderer(artifact, figure, notes);
    } catch (error) {
      figure.replaceChildren(htmlElement("div", "render-error", `${artifact.id}: ${error.message}`));
      card.dataset.renderError = "true";
    }
    card.append(figure);
    notes.forEach((note) => card.append(htmlElement("p", "artifact-note", note)));
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
    if (trigger.tagName !== "BUTTON") {
      trigger.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setCollapsed(container, !container.classList.contains("collapsed"));
      });
    }
  }

  function createQuietButton(label, action) {
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
    nav.id = "navbar";
    const home = htmlElement("a", "nav-home", payload.dataset?.name || payload.header?.title || "Dashboard");
    home.href = "#top";
    const acts = htmlElement("span", "nav-acts");
    for (const act of payload.acts) {
      const link = htmlElement("a", "", `Act ${act.numeral || act.id}`);
      link.href = `#${act.id}`;
      link.dataset.actLink = act.id;
      acts.append(link);
    }
    const tools = htmlElement("span", "nav-tools");
    append(tools, createQuietButton("Fold all", () => allPanels(true)), createQuietButton("Unfold all", () => allPanels(false)));
    append(nav, home, acts, tools);
    shell.append(nav);
  }

  function createHero(shell) {
    const hero = htmlElement("header", "hero");
    hero.id = "top";
    const title = payload.header?.title || payload.dataset?.name || "Payload dashboard";
    const subtitleParts = [payload.dataset?.source, payload.dataset?.instrument, payload.dataset?.snapshot, payload.dataset?.redistribution, payload.dataset?.license].filter(Boolean);
    append(hero, htmlElement("h1", "", title), htmlElement("p", "subtitle", payload.header?.subtitle || subtitleParts.join(" · ")));
    const facts = htmlElement("div", "facts");
    for (const fact of payload.header?.facts || []) {
      const item = htmlElement("div", "fact");
      item.append(document.createTextNode(`${fact.label || "fact"} `));
      item.append(htmlElement("strong", "", fact.value));
      if (fact.detail) item.append(document.createTextNode(` ${fact.detail}`));
      facts.append(item);
    }
    hero.append(facts);
    if (payload.header?.claim?.text || payload.header?.final_verdict?.statement) {
      const claim = htmlElement("div", "claim");
      claim.append(htmlElement("div", "eyebrow", `Stage ${payload.header?.final_verdict?.stage_ref ?? 0} claim`));
      const claimText = [payload.header?.claim?.text, payload.header?.final_verdict?.statement].filter(Boolean).join(" ");
      claim.append(markdownParagraph(claimText));
      hero.append(claim);
    }
    shell.append(hero);
  }

  function createCoverage(shell) {
    const section = htmlElement("section", "coverage");
    const top = htmlElement("div", "coverage-top");
    top.append(htmlElement("div", "section-label", `Coverage — ${payload.stages.length} stages`));
    const tools = htmlElement("span", "nav-tools");
    append(tools, createQuietButton("Fold all", () => allPanels(true)), createQuietButton("Unfold all", () => allPanels(false)));
    top.append(tools);
    const gridNode = htmlElement("div", "coverage-grid");
    for (const stage of payload.stages) {
      const link = htmlElement("a", "coverage-link");
      link.href = `#stage-${stage.id}`;
      append(link, htmlElement("span", "coverage-num", String(stage.id).padStart(2, "0")), htmlElement("span", "coverage-title", stage.short_label || stage.title));
      gridNode.append(link);
    }
    const legend = htmlElement("div", "coverage-legend");
    const supported = htmlElement("span");
    append(supported, htmlElement("i", "legend-swatch supported"), document.createTextNode("payload-backed"));
    const mutedLegend = htmlElement("span");
    append(mutedLegend, htmlElement("i", "legend-swatch muted"), document.createTextNode("unsupported types fail closed"));
    append(legend, supported, mutedLegend);
    append(section, top, gridNode, legend);
    shell.append(section);
  }

  function utilityPanel(title, badge, bodyBuilder, collapsed = true) {
    const panel = htmlElement("section", `utility-panel${collapsed ? " collapsed" : ""}`);
    const head = htmlElement("button", "utility-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(!collapsed));
    append(head, htmlElement("span", "chev"), htmlElement("span", "utility-title", title), htmlElement("span", "utility-badge", badge));
    const body = htmlElement("div", "utility-body");
    bodyBuilder(body);
    append(panel, head, body);
    bindToggle(panel, head);
    return panel;
  }

  function createUtilities(shell) {
    const glossary = utilityPanel("Glossary — how to read this data", "for non-specialists", (body) => {
      if (payload.glossary_intro) body.append(htmlElement("p", "glossary-intro", payload.glossary_intro));
      const gridNode = htmlElement("div", "glossary-grid");
      for (const item of payload.glossary || []) {
        const entry = htmlElement("div", "glossary-item");
        append(entry, htmlElement("span", "glossary-term", item.term), htmlElement("span", "glossary-qualifier", item.qualifier));
        const definition = htmlElement("div", "glossary-definition");
        appendInlineMarkdown(definition, item.definition);
        entry.append(definition);
        gridNode.append(entry);
      }
      body.append(gridNode);
    });
    const runFacts = utilityPanel("Run facts — reproducibility context", "computed, not asserted", (body) => {
      const gridNode = htmlElement("div", "glossary-grid");
      const entries = [
        ["Run ID", payload.run?.run_id],
        ["Schema", payload.schema_version],
        ["Seed", payload.run?.seed],
        ["Rows kept", payload.dataset?.n_rows],
        ["Features", payload.dataset?.n_features],
        ["Libraries", (payload.run?.libraries || []).join(" · ")]
      ].filter((entry) => entry[1] !== undefined && entry[1] !== null);
      for (const [term, value] of entries) {
        const entry = htmlElement("div", "glossary-item");
        append(entry, htmlElement("span", "glossary-term", term), htmlElement("div", "glossary-definition", value));
        gridNode.append(entry);
      }
      body.append(gridNode);
    });
    append(shell, glossary, runFacts);
  }

  function createStagePanel(stage) {
    const panel = htmlElement("article", "panel");
    panel.id = `stage-${stage.id}`;
    panel.dataset.stageId = stage.id;
    const head = htmlElement("div", "panel-head");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", "true");
    const badgeText = `${stage.artifacts.length} plot${stage.artifacts.length === 1 ? "" : "s"}`;
    const toTop = htmlElement("a", "to-top", "top ↑");
    toTop.href = "#top";
    append(head, htmlElement("span", "chev"), htmlElement("span", "stage-number", `Stage ${String(stage.id).padStart(2, "0")}`), htmlElement("span", "stage-title", stage.title), htmlElement("span", "stage-badge", badgeText), toTop);
    const body = htmlElement("div", "panel-body");
    if (stage.concepts?.length) {
      const concepts = htmlElement("div", "concepts");
      append(concepts, htmlElement("span", "section-label", "Concepts used"));
      stage.concepts.forEach((concept, index) => {
        if (index) concepts.append(document.createTextNode(" · "));
        appendInlineMarkdown(concepts, concept);
      });
      body.append(concepts);
    }
    if (stage.summary) body.append(markdownParagraph(stage.summary, "summary"));
    if (stage.artifacts?.length) {
      const artifactGrid = htmlElement("div", "artifact-grid");
      stage.artifacts.forEach((artifact) => artifactGrid.append(renderArtifactCard(artifact)));
      body.append(artifactGrid);
    }
    if (stage.narrative?.length) {
      const narrative = htmlElement("div", "narrative");
      stage.narrative.forEach((paragraph) => narrative.append(markdownParagraph(paragraph)));
      body.append(narrative);
    }
    if (stage.metrics?.length) {
      const strip = htmlElement("div", "metric-strip");
      stage.metrics.forEach((metric) => {
        const pill = htmlElement("div", "metric-pill");
        pill.append(document.createTextNode(`${metric.name}: `));
        pill.append(htmlElement("strong", "", formatNumber(metric.value)));
        strip.append(pill);
      });
      body.append(strip);
    }
    if (stage.objective) {
      const objectives = htmlElement("div", "objective-grid");
      for (const [label, value] of Object.entries(stage.objective)) {
        const item = htmlElement("div", "objective-item");
        item.append(htmlElement("strong", "", `${humanize(label)}: `));
        item.append(document.createTextNode(value));
        objectives.append(item);
      }
      body.append(objectives);
    }
    if (stage.checks?.length) {
      const checks = htmlElement("div", "check-list");
      stage.checks.forEach((check) => {
        const status = String(check.result || "other").toLowerCase();
        const chip = htmlElement("span", `check-chip ${status === "pass" ? "pass" : status === "fail" ? "fail" : "other"}`, `${check.result || "check"} · ${check.kind || check.id}`);
        chip.title = check.description || check.id;
        checks.append(chip);
      });
      body.append(checks);
    }
    if (stage.caveats?.length) {
      const caveats = htmlElement("ul", "caveats");
      stage.caveats.forEach((caveat) => caveats.append(htmlElement("li", "", caveat)));
      body.append(caveats);
    }
    append(panel, head, body);
    bindToggle(panel, head);
    return panel;
  }

  function createActs(shell) {
    const stagesById = new Map(payload.stages.map((stage) => [stage.id, stage]));
    for (const act of payload.acts) {
      const section = htmlElement("section", "act");
      section.id = act.id;
      const heading = htmlElement("div", "act-heading");
      const title = htmlElement("h2", "", `Act ${act.numeral || act.id} — ${act.name || ""}`);
      const topLink = htmlElement("a", "to-top", "top ↑");
      topLink.href = "#top";
      append(heading, title, topLink);
      section.append(heading);
      const orderedStages = (act.stage_ids || []).map((id) => stagesById.get(id)).filter(Boolean);
      const fallbackStages = payload.stages.filter((stage) => stage.act === act.id && !orderedStages.includes(stage));
      [...orderedStages, ...fallbackStages].forEach((stage) => section.append(createStagePanel(stage)));
      shell.append(section);
    }
  }

  function createFooter(shell) {
    const footer = htmlElement("footer", "build-footer");
    const hash = buildMeta.payload_sha256 ? buildMeta.payload_sha256.slice(0, 16) : "unknown";
    footer.textContent = `Standalone payload dashboard · schema ${payload.schema_version} · ${buildMeta.artifact_count} artifacts · payload sha256 ${hash}… · renderer ${buildMeta.generator_version}`;
    shell.append(footer);
  }

  function updateActiveAct() {
    const sections = [...document.querySelectorAll(".act")];
    let current = sections[0]?.id;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 90) current = section.id;
    }
    document.querySelectorAll("[data-act-link]").forEach((link) => link.classList.toggle("here", link.dataset.actLink === current));
  }

  function buildDashboard() {
    const shell = htmlElement("main", "shell");
    createNav(shell);
    createHero(shell);
    createCoverage(shell);
    createUtilities(shell);
    createActs(shell);
    createFooter(shell);
    root.replaceChildren(shell);
    updateActiveAct();
    let scheduled = false;
    addEventListener("scroll", () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        updateActiveAct();
        scheduled = false;
      });
    }, { passive: true });
  }

  try {
    buildDashboard();
  } catch (error) {
    root.replaceChildren(htmlElement("div", "render-error", `Dashboard render failed: ${error.message}`));
    throw error;
  }
})();
