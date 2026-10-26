#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildDashboard, verifyStandaloneHtml } from "./render-dashboard.mjs";
import {
  getPayloadV3Capabilities,
  inspectSafeRelativeSidecarPath,
  validateMaterializedDataV3,
  validatePayloadV3,
  verifyPayloadV3Sidecars
} from "./lib/payload-v3.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const kitDirectory = resolve(scriptDirectory, "..");
const starterDirectory = join(kitDirectory, "templates", "generic-package");

function usage() {
  return `Payload Dashboard producer CLI

Usage:
  node scripts/payload.mjs init <directory>
  node scripts/payload.mjs capabilities [--json]
  node scripts/payload.mjs validate <payload.json>
  node scripts/payload.mjs render <payload.json> [--output dashboard.html]
  node scripts/payload.mjs conformance <payload.json>
  node scripts/payload.mjs sidecar <file> [options]

Sidecar options:
  --format json|jsonl          Physical source format; inferred from the filename.
  --compression none|gzip     Stored compression; inferred from the filename.
  --output PATH               Converted sidecar path.
  --path PACKAGE_PATH         Explicit package-relative storage.path.
  --metadata PATH             Also write the storage object as JSON.
  --package-root PATH         Package base without --payload; default: cwd.
  --payload PATH              Payload whose data catalog supplies the field schema.
  --data-id ID                Data resource to inspect or update.
  --write                     Replace that resource's storage object atomically.

Sidecar source, output, and metadata paths are resolved from the payload
directory when --payload is present; otherwise from --package-root or cwd.
Relative paths declared inside payload.json are always package-relative.`;
}

function fail(message) {
  throw new Error(message);
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) fail(`${option} requires a value`);
  return value;
}

