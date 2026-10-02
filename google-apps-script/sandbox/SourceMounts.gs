/** Map verified physical project folders to unchanged logical V3 paths. */
function projectMounts_() {
  var config = JSON.parse(PropertiesService.getScriptProperties().getProperty('AIS_PROJECT_MOUNTS_V1') || '{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid project mount configuration');
  if (config.schema !== undefined && config.schema !== 1 && config.schema !== 2) throw new Error('Unsupported project mount schema');
  if (config.schema === 2) validateCategoryMounts_(config);
  return config;
}
function oneParent_(entry) {
  var it = entry.getParents();
  if (!it.hasNext()) throw new Error('Source has no parent');
  var parent = it.next();
  if (it.hasNext()) throw new Error('Ambiguous source parents');
  return parent;
}
/** Schema 2 binds every selected source-parent folder to its entire ID ancestry.
 * Physical labels (including project numbers) never become logical paths. A
 * nested download folder needs its own mount; mounting a parent grants no access
 * to arbitrary descendants. Keep this property key to preserve existing setup.
 */
function validateCategoryMounts_(config) {
  if (config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH') throw new Error('Unrecognized project root');
  if (!Array.isArray(config.mounts)) throw new Error('Invalid category mounts');
  var ids = {}, paths = {};
  config.mounts.forEach(function(mount) {
    if (!mount || typeof mount.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(mount.id)
      || mount.id === config.root_id || mount.id === SANDBOX.drive_root_id || ids[mount.id]) throw new Error('Invalid or duplicate mount ID');
    ids[mount.id] = true;
    var chain = mount.ancestor_chain;
    if (!Array.isArray(chain) || !chain.length || chain.length > 10 || chain[chain.length - 1] !== config.root_id) throw new Error('Invalid mount ancestor chain');
    var seen = {}; seen[mount.id] = true;
    chain.forEach(function(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || seen[id]) throw new Error('Invalid or duplicate mount ancestor');
      seen[id] = true;
    });
    var logical = mount.logical_path;
    if (typeof logical !== 'string' || logical.length >= 240 || paths[logical]) throw new Error('Invalid or duplicate mount path');
    var parts = logical.split('/'), stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (parts.length < 3 || !stableId.test(parts[1]) || !stableId.test(parts[2])
      || !(parts[0] === 'datasets' && parts.length === 3
        || parts[0] === 'projects' && (parts.length === 3 || parts[3] === 'resources'))
      || parts.slice(3).some(function(part) { return !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === '.' || part === '..'; })) throw new Error('Invalid mount path');
    paths[logical] = true;
  });
}
function categoryMountPath_(folder, mount) {
  var current = folder;
  mount.ancestor_chain.forEach(function(expectedId) {
    current = oneParent_(current);
    if (current.getId() !== expectedId) throw new Error('Project mount moved outside its approved location');
  });
  return mount.logical_path;
}
function mountedSourceParentPath_(file) {
  var config = projectMounts_(), parts = [], current = file, seen = {};
  for (var depth = 0; depth < 12; depth++) {
    var parent = oneParent_(current), id = parent.getId();
    if (seen[id]) throw new Error('Source parent cycle');
    seen[id] = true;
    if (id === SANDBOX.drive_root_id) return parts.reverse().join('/');
    var mount = (config.mounts || []).find(function(m) { return m.id === id; });
    if (mount) {
      if (config.schema === 2) {
        if (depth !== 0) throw new Error('Source parent folder has no explicit category mount');
        return categoryMountPath_(parent, mount);
      }
      if (config.root_id !== '1TNFstSJC4xqz7mcZx9qyKvicwTtlqoHH') throw new Error('Unrecognized project root');
      var project = oneParent_(parent);
      if (project.getId() !== mount.project_id || oneParent_(project).getId() !== config.root_id) throw new Error('Project mount moved outside its approved location');
      if (!/^(projects|datasets)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mount.logical_path)) throw new Error('Invalid mount path');
      return mount.logical_path + (parts.length ? '/' + parts.reverse().join('/') : '');
    }
    parts.push(parent.getName()); current = parent;
  }
  throw new Error('Source is outside the approved project folders');
}
