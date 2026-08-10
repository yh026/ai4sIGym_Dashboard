/**
 * AI4S demo registry — sheet generator & Drive sync
 * ==================================================
 * Paste this whole file into Extensions → Apps Script (replacing the
 * placeholder), save, then run setup() once from the toolbar.
 *
 * How a demo is uploaded now — one folder per demo:
 *
 *   <the Drive folder in Config>/
 *     tbb_cluster_explorer/                ← one sub-folder = one demo
 *         tbb_cluster_explorer.html        ← the page, named after the folder
 *         PROVENANCE.md                    ← the v2 provenance card
 *         card.png                         ← optional: the dataset picture
 *     superconductor_regression_explorer/
 *         superconductor_regression_explorer.html
 *         PROVENANCE.md
 *     old_one_off.html                     ← still fine: a loose .html in the
 *                                            root is registered exactly as
 *                                            before, just with no card to
 *                                            pre-fill the provenance columns.
 *
 * What it does:
 *   setup()        builds the Demos / Config / Log tabs, dropdowns, column
 *                  groups, hourly sync trigger and the custom menu. It also
 *                  MIGRATES an older Demos tab in place: any column this
 *                  version adds is inserted where it belongs with
 *                  insertColumnAfter, so existing data slides across with the
 *                  grid instead of falling out of alignment. Never deletes.
 *   syncDrive()    walks the Drive folder — every sub-folder, plus any loose
 *                  .html left over from the old layout — appends new demos as
 *                  Draft rows and pre-fills them from three sources, in this
 *                  order of authority:
 *                    1. whatever is already typed in the sheet — NEVER touched
 *                    2. the ai4s-meta JSON block inside the demo's HTML
 *                    3. the YAML frontmatter of the demo's PROVENANCE.md
 *                  It also picks up the demo's dataset picture, and flags
 *                  missing files and non-self-contained demos.
 *   doGet()        (used later) JSON endpoint the Netlify build reads —
 *                  the manifest, one demo page, or one dataset picture.
 *   publishPreview()    rebuilds a configured non-production branch deploy.
 *   publishProduction() rebuilds main only, after an explicit confirmation.
 *
 * The dashboard card shows the demo's `question` (the one it answers) and its
 * `picture` (the dataset's own image), so both are columns here: question is
 * pre-filled from PROVENANCE.md story.question, picture from an image dropped
 * into the demo folder — or paste your own http(s) URL over it, and sync will
 * leave it alone like any other cell you have typed in.
 *
 * Column order is never rearranged and no column is ever renamed, so an older
 * registry keeps working after the paste: re-run setup() once and the three
 * columns this version adds (question, picture, picture_file_id) appear in
 * place, with every existing row intact.
 *
 * Safe to re-run setup() at any time — it repairs formatting and never
 * deletes your rows.
 */

// ---------------------------------------------------------------- constants

var SHEET_DEMOS = 'Demos';
var SHEET_CONFIG = 'Config';
var SHEET_LOG = 'Log';
var REGISTRY_SPREADSHEET_ID_PROPERTY = 'AI4S_REGISTRY_SPREADSHEET_ID';

// Deployment guardrails. Preview publishing accepts these branch families
// plus the stable names below. Production is deliberately locked to main.
var PRODUCTION_BRANCH = 'main';
var PREVIEW_BRANCH_PREFIXES = [
  'fix/', 'feature/', 'preview/', 'chore/', 'docs/', 'test/',
  'refactor/', 'hotfix/', 'release/'
];
var PREVIEW_BRANCH_NAMES = ['develop', 'staging', 'dashboard-preview'];
var AUTO_PUBLISH_TARGETS = ['off', 'preview', 'production'];

// Column order for the Demos tab. 1-based indexes.
// Anything added here must also be added to HEADERS at the same position, and
// to headerInsertPlan_'s job by nothing at all: that function works the schema
// out from HEADERS, so setup() can migrate an older sheet on its own.
var COLS = {
  TITLE: 1, SLUG: 2, DESCRIPTION: 3, CATEGORY: 4, TAGS: 5, AUTHOR: 6,
  STATUS: 7, FEATURED: 8, AUDIENCE: 9, LEARNING_GOAL: 10, QUESTION: 11, PICTURE: 12,
  DATA_SOURCE: 13, DATA_LINK: 14, DATA_ACCESSED: 15, DATA_LICENSE: 16, DATA_NOTES: 17,
  TASK_TYPE: 18, METHOD: 19, FRAMEWORK: 20, TRAINING: 21, METRICS: 22, WORKFLOW_LINK: 23,
  PROVENANCE: 24,
  FILE_NAME: 25, FILE_ID: 26, PICTURE_FILE_ID: 27, DATE_ADDED: 28, LAST_MODIFIED: 29,
  FILE_CHECK: 30
};
var N_COLS = 30;

var HEADERS = [
  'title', 'slug', 'description', 'category', 'tags', 'author',
  'status', 'featured', 'audience', 'learning_goal', 'question', 'picture',
  'data_source', 'data_link', 'data_accessed', 'data_license', 'data_notes',
  'task_type', 'method', 'framework', 'training', 'metrics', 'workflow_link',
  'provenance',
  'file_name', 'file_id', 'picture_file_id', 'date_added', 'last_modified', 'file_check'
];

var HEADER_NOTES = {
  title: 'Shown on the card. Pre-filled from the HTML <title> tag — edit freely.',
  slug: 'Becomes the demo URL, e.g. /demos/butterfly-wings/. Auto-suggested from the demo folder name (or the title, for a loose file).',
  description: '1–2 lines shown on the dashboard card. Required to go Live. Pre-filled from PROVENANCE.md story.headline + story.data.',
  category: 'Domain of the demo. Options come from the Categories list on the Config tab. Not in the provenance card — pick it yourself.',
  tags: 'Comma-separated keywords, used by dashboard search. Not in the provenance card — type your own.',
  author: 'Who made it. Pre-filled from PROVENANCE.md notebook.author.',
  status: 'Draft = hidden. Live = on the site after next publish. Archived = kept in the record, off the site.',
  featured: 'Tick to pin this demo to the top of the dashboard.',
  audience: 'Rough level of the intended audience.',
  learning_goal: 'One sentence: what should a student take away? Shown on the demo page. Pre-filled from PROVENANCE.md story.answer — the answer IS the take-away.',
  question: 'The question this demo answers, in one plain sentence. Shown on the dashboard card next to the picture. Pre-filled from PROVENANCE.md story.question.',
  picture: 'The dataset picture on the dashboard card. Sync fills in the file name of an image found in the demo folder (card / cover / thumbnail / picture, or one named after the folder). Paste an http(s) URL here instead and sync will leave it alone.',
  data_source: 'Name of the dataset, e.g. "LTA DataMall traffic speed bands". Pre-filled from PROVENANCE.md dataset.dataset_name.',
  data_link: 'URL to the original data source (not to your copy). Pre-filled with the first URL found in PROVENANCE.md dataset.obtained_from.',
  data_accessed: 'When the data snapshot was taken — live datasets drift. Pre-filled with the first ISO date found in the card; check it before going Live.',
  data_license: 'License of the data. Matters once the dashboard is public. Pre-filled from PROVENANCE.md dataset.licence.',
  data_notes: 'One line on preprocessing / scale. Pre-filled from PROVENANCE.md dataset.prior_processing + dataset.known_issues.',
  task_type: 'ML/statistical task. Also becomes a filter axis on the dashboard. Not in the provenance card — pick it yourself.',
  method: 'Human-readable pipeline, e.g. "UMAP → K-Means". Pre-filled from the PROVENANCE.md workflow DAG (notebook.workflow).',
  framework: 'e.g. scikit-learn, PyTorch, D3, TensorFlow.js. Not in the provenance card — type your own.',
  training: 'Where the computation happened — a static HTML demo hides this. Not in the provenance card — pick it yourself.',
  metrics: 'Headline number + eval setup, e.g. "94% accuracy, held-out test". Pre-filled from PROVENANCE.md notebook.reported_results.',
  workflow_link: 'Notebook / repo / Colab that produced the demo. The real provenance anchor. Pre-filled from PROVENANCE.md notebook.file.',
  provenance: 'Auto ✓ when data_source, data_license, task_type and method are all filled. Shown as a badge on the site.',
  file_name: 'Auto — filled by sync.',
  file_id: 'Auto — Drive file ID of the demo page. Do not edit; it is how sync matches rows to files.',
  picture_file_id: 'Auto — Drive file ID of the dataset picture, so the build can download it. Empty when the folder has no picture, or when you pasted a URL into the picture column instead.',
  date_added: 'Auto — when the file was created in Drive.',
  last_modified: 'Auto — newest change in Drive across the demo page, its PROVENANCE.md and its picture.',
  file_check: 'Auto — "ok", "missing" (file gone from Drive), or a warning: external local assets, no provenance.md, an unreadable card, an unclear primary page, an unclear dataset picture.'
};

var STATUS_OPTIONS = ['Draft', 'Live', 'Archived'];
var AUDIENCE_OPTIONS = ['Intro', 'Intermediate', 'Advanced'];
var LICENSE_OPTIONS = ['CC-BY 4.0', 'CC-BY-SA 4.0', 'CC0', 'ODbL',
  'Singapore Open Data Licence', 'MIT', 'Synthetic data', 'Internal / private', 'Other'];
var TASK_OPTIONS = ['Classification', 'Regression', 'Clustering', 'Dimensionality reduction',
  'Generative', 'Simulation', 'Statistical inference', 'Visualisation only', 'Other'];
var TRAINING_OPTIONS = ['Pretrained', 'Trained offline', 'Trained in-browser', 'None / rule-based'];
var DEFAULT_CATEGORIES = ['Machine learning', 'Statistics', 'Data visualisation', 'Simulation'];

// The name of the provenance card inside a demo folder.
var PROVENANCE_FILE = 'provenance.md';

// What counts as the demo's dataset picture, and which names win when a folder
// holds more than one image. A file named after the folder wins first, then
// these words in this order; see pickDatasetPicture_.
var IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;
var PICTURE_NAMES = ['card', 'cover', 'thumbnail', 'picture'];

// Columns an ai4s-meta block inside a demo file is allowed to pre-fill.
// Sheet edits always win: meta only ever fills EMPTY cells.
var META_MAP = {
  description: COLS.DESCRIPTION, category: COLS.CATEGORY, tags: COLS.TAGS,
  author: COLS.AUTHOR, audience: COLS.AUDIENCE, learning_goal: COLS.LEARNING_GOAL,
  question: COLS.QUESTION,
  data_source: COLS.DATA_SOURCE, data_link: COLS.DATA_LINK, data_accessed: COLS.DATA_ACCESSED,
  data_license: COLS.DATA_LICENSE, data_notes: COLS.DATA_NOTES,
  task_type: COLS.TASK_TYPE, method: COLS.METHOD, framework: COLS.FRAMEWORK,
  training: COLS.TRAINING, metrics: COLS.METRICS, workflow_link: COLS.WORKFLOW_LINK
};

/**
 * PROVENANCE.md frontmatter → sheet columns.
 *
 * `from` holds FIELD PATHS INTO THE v2 CARD as design/PROVENANCE.template.md
 * spells them — nothing here is invented, and a column whose fact the card
 * simply does not carry (category, tags, audience, task_type, framework,
 * training) is deliberately absent from this table and stays empty for a human
 * to fill. `*` in a path means "every item of that list".
 *
 * `how` picks the small builder that turns the card value into one cell:
 *   text       the value as it stands
 *   lead       the value's leading clause — the card's fields are prose, the
 *              grid is not, so we take what sits before the first " — " (the
 *              card's own "name — gloss" idiom) or the first sentence. An
 *              `unknown — <why>` value always travels whole: the why is the point.
 *   sentences  every path's value, joined with a space (falls back to `alt`)
 *   lines      every path's value, joined with " · ", verbatim (numbers survive)
 *   notes      every path's value put through `lead`, joined with " · "
 *   url        the first http(s) URL found in any of the values
 *   date       the first ISO date (YYYY-MM-DD) found in any of the values,
 *              skipping documented absences ("unknown — …")
 *   licence    normalised to the data_license dropdown's own vocabulary when the
 *              text unambiguously names one of them, otherwise `lead` verbatim
 *   workflow   the DAG rendered as "a → b → {c, d} → e", the same one-line form
 *              design/check_folder.py prints
 * `max` is the cell budget; longer text is clipped with an ellipsis. Nothing is
 * lost by clipping — PROVENANCE.md remains the record, this is only the index.
 */