function parseOptions(args, allowedFlags = new Set()) {
  const options = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("-")) {
      options.positional.push(argument);
      continue;
    }
    if (allowedFlags.has(argument)) {
      options[argument.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (["--output", "--format", "--compression", "--path", "--metadata", "--package-root", "--payload", "--data-id"].includes(argument)) {
      const value = takeValue(args, index, argument);
      options[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    fail(`Unknown option: ${argument}`);
  }
  return options;
}

function resolveFrom(baseDirectory, value) {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

function portableRelative(baseDirectory, target) {
  return relative(baseDirectory, target).split(sep).join("/");
}

function isContainedPath(baseDirectory, target, { allowBase = false } = {}) {
  const fromBase = relative(baseDirectory, target);
  if (fromBase === "") return allowBase;
  return fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase);
}

/**
 * Resolve a not-yet-created package file without trusting symlinked parents.
 * The real nearest existing ancestor is authoritative so equivalent macOS
 * aliases such as /tmp and /private/tmp are accepted without weakening the
 * canonical containment check performed before any write.
 */
async function inspectContainedTarget(baseDirectory, target, label) {
  const lexicalTarget = resolve(target);
  const canonicalBase = await realpath(resolve(baseDirectory));
  let existingAncestor = lexicalTarget;
  let ancestorStat;
  while (true) {
    try {
      ancestorStat = await stat(existingAncestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) fail(`Unable to resolve an existing parent for ${label}: ${lexicalTarget}`);
      existingAncestor = parent;
    }
  }
  const suffix = relative(existingAncestor, lexicalTarget);
  if (suffix && !ancestorStat.isDirectory()) fail(`${label} has a non-directory parent: ${existingAncestor}`);
  const canonicalAncestor = await realpath(existingAncestor);
  const canonicalTarget = resolve(canonicalAncestor, suffix);
  if (!isContainedPath(canonicalBase, canonicalTarget)) {
    fail(`${label} must remain inside the payload package after canonical resolution: ${lexicalTarget}`);
  }
  if (!suffix && ancestorStat.isDirectory()) fail(`${label} must be a file, not a directory: ${lexicalTarget}`);
  return {
    lexical: lexicalTarget,
    canonical: canonicalTarget,
    package_path: portableRelative(canonicalBase, canonicalTarget)
  };
}

/** Canonical path of an existing or prospective file, without writing it. */
async function resolveProspectiveCanonicalPath(target, label) {
  const lexicalTarget = resolve(target);
  let existingAncestor = lexicalTarget;
  let ancestorStat;
  while (true) {
    try {
      ancestorStat = await stat(existingAncestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) fail(`Unable to resolve an existing parent for ${label}: ${lexicalTarget}`);
      existingAncestor = parent;
    }
  }
  const suffix = relative(existingAncestor, lexicalTarget);
  if (suffix && !ancestorStat.isDirectory()) fail(`${label} has a non-directory parent: ${existingAncestor}`);
  if (!suffix && ancestorStat.isDirectory()) fail(`${label} must be a file, not a directory: ${lexicalTarget}`);
  return resolve(await realpath(existingAncestor), suffix);
}

async function readJson(path, label = path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`, { cause: error });
  }
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else fail(`Starter contains unsupported filesystem entry: ${from}`);
  }
}

async function commandInit(args) {
  const options = parseOptions(args);
  if (options.positional.length !== 1) fail("init requires exactly one target directory");
  const destination = resolve(options.positional[0]);
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) fail(`init target exists and is not a directory: ${destination}`);
    if ((await readdir(destination)).length > 0) fail(`init refuses to overwrite a non-empty directory: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await copyDirectory(starterDirectory, destination);
  return {
    command: "init",
    created: destination,
    entrypoint: join(destination, "payload.json"),
    next: `node ${join(kitDirectory, "scripts", "payload.mjs")} validate ${join(destination, "payload.json")}`
  };
}

async function commandCapabilities(args) {
  const options = parseOptions(args, new Set(["--json"]));
  if (options.positional.length) fail("capabilities does not accept positional arguments");
  const capabilities = getPayloadV3Capabilities();
  if (options.json) return capabilities;
  const rendererVersion = typeof capabilities.renderer_contract === "string"
    ? capabilities.renderer_contract
    : capabilities.renderer_contract.version;
  return [
    `Payload ${capabilities.schema_version} / renderer ${rendererVersion}`,
    `Presentation presets: ${capabilities.presentation.presets.join(", ")}`,
    `Recipes: ${capabilities.recipes.join(", ")}`,
    `Coordinates: ${Object.keys(capabilities.coordinates).join(", ")}`,
    `Marks: ${Object.keys(capabilities.marks).join(", ")}`,
    `Transforms: ${capabilities.transforms.operations.join(", ")}`,
    `Interactions: ${capabilities.interactions.types.join(", ")}`,
    `Sidecars: ${capabilities.storage.formats.join("/")} + ${capabilities.storage.compressions.join("/")}`
  ].join("\n");
}

function payloadArgument(command, options) {
  if (options.positional.length !== 1) fail(`${command} requires exactly one payload.json path`);
  return resolve(options.positional[0]);
}

async function commandValidate(args) {
  const options = parseOptions(args);
  const inputPath = payloadArgument("validate", options);
  const receipt = await buildDashboard({ inputPath, validateOnly: true });
  return { command: "validate", valid: true, ...receipt };
}

async function commandRender(args) {
  const options = parseOptions(args);
  const inputPath = await realpath(payloadArgument("render", options));
  const payloadDirectory = dirname(inputPath);
  const outputPath = options.output
    ? resolveFrom(payloadDirectory, options.output)
    : join(payloadDirectory, "dashboard.html");
  const canonicalOutput = await resolveProspectiveCanonicalPath(outputPath, "Dashboard output");
  if (canonicalOutput === inputPath) fail("Dashboard output cannot overwrite payload.json");
  const payload = await readJson(inputPath, "payload");
  for (const resource of payload.data || []) {
    if (resource?.storage?.kind !== "sidecar" || typeof resource.storage.path !== "string") continue;
    const sidecarTarget = await resolveProspectiveCanonicalPath(
      resolve(payloadDirectory, resource.storage.path),
      `Declared sidecar ${JSON.stringify(resource.id)}`
    );
    if (canonicalOutput === sidecarTarget) {
      fail(`Dashboard output cannot overwrite declared sidecar ${JSON.stringify(resource.id)} at ${resource.storage.path}`);
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const receipt = await buildDashboard({ inputPath, outputPath });
  return { command: "render", rendered: true, ...receipt };
}

async function commandConformance(args) {
  const options = parseOptions(args);
  const inputPath = payloadArgument("conformance", options);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "payload-dashboard-conformance-"));
  try {
    const outputPath = join(temporaryDirectory, "dashboard.html");
    const compilation = await buildDashboard({ inputPath, outputPath });
    const html = await readFile(outputPath, "utf8");
    const offlineErrors = verifyStandaloneHtml(html);
    const outputEntries = (await readdir(temporaryDirectory)).sort();
    if (offlineErrors.length) fail(`Offline verification failed: ${offlineErrors.join("; ")}`);
    if (outputEntries.length !== 1 || outputEntries[0] !== "dashboard.html") {
      fail(`Conformance compilation emitted unexpected files: ${outputEntries.join(", ")}`);
    }
    const compilationReceipt = { ...compilation };
    delete compilationReceipt.output;
    return {
      command: "conformance",
      conformant: true,
      input: inputPath,
      validation: {
        strict: true,
        warnings: compilation.warnings,
        sidecars_verified: compilation.sidecar_count
      },
      compilation: compilationReceipt,
      offline: {
        single_html: true,
        temporary_output_removed: true,
        external_resource_errors: offlineErrors,
        output_bytes: Buffer.byteLength(html),
        output_sha256: createHash("sha256").update(html).digest("hex")
      }
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function inferFormat(path) {
  const withoutGzip = path.endsWith(".gz") ? path.slice(0, -3) : path;
  if (withoutGzip.endsWith(".jsonl")) return "jsonl";
  if (withoutGzip.endsWith(".json")) return "json";
  return null;
}

function parseSidecarContent(bytes, format, compression) {
  let decoded;
  try {
    decoded = compression === "gzip" ? gunzipSync(bytes) : bytes;
  } catch (error) {
    throw new Error(`Unable to decompress input sidecar: ${error.message}`, { cause: error });
  }
  const text = decoded.toString("utf8");
  if (format === "jsonl") {
    const rows = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`, { cause: error });
      }
      if (!row || typeof row !== "object" || Array.isArray(row)) fail(`JSONL line ${index + 1} must be an object`);
      rows.push(row);
    }
    return { value: rows, decoded };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON sidecar: ${error.message}`, { cause: error });
  }
  if (value && !Array.isArray(value) && typeof value === "object" && Array.isArray(value.rows) && Object.keys(value).length === 1) value = value.rows;
  if (value && !Array.isArray(value) && typeof value === "object" && value.values && Object.keys(value).length === 1) value = value.values;
  return { value, decoded };
}

function rowCount(value) {
  if (Array.isArray(value)) {
    const invalidIndex = value.findIndex((row) => !row || typeof row !== "object" || Array.isArray(row));
    if (invalidIndex !== -1) fail(`JSON sidecar row ${invalidIndex + 1} must be an object`);
    return value.length;
  }
  if (!value || typeof value !== "object") fail("JSON sidecar must contain row objects or parallel column arrays");
  const columns = Object.values(value);
  if (!columns.length || columns.some((column) => !Array.isArray(column))) fail("JSON sidecar columns must be non-empty arrays");
  const count = columns[0].length;
  if (columns.some((column) => column.length !== count)) fail("JSON sidecar columns must have equal lengths");
  return count;
}

function convertedPath(sourcePath, sourceCompression, targetCompression) {
  if (sourceCompression === targetCompression) return sourcePath;
  if (targetCompression === "gzip") return `${sourcePath}.gz`;
  return sourcePath.endsWith(".gz") ? sourcePath.slice(0, -3) : `${sourcePath}.decoded`;
}

async function commandSidecar(args) {
  const options = parseOptions(args, new Set(["--write"]));
  if (options.positional.length !== 1) fail("sidecar requires exactly one source file");
  let payloadPath = null;
  let payload = null;
  let source = null;
  let payloadDirectory = null;
  let packageRoot = null;
  if (options.payload && options.package_root) fail("--package-root cannot be combined with --payload; the payload directory is already the package root");
  if (options.payload) {
    payloadPath = await realpath(resolve(options.payload));
    payloadDirectory = dirname(payloadPath);
    packageRoot = payloadDirectory;
    payload = await readJson(payloadPath, "payload");
    if (!options.data_id) fail("--payload requires --data-id");
    source = payload.data?.find((entry) => entry.id === options.data_id);
    if (!source) fail(`Unknown data resource ${JSON.stringify(options.data_id)} in ${payloadPath}`);
  } else {
    if (options.data_id) fail("--data-id requires --payload");
    packageRoot = await realpath(resolve(options.package_root || process.cwd()));
    if (!(await stat(packageRoot)).isDirectory()) fail(`Package root must be a directory: ${packageRoot}`);
  }
  if (options.write && !payloadPath) fail("--write requires --payload and --data-id");

  const sourcePath = await realpath(resolveFrom(packageRoot, options.positional[0]));
  const sourceCompression = sourcePath.endsWith(".gz") ? "gzip" : "none";
  const format = options.format || inferFormat(sourcePath);
  const compression = options.compression || sourceCompression;
  if (!new Set(["json", "jsonl"]).has(format)) fail("sidecar format must be json or jsonl (or use a .json/.jsonl filename)");
  if (!new Set(["none", "gzip"]).has(compression)) fail("sidecar compression must be none or gzip");

  const rawInput = await readFile(sourcePath);
  const parsed = parseSidecarContent(rawInput, format, sourceCompression);
  const rows = rowCount(parsed.value);
  if (source) validateMaterializedDataV3(source, parsed.value, { path: `/data/${payload.data.indexOf(source)}/storage` });

  const storedBytes = compression === sourceCompression
    ? rawInput
    : (compression === "gzip" ? gzipSync(parsed.decoded, { mtime: 0 }) : parsed.decoded);
  const defaultOutput = convertedPath(sourcePath, sourceCompression, compression);
  const outputPath = options.output
    ? resolveFrom(packageRoot, options.output)
    : defaultOutput;
  const outputTarget = await inspectContainedTarget(packageRoot, outputPath, "Sidecar output");
  if (payloadPath && outputTarget.canonical === payloadPath) fail("Sidecar output cannot overwrite payload.json");

  const declaredPath = outputTarget.package_path;
  const pathSafety = inspectSafeRelativeSidecarPath(declaredPath);
  if (!pathSafety.safe) fail(`Unsafe package-relative sidecar path ${JSON.stringify(declaredPath)}: ${pathSafety.message}`);
  if (options.path) {
    const requestedPathSafety = inspectSafeRelativeSidecarPath(options.path);
    if (!requestedPathSafety.safe) fail(`Unsafe --path ${JSON.stringify(options.path)}: ${requestedPathSafety.message}`);
    if (options.path !== outputTarget.package_path) {
      fail(`--path must equal the actual package-relative output path ${JSON.stringify(outputTarget.package_path)}`);
    }
  }

  const metadataPath = options.metadata
    ? resolveFrom(packageRoot, options.metadata)
    : null;
  if (metadataPath) await inspectContainedTarget(packageRoot, metadataPath, "Sidecar metadata output");
  if (metadataPath && metadataPath === outputPath) fail("--metadata must not overwrite the sidecar output");
  if (metadataPath && metadataPath === sourcePath) fail("--metadata must not overwrite the source file");
  if (payloadPath && metadataPath === payloadPath) fail("Sidecar metadata cannot overwrite payload.json");

  const storage = {
    kind: "sidecar",
    path: declaredPath,
    format,
    compression,
    sha256: createHash("sha256").update(storedBytes).digest("hex"),
    bytes: storedBytes.byteLength,
    rows
  };

  let payloadUpdated = false;
  let payloadValidation = null;
  if (options.write) {
    source.storage = storage;
    payloadValidation = validatePayloadV3(payload);
    if (!payloadValidation.valid) {
      const details = payloadValidation.errors.map((entry) => `${entry.path} [${entry.code}]: ${entry.message}`).join("\n");
      fail(`Updated payload would be invalid:\n${details}`);
    }
  }

  if (outputPath !== sourcePath || !storedBytes.equals(rawInput)) await atomicWrite(outputPath, storedBytes);
  const canonicalOutput = await realpath(outputPath);
  if (canonicalOutput !== outputTarget.canonical) fail("Sidecar output changed location while it was being written");

  if (options.write) {
    await verifyPayloadV3Sidecars(payload, { baseDirectory: payloadDirectory, validation: payloadValidation });
  }
  if (metadataPath) await atomicWrite(metadataPath, `${JSON.stringify(storage, null, 2)}\n`);
  if (options.write) {
    await atomicWrite(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
    payloadUpdated = true;
  }

  return {
    command: "sidecar",
    source: sourcePath,
    output: outputPath,
    storage,
    package_root: packageRoot,
    ...(metadataPath ? { metadata: metadataPath } : {}),
    ...(payloadPath ? { payload: payloadPath, data_id: options.data_id, payload_updated: payloadUpdated } : {})
  };
}

export async function run(argumentsList = process.argv.slice(2)) {
  const [command, ...args] = argumentsList;
  if (!command || command === "--help" || command === "-h" || command === "help") return usage();
  if (command === "init") return commandInit(args);
  if (command === "capabilities") return commandCapabilities(args);
  if (command === "validate") return commandValidate(args);
  if (command === "render") return commandRender(args);
  if (command === "conformance") return commandConformance(args);
  if (command === "sidecar") return commandSidecar(args);
  fail(`Unknown command: ${command}\n\n${usage()}`);
}

async function main() {
  const command = process.argv[2];
  try {
    const result = await run();
    process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const receipt = command === "conformance"
      ? { command: "conformance", conformant: false, error: error.message }
      : null;
    process.stderr.write(receipt ? `${JSON.stringify(receipt, null, 2)}\n` : `${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
