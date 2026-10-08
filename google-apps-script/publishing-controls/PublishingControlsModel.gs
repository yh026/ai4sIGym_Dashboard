/** Pure publishing controls model. No Sheets, Drive, network, or trigger access.
 *
 * catalog: [{demo_id, title?}] containing every currently managed project.
 * selection: [{demo_id, includePreview: boolean, includeProduction: boolean}].
 * snapshot: {environment, known, projects: [{demo_id, version_id?, fingerprint?}]}.
 * A fingerprint must cover the project's complete release content and metadata.
 * It must use the same algorithm in candidate and deployed snapshots.
 *
 * The adapter must verify deployment identity and receipt/manifest consistency
 * before setting known=true. A cached or failed refresh is unknown, not empty.
 * Store staged selection separately from the active build input. Only an explicit
 * Update preview / Publish production action may apply a returned release plan.
 */
var RegistryPublishingModel = (function() {
  'use strict';
  var ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

  function need(condition, message) {
    if (!condition) throw new Error('Publishing controls: ' + message);
  }
  function environment(value) {
    need(value === 'preview' || value === 'production', 'invalid environment');
    return value;
  }
  function index(rows, label) {
    need(Array.isArray(rows), label + ' must be an array');
    var result = Object.create(null);
    rows.forEach(function(row) {
      need(row && typeof row.demo_id === 'string' && ID.test(row.demo_id), 'invalid ' + label + ' project ID');
      need(!Object.prototype.hasOwnProperty.call(result, row.demo_id), 'duplicate ' + label + ' project: ' + row.demo_id);
      result[row.demo_id] = row;
    });
    return result;
  }

  /** Strict booleans avoid treating a pasted "FALSE" string as a checked box. */
  function normalizeSelection(catalog, rows) {
    var projects = index(catalog, 'catalog'), selected = index(rows, 'selection');
    Object.keys(selected).forEach(function(id) { need(projects[id], 'selection has an unmanaged project: ' + id); });
    return catalog.map(function(project) {
      var row = selected[project.demo_id];
      need(row, 'selection is missing project: ' + project.demo_id);
      need(typeof row.includePreview === 'boolean' && typeof row.includeProduction === 'boolean',
        'both inclusion controls must be booleans: ' + project.demo_id);
      return {demo_id: project.demo_id, includePreview: row.includePreview, includeProduction: row.includeProduction};
    });
  }

  function normalizeSnapshot(value, expectedEnvironment) {
    need(value && typeof value.known === 'boolean', 'snapshot must explicitly state whether it is known');
    need(environment(value.environment) === environment(expectedEnvironment), 'snapshot environment mismatch');
    if (!value.known) return {environment: value.environment, known: false, projects: [],
      reason: String(value.reason || 'Deployment has not been verified.')};
    var source = index(value.projects, 'snapshot');
    return {environment: value.environment, known: true,
      revision: String(value.revision || ''), deploy_id: String(value.deploy_id || ''),
      projects: Object.keys(source).sort().map(function(id) {
        var item = source[id], fingerprint = item.fingerprint || '';
        need(!fingerprint || typeof fingerprint === 'string' && FINGERPRINT.test(fingerprint),
          'invalid project fingerprint: ' + id);
        need(!item.version_id || typeof item.version_id === 'string' && ID.test(item.version_id),
          'invalid project version: ' + id);
        return {demo_id: id, version_id: item.version_id || '', fingerprint: fingerprint};
      })};
  }

  /** Adapter for the existing V3 internal manifest or the public demos manifest.
   * Public manifests without bundles give membership only, never content equality.
   * context.verified must come from verification performed by the calling adapter.
   */
  function snapshotFromManifest(manifest, context) {
    need(context, 'manifest context is required');
    environment(context.environment);
    if (context.verified !== true) return normalizeSnapshot({environment: context.environment,
      known: false, reason: context.reason}, context.environment);
    need(manifest && Array.isArray(manifest.demos), 'verified manifest has no demos list');
    if (manifest.audience) need(manifest.audience === context.environment, 'manifest audience mismatch');
    var demos = index(manifest.demos, 'manifest'), bundles = index(manifest.bundles || [], 'bundle');
    Object.keys(bundles).forEach(function(id) { need(demos[id], 'bundle has no manifest project: ' + id); });
    if (Array.isArray(manifest.bundles)) {
      Object.keys(demos).forEach(function(id) { need(bundles[id], 'manifest project has no bundle: ' + id); });
    }
    return normalizeSnapshot({environment: context.environment, known: true,
      revision: manifest.registry_revision || context.revision || '', deploy_id: context.deploy_id || '',
      projects: manifest.demos.map(function(demo) {
        var bundle = bundles[demo.demo_id] || {};
        return {demo_id: demo.demo_id, version_id: bundle.version_id || '', fingerprint: bundle.snapshot_digest || ''};
      })}, context.environment);
  }

  /** Diff one environment. An included production project uses reviewed preview
   * content when includePreview is on; otherwise it retains its deployed version.
   * Preview never inherits production content. Neither path mutates input.
   *
   * candidate is the verified preview release for production; for preview it is
   * the validated next preview snapshot. actual is the corresponding deployed site.
   * canRelease=false means refresh/validation is required, not implicit removal.
   */
  function plan(input) {
    need(input, 'plan input is required');
    var target = environment(input.environment), catalog = index(input.catalog, 'catalog');
    var selection = normalizeSelection(input.catalog, input.selection);
    var actual = normalizeSnapshot(input.actual, target);
    var candidate = normalizeSnapshot(input.candidate, 'preview');
    var deployed = index(actual.projects, 'deployed'), available = index(candidate.projects, 'candidate');
    var blockers = [], release = [];
    if (!actual.known) blockers.push('Refresh ' + target + ' status before releasing.');
    var needsPreview = selection.some(function(setting) {
      return setting.includePreview && (target === 'preview' || setting.includeProduction);
    });
    if (!candidate.known && needsPreview) blockers.push('Validate the preview candidate before releasing.');
    Object.keys(deployed).forEach(function(id) {
      if (!catalog[id]) blockers.push('The deployed site contains an unmanaged project: ' + id);
    });
    Object.keys(available).forEach(function(id) {
      if (!catalog[id]) blockers.push('The preview candidate contains an unmanaged project: ' + id);
    });
    var rows = selection.map(function(setting) {
      var id = setting.demo_id, previous = deployed[id], next = available[id];
      var included = target === 'preview' ? setting.includePreview : setting.includeProduction;
      var row = {demo_id: id, title: catalog[id].title || id, included: included,
        status: actual.known ? (previous ? 'Published' : 'Not published') : 'Not checked',
        action: 'none', pending: false, source: '', reason: '',
        current_version_id: previous ? previous.version_id : '', next_version_id: ''};
      if (!actual.known) {
        row.action = 'unknown'; row.reason = 'The deployed state has not been verified.';
      } else if (!included) {
        row.action = previous ? 'remove' : 'none';
      } else if (target === 'production' && !setting.includePreview) {
        if (previous) {
          row.source = 'production'; row.next_version_id = previous.version_id;
          release.push({demo_id: id, source: 'production', version_id: previous.version_id, fingerprint: previous.fingerprint});
          row.reason = 'Keep the current production version; preview inclusion is off.';
        } else {
          row.action = 'blocked'; row.reason = 'There is no production version to retain. Include this project in preview and update preview first.';
        }
      } else if (!candidate.known) {
        row.action = 'unknown'; row.reason = 'The candidate has not been validated.';
      } else if (next) {
        row.source = 'preview'; row.next_version_id = next.version_id;
        release.push({demo_id: id, source: 'preview', version_id: next.version_id, fingerprint: next.fingerprint});
        if (!previous) row.action = 'add';
        else if (!previous.fingerprint || !next.fingerprint) {
          row.action = 'unknown'; row.reason = 'Content fingerprints are required to compare this project.';
        } else row.action = previous.fingerprint === next.fingerprint ? 'none' : 'update';
      } else {
        row.action = 'blocked'; row.reason = 'The included project is missing from the preview candidate.';
      }
      row.pending = row.action === 'add' || row.action === 'update' || row.action === 'remove';
      if (row.action === 'unknown' || row.action === 'blocked') blockers.push(id + ': ' + row.reason);
      return row;
    });
    return {environment: target, canRelease: blockers.length === 0, blockers: blockers,
      rows: rows, changes: rows.filter(function(row) { return row.pending; }),
      release: release, actual_revision: actual.revision || '', candidate_revision: candidate.revision || ''};
  }

  return {normalizeSelection: normalizeSelection, normalizeSnapshot: normalizeSnapshot,
    snapshotFromManifest: snapshotFromManifest, plan: plan};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RegistryPublishingModel;
