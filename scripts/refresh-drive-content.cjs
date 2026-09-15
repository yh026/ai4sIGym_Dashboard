'use strict';

// Run through Codex's connected Google Drive tools. No Google credential is
// stored in this repository. This module only calls remote read operations.
module.exports = async function refreshDriveContent({ tools, root, report = () => {} }) {
  if (!root || !tools) throw new Error('A workspace root and connected Codex tools are required.');
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  async function shell(cmd) {
    let result = await tools.exec_command({ cmd, workdir: root, yield_time_ms: 1000, max_output_tokens: 20000 });
    let output = result.output;
    while (result.session_id) {
      result = await tools.write_stdin({ session_id: result.session_id, chars: '', yield_time_ms: 1000, max_output_tokens: 20000 });
      output += result.output;
    }
    if (result.exit_code !== 0) throw new Error(output || 'Local content command failed.');
    return output;
  }
  async function python(code, data) {
    return shell("python3 - <<'PY'\nimport json\narg=json.loads(" + JSON.stringify(JSON.stringify(data)) + ')\n' + code + '\nPY');
  }
  function content(result) {
    if (result.isError || !result.structuredContent) throw new Error('A Google Drive read failed.');
    return result.structuredContent;
  }
  function safeName(name) {
    if (!name || /[\\/\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) throw new Error('Unsafe source filename.');
    return name;
  }
  async function batches(items, fn, size = 6) {
    const all = [];
    for (let i = 0; i < items.length; i += size) {
      const results = await Promise.allSettled(items.slice(i, i + size).map(fn));
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) throw new Error(failed.map(result => result.reason?.message || String(result.reason)).join('\n'));
      for (const result of results) {
        all.push(result.value);
      }
    }
    return all;
  }
  function columnName(count) {
    let label = '';
    for (let n = count; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
    return label;
  }
  const local = JSON.parse(await python(`from pathlib import Path
p=Path(arg)/'local-content'
config=json.loads((p/'source.json').read_text())
inventory=p/'drive-current'/'inventory.json'
print(json.dumps({'config':config,'inventory':json.loads(inventory.read_text()) if inventory.exists() else None}))`, root));
  const config = local.config;
  if (!/^[A-Za-z0-9_-]+$/.test(config.drive_root_id) || !/^[A-Za-z0-9_-]+$/.test(config.spreadsheet_id)) throw new Error('Invalid source.json.');
  // Resolve Node from PATH or the desktop bundle supplied for this workspace.
  const node = JSON.parse(await python(`from pathlib import Path
import shutil
p=shutil.which('node')
if not p:
    candidate=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
    if candidate.exists(): p=str(candidate)
if not p: raise SystemExit('Node.js 24 is required.')
print(json.dumps(p))`, null));
  if (local.inventory) await shell(quote(node) + ' scripts/local-content.cjs verify');

  const metadata = content(await tools.mcp__codex_apps__google_drive_get_spreadsheet_metadata({ spreadsheet_id: config.spreadsheet_id }));
  const sheetNames = ['Projects', '_Registry', '_Taxonomy', '_Facets', '_Assets', '_Config', 'Options'];
  async function readSheets() {
    return Object.fromEntries(await batches(sheetNames, async name => {
      const sheet = metadata.sheets.find(s => s.properties.title === name)?.properties;
      if (!sheet) { if (name === 'Options') return [name, null]; throw new Error('Missing Registry tab: ' + name); }
      const { rowCount, columnCount } = sheet.gridProperties;
      if (rowCount * columnCount > 50000) throw new Error('Registry tab needs bounded pagination: ' + name);
      const result = content(await tools.mcp__codex_apps__google_drive_get_spreadsheet_range({
        spreadsheet_id: config.spreadsheet_id, sheet_name: name,
        range: 'A1:' + columnName(columnCount) + rowCount, value_render_option: 'UNFORMATTED_VALUE',
      }));
      return [name, result.values || []];
    }));
  }
  const sheets = await readSheets();
  if (sheets.Options === null) delete sheets.Options;
  const registry = sheets._Registry;
  const rows = registry.slice(1).filter(r => r.some(v => v !== '' && v !== null))
    .map(row => Object.fromEntries(registry[0].map((header, i) => [header, row[i] ?? ''])))
    .filter(row => row.entry_type === 'project' && ['Live', 'Draft'].includes(row.status));
  if (!rows.length) throw new Error('No active Registry projects. The current snapshot is preserved.');
  const folderStates = [];
  async function listFolder(url) {
    const result = content(await tools.mcp__codex_apps__google_drive_fetch({ url }));
    if (result.mime_type !== 'application/vnd.google-apps.folder') throw new Error('Expected a Drive folder.');
    const files = JSON.parse(result.content).files;
    if (!Array.isArray(files) || files.length >= 100) throw new Error('Folder listing may be incomplete; the current snapshot is preserved.');
    folderStates.push({ url, files });
    return files;
  }
  const rootMeta = content(await tools.mcp__codex_apps__google_drive_get_file_metadata({ fileId: config.drive_root_id }));
  const rootFiles = await listFolder(rootMeta.url);
  const files = [], references = [], projects = [];
  const seenIds = new Set();
  async function walk(folder, prefix, slug) {
    const children = await listFolder(folder.url);
    for (const file of children) {
      safeName(file.title);
      if (seenIds.has(file.id)) throw new Error('Repeated Drive file or folder identity.');
      seenIds.add(file.id);
      if (file.mime_type === 'application/vnd.google-apps.folder') await walk(file, prefix + '/' + file.title, slug);
      else if (file.mime_type.startsWith('application/vnd.google-apps.')) references.push({
        id: file.id, name: file.title, url: file.url, mime_type: file.mime_type,
        project_slug: slug, status: 'native_reference',
      });
      else files.push({ id: file.id, name: file.title, path: prefix + '/' + file.title,
        mime_type: file.mime_type, bytes: Number(file.size), modified_time: file.modified_time,
        folder_id: folder.id, source_url: file.url });
    }
  }
  report('Reading the current project folders and Registry snapshot.');
  await batches(rows, async row => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug)) throw new Error('Invalid project slug.');
    let folderId = row.source_folder_id;
    if (!folderId) {
      const primary = content(await tools.mcp__codex_apps__google_drive_get_file_metadata({ fileId: row.file_id, fields: 'id,name,mimeType,parents,webViewLink' }));
      folderId = primary.parent_ids?.find(id => rootFiles.some(f => f.id === id));
    }
    const folder = rootFiles.find(f => f.id === folderId && f.mime_type === 'application/vnd.google-apps.folder');
    if (!folder) throw new Error('Registered project folder is missing: ' + row.slug);
    await walk(folder, 'projects/' + row.slug, row.slug);
    const primary = files.find(f => f.id === row.file_id && f.folder_id === folder.id);
    if (!primary) throw new Error('Registered primary HTML is missing: ' + row.slug);
    projects.push({ demo_id: row.demo_id, slug: row.slug, title: row.title, status: row.status,
      folder_id: folder.id, folder_name: folder.title, primary_file_id: row.file_id, primary_path: primary.path });
  });
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  projects.sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
  const inventory = { schema_version: 1, source: config, projects, files, native_references: references,
    excluded_folders: rootFiles.filter(f => f.mime_type === 'application/vnd.google-apps.folder'
      && !projects.some(p => p.folder_id === f.id)).map(f => ({ id: f.id, name: f.title, reason: 'not an active registered project' })) };
  const snapshot = { schema: 1, spreadsheet_id: config.spreadsheet_id, sheets };
  const stage = root + '/local-content/.incoming-' + Date.now();
  await python(`from pathlib import Path
p=Path(arg['stage']); p.mkdir(parents=True,exist_ok=False)
(p/'inventory.json').write_text(json.dumps(arg['inventory'],indent=2)+'\\n')
(p/'registry.snapshot.json').write_text(json.dumps(arg['snapshot'],indent=2)+'\\n')`, { stage, inventory, snapshot });
  const cached = new Map((local.inventory?.files || []).map(file => [file.id, file]));
  let downloaded = 0, reused = 0;
  for (let index = 0; index < files.length; index += 6) {
    const jobs = await batches(files.slice(index, index + 6), async file => {
      const old = cached.get(file.id);
      if (old && old.bytes === file.bytes && old.modified_time === file.modified_time) {
        reused++; return { ...file, cached_path: old.path, sha256: old.sha256 };
      }
      const raw = content(await tools.mcp__codex_apps__google_drive_fetch({ url: file.source_url, download_raw_file: true, include_base64: false }));
      if (!raw.file_uri?.download_url || raw.file_size_bytes !== file.bytes
          || raw.modified_time !== file.modified_time || !raw.parent_ids?.includes(file.folder_id)) {
        throw new Error('Source changed during download: ' + file.path);
      }
      downloaded++; return { ...file, download_url: raw.file_uri.download_url };
    });
    await python(`from pathlib import Path
import urllib.request,hashlib,concurrent.futures
stage=Path(arg['stage']); current=Path(arg['root'])/'local-content/drive-current'
def materialize(job):
    target=stage/job['path']; target.parent.mkdir(parents=True,exist_ok=True)
    if 'cached_path' in job:
        data=(current/job['cached_path']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=job['sha256']: raise RuntimeError('Cached file changed')
    else:
        req=urllib.request.Request(job['download_url'],headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=90) as response: data=response.read()
    if len(data)!=job['bytes']: raise RuntimeError('Incomplete download: '+job['path'])
    target.write_bytes(data)
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: list(pool.map(materialize,arg['jobs']))`, { stage, root, jobs });
  }
  report('Checking ' + files.length + ' files (' + downloaded + ' downloaded, ' + reused + ' unchanged).');
  // Recheck the complete folder inventory and Sheet values before replacing local content.
  const canonical = list => JSON.stringify(list.map(f => [f.id, f.title, f.mime_type, f.size, f.modified_time]).sort((a, b) => a[0].localeCompare(b[0])));
  await batches(folderStates, async prior => {
    const result = content(await tools.mcp__codex_apps__google_drive_fetch({ url: prior.url }));
    const fresh = JSON.parse(result.content).files;
    if (canonical(fresh) !== canonical(prior.files)) throw new Error('Drive changed during refresh. The old snapshot is preserved.');
  });
  const finalSheets = await readSheets();
  if (finalSheets.Options === null) delete finalSheets.Options;
  if (JSON.stringify(finalSheets) !== JSON.stringify(sheets)) throw new Error('Registry changed during refresh. The old snapshot is preserved.');
  await shell(quote(node) + ' scripts/local-content.cjs seal ' + quote(stage));
  const result = JSON.parse(await shell(quote(node) + ' scripts/local-content.cjs install ' + quote(stage)));
  report({ projects: projects.length, files: files.length, downloaded, reused,
    added: result.added.length, updated: result.updated.length, removed: result.removed.length });
  return result;
};