var CARD_MAP = [
  { col: COLS.DESCRIPTION, how: 'sentences', max: 300,
    from: ['story.headline', 'story.data'], alt: ['scope'],
    source: 'story.headline + story.data (else scope)' },
  // story.question and story.answer used to share the learning_goal cell. Now
  // that the dashboard card shows the question in its own right, the question
  // gets its own column and learning_goal keeps only the answer — one sentence
  // must not be printed in two columns.
  { col: COLS.QUESTION, how: 'sentences', max: 300,
    from: ['story.question'],
    source: 'story.question' },
  { col: COLS.LEARNING_GOAL, how: 'sentences', max: 300,
    from: ['story.answer'],
    source: 'story.answer' },
  { col: COLS.AUTHOR, how: 'lead', max: 120,
    from: ['notebook.author'],
    source: 'notebook.author' },
  { col: COLS.DATA_SOURCE, how: 'lead', max: 200,
    from: ['dataset.dataset_name'],
    source: 'dataset.dataset_name' },
  { col: COLS.DATA_LINK, how: 'url', max: 300,
    from: ['dataset.obtained_from', 'dataset.files.*.downloaded_from'],
    source: 'first URL in dataset.obtained_from / dataset.files[].downloaded_from' },
  { col: COLS.DATA_ACCESSED, how: 'date', max: 40,
    from: ['dataset.files.*.downloaded_on', 'dataset.obtained_from'],
    source: 'first ISO date in dataset.files[].downloaded_on / dataset.obtained_from' },
  { col: COLS.DATA_LICENSE, how: 'licence', max: 160,
    from: ['dataset.licence'],
    source: 'dataset.licence' },
  { col: COLS.DATA_NOTES, how: 'notes', max: 400,
    from: ['dataset.prior_processing', 'dataset.known_issues'],
    source: 'dataset.prior_processing + dataset.known_issues' },
  { col: COLS.METHOD, how: 'workflow', max: 300,
    from: ['notebook.workflow'],
    source: 'notebook.workflow, as the one-line DAG form' },
  { col: COLS.METRICS, how: 'lines', max: 300,
    from: ['notebook.reported_results'],
    source: 'notebook.reported_results (one line, or a list of them)' },
  { col: COLS.WORKFLOW_LINK, how: 'text', max: 200,
    from: ['notebook.file'],
    source: 'notebook.file' }
];

// Licence text → the data_license dropdown's own wording. Order matters:
// the ShareAlike test has to run before the plain Attribution one. Anything
// not matched here is carried over from the card verbatim, never guessed.
var LICENCE_ALIASES = [
  ['CC-BY-SA 4.0', /creative commons attribution[\s\-]share[\s\-]?alike 4\.0|cc[\s\-]?by[\s\-]?sa[\s\-]?4\.0/i],
  ['CC-BY 4.0', /creative commons attribution 4\.0|cc[\s\-]?by[\s\-]?4\.0/i],
  ['CC0', /\bcc0\b|creative commons zero|public domain dedication/i],
  ['ODbL', /\bodbl\b|open database licen[cs]e/i],
  ['Singapore Open Data Licence', /singapore open data licen[cs]e/i],
  ['MIT', /\bmit licen[cs]e\b/i],
  ['Synthetic data', /\bsynthetic (data|dataset)\b/i]
];

// ------------------------------------------------------------------- setup

/** Run this once after pasting the script. Safe to re-run any time. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  if (!ss) throw new Error('Run setup() from the Apps Script project bound to the Registry Sheet.');

  // A deployed web app has no active spreadsheet. Persist the bound Sheet ID
  // once so doGet() can reopen this exact Registry by ID in web-app context.
  PropertiesService.getScriptProperties()
    .setProperty(REGISTRY_SPREADSHEET_ID_PROPERTY, ss.getId());

  setupConfigSheet_(ss);
  setupDemosSheet_(ss);
  setupLogSheet_(ss);
  installTrigger_();
  onOpen();

  logEvent_('setup', 'Sheet structure created / repaired.');
  ss.toast('Next: paste your Drive folder URL into Config, then run "AI4S dashboard → Sync Drive folder now".',
    'Setup complete', 10);
}

function setupDemosSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_DEMOS) || ss.insertSheet(SHEET_DEMOS, 0);

  // An older sheet first: insert whatever columns this version added, in place,
  // so the rows already in the grid stay aligned with their headers.
  migrateColumns_(sh);
  ensureColumns_(sh);

  writeHeaderRow_(sh);

  // Section tints on the header: identity/publishing, data, method, system.
  paint_(sh, 1, COLS.TITLE, COLS.PICTURE, '#F1F3F4');             // identity & publishing
  paint_(sh, 1, COLS.DATA_SOURCE, COLS.DATA_NOTES, '#E8F0FE');    // data provenance
  paint_(sh, 1, COLS.TASK_TYPE, COLS.WORKFLOW_LINK, '#E6F4EA');   // model & method
  paint_(sh, 1, COLS.PROVENANCE, COLS.PROVENANCE, '#FEF7E0');     // provenance flag
  paint_(sh, 1, COLS.FILE_NAME, COLS.FILE_CHECK, '#F3E8FD');      // system (auto)

  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);

  // Dropdowns / checkbox on the data area.
  var maxR = 999;
  setListValidation_(sh, COLS.STATUS, STATUS_OPTIONS, false, maxR);
  setListValidation_(sh, COLS.AUDIENCE, AUDIENCE_OPTIONS, true, maxR);
  setListValidation_(sh, COLS.DATA_LICENSE, LICENSE_OPTIONS, true, maxR);
  setListValidation_(sh, COLS.TASK_TYPE, TASK_OPTIONS, true, maxR);
  setListValidation_(sh, COLS.TRAINING, TRAINING_OPTIONS, true, maxR);
  sh.getRange(2, COLS.FEATURED, maxR, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build());

  // Category dropdown reads the editable list on the Config tab.
  var catRange = ss.getSheetByName(SHEET_CONFIG).getRange('E2:E30');
  sh.getRange(2, COLS.CATEGORY, maxR, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(catRange, true)
      .setAllowInvalid(true).build());

  // Sensible column widths.
  var widths = {};
  widths[COLS.TITLE] = 220; widths[COLS.SLUG] = 150; widths[COLS.DESCRIPTION] = 320;
  widths[COLS.CATEGORY] = 150; widths[COLS.TAGS] = 160; widths[COLS.AUTHOR] = 110;
  widths[COLS.STATUS] = 90; widths[COLS.FEATURED] = 80; widths[COLS.AUDIENCE] = 110;
  widths[COLS.LEARNING_GOAL] = 260; widths[COLS.QUESTION] = 260; widths[COLS.PICTURE] = 170;
  widths[COLS.DATA_SOURCE] = 220; widths[COLS.DATA_LINK] = 180; widths[COLS.DATA_ACCESSED] = 120;
  widths[COLS.DATA_LICENSE] = 170; widths[COLS.DATA_NOTES] = 260;
  widths[COLS.TASK_TYPE] = 170; widths[COLS.METHOD] = 200; widths[COLS.FRAMEWORK] = 160;
  widths[COLS.TRAINING] = 150; widths[COLS.METRICS] = 200; widths[COLS.WORKFLOW_LINK] = 180;
  widths[COLS.PROVENANCE] = 100;
  widths[COLS.FILE_NAME] = 180; widths[COLS.FILE_ID] = 120; widths[COLS.PICTURE_FILE_ID] = 120;
  widths[COLS.DATE_ADDED] = 110; widths[COLS.LAST_MODIFIED] = 110; widths[COLS.FILE_CHECK] = 160;
  for (var c in widths) sh.setColumnWidth(Number(c), widths[c]);

  // Keep long text tidy in the grid.
  sh.getRange(2, 1, maxR, N_COLS).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  // Collapsible column groups: Data, Method, System. Non-fatal if unsupported.
  try {
    groupCols_(sh, COLS.DATA_SOURCE, COLS.DATA_NOTES);
    groupCols_(sh, COLS.TASK_TYPE, COLS.WORKFLOW_LINK);
    groupCols_(sh, COLS.FILE_NAME, COLS.FILE_CHECK);
  } catch (e) { /* older domains may lack the API; groups are cosmetic */ }

  protectSystemIdColumns_(sh);
}

/** Warn before anyone edits the two Drive-ID columns owned by sync. */
function protectSystemIdColumns_(sh) {
  var description = 'AI4S auto-managed Drive IDs';
  var range = sh.getRange(2, COLS.FILE_ID, Math.max(sh.getMaxRows() - 1, 1), 2);
  var protections = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  var protection = null;
  for (var i = 0; i < protections.length; i++) {
    if (protections[i].getDescription() === description) {
      protection = protections[i];
      break;
    }
  }
  if (!protection) protection = range.protect().setDescription(description);
  else protection.setRange(range);
  protection.setWarningOnly(true);
}

/**
 * Bring an older Demos tab up to the current schema, in place.
 *
 * The columns this version adds sit in the MIDDLE of the sheet, so they cannot
 * simply be appended: writing the new header row over an old grid would leave
 * every value from data_source rightwards sitting under the wrong heading.
 * insertColumnAfter moves the data with the grid instead, which is the whole
 * point of doing it this way — the cells travel, the alignment holds.
 *
 * Which columns to insert, and where, is worked out by the pure function
 * headerInsertPlan_ (see the pure zone) so it can be tested offline. Here we
 * only carry the plan out. Idempotent: a sheet already at the current schema
 * produces an empty plan and nothing happens. Never deletes a column — a
 * column this script does not know about is left exactly where it is.
 *
 * Returns the number of columns inserted.
 */
function migrateColumns_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1 || sh.getLastRow() < 1) return 0;      // brand new sheet

  var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  if (!existing.some(function (v) { return String(v == null ? '' : v).trim() !== ''; })) {
    return 0;                                            // no header row yet
  }

  var plan = headerInsertPlan_(existing, HEADERS);
  if (!plan.length) return 0;

  for (var i = 0; i < plan.length; i++) {
    var at = plan[i].after;                              // columns before the new one
    if (at <= 0) sh.insertColumnBefore(1); else sh.insertColumnAfter(at);
    // A fresh column inherits its neighbour's formatting. Strip anything that
    // would be wrong on a new text column — a dropdown, a checkbox, a note.
    sh.getRange(1, at + 1, sh.getMaxRows(), 1).clearDataValidations().clearNote();
  }

  // Name the new columns straight away. A migrated sheet whose header row still
  // has holes in it would look unmigrated to the next run, and get a second set
  // of columns inserted beside the first.
  ensureColumns_(sh);
  writeHeaderRow_(sh);

  logEvent_('setup', 'Migrated the Demos tab — inserted: '
    + plan.map(function (p) { return p.name + ' at column ' + (p.after + 1); }).join(', '));
  return plan.length;
}

/** The grid has to be at least N_COLS wide before anything writes a whole row. */
function ensureColumns_(sh) {
  var maxCols = sh.getMaxColumns();
  if (maxCols < N_COLS) sh.insertColumnsAfter(maxCols, N_COLS - maxCols);
}

function writeHeaderRow_(sh) {
  sh.getRange(1, 1, 1, N_COLS).setValues([HEADERS])
    .setFontWeight('bold').setWrap(true).setVerticalAlignment('middle');
  for (var i = 0; i < HEADERS.length; i++) {
    var note = HEADER_NOTES[HEADERS[i]];
    if (note) sh.getRange(1, i + 1).setNote(note);
  }
}

function setupConfigSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_CONFIG) || ss.insertSheet(SHEET_CONFIG);
  var existing = readConfig_(ss); // preserve values on re-run
  var autoTarget = String(existing.auto_publish_target || '').trim().toLowerCase();
  if (!autoTarget) {
    // Deliberately migrate the old yes/no switch to safe-off. Preview and
    // production are now separate, so automation must be re-enabled explicitly.
    autoTarget = 'off';
  }
  if (AUTO_PUBLISH_TARGETS.indexOf(autoTarget) === -1) autoTarget = 'off';

  var managedRows = [
    ['site_title', existing.site_title || 'AI for Science demos', 'Shown as the dashboard heading.'],
    ['site_tagline', existing.site_tagline || 'Interactive demos from our AI4S projects', 'Shown under the heading.'],
    ['drive_folder_url', existing.drive_folder_url || '', 'PASTE YOUR DRIVE FOLDER URL HERE, then run Sync from the AI4S menu. Upload one sub-folder per demo (page + PROVENANCE.md).'],
    ['netlify_build_hook', existing.netlify_build_hook || '', 'PRODUCTION Build Hook base URL. Its Netlify default branch must be main. Treat this URL as a secret.'],
    ['netlify_preview_build_hook', existing.netlify_preview_build_hook || '', 'PREVIEW Build Hook base URL. Its Netlify default branch must be non-production. Treat this URL as a secret.'],
    ['production_branch', existing.production_branch || PRODUCTION_BRANCH, 'Safety setting. Production publishing is accepted only when this is main.'],
    ['preview_branch', existing.preview_branch || '', 'Exact existing GitHub branch to preview, e.g. develop. main is always rejected.'],
    ['preview_url', existing.preview_url || '', 'Actual Branch Deploy URL copied from Netlify. Do not guess it from a branch containing slashes.'],
    ['preview_url_branch', existing.preview_url_branch || '', 'Exact branch served by preview_url. The Open preview link is shown only when this matches preview_branch.'],
    ['auto_publish_target', autoTarget, 'off (recommended), preview, or production. Controls rebuilds after an hourly Drive sync finds changes.'],
    ['access_token', existing.access_token || Utilities.getUuid(), 'Auto-generated secret for the registry endpoint. No need to touch it.']
  ];

  // Upsert only the managed keys in place. Unknown rows keep their position,
  // formulas, formatting, notes/comments, protections and named-range refs.
  sh.getRange(1, 1, 1, 3).setValues([['setting', 'value', 'notes']]);
  var rowIndex = configRowIndex_(sh);
  var rowState = { lastRow: lastConfigSettingRow_(sh) };
  var managedRowNumbers = {};
  managedRows.forEach(function (setting) {
    managedRowNumbers[setting[0]] = upsertConfigSetting_(sh, rowIndex, rowState, setting);
  });

  if (rowIndex.auto_publish) {
    sh.getRange(rowIndex.auto_publish, 3).setValue(
      'Legacy setting retained but ignored. Use auto_publish_target; upgrades default it to off.');
  }

  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  sh.getRange('A1:C1').setBackground('#F1F3F4');

  var autoTargetRow = managedRowNumbers.auto_publish_target;
  sh.getRange(autoTargetRow, 2).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(AUTO_PUBLISH_TARGETS, true)
      .setAllowInvalid(false).build());

  // Editable category list feeding the Demos dropdown.
  sh.getRange('E1').setValue('categories').setFontWeight('bold').setBackground('#F1F3F4')
    .setNote('One per row. The category dropdown and the dashboard filter chips both read this list.');
  var haveCats = sh.getRange('E2:E30').getValues().some(function (r) { return r[0] !== ''; });
  if (!haveCats) {
    sh.getRange(2, 5, DEFAULT_CATEGORIES.length, 1)
      .setValues(DEFAULT_CATEGORIES.map(function (c) { return [c]; }));
  }
  sh.setColumnWidth(1, 190); sh.setColumnWidth(2, 380); sh.setColumnWidth(3, 500); sh.setColumnWidth(5, 200);
}

function configRowIndex_(sh) {
  var out = {};
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return out;
  sh.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (r, index) {
    var key = String(r[0] || '').trim();
    if (key) out[key] = index + 2; // the last duplicate wins, like readConfig_
  });
  return out;
}

function lastConfigSettingRow_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  var values = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || '').trim()) return i + 2;
  }
  return 1;
}

function upsertConfigSetting_(sh, rowIndex, rowState, setting) {
  var key = setting[0];
  var row = rowIndex[key];
  if (!row) {
    row = rowState.lastRow + 1;
    rowState.lastRow = row;
    rowIndex[key] = row;
  }
  sh.getRange(row, 1, 1, 3).setValues([setting]);
  return row;
}

function setupLogSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  sh.getRange(1, 1, 1, 3).setValues([['when', 'event', 'details']]).setFontWeight('bold')
    .setBackground('#F1F3F4');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 100); sh.setColumnWidth(3, 520);
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncDrive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncDrive').timeBased().everyHours(1).create();
}

// -------------------------------------------------------------------- menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('AI4S dashboard')
    .addItem('Sync Drive folder now', 'syncDriveFromMenu')
    .addItem('Build preview branch', 'publishPreview')
    .addItem('Open preview site', 'showPreviewSite')
    .addSeparator()
    .addItem('Rebuild production site (main)', 'publishProduction')
    .addSeparator()
    .addItem('Show Registry API URL for Netlify', 'showBuildUrl')
    .addItem('What PROVENANCE.md fills in', 'showCardMapping')
    .addItem('Copy ai4s-meta template', 'showMetaTemplate')
    .addSeparator()
    .addItem('Re-run setup / repair sheet', 'setup')
    .addItem('Help — the routine', 'showHelp')
    .addToUi();
}

function showHelp() {
  var html = '<div style="font: 14px/1.6 Arial; padding: 4px 8px">'
    + '<b>Adding a demo</b><ol style="margin:8px 0 12px 18px; padding:0">'
    + '<li>Upload <b>one folder per demo</b> into the Drive folder. Inside it: the page, '
    + 'named after the folder (<code>my_demo/my_demo.html</code>), its '
    + '<code>PROVENANCE.md</code>, and — if you have one — the <b>dataset picture</b> for the '
    + 'dashboard card, named <code>card</code>, <code>cover</code>, <code>thumbnail</code>, '
    + '<code>picture</code> or after the folder (png / jpg / webp / gif / svg).</li>'
    + '<li>AI4S dashboard → Sync Drive folder now (or wait for the hourly sync). A Draft row '
    + 'appears with the provenance columns, the <code>question</code> and the '
    + '<code>picture</code> already filled from the card and the folder.</li>'
    + '<li>Check what it filled in, add category + task_type (those two are not in the card), '
    + 'set status to Live.</li>'
    + '<li>Use <b>Build preview branch</b> while reviewing changes. Only after the '
    + 'GitHub branch has been approved and merged into <code>main</code>, use '
    + '<b>Rebuild production site (main)</b>.</li></ol>'
    + '<b>Notes.</b> Anything you have already typed is never overwritten — sync only ever '
    + 'fills empty cells, so pasting an image URL into <code>picture</code> keeps it. '
    + 'A loose <code>.html</code> dropped straight into the Drive folder still '
    + 'works, it just has no card to read, and its <code>file_check</code> says so. '
    + 'If a folder holds several pages, the one named after the folder wins; otherwise the card’s '
    + '<code>pages:</code> entry marked <code>role: primary</code> decides. Several images with '
    + 'no such name and none is chosen — <code>file_check</code> says which ones it saw. '
    + 'Auto columns (purple headers) are maintained by sync. '
    + 'Hover any column header for an explanation of that field.</div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(470), 'AI4S dashboard — help');
}

/** Which sheet column each PROVENANCE.md field lands in — read off CARD_MAP itself. */
function showCardMapping() {
  var rows = CARD_MAP.map(function (r) {
    return '<tr><td style="padding:3px 10px 3px 0"><code>' + HEADERS[r.col - 1]
      + '</code></td><td style="padding:3px 0">' + r.source + '</td></tr>';
  }).join('');
  var blanks = [COLS.CATEGORY, COLS.TAGS, COLS.AUDIENCE, COLS.TASK_TYPE, COLS.FRAMEWORK, COLS.TRAINING]
    .map(function (c) { return '<code>' + HEADERS[c - 1] + '</code>'; }).join(', ');
  var html = '<div style="font: 13px/1.5 Arial; padding: 4px 8px">'
    + 'Sync reads the YAML frontmatter of each demo folder’s <code>PROVENANCE.md</code> '
    + 'and fills these columns — only where the cell is still empty:'
    + '<table style="margin-top:8px; border-collapse:collapse">' + rows + '</table>'
    + '<p>' + blanks + ' are <b>not</b> in the provenance card, so sync leaves them alone: '
    + 'they are yours to fill.</p>'
    + '<p><code>picture</code> and <code>picture_file_id</code> come from the demo folder, not '
    + 'from the card: sync takes an image named <code>card</code>, <code>cover</code>, '
    + '<code>thumbnail</code>, <code>picture</code> or after the folder itself.</p>'
    + '<p>An <code>ai4s-meta</code> JSON block inside the page still wins over the card.</p></div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(620).setHeight(440), 'What PROVENANCE.md fills in');
}

function showMetaTemplate() {
  var tpl = '<script type="application/json" id="ai4s-meta">\n{\n'
    + '  "description": "",\n  "category": "",\n  "tags": "",\n  "author": "",\n'
    + '  "audience": "",\n  "learning_goal": "",\n  "question": "",\n'
    + '  "data_source": "",\n  "data_link": "",\n  "data_accessed": "",\n'
    + '  "data_license": "",\n  "data_notes": "",\n'
    + '  "task_type": "",\n  "method": "",\n  "framework": "",\n'
    + '  "training": "",\n  "metrics": "",\n  "workflow_link": ""\n'
    + '}\n<\/script>';
  var html = '<div style="font: 13px Arial; padding: 4px 8px">'
    + 'Optional. Paste this anywhere inside a demo’s &lt;head&gt; or &lt;body&gt; when you want the '
    + 'page itself to say what the dashboard should show — it overrides PROVENANCE.md. It never '
    + 'executes or changes the page. Delete keys you don’t need.'
    + '<textarea style="width:100%; height:250px; margin-top:8px; font:12px monospace" '
    + 'onclick="this.select()">' + tpl.replace(/</g, '&lt;') + '</textarea></div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(520).setHeight(380), 'ai4s-meta template');
}

// -------------------------------------------------------------------- sync

function syncDriveFromMenu() {
  var res = syncDrive();
  if (res && res.error) SpreadsheetApp.getUi().alert(res.error);
}

/**
 * Scan the Drive folder and reconcile it with the Demos tab.
 * New demo  → new Draft row (title from <title>, fields from ai4s-meta, then
 *             from PROVENANCE.md).
 * Changed   → last_modified + file_check refreshed; still-empty cells re-filled
 *             from ai4s-meta and PROVENANCE.md. "Changed" means either the page
 *             or its card moved in Drive.
 * Missing   → file_check = "missing" (row is kept — the sheet is the record).
 * Always    → provenance ✓ recomputed for every row.
 */
function syncDrive() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    var busy = 'Drive sync skipped because another sync is already running.';
    logEvent_('sync', busy);
    return { error: busy };
  }
  try {
    return syncDriveUnlocked_();
  } finally {
    try { SpreadsheetApp.flush(); }
    finally { lock.releaseLock(); }
  }
}

