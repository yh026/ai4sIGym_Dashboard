/** Shared, dependency-free helpers for the Payload v3 core. */

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function pointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function joinPointer(pointer, token) {
  return `${pointer === "/" ? "" : pointer}/${pointerToken(token)}` || "/";
}

export function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, stableClone(value[key])])
    );
  }
  return value;
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(stableClone(value), null, space);
}

export class DiagnosticCollector {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(path, code, message) {
    this.errors.push({ path, code, message });
  }

  warn(path, code, message) {
    this.warnings.push({ path, code, message });
  }

  merge(other) {
    this.errors.push(...(other?.errors || []));
    this.warnings.push(...(other?.warnings || []));
  }

  result(extra = {}) {
    return {
      valid: this.errors.length === 0,
      errors: stableDiagnostics(this.errors),
      warnings: stableDiagnostics(this.warnings),
      ...extra
    };
  }
}

function stableDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  );
}

export function formatDiagnostics(diagnostics) {
  return (diagnostics || [])
    .map(({ path, code, message }) => `${path} [${code}]: ${message}`)
    .join("\n");
}

export class PayloadV3Error extends Error {
  constructor(message, diagnostics = [], options = {}) {
    super(message, options);
    this.name = "PayloadV3Error";
    this.diagnostics = diagnostics;
  }
}

export function assertNonEmptyString(value, path, collector, code = "expected_string") {
  if (typeof value !== "string" || value.trim() === "") {
    collector.error(path, code, "expected a non-empty string");
    return false;
  }
  return true;
}

export function assertUniqueIds(items, path, collector, { required = true } = {}) {
  const ids = new Set();
  (items || []).forEach((item, index) => {
    const idPath = `${path}/${index}/id`;
    if (typeof item?.id !== "string" || item.id.trim() === "") {
      if (required) collector.error(idPath, "expected_id", "expected a non-empty string id");
      return;
    }
    if (ids.has(item.id)) collector.error(idPath, "duplicate_id", `duplicate id ${JSON.stringify(item.id)}`);
    ids.add(item.id);
  });
  return ids;
}

export function findUnknownKeys(value, allowed, path, collector) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) collector.error(joinPointer(path, key), "unknown_property", `unsupported property ${JSON.stringify(key)}`);
  }
}
