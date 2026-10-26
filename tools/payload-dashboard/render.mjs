#!/usr/bin/env node

import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDashboard } from "./scripts/render-dashboard.mjs";

const kitDirectory = dirname(fileURLToPath(import.meta.url));
const defaultInput = join(kitDirectory, "input", "payload.json");
const defaultOutput = join(kitDirectory, "output", "dashboard.html");

function usage() {
  return `Usage:
  node render.mjs [--input payload.json] [--output dashboard.html] [--validate-only]

With no arguments, the portable-package convention is used:
  input/payload.json (+ package-relative data/ sidecars) -> output/dashboard.html

Options:
  --input, -i PATH   Payload v3 or legacy 2.2 JSON. Default: input/payload.json
  --output, -o PATH  Standalone HTML destination. Default: output/dashboard.html
  --validate-only    Validate the package without writing HTML.
  --strict           Accepted for compatibility; validation is always strict.
  --help, -h         Show this help.`;
}

function parseArguments(argumentsList) {
  const options = {
    inputPath: defaultInput,
    outputPath: defaultOutput,
    validateOnly: false
  };
  let positionalInputSeen = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--validate-only") options.validateOnly = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--input" || argument === "-i") {
      const value = argumentsList[++index];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a path`);
      options.inputPath = resolve(value);
      positionalInputSeen = true;
    } else if (argument === "--output" || argument === "-o") {
      const value = argumentsList[++index];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a path`);
      options.outputPath = resolve(value);
    } else if (!argument.startsWith("-") && !positionalInputSeen) {
      options.inputPath = resolve(argument);
      positionalInputSeen = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    try {
      await access(options.inputPath);
    } catch {
      const hint = options.inputPath === defaultInput
        ? "Place payload.json in input/ and its sidecars under input/data/, or pass --input PATH."
        : "Check the --input path. Sidecar paths are resolved relative to payload.json.";
      throw new Error(`Payload not found: ${options.inputPath}\n${hint}`);
    }

    if (!options.validateOnly) await mkdir(dirname(options.outputPath), { recursive: true });
    const summary = await buildDashboard(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
