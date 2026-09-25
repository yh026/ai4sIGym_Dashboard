/** Map verified physical project folders to unchanged logical V3 paths. */
function projectMounts_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('AIS_PROJECT_MOUNTS_V1') || '{}');
}
function oneParent_(entry) {
  var it = entry.getParents();
  if (!it.hasNext()) throw new Error('Source has no parent');
  var parent = it.next();
  if (it.hasNext()) throw new Error('Ambiguous source parents');
  return parent;
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
