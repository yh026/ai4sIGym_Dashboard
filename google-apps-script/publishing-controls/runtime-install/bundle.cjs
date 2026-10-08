'use strict';

// Local-only runtime assembly. This command never calls Google, Netlify, or Git.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_NAMES = [
  'runtime-install/base/Code.gs',
  'runtime-install/base/RegistryUi.gs',
  'PublishingControlsModel.gs',
  'RegistryPublishing.gs',
  'sidebar.html',
  'manual-release/ManualReleaseStore.gs',
  'manual-release/ManualReleaseUi.gs',
];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const need = (value, message) => { if (!value) throw new Error('Runtime bundle: ' + message); };

function replaceOnce(source, marker, replacement) {
  need(source.split(marker).length === 2, 'expected one source marker: ' + marker);
  return source.replace(marker, replacement);
}

function replaceFunction(source, name, replacement) {
  const marker = 'function ' + name + '(';
  need(source.split(marker).length === 2, 'expected one adapter function: ' + name);
  const start = source.indexOf(marker), end = source.indexOf('\nfunction ', start + marker.length);
  need(end > start, 'missing end boundary for ' + name);
  return source.slice(0, start) + replacement + '\n' + source.slice(end);
}

function validateCore(source) {
  need(source.includes("function hourlySandbox(){registryPublishingRefreshStatus();}"), 'hourly handler must only refresh status');
  need(source.includes("function doPost(e){if(e&&e.parameter&&e.parameter.action==='manual_release')return registryReleaseStoreHandlePost_(e);"),
    'manual release API dispatcher is missing');
  need(source.includes('function onOpen() {\n  registryUiOnOpen_();\n}'), 'menu entry point changed');
  // Installation bindings are identifiers, never credential values.
  need(!/https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]{16,}/.test(source), 'a build hook value must not be embedded');
  need(!/AIza[0-9A-Za-z_-]{25,}/.test(source), 'an API key must not be embedded');
}

function assembleRuntime(sources) {
  SOURCE_NAMES.forEach(name => need(typeof sources[name] === 'string', 'missing source ' + name));
  const core = sources['runtime-install/base/Code.gs'];
  validateCore(core);
  let ui = replaceOnce(sources['runtime-install/base/RegistryUi.gs'], '__AIS_SIDEBAR_HTML__', JSON.stringify(sources['sidebar.html']));
  need(ui.includes('function registryUiLegacyGetStatus_() {') && ui.includes('function registryUiLegacyWriteStatus_(status) {'),
    'the base UI must expose its legacy adapters');
  ui += '\n' + sources['PublishingControlsModel.gs'] + '\n' + sources['RegistryPublishing.gs'];
  ui = replaceOnce(ui, 'function registryPublishingVerifyReceipt_(receipt,environment) {', 'function registryPublishingLegacyVerifyReceipt_(receipt,environment) {');
  ui = replaceOnce(ui, 'function registryPublishingRefreshPreview_() {', 'function registryPublishingLegacyRefreshPreview_() {');
  ui = replaceOnce(ui, 'function registryPublishingRefreshStatus() {', 'function registryPublishingLegacyRefreshStatus_() {');
  ui = replaceFunction(ui, 'registryPublishingSummary_', 'function registryPublishingSummary_() { return registryManualSummary_(); }');
  ui = replaceFunction(ui, 'registryPublishingReviewProduction', 'function registryPublishingReviewProduction() { return registryManualReviewProduction(); }');
  ui = replaceFunction(ui, 'registryPublishingConfirmProduction', 'function registryPublishingConfirmProduction(reviewId) { return registryManualConfirmProduction(reviewId); }');
  ui += '\nfunction registryPublishingRefreshStatus(){locked_(registryReleaseStoreReconcileProduction_);return registryPublishingLegacyRefreshStatus_();}\n'
    + 'function registryPublishingVerifyReceipt_(r,e){return registryManualVerifyReceipt_(r,e);}\n'
    + 'function registryPublishingRefreshPreview_(){return registryManualRefreshPreview_();}\n'
    + 'function registryUiGetStatus(){return registryManualEnrichStatus_(registryUiLegacyGetStatus_());}\n'
    + 'function registryUiWriteStatus_(s){return registryManualWritePanel_(registryUiLegacyWriteStatus_(registryManualEnrichStatus_(s)));}\n'
    + "function registryManualEnableStatusChecks(){disableSandboxAutomation();ScriptApp.newTrigger('hourlySandbox').timeBased().everyHours(1).create();}\n";
  const release = sources['manual-release/ManualReleaseStore.gs'] + '\n' + sources['manual-release/ManualReleaseUi.gs'];
  const files = {'Code.gs': core, 'RegistryUi.gs': ui, 'ManualRelease.gs': release};
  for (const [name, text] of Object.entries(files)) new vm.Script(text, {filename: name});
  new vm.Script(Object.values(files).join('\n'), {filename: 'combined-runtime.gs'});
  const manifest = {
    schema: 1,
    purpose: 'AIS manual publishing Apps Script runtime',
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, {bytes: Buffer.byteLength(text), sha256: hash(text)}])),
    sources: Object.fromEntries(SOURCE_NAMES.map(name => [name, hash(sources[name])])),
  };
  return {files, manifest};
}

function buildRuntime() {
  const sources = Object.fromEntries(SOURCE_NAMES.map(name => [name, fs.readFileSync(path.join(ROOT, name), 'utf8')]));
  return assembleRuntime(sources);
}

function writeRuntime(output) {
  need(typeof output === 'string' && output.length, 'an explicit output directory is required');
  const destination = path.resolve(output);
  need(destination !== ROOT && !destination.startsWith(path.join(__dirname, 'base') + path.sep)
    && destination !== path.join(__dirname, 'base'), 'output must not overwrite versioned runtime inputs');
  const bundle = buildRuntime();
  fs.mkdirSync(destination, {recursive: true});
  for (const [name, text] of Object.entries(bundle.files)) fs.writeFileSync(path.join(destination, name), text);
  fs.writeFileSync(path.join(destination, 'runtime-manifest.json'), JSON.stringify(bundle.manifest, null, 2) + '\n');
  return bundle.manifest;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') {
    process.stderr.write('Usage: node google-apps-script/publishing-controls/runtime-install/bundle.cjs --out <directory>\n');
    process.exitCode = 1;
  } else {
    try { process.stdout.write(JSON.stringify(writeRuntime(args[1]), null, 2) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  }
}
module.exports = {SOURCE_NAMES, assembleRuntime, buildRuntime, writeRuntime};