function syncDriveUnlocked_() {
  var ss = registrySpreadsheet_();
  var cfg = readConfig_(ss);
  var folderId = folderIdFromUrl_(cfg.drive_folder_url || '');
  if (!folderId) {
    var msg = 'No Drive folder set. Paste the folder URL into Config (drive_folder_url), then sync again.';
    logEvent_('sync', msg);
    return { error: msg };
  }

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (e) {
    var msg2 = 'Could not open that folder. Check the URL in Config and that this account can access it.';
    logEvent_('sync', msg2);
    return { error: msg2 };
  }

  var sh = ss.getSheetByName(SHEET_DEMOS);
  // In case this script was pasted over an older one and sync ran before
  // setup: bring the columns up to date first, or every row below would be
  // written one schema against another. Both calls are no-ops once migrated.
  migrateColumns_(sh);
  ensureColumns_(sh);

  // Don't trust getLastRow() here: the pre-applied checkbox/dropdown formatting
  // can make it report the end of the formatted band (row 1000) instead of the
  // end of the data. Scan for the last row with real content instead.
  var gridLast = sh.getLastRow();
  var all = gridLast > 1 ? sh.getRange(2, 1, gridLast - 1, N_COLS).getValues() : [];
  var dataEnd = 1; // header row; data starts at 2
  for (var s = all.length - 1; s >= 0; s--) {
    if (rowHasContent_(all[s])) { dataEnd = s + 2; break; }
  }
  var rows = all.slice(0, Math.max(dataEnd - 1, 0));
  var byId = {};
  rows.forEach(function (r, i) { if (r[COLS.FILE_ID - 1]) byId[r[COLS.FILE_ID - 1]] = i; });
  var slugsInUse = {};
  rows.forEach(function (r) { if (r[COLS.SLUG - 1]) slugsInUse[String(r[COLS.SLUG - 1])] = true; });

  var seen = {};
  var newRows = [];
  var nNew = 0, nUpdated = 0, nWarn = 0;

  var items = collectDemos_(folder);
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    var id = it.file.getId();
    if (seen[id]) continue;   // the same page reachable twice — register it once
    seen[id] = true;

    if (byId.hasOwnProperty(id)) {
      // Known page — refresh if the page or its card changed in Drive.
      var i = byId[id];
      var stored = rows[i][COLS.LAST_MODIFIED - 1];
      var changed = !isDate_(stored) ||
        Math.abs(it.stamp.getTime() - stored.getTime()) > 60 * 1000;
      if (changed) {
        var read = readDemo_(it);
        rows[i][COLS.LAST_MODIFIED - 1] = it.stamp;
        rows[i][COLS.FILE_NAME - 1] = it.file.getName();
        rows[i][COLS.FILE_CHECK - 1] = fileCheck_(checkAssets_(read.html), it.notes.concat(read.notes));
        if (!rows[i][COLS.TITLE - 1]) rows[i][COLS.TITLE - 1] = extractTitle_(read.html, it.file.getName());
        fillRow_(rows[i], read.meta, read.card);
        fillPicture_(rows[i], it.picFile);
        nUpdated++;
      } else if (rows[i][COLS.FILE_CHECK - 1] === 'missing') {
        rows[i][COLS.FILE_CHECK - 1] = 'ok'; // it came back
      }
    } else {
      // New demo — build a Draft row.
      var fresh = readDemo_(it);
      var title = String(fresh.meta.title || extractTitle_(fresh.html, it.file.getName()));
      // The folder name is the demo's name by convention (design §10.2), so it
      // makes the steadier URL; a loose file has only its title to go on.
      var slug = uniqueSlug_(slugify_(it.folderName || title), slugsInUse);
      slugsInUse[slug] = true;

      var row = new Array(N_COLS).fill('');
      row[COLS.TITLE - 1] = title;
      row[COLS.SLUG - 1] = slug;
      row[COLS.STATUS - 1] = 'Draft';
      row[COLS.FEATURED - 1] = false;
      fillRow_(row, fresh.meta, fresh.card);
      fillPicture_(row, it.picFile);
      row[COLS.FILE_NAME - 1] = it.file.getName();
      row[COLS.FILE_ID - 1] = id;
      row[COLS.DATE_ADDED - 1] = it.file.getDateCreated();
      row[COLS.LAST_MODIFIED - 1] = it.stamp;
      row[COLS.FILE_CHECK - 1] = fileCheck_(checkAssets_(fresh.html), it.notes.concat(fresh.notes));
      newRows.push(row);
      nNew++;
    }
  }

  // Files that vanished from the folder.
  rows.forEach(function (r) {
    var id = r[COLS.FILE_ID - 1];
    if (id && !seen[id] && r[COLS.FILE_CHECK - 1] !== 'missing') {
      r[COLS.FILE_CHECK - 1] = 'missing';
      nWarn++;
    }
  });

  // Recompute the provenance flag everywhere (existing + new).
  rows.forEach(function (r) { r[COLS.PROVENANCE - 1] = provenanceFlag_(r); });
  newRows.forEach(function (r) { r[COLS.PROVENANCE - 1] = provenanceFlag_(r); });

  if (rows.length) sh.getRange(2, 1, rows.length, N_COLS).setValues(rows);
  if (newRows.length) sh.getRange(dataEnd + 1, 1, newRows.length, N_COLS).setValues(newRows);
  // Commit Registry changes before a Build Hook can make Netlify read them.
  SpreadsheetApp.flush();

  var summary = nNew + ' new, ' + nUpdated + ' updated, ' + nWarn + ' now missing.';
  logEvent_('sync', summary);
  ss.toast(summary, 'Drive sync', 6);

  // Optional hands-off mode. The target is explicit so a preview workflow can
  // never silently inherit the old production-only Build Hook behaviour.
  if ((nNew + nUpdated) > 0) {
    var autoTarget = autoPublishTarget_(cfg);
    if (autoTarget !== 'off') {
      var autoResult = triggerConfiguredBuild_(cfg, autoTarget);
      if (autoResult.ok) {
        logEvent_('publish', 'Auto-build ' + autoTarget + ' / ' + autoResult.branch
          + ' accepted by Netlify (HTTP ' + autoResult.status + ').');
      } else {
        logEvent_('publish-error', 'Auto-build ' + autoTarget + ' blocked or failed: '
          + autoResult.error);
      }
    }
  }
  return { nNew: nNew, nUpdated: nUpdated, nWarn: nWarn };
}

/**
 * The demo's dataset picture, written into the row.
 *   picture          — human-editable, so only ever filled when it is empty:
 *                      a URL you pasted there stays put.
 *   picture_file_id  — an auto column like file_id, always rewritten, so that
 *                      a picture swapped or deleted in Drive is reflected.
 */
function fillPicture_(row, picFile) {
  row[COLS.PICTURE_FILE_ID - 1] = picFile ? picFile.getId() : '';
  if (picFile && isEmptyCell_(row[COLS.PICTURE - 1])) {
    row[COLS.PICTURE - 1] = picFile.getName();
  }
}

/**
 * Everything in the Drive folder that counts as a demo, newest layout first.
 * Each item is { file, folderName, provFile, picFile, card, stamp, notes }
 * where `file` is the demo's primary page, `picFile` its dataset picture (or
 * null) and `stamp` the newest change across the page, its card and its
 * picture. Nothing is downloaded here except a card that has to be read to
 * decide which page is primary — the blobs come later, and only for demos that
 * are new or have moved.
 */
function collectDemos_(folder) {
  var out = [];

  // One sub-folder per demo — page + PROVENANCE.md.
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var item = collectDemoFolder_(subs.next());
    if (item) out.push(item);
  }

  // The old layout: a loose .html sitting in the root. Still registered, just
  // with no card behind it.
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (!isHtmlFile_(f)) continue;
    out.push({ file: f, folderName: '', provFile: null, picFile: null, card: null,
      stamp: f.getLastUpdated(), notes: [] });
  }
  return out;
}

/** One demo sub-folder → an item for collectDemos_, or null if it holds no page. */
function collectDemoFolder_(sub) {
  var name = sub.getName();
  var pages = [], images = [], prov = null;

  var files = sub.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (isHtmlFile_(f)) pages.push(f);
    else if (isImageFile_(f)) images.push(f);
    else if (String(f.getName()).toLowerCase() === PROVENANCE_FILE) prov = f;
  }
  if (!pages.length) {
    logEvent_('sync', 'Skipped folder "' + name + '" — no .html page inside.');
    return null;
  }

  var names = pages.map(function (f) { return f.getName(); });
  var pick = pickPrimaryPage_(name, names, null);
  var card = null;
  if (pick.needsCard && prov) {           // several pages and no name match:
    card = readCard_(prov);               // the card's pages[] is the tie-break
    pick = pickPrimaryPage_(name, names, card);
  }

  var imageNames = images.map(function (f) { return f.getName(); });
  var picked = pickDatasetPicture_(name, imageNames);
  var picFile = picked.file ? images[imageNames.indexOf(picked.file)] : null;

  var file = pages[names.indexOf(pick.file)] || pages[0];
  var stamp = file.getLastUpdated();
  if (prov && prov.getLastUpdated().getTime() > stamp.getTime()) stamp = prov.getLastUpdated();
  if (picFile && picFile.getLastUpdated().getTime() > stamp.getTime()) stamp = picFile.getLastUpdated();

  var notes = [];
  if (pick.note) notes.push(pick.note);
  if (picked.note) notes.push(picked.note);

  return { file: file, folderName: name, provFile: prov, picFile: picFile, card: card,
    stamp: stamp, notes: notes };
}

/** Download and parse one demo: page HTML, its ai4s-meta, its provenance card. */
function readDemo_(item) {
  var html = '';
  try { html = item.file.getBlob().getDataAsString(); }
  catch (e) { html = ''; }

  var notes = [];
  var card = item.card;
  if (!item.provFile) {
    notes.push(item.folderName ? 'no provenance.md' : 'loose file, no provenance.md');
  } else if (!card) {
    card = readCard_(item.provFile);
  }
  if (item.provFile && !hasFields_(card)) {
    notes.push('provenance unreadable');
    card = {};
  }
  return { html: html, meta: extractMeta_(html), card: card || {}, notes: notes };
}

/** PROVENANCE.md → its frontmatter as a plain object. {} when unreadable. */
function readCard_(file) {
  try { return parseFrontmatter_(file.getBlob().getDataAsString()); }
  catch (e) { return {}; }
}

// -------------------------------------------------- publish & build endpoint

