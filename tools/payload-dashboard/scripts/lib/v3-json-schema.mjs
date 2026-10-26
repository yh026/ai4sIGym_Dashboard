import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isPlainObject, joinPointer, pointerToken } from "./v3-common.mjs";

const schemaUrl = new URL("../../references/payload-v3.schema.json", import.meta.url);

/** The checked-in authoring schema used by both the API and compiler path. */
export const PAYLOAD_V3_SCHEMA = Object.freeze(JSON.parse(readFileSync(schemaUrl, "utf8")));
export const PAYLOAD_V3_SCHEMA_PATH = fileURLToPath(schemaUrl);

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  return typeof value;
}

function typeMatches(value, expected) {
  if (expected === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return isPlainObject(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function diagnostic(path, code, message, schemaPath) {
  return { path, code, message, schema_path: schemaPath };
}

function resolveLocalReference(rootSchema, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) throw new Error(`Unsupported JSON Schema reference: ${String(reference)}`);
  let current = rootSchema;
  for (const rawToken of reference.slice(2).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainObject(current) || !Object.hasOwn(current, token)) throw new Error(`Unresolved JSON Schema reference: ${reference}`);
    current = current[token];
  }
  return current;
}

function validateNode(value, schema, path, schemaPath, rootSchema) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [diagnostic(path, "schema_disallowed", "value is not allowed here", schemaPath)];
  if (!isPlainObject(schema)) throw new TypeError(`Invalid JSON Schema node at ${schemaPath}`);

  if (schema.$ref !== undefined) {
    const resolved = resolveLocalReference(rootSchema, schema.$ref);
    return validateNode(value, resolved, path, schema.$ref, rootSchema);
  }

  if (Array.isArray(schema.oneOf)) {
    const branchResults = schema.oneOf.map((branch, index) => validateNode(value, branch, path, `${schemaPath}/oneOf/${index}`, rootSchema));
    const matching = branchResults.filter((errors) => errors.length === 0);
    if (matching.length === 1) return [];
    if (matching.length > 1) return [diagnostic(path, "schema_one_of", `value matches ${matching.length} oneOf branches; expected exactly one`, `${schemaPath}/oneOf`)];
    const closest = branchResults
      .map((errors, index) => ({
        errors,
        index,
        specificity: errors.reduce((score, error) => score + error.path.split("/").length, 0)
      }))
      .sort((left, right) => left.errors.length - right.errors.length || right.specificity - left.specificity || left.index - right.index)[0];
    return [
      diagnostic(path, "schema_one_of", "value does not match any allowed schema branch", `${schemaPath}/oneOf`),
      ...closest.errors
    ];
  }

  const errors = [];
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(diagnostic(path, "schema_const", `expected ${JSON.stringify(schema.const)}; received ${JSON.stringify(value)}`, `${schemaPath}/const`));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    errors.push(diagnostic(path, "schema_enum", `expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}; received ${JSON.stringify(value)}`, `${schemaPath}/enum`));
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((type) => typeMatches(value, type))) {
      errors.push(diagnostic(path, "schema_type", `expected ${expected.join(" or ")}; received ${valueType(value)}`, `${schemaPath}/type`));
      return errors;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(diagnostic(path, "schema_min_length", `string length must be at least ${schema.minLength}`, `${schemaPath}/minLength`));
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(diagnostic(path, "schema_max_length", `string length must be at most ${schema.maxLength}`, `${schemaPath}/maxLength`));
    if (schema.pattern !== undefined) {
      const pattern = new RegExp(schema.pattern, "u");
      if (!pattern.test(value)) errors.push(diagnostic(path, "schema_pattern", `string does not match ${JSON.stringify(schema.pattern)}`, `${schemaPath}/pattern`));
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(diagnostic(path, "schema_minimum", `number must be >= ${schema.minimum}`, `${schemaPath}/minimum`));
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(diagnostic(path, "schema_maximum", `number must be <= ${schema.maximum}`, `${schemaPath}/maximum`));
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(diagnostic(path, "schema_exclusive_minimum", `number must be > ${schema.exclusiveMinimum}`, `${schemaPath}/exclusiveMinimum`));
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(diagnostic(path, "schema_exclusive_maximum", `number must be < ${schema.exclusiveMaximum}`, `${schemaPath}/exclusiveMaximum`));
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(diagnostic(path, "schema_min_items", `array requires at least ${schema.minItems} items`, `${schemaPath}/minItems`));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(diagnostic(path, "schema_max_items", `array allows at most ${schema.maxItems} items`, `${schemaPath}/maxItems`));
    const prefixCount = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) errors.push(...validateNode(value[index], itemSchema, `${path === "/" ? "" : path}/${index}`, `${schemaPath}/prefixItems/${index}`, rootSchema));
      });
    }
    if (schema.items !== undefined) {
      for (let index = prefixCount; index < value.length; index += 1) {
        errors.push(...validateNode(value[index], schema.items, `${path === "/" ? "" : path}/${index}`, `${schemaPath}/items`, rootSchema));
      }
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(diagnostic(path, "schema_min_properties", `object requires at least ${schema.minProperties} properties`, `${schemaPath}/minProperties`));
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(diagnostic(path, "schema_max_properties", `object allows at most ${schema.maxProperties} properties`, `${schemaPath}/maxProperties`));
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) errors.push(diagnostic(joinPointer(path, key), "schema_required", `required property ${JSON.stringify(key)} is missing`, `${schemaPath}/required`));
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of keys) {
      const childPath = joinPointer(path, key);
      if (schema.propertyNames !== undefined) {
        errors.push(...validateNode(key, schema.propertyNames, childPath, `${schemaPath}/propertyNames`, rootSchema));
      }
      if (Object.hasOwn(properties, key)) {
        errors.push(...validateNode(value[key], properties[key], childPath, `${schemaPath}/properties/${pointerToken(key)}`, rootSchema));
      } else if (schema.additionalProperties === false) {
        errors.push(diagnostic(childPath, "schema_additional_property", `additional property ${JSON.stringify(key)} is not allowed`, `${schemaPath}/additionalProperties`));
      } else if (isPlainObject(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
        errors.push(...validateNode(value[key], schema.additionalProperties, childPath, `${schemaPath}/additionalProperties`, rootSchema));
      }
    }
  }
  return errors;
}

/** Validate a value with the dependency-free subset used by payload-v3.schema.json. */
export function validateJsonSchema(value, schema = PAYLOAD_V3_SCHEMA) {
  return validateNode(value, schema, "/", "#", schema).sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  );
}

export function validatePayloadV3Schema(value) {
  return validateJsonSchema(value, PAYLOAD_V3_SCHEMA);
}