/** Build the configured non-production branch and leave main untouched. */
function publishPreview() {
  var ss = SpreadsheetApp.getActive();
  var cfg = readConfig_(ss);
  var result = triggerConfiguredBuild_(cfg, 'preview');
  if (!result.ok) {
    logEvent_('publish-error', 'Manual preview build blocked or failed: ' + result.error);
    SpreadsheetApp.getUi().alert('Preview build was not started', result.error,
      SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }

  logEvent_('publish', 'Manual preview build / ' + result.branch
    + ' accepted by Netlify (HTTP ' + result.status + ').');
  ss.toast('Preview build accepted for ' + result.branch + '.', 'Preview', 6);
  showPreviewBuildResult_(result.branch, cfg.preview_url, cfg.preview_url_branch,
    cfg.production_branch);
}

/** Rebuild main only, with a visible confirmation before the Hook is called. */
function publishProduction() {
  var ss = SpreadsheetApp.getActive();
  var cfg = readConfig_(ss);
  var request = configuredBuildRequest_(cfg, 'production');
  var ui = SpreadsheetApp.getUi();
  if (!request.ok) {
    ui.alert('Production build is not configured safely', request.error, ui.ButtonSet.OK);
    return;
  }

  var answer = ui.alert('Rebuild the production site?',
    'This will ask Netlify to rebuild the production branch "' + request.branch
      + '". It does not merge Git branches. Continue?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    logEvent_('publish-cancelled', 'Production rebuild cancelled by the user.');
    return;
  }

  var result = triggerBuildRequest_(request);
  if (!result.ok) {
    logEvent_('publish-error', 'Manual production build failed: ' + result.error);
    ui.alert('Production build was not started', result.error, ui.ButtonSet.OK);
    return;
  }

  logEvent_('publish', 'Manual production build / ' + result.branch
    + ' accepted by Netlify (HTTP ' + result.status + ').');
  ss.toast('Production build accepted for main.', 'Production', 6);
}

// Backwards-compatible function name for any old menu shortcut or trigger.
// It now goes through the protected production confirmation above.
function publishSite() {
  publishProduction();
}

/** Show the real Branch Deploy URL copied from Netlify. */
function showPreviewSite() {
  var cfg = readConfig_(SpreadsheetApp.getActive());
  var branch = String(cfg.preview_branch || '').trim();
  var url = String(cfg.preview_url || '').trim();
  var urlError = previewUrlError_(branch, url, cfg.preview_url_branch,
    cfg.production_branch);
  if (urlError) {
    SpreadsheetApp.getUi().alert('Preview link is not ready', urlError,
      SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  var html = '<div style="font:14px/1.5 Arial;padding:8px 10px">'
    + '<p>Preview branch: <code>' + htmlEscape_(branch) + '</code></p>'
    + '<p><a href="' + htmlEscape_(url) + '" target="_blank" rel="noopener">Open preview site &#8599;</a></p>'
    + '</div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(440).setHeight(150), 'AI4S preview');
}

function showPreviewBuildResult_(branch, previewUrl, previewUrlBranch, productionBranch) {
  var url = String(previewUrl || '').trim();
  var urlError = previewUrlError_(branch, url, previewUrlBranch, productionBranch);
  var html = '<div style="font:14px/1.5 Arial;padding:8px 10px">'
    + '<p>Netlify accepted a build for <code>' + htmlEscape_(branch) + '</code>.</p>'
    + '<p>The existing preview may remain visible while the new build runs.</p>';
  if (urlError) {
    html += '<p><b>Preview link hidden:</b> ' + htmlEscape_(urlError) + '</p>';
  } else {
    html += '<p><a href="' + htmlEscape_(url)
      + '" target="_blank" rel="noopener">Open preview site &#8599;</a></p>';
  }
  html += '</div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(500).setHeight(urlError ? 230 : 190),
    'Preview build started');
}

/** Pure configuration step: no network or Google UI calls. */
function configuredBuildRequest_(cfg, target) {
  target = String(target || '').toLowerCase();
  var branch;
  var hook;

  if (target === 'preview') {
    branch = String(cfg.preview_branch || '').trim();
    var branchError = previewBranchError_(branch, cfg.production_branch || PRODUCTION_BRANCH);
    if (branchError) return { ok: false, target: target, error: branchError };
    hook = String(cfg.netlify_preview_build_hook || '').trim();
    if (!hook) {
      return { ok: false, target: target,
        error: 'Config is missing netlify_preview_build_hook. Create a Netlify Build Hook whose default branch is non-production, then paste its base URL into Config.' };
    }
  } else if (target === 'production') {
    branch = String(cfg.production_branch || PRODUCTION_BRANCH).trim();
    if (branch !== PRODUCTION_BRANCH) {
      return { ok: false, target: target,
        error: 'Production is locked to main. Set production_branch to main before publishing.' };
    }
    hook = String(cfg.netlify_build_hook || '').trim();
    if (!hook) {
      return { ok: false, target: target,
        error: 'Config is missing netlify_build_hook, the production Build Hook for main.' };
    }
  } else {
    return { ok: false, target: target, error: 'Unknown build target: ' + target };
  }

  var hookError = buildHookUrlError_(hook);
  if (hookError) return { ok: false, target: target, branch: branch, error: hookError };

  return {
    ok: true,
    target: target,
    branch: branch,
    hookUrl: buildHookUrl_(hook, branch, 'AI4S ' + target + ': ' + branch)
  };
}

function triggerConfiguredBuild_(cfg, target) {
  return triggerBuildRequest_(configuredBuildRequest_(cfg, target));
}

function triggerBuildRequest_(request) {
  if (!request.ok) return request;
  var response = triggerBuild_(request.hookUrl);
  response.target = request.target;
  response.branch = request.branch;
  return response;
}

/** POST one secret Hook URL and report the real HTTP outcome. */
function triggerBuild_(hookUrl) {
  try {
    var response = UrlFetchApp.fetch(hookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: '{}',
      muteHttpExceptions: true
    });
    var status = Number(response.getResponseCode());
    return {
      ok: status >= 200 && status < 300,
      status: status,
      error: status >= 200 && status < 300
        ? '' : 'Netlify returned HTTP ' + status + '. Check the Build Hook and Netlify deploy log.'
    };
  } catch (err) {
    return { ok: false, status: 0,
      error: 'Could not call Netlify: ' + safeErrorMessage_(err) };
  }
}

function safeErrorMessage_(err) {
  return String(err && err.message ? err.message : err)
    .replace(/https:\/\/api\.netlify\.com\/build_hooks\/[^\s"'<>]+/gi,
      '[redacted Netlify Build Hook]')
    .replace(/\s+/g, ' ').slice(0, 300);
}

function buildHookUrlError_(hookUrl) {
  var url = String(hookUrl || '').trim();
  if (!/^https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9_-]+$/.test(url)) {
    return 'The Build Hook must be the base https://api.netlify.com/build_hooks/... URL with no query parameters. Do not paste a Deploy URL here.';
  }
  return '';
}

function buildHookUrl_(baseUrl, branch, title) {
  return String(baseUrl).trim()
    + '?trigger_branch=' + encodeURIComponent(branch)
    + '&trigger_title=' + encodeURIComponent(title);
}

function previewBranchError_(branch, productionBranch) {
  branch = String(branch || '').trim();
  productionBranch = String(productionBranch || PRODUCTION_BRANCH).trim();
  if (!branch) return 'Config is missing preview_branch.';
  var lower = branch.toLowerCase();
  if (lower === PRODUCTION_BRANCH.toLowerCase()
      || lower === productionBranch.toLowerCase() || lower === 'master') {
    return 'Preview publishing refuses the production branch "' + branch + '".';
  }
  if (branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch)
      || branch.indexOf('..') !== -1 || branch.indexOf('//') !== -1
      || branch.indexOf('@{') !== -1 || /(^|\/)\./.test(branch)
      || /[\/.]$/.test(branch) || /(^|\/)[^\/]*\.lock(?:\/|$)/i.test(branch)) {
    return 'preview_branch is not a safe Git branch name: ' + branch;
  }

  var allowed = PREVIEW_BRANCH_NAMES.indexOf(lower) !== -1
    || PREVIEW_BRANCH_PREFIXES.some(function (prefix) {
      return lower.indexOf(prefix) === 0;
    });
  if (!allowed) {
    return 'Preview branch must use an approved prefix ('
      + PREVIEW_BRANCH_PREFIXES.join(', ') + ') or a stable preview name ('
      + PREVIEW_BRANCH_NAMES.join(', ') + ').';
  }
  return '';
}

function autoPublishTarget_(cfg) {
  var target = String(cfg.auto_publish_target || '').trim().toLowerCase();
  // The retired auto_publish=yes never silently maps to production. Run setup()
  // and choose a new explicit target if automation is genuinely wanted.
  return AUTO_PUBLISH_TARGETS.indexOf(target) === -1 ? 'off' : target;
}

function previewUrlError_(branch, previewUrl, previewUrlBranch, productionBranch) {
  branch = String(branch || '').trim();
  var branchError = previewBranchError_(branch, productionBranch || PRODUCTION_BRANCH);
  if (branchError) return branchError;
  if (!isSafeHttpsUrl_(previewUrl)) {
    return 'Config has no valid preview_url. Copy the actual HTTPS Branch Deploy URL from Netlify.';
  }
  var servedBranch = String(previewUrlBranch || '').trim();
  if (!servedBranch) {
    return 'Set preview_url_branch to the exact branch served by preview_url.';
  }
  if (servedBranch !== branch) {
    return 'preview_url_branch is "' + servedBranch + '" but preview_branch is "'
      + branch + '". Update both values from the same Netlify Branch Deploy.';
  }
  return '';
}

function isSafeHttpsUrl_(url) {
  return /^https:\/\/[^\s<>"']+$/.test(String(url || '').trim());
}

function registryUrl_(webAppUrl, accessToken) {
  return String(webAppUrl || '').trim() + '?token=' + encodeURIComponent(accessToken || '');
}

function htmlEscape_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showBuildUrl() {
  var url = ScriptApp.getService().getUrl();
  var cfg = readConfig_(SpreadsheetApp.getActive());
  if (!url) {
    SpreadsheetApp.getUi().alert('Deploy this script as a web app first (Deploy → New deployment → Web app, execute as Me, and allow requests without Google sign-in — usually access: Anyone). Then run this again.');
    return;
  }
  var full = registryUrl_(url, cfg.access_token);
  var html = '<div style="font:13px/1.5 Arial;padding:4px 8px">Paste this as the '
    + '<b>REGISTRY_URL</b> environment variable in Netlify:'
    + '<textarea style="width:100%; height:70px; margin-top:8px; font:12px monospace" '
    + 'onclick="this.select()">' + htmlEscape_(full) + '</textarea>'
    + '<p style="color:#555">This is the Registry API URL, not a Build Hook or preview URL.</p></div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(540).setHeight(205), 'Registry API URL');
}

/**
 * JSON endpoint for the Netlify build (deployed later as a web app).
 *   ?token=...&action=manifest          → site config + all Live demos
 *   ?token=...&action=manifest&status=all → every row (debugging)
 *   ?token=...&action=file&id=FILE_ID   → HTML content of one registered demo
 *   ?token=...&action=file&id=PICTURE_FILE_ID
 *                                       → that demo's dataset picture, as
 *                                         { mime, base64 } for the build to
 *                                         write back out as a file
 * Only Live ids the sheet actually carries and files physically located in
 * the configured registry folder (or one direct demo sub-folder) are served.
 */
function registrySpreadsheet_() {
  // Menus, editor runs and triggers normally have an active container.
  try {
    var active = SpreadsheetApp.getActive();
    if (active) return active;
  } catch (ignored) { /* web apps do not expose bound-script active methods */ }

  var id = PropertiesService.getScriptProperties()
    .getProperty(REGISTRY_SPREADSHEET_ID_PROPERTY);
  if (!id) {
    throw new Error('Registry Sheet ID is not configured. Run setup() once from the bound Sheet.');
  }
  return SpreadsheetApp.openById(id);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var ss;
  try {
    ss = registrySpreadsheet_();
  } catch (err) {
    return jsonOut_({ ok: false,
      error: 'registry spreadsheet unavailable — run setup() and deploy a new web-app version' });
  }
  var cfg = readConfig_(ss);

  if (!p.token || p.token !== cfg.access_token) {
    return jsonOut_({ ok: false, error: 'bad token' });
  }

  if (p.action === 'file') {
    if (!p.id) return jsonOut_({ ok: false, error: 'unknown file id' });
    var demos = readDemos_(ss).filter(function (d) { return d.status === 'Live'; });
    var isPage = demos.some(function (d) { return d.file_id === p.id; });
    var isPicture = !isPage && demos.some(function (d) {
      return d.picture_file_id !== '' && d.picture_file_id === p.id;
    });
    if (!isPage && !isPicture) return jsonOut_({ ok: false, error: 'unknown file id' });
    try {
      var file = registryDriveFile_(cfg, p.id, isPage ? 'page' : 'picture');
      if (!file) return jsonOut_({ ok: false, error: 'unknown file id' });
      var blob = file.getBlob();
      if (isPage) return jsonOut_({ ok: true, id: p.id, html: blob.getDataAsString() });
      return jsonOut_({
        ok: true, id: p.id,
        mime: String(blob.getContentType() || 'application/octet-stream'),
        base64: Utilities.base64Encode(blob.getBytes())
      });
    } catch (err) {
      return jsonOut_({ ok: false, error: 'could not read file' });
    }
  }

  // default: manifest
  var all = readDemos_(ss);
  var wanted = p.status === 'all' ? all
    : all.filter(function (d) { return d.status === 'Live'; });
  return jsonOut_({
    ok: true,
    generated: new Date().toISOString(),
    site: {
      title: cfg.site_title || 'AI for Science demos',
      tagline: cfg.site_tagline || '',
      categories: readCategories_(ss)
    },
    demos: wanted
  });
}

/**
 * Resolve a response file only inside the configured registry boundary.
 * A hand-edited Sheet ID must never turn this owner-executed web app into a
 * reader for unrelated Drive files that happen to be visible to the owner.
 */
function registryDriveFile_(cfg, fileId, kind) {
  var rootId = folderIdFromUrl_(cfg && cfg.drive_folder_url);
  if (!rootId || !/^[-\w]{10,}$/.test(String(fileId || ''))) return null;

  var file;
  try { file = DriveApp.getFileById(String(fileId)); }
  catch (ignored) { return null; }

  if (kind === 'page') {
    if (!isHtmlFile_(file)) return null;
  } else if (kind === 'picture') {
    if (!isImageFile_(file)) return null;
  } else {
    return null;
  }

  try {
    var parents = file.getParents();
    while (parents.hasNext()) {
      var parent = parents.next();
      if (kind === 'page' && parent.getId() === rootId) return file;
      if (folderHasParentId_(parent, rootId)) return file;
    }
  } catch (ignored2) { return null; }
  return null;
}

function folderHasParentId_(folder, wantedParentId) {
  var parents = folder.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === wantedParentId) return true;
  }
  return false;
}

// ----------------------------------------------------------------- readers

function readConfig_(ss) {
  var sh = ss.getSheetByName(SHEET_CONFIG);
  var out = {};
  if (!sh) return out;
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues().forEach(function (r) {
    if (r[0]) out[String(r[0]).trim()] = String(r[1]).trim();
  });
  return out;
}

function readCategories_(ss) {
  var sh = ss.getSheetByName(SHEET_CONFIG);
  if (!sh) return [];
  return sh.getRange('E2:E30').getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (v) { return v !== ''; });
}

function readDemos_(ss) {
  var sh = ss.getSheetByName(SHEET_DEMOS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  // Read only as wide as the grid actually is, then pad. This endpoint must not
  // throw on a sheet narrower than the schema — it is the one entry point that
  // never migrates anything (setup() and syncDrive() do that; a web app request
  // should not be rewriting the sheet's shape underneath the owner).
  var width = Math.min(N_COLS, sh.getMaxColumns());
  return sh.getRange(2, 1, lastRow - 1, width).getValues()
    .map(function (r) { while (r.length < N_COLS) r.push(''); return r; })
    .filter(function (r) { return r[COLS.FILE_ID - 1] !== ''; })
    .map(function (r) {
      return {
        title: String(r[COLS.TITLE - 1]),
        slug: String(r[COLS.SLUG - 1]),
        description: String(r[COLS.DESCRIPTION - 1]),
        category: String(r[COLS.CATEGORY - 1]),
        tags: String(r[COLS.TAGS - 1]).split(',').map(function (t) { return t.trim(); })
          .filter(function (t) { return t !== ''; }),
        author: String(r[COLS.AUTHOR - 1]),
        status: String(r[COLS.STATUS - 1]),
        featured: r[COLS.FEATURED - 1] === true,
        audience: String(r[COLS.AUDIENCE - 1]),
        learning_goal: String(r[COLS.LEARNING_GOAL - 1]),
        question: String(r[COLS.QUESTION - 1]),
        picture: String(r[COLS.PICTURE - 1]),
        data_source: String(r[COLS.DATA_SOURCE - 1]),
        data_link: String(r[COLS.DATA_LINK - 1]),
        data_accessed: isoOrString_(r[COLS.DATA_ACCESSED - 1]),
        data_license: String(r[COLS.DATA_LICENSE - 1]),
        data_notes: String(r[COLS.DATA_NOTES - 1]),
        task_type: String(r[COLS.TASK_TYPE - 1]),
        method: String(r[COLS.METHOD - 1]),
        framework: String(r[COLS.FRAMEWORK - 1]),
        training: String(r[COLS.TRAINING - 1]),
        metrics: String(r[COLS.METRICS - 1]),
        workflow_link: String(r[COLS.WORKFLOW_LINK - 1]),
        provenance: r[COLS.PROVENANCE - 1] === '✓',
        file_name: String(r[COLS.FILE_NAME - 1]),
        file_id: String(r[COLS.FILE_ID - 1]),
        picture_file_id: String(r[COLS.PICTURE_FILE_ID - 1]),
        date_added: isoOrString_(r[COLS.DATE_ADDED - 1]),
        last_modified: isoOrString_(r[COLS.LAST_MODIFIED - 1]),
        file_check: String(r[COLS.FILE_CHECK - 1])
      };
    });
}

// ----------------------------------------------------------- pure helpers
// (No Google services below this line — unit-testable in plain Node.)

function extractTitle_(html, fallback) {
  var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  var t = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  return t || String(fallback || '').replace(/\.html?$/i, '');
}

function extractMeta_(html) {
  var m = /<script[^>]*\bid\s*=\s*["']ai4s-meta["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
  if (!m) return {};
  try {
    var obj = JSON.parse(m[1]);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) { return {}; }
}

function metaValue_(v) {
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function slugify_(s) {
  var slug = String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'demo';
}

function uniqueSlug_(base, used) {
  if (!used[base]) return base;
  var n = 2;
  while (used[base + '-' + n]) n++;
  return base + '-' + n;
}

/**
 * Self-containment check: flag src/href values that point at local relative
 * files (which won't exist once the demo is served from the dashboard).
 */
function checkAssets_(html) {
  var re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  var bad = [];
  var m;
  while ((m = re.exec(html || '')) !== null) {
    var v = m[1].trim();
    if (v === '' || /^(https?:)?\/\//i.test(v)) continue;
    if (/^(data:|blob:|#|mailto:|tel:|javascript:)/i.test(v)) continue;
    if (bad.indexOf(v) === -1) bad.push(v);
  }
  if (!bad.length) return 'ok';
  var shown = bad.slice(0, 3).join(', ');
  return 'check assets: ' + shown + (bad.length > 3 ? ' +' + (bad.length - 3) + ' more' : '');
}

/** The asset verdict plus whatever sync noticed about the folder, as one cell. */
function fileCheck_(assetCheck, notes) {
  var base = String(assetCheck || 'ok');
  var extra = (notes || []).filter(function (n) { return n && String(n).trim() !== ''; });
  return extra.length ? base + ' — ' + extra.join('; ') : base;
}

function provenanceFlag_(row) {
  var need = [COLS.DATA_SOURCE, COLS.DATA_LICENSE, COLS.TASK_TYPE, COLS.METHOD];
  var ok = need.every(function (c) { return String(row[c - 1]).trim() !== ''; });
  return ok ? '✓' : '';
}

/** True if the row holds real content — empty strings, unticked checkboxes and nulls don't count. */
function rowHasContent_(r) {
  return r.some(function (v) { return v !== '' && v !== false && v != null; });
}

function folderIdFromUrl_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  var m = /\/folders\/([-\w]+)/.exec(s);
  if (m) return m[1];
  if (/^[-\w]{20,}$/.test(s)) return s; // a bare ID pasted directly
  return '';
}

function isoOrString_(v) {
  return isDate_(v) ? v.toISOString() : String(v || '');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

// - - - - - - - - - - - - - - - - - - - - - - - filling a row from the sources

/** An empty cell is the only kind sync is allowed to write into. */
function isEmptyCell_(v) {
  return v === '' || v === null || v === undefined;
}

function hasFields_(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) return true; }
  return false;
}

/**
 * Fill a row's empty cells. Priority, highest first:
 *   1. what is already in the cell — never overwritten, sheet edits always win
 *   2. the ai4s-meta block the demo author wrote for the dashboard
 *   3. the PROVENANCE.md card
 * Returns how many cells were written, for the caller's own bookkeeping.
 */
function fillRow_(row, meta, card) {
  var filled = 0, c;
  for (var key in META_MAP) {
    if (!Object.prototype.hasOwnProperty.call(META_MAP, key)) continue;
    c = META_MAP[key];
    if (meta && meta[key] != null && meta[key] !== '' && isEmptyCell_(row[c - 1])) {
      row[c - 1] = metaValue_(meta[key]);
      filled++;
    }
  }
  var fromCard = cardToColumns_(card);
  for (var col in fromCard) {
    if (!Object.prototype.hasOwnProperty.call(fromCard, col)) continue;
    c = Number(col);
    if (isEmptyCell_(row[c - 1])) { row[c - 1] = fromCard[col]; filled++; }
  }
  return filled;
}

// - - - - - - - - - - - - - - - - - - - - - - - the card → column mapping

/** The whole card reduced to { columnIndex: cellText }. Empty when nothing maps. */
function cardToColumns_(card) {
  var out = {};
  if (!card || typeof card !== 'object' || Array.isArray(card)) return out;
  for (var i = 0; i < CARD_MAP.length; i++) {
    var rule = CARD_MAP[i];
    var v = '';
    try { v = cardValue_(card, rule); } catch (e) { v = ''; }   // one bad field never sinks the rest
    v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (v) out[rule.col] = clip_(v, rule.max || 300);
  }
  return out;
}

/** One CARD_MAP rule applied to one card. */
function cardValue_(card, rule) {
  var vals;
  switch (rule.how) {
    case 'text':
      return String(cardFirst_(card, rule.from) || '');
    case 'lead':
      return lead_(cardFirst_(card, rule.from));
    case 'sentences':
      vals = cardAll_(card, rule.from);
      if (!vals.length && rule.alt) vals = cardAll_(card, rule.alt);
      return vals.join(' ');
    case 'lines':
      return cardAll_(card, rule.from).join(' · ');
    case 'notes':
      return cardAll_(card, rule.from).map(lead_).join(' · ');
    case 'url':
      return firstUrl_(cardAll_(card, rule.from));
    case 'date':
      return firstIsoDate_(cardAll_(card, rule.from).filter(function (t) {
        return !/^unknown\b/i.test(t);   // a documented absence is not a date
      }));
    case 'licence':
      return licenceLabel_(cardFirst_(card, rule.from));
    case 'workflow':
      return workflowLine_(cardRaw_(card, rule.from[0]));
  }
  return '';
}

/**
 * Look a dotted path up in the card. `*` walks every item of a list, so
 * "dataset.files.*.sha256" is legal. Returns the raw value, or undefined.
 * With a `*` in it the result is always a (possibly empty) array.
 */
function cardRaw_(card, path) {
  var parts = String(path || '').split('.');
  var cur = [card], next, i, j, node;
  var spread = false;
  for (i = 0; i < parts.length; i++) {
    next = [];
    for (j = 0; j < cur.length; j++) {
      node = cur[j];
      if (node == null) continue;
      if (parts[i] === '*') {
        spread = true;
        if (Array.isArray(node)) next = next.concat(node);
        continue;
      }
      if (typeof node !== 'object') continue;
      if (Array.isArray(node) && /^[0-9]+$/.test(parts[i])) next.push(node[Number(parts[i])]);
      else if (!Array.isArray(node)) next.push(node[parts[i]]);
    }
    cur = next;
  }
  cur = cur.filter(function (v) { return v !== undefined; });
  if (spread) return cur;
  return cur.length ? cur[0] : undefined;
}

/** Every filled string a list of paths yields, lists flattened, TODOs dropped. */
function cardAll_(card, paths) {
  var out = [];
  (paths || []).forEach(function (p) {
    pushFilled_(out, cardRaw_(card, p));
  });
  return out;
}

/** The first filled string among a list of paths. */
function cardFirst_(card, paths) {
  var all = cardAll_(card, paths);
  return all.length ? all[0] : '';
}

function pushFilled_(out, v) {
  if (v == null) return;
  if (Array.isArray(v)) {
    for (var i = 0; i < v.length; i++) pushFilled_(out, v[i]);
    return;
  }
  if (typeof v === 'object') return;                 // a map is never a cell
  var s = (v === true) ? 'yes' : (v === false ? 'no' : String(v));
  s = s.replace(/\s+/g, ' ').trim();
  if (isFilled_(s)) out.push(s);
}

/** A card value that is absent, blank or still a TODO carries no fact. */
function isFilled_(s) {
  var t = String(s == null ? '' : s).trim();
  return t !== '' && !/\bTODO\b/.test(t);
}

/**
 * The leading clause of a card field. The card's fields are prose; the grid is
 * one line. So: a documented absence travels whole (the "why" is the point),
 * otherwise take what sits before the card's own " — " gloss dash, otherwise
 * the first sentence, otherwise the lot.
 */
function lead_(s) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/^unknown\b/i.test(t)) return t;
  var d = t.indexOf(' — ');
  if (d > 2 && d <= 120) return t.slice(0, d);
  var m = /^([\s\S]{20,220}?[.!?])(\s|$)/.exec(t);
  if (m) return m[1];
  return t;
}

function clip_(s, max) {
  var t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  var cut = t.slice(0, max - 1);
  var sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[ ,;:.\-–—]+$/, '') + '…';
}

function firstUrl_(list) {
  for (var i = 0; i < (list || []).length; i++) {
    var m = /https?:\/\/[^\s,;"'<>()\[\]]+/i.exec(list[i]);
    if (m) return m[0].replace(/[.,;:]+$/, '');
  }
  return '';
}

function firstIsoDate_(list) {
  for (var i = 0; i < (list || []).length; i++) {
    var m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(list[i]);
    if (m) return m[1];
  }
  return '';
}

/** The licence as the dropdown words it when that is unambiguous, else verbatim. */
function licenceLabel_(text) {
  var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  for (var i = 0; i < LICENCE_ALIASES.length; i++) {
    if (LICENCE_ALIASES[i][1].test(t)) return LICENCE_ALIASES[i][0];
  }
  return lead_(t);
}

/**
 * The workflow DAG as the one line the card body prints: "a → b → {c, d} → e".
 * A port of design/check_folder.py workflow_line(), rendered from the EDGES:
 * steps sharing an identical `needs` set are grouped in braces, and a clause is
 * chained onto the previous one only when its sources are exactly what the
 * previous clause produced — otherwise a new clause starts after " · ".
 * Returns '' for anything that is not a usable DAG (no ids, duplicate ids, a
 * cycle): a wrong pipeline in the method column is worse than an empty one.
 */
function workflowLine_(steps) {
  if (!Array.isArray(steps) || !steps.length) return '';

  var order = [], needs = {}, i, j;
  for (i = 0; i < steps.length; i++) {
    var st = steps[i];
    if (!st || typeof st !== 'object' || Array.isArray(st)) return '';
    var id = st.id == null ? '' : String(st.id).trim();
    if (!id || Object.prototype.hasOwnProperty.call(needs, id)) return '';
    var n = st.needs == null ? [] : (Array.isArray(st.needs) ? st.needs : [st.needs]);
    needs[id] = n.map(function (x) { return String(x).trim(); });
    order.push(id);
  }
  // An edge to a step that does not exist is dropped: the checker reports it,
  // this line just should not deadlock on it.
  order.forEach(function (id) {
    needs[id] = needs[id].filter(function (x) {
      return Object.prototype.hasOwnProperty.call(needs, x);
    });
  });

  // Kahn's algorithm, same ready-queue order as the Python.
  var indeg = {}, ready = [], done = [];
  order.forEach(function (id) { indeg[id] = needs[id].length; });
  order.forEach(function (id) { if (indeg[id] === 0) ready.push(id); });
  while (ready.length) {
    var cur = ready.shift();
    done.push(cur);
    for (j = 0; j < order.length; j++) {
      if (needs[order[j]].indexOf(cur) !== -1 && --indeg[order[j]] === 0) ready.push(order[j]);
    }
  }
  if (done.length !== order.length) return '';   // a cycle

  var rank = {};
  done.forEach(function (id, k) { rank[id] = k; });

  var groups = [], seen = {};
  done.forEach(function (id) {
    var key = needs[id].slice().sort(function (a, b) { return rank[a] - rank[b]; });
    if (!key.length) return;                     // a root is named by the clause it feeds
    var k = key.join('');
    if (Object.prototype.hasOwnProperty.call(seen, k)) groups[seen[k]].targets.push(id);
    else { seen[k] = groups.length; groups.push({ sources: key, targets: [id] }); }
  });

  var chains = [], produced = null;
  groups.forEach(function (g) {
    if (produced && sortedKey_(g.sources) === sortedKey_(produced)) {
      chains[chains.length - 1].push(braced_(g.targets));
    } else {
      chains.push([braced_(g.sources), braced_(g.targets)]);
    }
    produced = g.targets;
  });
  var line = chains.map(function (c) { return c.join(' → '); }).join(' · ');

  var named = {};
  chains.forEach(function (c) {
    c.forEach(function (part) {
      part.replace(/[{}]/g, '').split(', ').forEach(function (id) { named[id] = true; });
    });
  });
  var loose = order.filter(function (id) { return !named[id]; });
  if (loose.length) line = (line ? line + ' · ' : '') + '(unconnected: ' + loose.join(', ') + ')';
  return line;
}

function braced_(ids) {
  return ids.length === 1 ? ids[0] : '{' + ids.join(', ') + '}';
}

function sortedKey_(ids) {
  return ids.slice().sort().join('');
}

// - - - - - - - - - - - - - - - - - - - - - - - which page in the folder

/**
 * Which .html in a demo folder is the demo. In order:
 *   (a) the file named after the folder — the convention (design §10.2)
 *   (b) the card's Part C `pages:` entry with `role: primary`
 *   (c) the only page there is
 * Files called template*.html or _*.html are set aside first; they are only
 * considered if the folder has nothing else. When none of the three rules
 * decides, the alphabetically first candidate is used and `note` says so — the
 * row still gets built, because a row with a warning beats no row at all.
 * `needsCard` tells the caller it is worth reading PROVENANCE.md and asking again.
 */
function pickPrimaryPage_(folderName, htmlNames, card) {
  var names = (htmlNames || []).filter(function (n) { return /\.html?$/i.test(String(n)); });
  if (!names.length) return { file: '', rule: 'none', note: 'no .html page in the folder', needsCard: false };

  var main = names.filter(function (n) { return !isSidePage_(n); });
  var pool = (main.length ? main : names).slice().sort();

  // (a) named after the folder
  var want = baseName_(folderName).toLowerCase();
  for (var i = 0; i < pool.length; i++) {
    if (baseName_(pool[i]).toLowerCase() === want) {
      return { file: pool[i], rule: 'folder-name', note: '', needsCard: false };
    }
  }

  // (b) the card says which one is primary
  var primary = cardPrimaryPage_(card);
  if (primary) {
    for (var j = 0; j < names.length; j++) {
      if (baseName_(names[j]).toLowerCase() === baseName_(primary).toLowerCase()) {
        return { file: names[j], rule: 'card-primary', note: '', needsCard: false };
      }
    }
  }

  // (c) the only one
  if (pool.length === 1) return { file: pool[0], rule: 'only-page', note: '', needsCard: false };

  return {
    file: pool[0], rule: 'ambiguous', needsCard: !primary,
    note: 'primary page unclear (' + pool.join(', ') + ') — using ' + pool[0]
  };
}

/** The `file` of the Part C pages[] entry whose role is primary, if any. */
function cardPrimaryPage_(card) {
  var pages = cardRaw_(card || {}, 'pages');
  if (!Array.isArray(pages)) return '';
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i];
    if (!p || typeof p !== 'object') continue;
    if (String(p.role || '').toLowerCase() === 'primary' && isFilled_(p.file)) {
      return String(p.file).replace(/^.*\//, '');   // the card may carry a path
    }
  }
  return '';
}

/** template.html, template_v2.html, _scratch.html … — kept out of the running. */
function isSidePage_(name) {
  return /^(template|_)/i.test(baseName_(name));
}

function baseName_(name) {
  return String(name || '').replace(/^.*\//, '').replace(/\.html?$/i, '');
}

/** A file name with its directory and its extension taken off. */
function stemName_(name) {
  return String(name || '').replace(/^.*\//, '').replace(/\.[^.]*$/, '');
}

// - - - - - - - - - - - - - - - - - - - - - - - which image is the dataset picture

/**
 * Which image in a demo folder is the dataset picture for the dashboard card.
 * In order:
 *   (a) a NAMED one — the file named after the folder, else card / cover /
 *       thumbnail / picture, in that order of preference. Ties inside one tier
 *       break alphabetically, so the answer never depends on Drive's ordering.
 *   (b) the only image there is
 *   (c) several images and not one of those names → NONE is chosen, and `note`
 *       says which ones were seen. Guessing here would put an arbitrary
 *       screenshot on the dashboard card, which is worse than an empty cell
 *       the owner can fill in one paste.
 * Returns { file, rule, note } — `file` empty when nothing was chosen.
 */
function pickDatasetPicture_(folderName, imageNames) {
  var names = (imageNames || [])
    .map(function (n) { return String(n); })
    .filter(function (n) { return IMAGE_EXT.test(n); })
    .sort();
  if (!names.length) return { file: '', rule: 'none', note: '' };

  // (a) a name that says "this is the card picture"
  var want = [String(folderName || '').toLowerCase()].concat(PICTURE_NAMES);
  for (var w = 0; w < want.length; w++) {
    if (!want[w]) continue;
    for (var i = 0; i < names.length; i++) {
      if (stemName_(names[i]).toLowerCase() === want[w]) {
        return { file: names[i], rule: w === 0 ? 'folder-name' : 'named', note: '' };
      }
    }
  }

  // (b) the only image
  if (names.length === 1) return { file: names[0], rule: 'only-image', note: '' };

  // (c) too many, no clue
  return {
    file: '', rule: 'ambiguous',
    note: 'dataset picture unclear (' + names.join(', ') + ') — none chosen; '
      + 'rename one to ' + PICTURE_NAMES[0] + ' or fill the picture column yourself'
  };
}

// - - - - - - - - - - - - - - - - - - - - - - - migrating an older sheet

/**
 * Which columns are missing from a sheet's header row, and where each one has
 * to be inserted — the offline half of migrateColumns_.
 *
 * Returns a list of { name, after } operations to be applied IN ORDER, where
 * `after` is how many columns precede the new one AT THE MOMENT THAT OPERATION
 * RUNS (so `after` 10 means insertColumnAfter(10); 0 means insertColumnBefore(1)).
 * Each step is computed against the sheet as the previous steps left it, which
 * is why they cannot be reordered or applied backwards.
 *
 * A header the script does not know about is never touched and never counted —
 * a column somebody added by hand keeps its place and its data. The one
 * assumption is that the known columns are still in their original relative
 * order, which is the only shape this script has ever written.
 */
function headerInsertPlan_(existingHeaders, wantedHeaders) {
  var cur = (existingHeaders || []).map(function (h) {
    return String(h == null ? '' : h).trim().toLowerCase();
  });
  while (cur.length && cur[cur.length - 1] === '') cur.pop();   // trailing blanks are not columns

  var wanted = wantedHeaders || [];
  var plan = [];
  for (var w = 0; w < wanted.length; w++) {
    var name = String(wanted[w]).toLowerCase();
    if (cur.indexOf(name) !== -1) continue;                     // already there
    var at = Math.min(w, cur.length);                           // columns before it
    plan.push({ name: name, after: at });
    cur.splice(at, 0, name);
  }
  return plan;
}

// - - - - - - - - - - - - - - - - - - - - - - - the YAML frontmatter parser

/**
 * A minimal YAML frontmatter parser — enough for a PC5251 v2 provenance card
 * (design/PROVENANCE.template.md) and no more. Apps Script ships no YAML
 * library and this file has to stay one paste-able script, so the subset lives
 * here. WHAT IT HANDLES, all of it exercised by a real card:
 *   • the `---` … `---` fence at the top of the file, BOM tolerated; the end is
 *     the first line that is exactly `---`, same rule design/check_folder.py uses
 *   • block mappings nested by indentation, to any depth (dataset → usage → …)
 *   • block sequences of scalars (`- one line`), of mappings written over
 *     several lines (`- file: x` + more-indented keys) and of flow mappings
 *     (`- {id: load, stage: 1, needs: [a, b]}`)
 *   • flow mappings and flow sequences, quotes and nesting respected
 *   • double- and single-quoted scalars, including ones wrapped over several
 *     lines, which are folded back onto one with single spaces
 *   • plain scalars wrapped over several lines, folded the same way
 *   • literal / folded block scalars — `key: |`, `key: >`, with -/+ chomping
 *   • `#` comments, whole-line and trailing, never inside a quoted string
 *   • yes/no/true/false → boolean, plain integers and floats → number,
 *     null/~/empty → null, anything else → string (so 2024-05-05 stays a string)
 *
 * WHAT IT DOES NOT HANDLE — a v2 card never needs these, and each one throws,
 * which lands the caller on the safe {} path:
 *   anchors and aliases (&a, *a), tags (!!str), multiple documents, complex
 *   keys (`? k`), merge keys (<<), tab indentation, and a wrapped plain scalar
 *   whose continuation line contains a `: ` — that line is read as a new key.
 * Also: a `---` line inside a block scalar would end the frontmatter early.
 *
 * On ANY failure it returns {} — sync must never break on a malformed card, it
 * just records "provenance unreadable" in file_check and carries on.
 */
function parseFrontmatter_(text) {
  try {
    var body = frontmatterBlock_(text);
    if (body === null) return {};
    var st = { lines: body.split('\n'), i: 0 };
    var val = yamlBlock_(st, -1);
    return (val && typeof val === 'object' && !Array.isArray(val)) ? val : {};
  } catch (e) {
    return {};
  }
}

/** The text between the opening and closing `---` fences, or null if there is none. */
function frontmatterBlock_(text) {
  var t = String(text == null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  var lines = t.split('\n');
  if (lines.length < 2 || lines[0].replace(/[ \t]+$/, '') !== '---') return null;
  for (var i = 1; i < lines.length; i++) {
    var s = lines[i].replace(/[ \t]+$/, '');
    if (s === '---' || s === '...') return lines.slice(1, i).join('\n');
  }
  return null;
}

/** The next line that carries content, comments and blanks skipped. Does not consume it. */
function yamlPeek_(st) {
  while (st.i < st.lines.length) {
    var stripped = yamlStripComment_(st.lines[st.i]).replace(/[ \t]+$/, '');
    if (stripped.replace(/^[ \t]+/, '') === '') { st.i++; continue; }
    if (/^ *\t/.test(stripped)) throw new Error('tab used for indentation');
    var body = stripped.replace(/^ +/, '');
    return { indent: stripped.length - body.length, text: body };
  }
  return null;
}

/** A mapping or a sequence sitting under a key indented at `parentIndent`. */
function yamlBlock_(st, parentIndent) {
  var info = yamlPeek_(st);
  if (!info) return null;
  // A sequence may sit at its key's own indent — `known_issues:` then `- a`.
  if (info.indent === parentIndent && /^-([ \t]|$)/.test(info.text)) return yamlSeq_(st, info.indent);
  if (info.indent <= parentIndent) return null;
  if (/^-([ \t]|$)/.test(info.text)) return yamlSeq_(st, info.indent);
  return yamlMap_(st, info.indent);
}

function yamlMap_(st, indent) {
  var out = {};
  for (;;) {
    var info = yamlPeek_(st);
    if (!info || info.indent < indent) return out;
    if (info.indent > indent) throw new Error('unexpected indent at "' + info.text + '"');
    if (/^-([ \t]|$)/.test(info.text)) return out;
    st.i++;
    yamlEntry_(st, indent, info.text, out);
  }
}

function yamlSeq_(st, indent) {
  var out = [];
  for (;;) {
    var info = yamlPeek_(st);
    if (!info || info.indent !== indent || !/^-([ \t]|$)/.test(info.text)) {
      if (info && info.indent > indent) throw new Error('unexpected indent in a list');
      return out;
    }
    st.i++;
    var head = info.text.replace(/^-[ \t]*/, '');
    var keyCol = indent + (info.text.length - head.length);
    if (head === '') {
      out.push(yamlBlock_(st, indent));
    } else if (/^[|>][+-]?$/.test(head)) {
      out.push(yamlBlockScalar_(st, indent, head));
    } else if (!/^["'{\[]/.test(head) && /^[^:#]+?[ \t]*:([ \t]|$)/.test(head)) {
      // `- key: value`, the rest of the mapping indented under the key column
      var obj = {};
      yamlEntry_(st, keyCol, head, obj);
      var more = yamlMap_(st, keyCol);
      for (var k in more) { if (Object.prototype.hasOwnProperty.call(more, k)) obj[k] = more[k]; }
      out.push(obj);
    } else {
      out.push(yamlScalarFrom_(st, indent, head));
    }
  }
}

/** One `key: value` pair — plus whatever is indented under it — into `out`. */
function yamlEntry_(st, indent, text, out) {
  var m = /^([^:#]+?)[ \t]*:(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!m) throw new Error('not a key: "' + text + '"');
  var key = yamlKey_(m[1]);
  var rest = m[2] == null ? '' : m[2].replace(/[ \t]+$/, '');
  if (rest === '') {
    out[key] = yamlBlock_(st, indent);
  } else if (/^[|>][+-]?$/.test(rest)) {
    out[key] = yamlBlockScalar_(st, indent, rest);
  } else {
    out[key] = yamlScalarFrom_(st, indent, rest);
  }
}

function yamlKey_(raw) {
  var k = String(raw).trim();
  if ((k.charAt(0) === '"' && k.charAt(k.length - 1) === '"') ||
      (k.charAt(0) === "'" && k.charAt(k.length - 1) === "'")) {
    k = k.slice(1, -1);
  }
  return k;
}

/**
 * A scalar that starts on the key's line and may run on over the next ones:
 * an unclosed quote or an unclosed flow collection pulls in raw lines, and a
 * plain scalar folds in any deeper-indented line that is plainly prose.
 */
function yamlScalarFrom_(st, indent, head) {
  var acc = head, guard = 0;
  var q = acc.charAt(0);

  if (q === '"' || q === "'") {
    while (yamlQuoteEnd_(acc, q) === -1) {
      if (st.i >= st.lines.length || ++guard > 500) throw new Error('unterminated quoted scalar');
      acc += ' ' + st.lines[st.i].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      st.i++;
    }
    return yamlScalar_(acc);
  }

  if (q === '{' || q === '[') {
    while (!yamlFlowClosed_(acc)) {
      if (st.i >= st.lines.length || ++guard > 500) throw new Error('unterminated flow collection');
      acc += ' ' + st.lines[st.i].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      st.i++;
    }
    return yamlScalar_(acc);
  }

  for (;;) {
    var info = yamlPeek_(st);
    if (!info || info.indent <= indent) break;
    if (/^-([ \t]|$)/.test(info.text)) break;
    if (/^[^:#]+?[ \t]*:([ \t]|$)/.test(info.text)) break;   // that is a key, not our prose
    acc += ' ' + info.text;
    st.i++;
  }
  return yamlScalar_(acc);
}

/**
 * `key: |` and `key: >`. Everything indented deeper than the key belongs to the
 * block, comment marks and all — inside a block scalar a `#` is content.
 * Trailing blank lines are dropped and no trailing newline is kept: nothing in
 * the card needs one, and a spreadsheet cell certainly does not.
 */
function yamlBlockScalar_(st, indent, header) {
  var folded = header.charAt(0) === '>';
  var keepAll = header.indexOf('+') !== -1;
  var lines = [], blockIndent = -1;
  while (st.i < st.lines.length) {
    var raw = st.lines[st.i].replace(/[ \t]+$/, '');
    if (raw === '') { lines.push(''); st.i++; continue; }
    if (/^ *\t/.test(raw)) throw new Error('tab used for indentation');
    var body = raw.replace(/^ +/, '');
    var ind = raw.length - body.length;
    if (ind <= indent) break;
    if (blockIndent < 0) blockIndent = ind;
    lines.push(raw.slice(Math.min(ind, blockIndent)));
    st.i++;
  }
  if (!keepAll) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
  }
  return folded ? lines.join(' ').replace(/\s+/g, ' ').trim() : lines.join('\n');
}

/** One scalar token → its JavaScript value. */
function yamlScalar_(raw) {
  var s = String(raw == null ? '' : raw).replace(/^[ \t]+|[ \t]+$/g, '');
  if (s === '') return null;
  var c0 = s.charAt(0);
  if (c0 === '"' || c0 === "'") {
    var end = yamlQuoteEnd_(s, c0);
    if (end === -1) return s;                     // unterminated: hand back what we have
    var inner = s.slice(1, end);
    return c0 === '"' ? yamlUnescape_(inner) : inner.replace(/''/g, "'");
  }
  if (c0 === '{' || c0 === '[') return yamlFlow_(s);
  if (/^(null|Null|NULL|~)$/.test(s)) return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[-+]?(?:[0-9]*\.[0-9]+|[0-9]+\.)(?:[eE][-+]?[0-9]+)?$/.test(s)) return parseFloat(s);
  return s;
}

function yamlUnescape_(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) {
    return String.fromCharCode(parseInt(h, 16));
  }).replace(/\\(.)/g, function (m, c) {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '0') return '\0';
    return c;                                     // \" \\ \/ and friends
  });
}

/** Index of the quote that closes s[0], or -1 if this line does not close it. */
function yamlQuoteEnd_(s, q) {
  for (var i = 1; i < s.length; i++) {
    var c = s.charAt(i);
    if (q === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') return i;
    } else {
      if (c === "'") {
        if (s.charAt(i + 1) === "'") { i++; continue; }
        return i;
      }
    }
  }
  return -1;
}

/** A trailing `#` comment removed, unless it sits inside a quoted string. */
function yamlStripComment_(line) {
  var s = String(line == null ? '' : line);
  var q = '', prev = ' ';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (q) {
      if (q === '"' && c === '\\') { i++; prev = 'x'; continue; }
      if (c === q) q = '';
    } else if (c === '"') {
      q = c;
    } else if (c === "'" && /[\s:,\[{]/.test(prev)) {
      q = c;                                      // an apostrophe mid-word opens nothing
    } else if (c === '#' && /\s/.test(prev)) {
      return s.slice(0, i);
    }
    prev = c;
  }
  return s;
}

/** True when every flow bracket opened in `s` has been closed. */
function yamlFlowClosed_(s) {
  var depth = 0, q = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth === 0;
}

/** `{a: 1, b: [x, y]}` / `[a, b]` → object / array. */
function yamlFlow_(s) {
  var t = String(s).replace(/^[ \t]+|[ \t]+$/g, '');
  var open = t.charAt(0), close = t.charAt(t.length - 1);
  if (open === '{' && close !== '}') throw new Error('unclosed flow mapping');
  if (open === '[' && close !== ']') throw new Error('unclosed flow sequence');
  var parts = yamlSplitFlow_(t.slice(1, -1));
  if (open === '[') {
    var arr = [];
    parts.forEach(function (p) {
      if (p.replace(/[ \t]+/g, '') !== '') arr.push(yamlScalar_(p));
    });
    return arr;
  }
  var obj = {};
  parts.forEach(function (p) {
    var e = p.replace(/^[ \t]+|[ \t]+$/g, '');
    if (e === '') return;
    var idx = yamlFlowColon_(e);
    if (idx < 0) throw new Error('flow mapping entry without a key: "' + e + '"');
    obj[yamlKey_(e.slice(0, idx))] = yamlScalar_(e.slice(idx + 1));
  });
  return obj;
}

/** Split on the commas that are not inside a nested collection or a quote. */
function yamlSplitFlow_(inner) {
  var parts = [], depth = 0, q = '', cur = '';
  for (var i = 0; i < inner.length; i++) {
    var c = inner.charAt(i);
    if (q) {
      cur += c;
      if (q === '"' && c === '\\') { cur += inner.charAt(++i); continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.replace(/[ \t]+/g, '') !== '') parts.push(cur);
  return parts;
}

/** Index of the `: ` that separates key from value in one flow entry. */
function yamlFlowColon_(s) {
  var depth = 0, q = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0) {
      var next = s.charAt(i + 1);
      if (next === '' || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

// ------------------------------------------------------------------- misc

function isHtmlFile_(f) {
  var name = f.getName().toLowerCase();
  if (/\.html?$/.test(name)) return true;
  var mime = String(f.getMimeType() || '').toLowerCase();
  return mime.indexOf('html') !== -1;
}

function isImageFile_(f) {
  if (IMAGE_EXT.test(String(f.getName()))) return true;
  return String(f.getMimeType() || '').toLowerCase().indexOf('image/') === 0;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function logEvent_(event, details) {
  try {
    var sh = registrySpreadsheet_().getSheetByName(SHEET_LOG);
    if (sh) sh.appendRow([new Date(), event, details]);
  } catch (e) { /* logging must never break the main action */ }
}

function paint_(sh, row, colFrom, colTo, color) {
  sh.getRange(row, colFrom, 1, colTo - colFrom + 1).setBackground(color);
}

function setListValidation_(sh, col, options, allowInvalid, maxR) {
  sh.getRange(2, col, maxR, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(options, true)
      .setAllowInvalid(allowInvalid).build());
}

function groupCols_(sh, from, to) {
  sh.getRange(1, from, 1, to - from + 1).shiftColumnGroupDepth(1);
}
