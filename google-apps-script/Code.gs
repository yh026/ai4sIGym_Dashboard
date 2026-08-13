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
var REGISTRY_V2_SPREADSHEET_ID_PROPERTY = 'AI4S_REGISTRY_V2_SPREADSHEET_ID';
var PREVIEW_REGISTRY_SCHEMA_PROPERTY = 'AI4S_PREVIEW_REGISTRY_SCHEMA';
var PREVIEW_PUBLISH_STATE_PROPERTY = 'AI4S_PREVIEW_PUBLISH_STATE_V2';
var PREVIEW_CALLBACK_SECRET_PROPERTY = 'AI4S_PREVIEW_CALLBACK_SECRET';
var NETLIFY_SITE_ID_PROPERTY = 'AI4S_NETLIFY_SITE_ID';
var REGISTRY_REVISION_SCHEMA = 1;
var REGISTRY_V2_REVISION_SCHEMA = 2;
var REGISTRY_V2_MAX_CARD_ASSET_BYTES = 5 * 1024 * 1024;
var REGISTRY_V2_IMAGE_MIME_BY_EXTENSION = {
  avif: 'image/avif', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp'
};
var REGISTRY_V2_PROJECT_FIELDS = [
  ['status', 'Status'], ['readiness', 'Readiness'], ['preview_url', 'Preview URL'],
  ['title', 'Project Title'], ['card_summary', 'Card Summary'],
  ['department', 'Department'], ['subtopic', 'Subtopic'], ['task', 'Task Type'],
  ['methods', 'Methods'], ['card_image', 'Card Image'],
  ['image_alt', 'Image Alt Text'], ['audience', 'Audience'],
  ['featured', 'Featured'], ['data_source', 'Data Source'],
  ['public_permission', 'Public Permission'], ['demo_id', 'demo_id']
];
var REGISTRY_V2_HEADERS = {
  _Registry: [
    'schema_version', 'row_number', 'demo_id', 'entry_type', 'slug', 'status',
    'readiness', 'featured', 'sort_order', 'title', 'card_summary',
    'department_id', 'subtopic_id', 'task_ids', 'method_ids', 'audience',
    'data_source_label', 'public_page_permission', 'card_asset_id', 'file_id',
    'file_check', 'date_added'
  ],
  _Taxonomy: [
    'term_type', 'term_id', 'parent_id', 'label', 'short_label', 'description',
    'display_order', 'active', 'theme_key', 'icon_key', 'aliases'
  ],
  _Facets: ['demo_id', 'facet_type', 'term_id', 'display_order'],
  _Assets: [
    'asset_id', 'demo_id', 'role', 'source_type', 'drive_file_id',
    'external_url', 'mime_type', 'alt_text', 'credit', 'license', 'checksum',
    'public_path', 'sync_status', 'source_modified_at', 'source_file_name'
  ],
  _Config: ['key', 'value', 'visibility', 'description']
};
var PREVIEW_PUBLISH_STATE_VERSION = 2;
var PREVIEW_CALLBACK_SCHEMA = 1;
var PREVIEW_CALLBACK_MAX_BYTES = 16 * 1024;
var PREVIEW_CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;
var PREVIEW_MAX_ATTEMPTS = 6;
var PREVIEW_RETRY_DELAYS_MS = [
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000
];

// Deployment guardrails. Preview publishing accepts these branch families
// plus the stable names below. Production is deliberately locked to main.
var PRODUCTION_BRANCH = 'main';
var PREVIEW_BRANCH_PREFIXES = [
  'fix/', 'feature/', 'preview/', 'chore/', 'docs/', 'test/',
  'refactor/', 'hotfix/', 'release/'
];
var PREVIEW_BRANCH_NAMES = ['develop', 'staging', 'dashboard-preview'];
// Production is deliberately excluded: main may be rebuilt only through the
// explicit publishProduction() confirmation dialog.
var AUTO_PUBLISH_TARGETS = ['off', 'preview'];

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
  status: 'Draft = visible only on the private develop Preview. Live = eligible for Production after explicit release approval. Archived = kept in the record, off both sites.',
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

// Existing rows have three deliberately separate write surfaces. Keeping the
// lists explicit makes it possible to audit every Sheet write:
//   MANUAL  — owned by the editor. Sync may only pre-fill an empty IMPORT cell.
//   AUTO    — owned by Drive sync.
//   DERIVED — recomputed from the final, concurrency-checked row.
// A sync never writes any other column on an existing row.
var MANUAL_COLS = [
  COLS.TITLE, COLS.SLUG, COLS.DESCRIPTION, COLS.CATEGORY, COLS.TAGS, COLS.AUTHOR,
  COLS.STATUS, COLS.FEATURED, COLS.AUDIENCE, COLS.LEARNING_GOAL, COLS.QUESTION,
  COLS.PICTURE, COLS.DATA_SOURCE, COLS.DATA_LINK, COLS.DATA_ACCESSED,
  COLS.DATA_LICENSE, COLS.DATA_NOTES, COLS.TASK_TYPE, COLS.METHOD, COLS.FRAMEWORK,
  COLS.TRAINING, COLS.METRICS, COLS.WORKFLOW_LINK
];
var IMPORT_COLS = [
  COLS.TITLE, COLS.DESCRIPTION, COLS.CATEGORY, COLS.TAGS, COLS.AUTHOR,
  COLS.AUDIENCE, COLS.LEARNING_GOAL, COLS.QUESTION, COLS.PICTURE,
  COLS.DATA_SOURCE, COLS.DATA_LINK, COLS.DATA_ACCESSED, COLS.DATA_LICENSE,
  COLS.DATA_NOTES, COLS.TASK_TYPE, COLS.METHOD, COLS.FRAMEWORK, COLS.TRAINING,
  COLS.METRICS, COLS.WORKFLOW_LINK
];
var AUTO_COLS = [
  COLS.FILE_NAME, COLS.FILE_ID, COLS.PICTURE_FILE_ID, COLS.DATE_ADDED,
  COLS.LAST_MODIFIED, COLS.FILE_CHECK
];
var DERIVED_COLS = [COLS.PROVENANCE];

var DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

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
    ['auto_publish_target', autoTarget, 'off or preview. Apps Script never auto-publishes Production; content-only releases use the separate confirmed manual action.'],
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
    .addItem('Refresh Registry v2 status', 'refreshRegistryV2Status')
    .addItem('Build preview branch', 'publishPreview')
    .addItem('Preview publish status', 'showPreviewPublishStatus')
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
    + '<li>Check what it filled in and add category + task_type (those two are not in the card). '
    + 'Keep the row as <b>Draft</b> while it is under review.</li>'
    + '<li>Use <b>Build preview branch</b> and review the Draft on the private develop Preview. '
    + 'Only after the content is approved, set its status to <b>Live</b>.</li>'
    + '<li>For a content-only Drive/Sheet release, use <b>Rebuild production site (main)</b> '
    + 'once and confirm Yes. For a code release, approve and merge the pull request into '
    + '<code>main</code>; with Netlify continuous deployment enabled, that merge is itself the '
    + 'Production release, so do not also press the rebuild button.</li></ol>'
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
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(535), 'AI4S dashboard — help');
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
    var result = syncDriveUnlocked_();
    try {
      var publishSs = registrySpreadsheet_();
      var publishCfg = readConfig_(publishSs);
      var previewRun = maintainPreviewPublish_(publishSs, publishCfg,
        {
          allowAttempt: !(result && result.error),
          allowAutoRequest: !(result && result.error)
        });
      if (previewRun.attempted) {
        if (previewRun.attemptResult.ok) {
          logEvent_('publish', 'Hourly Preview request '
            + previewRun.state.requestId.slice(0, 12) + ' accepted by Netlify (HTTP '
            + previewRun.attemptResult.status + '); not ready yet.');
        } else {
          logEvent_('publish-error', 'Hourly Preview retry failed: '
            + safeErrorMessage_(previewRun.attemptResult.error));
        }
      }
      if (previewRun.becameReady) {
        logEvent_('publish-ready', 'Preview request '
          + previewRun.state.readyRequestId.slice(0, 12) + ' is ready at revision '
          + previewRun.state.ready.slice(0, 19) + '.');
      }
      if (result && typeof result === 'object') result.previewPublishPhase = previewRun.phase;
    } catch (publishErr) {
      logEvent_('publish-error', 'Hourly Preview reconciliation failed: '
        + safeErrorMessage_(publishErr));
    }
    return result;
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
  var dataRange = gridLast > 1 ? sh.getRange(2, 1, gridLast - 1, N_COLS) : null;
  var all = dataRange ? dataRange.getValues() : [];
  var allFormulas = dataRange ? dataRange.getFormulas() : [];
  var dataEnd = 1; // header row; data starts at 2
  for (var s = all.length - 1; s >= 0; s--) {
    if (rowHasContent_(all[s])) { dataEnd = s + 2; break; }
  }
  var rows = all.slice(0, Math.max(dataEnd - 1, 0));
  // Keep the values exactly as first observed. A Sheet editor is not governed
  // by ScriptLock, so these snapshots are checked again immediately before
  // any existing-row write.
  var originalRows = rows.map(function (r) { return r.slice(); });
  var originalFormulas = allFormulas.slice(0, Math.max(dataEnd - 1, 0))
    .map(function (r) { return r.slice(); });
  var byId = {};
  rows.forEach(function (r, i) { if (r[COLS.FILE_ID - 1]) byId[r[COLS.FILE_ID - 1]] = i; });
  var slugsInUse = {};
  rows.forEach(function (r) { if (r[COLS.SLUG - 1]) slugsInUse[String(r[COLS.SLUG - 1])] = true; });

  var seen = {};
  var newRows = [];
  var nNew = 0, nUpdated = 0, nWarn = 0;

  // Capture Registry v2 before Drive is scanned. Sheet editors are not bound
  // by ScriptLock, so this snapshot is compared twice more immediately before
  // the first v2 write. A missing v2 property deliberately keeps v1 working.
  var v2Context;
  try { v2Context = registryV2AutoIngestContext_(); }
  catch (v2ContextError) {
    v2Context = { enabled: true, error: v2ContextError };
  }

  // This is the only Drive collection pass used by both registries.
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
      var changed = driveStampChanged_(stored, it.stamp);
      if (changed) {
        var read = readDemo_(it);
        it.registryRead = read;
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
      it.registryRead = fresh;
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

  // Existing-row provenance is recomputed only after the optimistic
  // concurrency check has overlaid any human edits made during this scan.
  newRows.forEach(function (r) { r[COLS.PROVENANCE - 1] = provenanceFlag_(r); });

  var writeResult = writeExistingRowsSafely_(sh, rows, originalRows, originalFormulas);
  appendNewRows_(sh, newRows);
  // Commit Registry changes before a Build Hook can make Netlify read them.
  SpreadsheetApp.flush();

  var v1ByFileId = {};
  rows.concat(newRows).forEach(function (row) {
    var fileId = String(row[COLS.FILE_ID - 1] || '');
    if (fileId) v1ByFileId[fileId] = row.slice();
  });
  var v2Result = { enabled: false, added: 0, checked: 0, skipped: 0 };
  var v2Error = '';
  if (v2Context && v2Context.enabled) {
    try {
      if (v2Context.error) throw v2Context.error;
      v2Result = registryV2AutoIngest_(v2Context, cfg, items, v1ByFileId);
    } catch (v2Err) {
      v2Error = 'Registry v2 auto-ingest failed: ' + safeErrorMessage_(v2Err);
      logEvent_('sync-v2-error', v2Error);
    }
  }

  var summary = nNew + ' new, ' + nUpdated + ' updated, ' + nWarn + ' now missing.';
  if (writeResult.conflicts) {
    summary += ' ' + writeResult.conflicts + ' concurrent edit conflict(s) preserved.';
  }
  if (v2Result.enabled) {
    summary += ' Registry v2: ' + v2Result.added + ' added, '
      + v2Result.checked + ' checked, ' + v2Result.skipped + ' skipped.';
  }
  if (v2Error) summary += ' ' + v2Error;
  logEvent_('sync', summary);
  ss.toast(summary, 'Drive sync', 6);

  var result = {
    nNew: nNew, nUpdated: nUpdated, nWarn: nWarn,
    nConflicts: writeResult.conflicts,
    registryV2: v2Result
  };
  if (v2Error) result.error = v2Error;
  return result;
}

/**
 * Apply an existing-row reconciliation without ever writing a whole row.
 *
 * `originalRows` is the first Sheet snapshot; `desiredRows` is that snapshot
 * after Drive/import reconciliation. Immediately before writing, the current
 * rows are read again. Concurrent human edits are overlaid onto the desired
 * rows, listed in the Log, and never replaced. A changed FILE_ID means rows may
 * have moved or been deleted, so the whole write fails before the first patch.
 */
function writeExistingRowsSafely_(sh, desiredRows, originalRows, originalFormulas) {
  if (!desiredRows.length) return { conflicts: 0, patches: 0 };
  if (desiredRows.length !== originalRows.length) {
    throw new Error('Drive sync stopped: its Sheet snapshots do not match. No existing rows were updated.');
  }

  var currentRange = sh.getRange(2, 1, originalRows.length, N_COLS);
  var currentRows = currentRange.getValues();
  var currentFormulas = currentRange.getFormulas();
  originalFormulas = originalFormulas || blankFormulaRows_(originalRows.length);
  var i, c;
  // Verify every row identity before making any write. This turns a concurrent
  // sort, deletion or system-column edit into a fail-closed retry instead of a
  // patch applied to the wrong demo.
  for (i = 0; i < originalRows.length; i++) {
    if (!sameCellValue_(currentRows[i][COLS.FILE_ID - 1], originalRows[i][COLS.FILE_ID - 1])
        || currentFormulas[i][COLS.FILE_ID - 1] !== originalFormulas[i][COLS.FILE_ID - 1]) {
      throw new Error('Drive sync stopped: Demos row ' + (i + 2)
        + ' moved or its file_id changed during the scan. No existing rows were updated; run sync again.');
    }
  }

  var patches = [];
  var conflictCount = 0;
  for (i = 0; i < originalRows.length; i++) {
    var desired = desiredRows[i].slice();
    var current = currentRows[i];
    var changedHeaders = [];

    for (var m = 0; m < MANUAL_COLS.length; m++) {
      c = MANUAL_COLS[m];
      var formulaChanged = currentFormulas[i][c - 1] !== originalFormulas[i][c - 1];
      if (!sameCellValue_(current[c - 1], originalRows[i][c - 1]) || formulaChanged) {
        changedHeaders.push(HEADERS[c - 1]);
        // Only a value that changed since the initial snapshot replaces the
        // import candidate. An unchanged empty cell remains eligible for the
        // pre-fill computed in `desired`.
        desired[c - 1] = current[c - 1];
      } else if (currentFormulas[i][c - 1]) {
        // A pre-existing formula that currently evaluates to an empty string
        // is still human-owned and must not be replaced by an import.
        desired[c - 1] = current[c - 1];
      }
    }

    // Derived values must see the editor's current metadata, not the stale
    // values that were present at the beginning of the scan.
    desired[COLS.PROVENANCE - 1] = provenanceFlag_(desired);

    if (changedHeaders.length) {
      conflictCount++;
      logEvent_('sync-conflict', 'Preserved concurrent manual edit(s) on Demos row '
        + (i + 2) + ': ' + changedHeaders.join(', ') + '.');
    }

    collectColumnPatches_(patches, i + 2, current, desired, IMPORT_COLS);
    collectColumnPatches_(patches, i + 2, current, desired, AUTO_COLS);
    collectColumnPatches_(patches, i + 2, current, desired, DERIVED_COLS);
  }

  // Each patch targets one explicitly managed cell. In particular, status,
  // slug, title and other neighbouring manual cells are never collateral
  // damage from a wide setValues call.
  for (i = 0; i < patches.length; i++) {
    sh.getRange(patches[i].row, patches[i].col).setValue(patches[i].value);
  }
  return { conflicts: conflictCount, patches: patches.length };
}

function collectColumnPatches_(patches, rowNumber, current, desired, columns) {
  for (var i = 0; i < columns.length; i++) {
    var c = columns[i];
    if (!sameCellValue_(current[c - 1], desired[c - 1])) {
      patches.push({ row: rowNumber, col: c, value: desired[c - 1] });
    }
  }
}

function sameCellValue_(a, b) {
  if (isDate_(a) || isDate_(b)) {
    return isDate_(a) && isDate_(b) && a.getTime() === b.getTime();
  }
  return a === b;
}

function blankFormulaRows_(count) {
  var rows = [];
  for (var i = 0; i < count; i++) {
    var row = [];
    for (var c = 0; c < N_COLS; c++) row.push('');
    rows.push(row);
  }
  return rows;
}

/** Append complete new records after the current last content row. */
function appendNewRows_(sh, newRows) {
  if (!newRows.length) return;
  var gridLast = sh.getLastRow();
  var values = gridLast > 1 ? sh.getRange(2, 1, gridLast - 1, N_COLS).getValues() : [];
  var dataEnd = 1;
  for (var i = values.length - 1; i >= 0; i--) {
    if (rowHasContent_(values[i])) { dataEnd = i + 2; break; }
  }
  sh.getRange(dataEnd + 1, 1, newRows.length, N_COLS).setValues(newRows);
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
  var rootId = driveEntryIdOrThrow_(folder, 'configured Drive root');

  // One sub-folder per demo — page + PROVENANCE.md.
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    if (!hasDirectParentOrThrow_(sub, rootId, 'folder')) {
      logEvent_('sync-skip', 'Skipped folder "' + driveEntryName_(sub)
        + '" because it is no longer directly inside the configured Drive root.');
      continue;
    }
    var item = collectDemoFolder_(sub);
    if (item) out.push(item);
  }

  // The old layout: a loose .html sitting in the root. Still registered, just
  // with no card behind it.
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (!hasDirectParentOrThrow_(f, rootId, 'file')) {
      logEvent_('sync-skip', 'Skipped file "' + driveEntryName_(f)
        + '" because it is no longer directly inside the configured Drive root.');
      continue;
    }
    if (isShortcutFile_(f)) {
      logEvent_('sync-skip', 'Skipped Drive shortcut "' + driveEntryName_(f) + '".');
      continue;
    }
    if (!isHtmlFile_(f)) continue;
    out.push({ file: f, folderName: '', provFile: null, picFile: null, card: null,
      stamp: f.getLastUpdated(), notes: [] });
  }
  return out;
}

/** One demo sub-folder → an item for collectDemos_, or null if it holds no page. */
function collectDemoFolder_(sub) {
  var name = sub.getName();
  var subId = driveEntryIdOrThrow_(sub, 'demo folder "' + name + '"');
  var pages = [], images = [], prov = null;

  var files = sub.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (!hasDirectParentOrThrow_(f, subId, 'file')) {
      logEvent_('sync-skip', 'Skipped file "' + driveEntryName_(f)
        + '" because it is no longer directly inside demo folder "' + name + '".');
      continue;
    }
    if (isShortcutFile_(f)) {
      logEvent_('sync-skip', 'Skipped Drive shortcut "' + driveEntryName_(f)
        + '" in demo folder "' + name + '".');
      continue;
    }
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

/** True only for a current, direct parent edge; lookup failures stop the sync. */
function hasDirectParentOrThrow_(entry, wantedParentId, kind) {
  var parents;
  try { parents = entry.getParents(); }
  catch (e) {
    throw new Error('Drive sync stopped: parent lookup failed for ' + kind + ' "'
      + driveEntryName_(entry) + '". No registry changes were written.');
  }
  if (!parents || typeof parents.hasNext !== 'function' || typeof parents.next !== 'function') {
    throw new Error('Drive sync stopped: parent lookup failed for ' + kind + ' "'
      + driveEntryName_(entry) + '". No registry changes were written.');
  }
  try {
    while (parents.hasNext()) {
      var parent = parents.next();
      if (parent && String(parent.getId()) === String(wantedParentId)) return true;
    }
  } catch (e2) {
    throw new Error('Drive sync stopped: parent lookup failed for ' + kind + ' "'
      + driveEntryName_(entry) + '". No registry changes were written.');
  }
  return false;
}

function driveEntryIdOrThrow_(entry, label) {
  try {
    var id = entry.getId();
    if (id !== null && id !== undefined && String(id) !== '') return String(id);
  } catch (ignored) { /* converted to a stable fail-closed error below */ }
  throw new Error('Drive sync stopped: could not identify ' + label
    + '. No registry changes were written.');
}

function driveEntryName_(entry) {
  try { return String(entry.getName() || '(unnamed)'); }
  catch (ignored) { return '(unreadable name)'; }
}

/** Download and parse one demo: page HTML, its ai4s-meta, its provenance card. */
function readDemo_(item) {
  var html = '';
  var notes = [];
  try { html = item.file.getBlob().getDataAsString(); }
  catch (e) { notes.push('page unreadable'); }
  if (!String(html || '').trim() && notes.indexOf('page unreadable') === -1) {
    notes.push('page empty');
  }

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

function emptyPreviewPublishState_() {
  return {
    v: PREVIEW_PUBLISH_STATE_VERSION,
    branch: '', desired: '', requested: '', requestId: '', requestedAt: '',
    accepted: '', acceptedAt: 0,
    ready: '', readyRequestId: '', readyAt: 0,
    readyDeployId: '', readyBuildId: '', readyCommitRef: '', readyPublishedAt: '',
    lastDeployId: '', lastDeployAt: 0,
    attempts: 0, lastAttemptAt: 0, nextAttemptAt: 0,
    lastCheckAt: 0, lastHttpStatus: 0, lastError: ''
  };
}

function normalisePreviewPublishState_(value) {
  var out = emptyPreviewPublishState_();
  if (!value || Number(value.v) !== PREVIEW_PUBLISH_STATE_VERSION) return out;
  ['branch', 'desired', 'requested', 'requestId', 'requestedAt', 'accepted',
    'ready', 'readyRequestId', 'readyDeployId', 'readyBuildId', 'readyCommitRef',
    'readyPublishedAt', 'lastDeployId', 'lastError'].forEach(function (key) {
    out[key] = String(value[key] || '');
  });
  ['acceptedAt', 'readyAt', 'attempts', 'lastAttemptAt', 'nextAttemptAt',
    'lastCheckAt', 'lastHttpStatus', 'lastDeployAt'].forEach(function (key) {
    var n = Number(value[key]);
    out[key] = isFinite(n) && n >= 0 ? n : 0;
  });
  out.attempts = Math.floor(out.attempts);
  out.lastError = out.lastError.replace(/\s+/g, ' ').slice(0, 300);
  return out;
}

function readPreviewPublishState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PREVIEW_PUBLISH_STATE_PROPERTY);
  if (!raw) return emptyPreviewPublishState_();
  try { return normalisePreviewPublishState_(JSON.parse(raw)); }
  catch (ignored) {
    var state = emptyPreviewPublishState_();
    state.lastError = 'Stored Preview publish state was unreadable and was reset safely.';
    return state;
  }
}

function writePreviewPublishState_(state) {
  state = normalisePreviewPublishState_(state);
  PropertiesService.getScriptProperties()
    .setProperty(PREVIEW_PUBLISH_STATE_PROPERTY, JSON.stringify(state));
  return state;
}

function validRegistryRevision_(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ''));
}

function previewRequestId_() {
  return String(Utilities.getUuid());
}

function observePreviewDesired_(state, branch, revision) {
  state = normalisePreviewPublishState_(state);
  branch = String(branch || '').trim();
  revision = String(revision || '');
  if (state.branch !== branch) {
    state = emptyPreviewPublishState_();
    state.branch = branch;
  }
  if (state.desired !== revision) {
    state.desired = revision;
    state.requested = '';
    state.requestId = '';
    state.requestedAt = '';
    state.accepted = '';
    state.acceptedAt = 0;
    state.attempts = 0;
    state.lastAttemptAt = 0;
    state.nextAttemptAt = 0;
    state.lastHttpStatus = 0;
    state.lastError = '';
  }
  return state;
}

function requestPreviewRevision_(state, now) {
  state.requested = state.desired;
  state.requestId = previewRequestId_();
  state.requestedAt = new Date(now).toISOString();
  state.accepted = '';
  state.acceptedAt = 0;
  state.attempts = 0;
  state.lastAttemptAt = 0;
  state.nextAttemptAt = now;
  state.lastHttpStatus = 0;
  state.lastError = '';
  return state;
}

function previewRetryDelayMs_(attempts) {
  var index = Math.max(0, Math.min(Number(attempts || 1) - 1,
    PREVIEW_RETRY_DELAYS_MS.length - 1));
  return PREVIEW_RETRY_DELAYS_MS[index];
}

function previewReceiptMatches_(receipt, expected) {
  if (!receipt || receipt.schema !== 1 || receipt.verified !== true) return false;
  if (receipt.revision_bound !== true) return false;
  if (receipt.target !== 'preview' || receipt.audience !== 'preview') return false;
  if (receipt.platform !== 'netlify') return false;
  if (receipt.context !== 'branch-deploy') return false;
  if (String(receipt.branch || '') !== String(expected.branch || '')) return false;
  if (String(receipt.registry_revision || '') !== String(expected.revision || '')) return false;
  if (expected.requestId
      && String(receipt.request_id || '') !== String(expected.requestId)) return false;
  if (expected.requestedAt
      && String(receipt.requested_at || '') !== String(expected.requestedAt)) return false;
  if (expected.siteId
      && String(receipt.site_id || '') !== String(expected.siteId)) return false;
  return true;
}

function previewPublishPhase_(state, now) {
  state = normalisePreviewPublishState_(state);
  if (!state.desired) return 'unknown';
  if (state.requested === state.desired) {
    if (state.ready === state.desired && state.readyRequestId === state.requestId) return 'ready';
    if (state.accepted === state.desired) {
      var checkedAt = Number(now);
      if (now != null && state.acceptedAt > 0
          && checkedAt >= state.acceptedAt + PREVIEW_CALLBACK_TIMEOUT_MS) {
        return 'verification-timeout';
      }
      return 'accepted';
    }
    if (state.attempts >= PREVIEW_MAX_ATTEMPTS) return 'retry-exhausted';
    return state.attempts > 0 ? 'retry-scheduled' : 'requested';
  }
  return state.ready === state.desired ? 'ready' : 'dirty';
}

function previewPublishConfigurationError_(cfg) {
  var branch = String(cfg.preview_branch || '').trim();
  if (branch !== 'develop') {
    return 'Durable Preview publishing is locked to the develop branch.';
  }
  return previewUrlError_(branch, cfg.preview_url, cfg.preview_url_branch,
    cfg.production_branch);
}

function validPreviewTimestamp_(value) {
  var text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return false;
  var milliseconds = Date.parse(text);
  return isFinite(milliseconds) && new Date(milliseconds).toISOString() === text;
}

function previewDeployReceiptError_(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return 'Preview callback receipt must be a JSON object.';
  }
  if (receipt.schema !== 1 || receipt.revision_bound !== true) {
    return 'Preview callback receipt has an unsupported schema.';
  }
  if (receipt.target !== 'preview' || receipt.audience !== 'preview'
      || receipt.platform !== 'netlify' || receipt.context !== 'branch-deploy'
      || receipt.branch !== 'develop') {
    return 'Preview callback receipt does not identify the develop Branch Deploy.';
  }
  if (!validRegistryRevision_(receipt.registry_revision)) {
    return 'Preview callback receipt has an invalid Registry revision.';
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(receipt.deploy_id || ''))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(String(receipt.build_id || ''))
      || !/^[0-9a-f]{7,64}$/i.test(String(receipt.commit_ref || ''))
      || !/^[0-9a-f-]{20,64}$/i.test(String(receipt.site_id || ''))) {
    return 'Preview callback receipt has invalid Netlify deploy identity.';
  }
  if (!validPreviewTimestamp_(receipt.built_at)) {
    return 'Preview callback receipt has an invalid build time.';
  }
  if (receipt.verified === true) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(receipt.request_id || ''))
        || !validPreviewTimestamp_(receipt.requested_at)) {
      return 'Verified Preview callback receipt has invalid request identity.';
    }
  } else if (receipt.verified !== false) {
    return 'Preview callback receipt has an invalid verification flag.';
  }
  return '';
}

function previewCallbackPayloadError_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'Preview callback payload must be a JSON object.';
  }
  var allowed = { schema: true, event: true, callback_at: true, receipt: true };
  if (Object.keys(payload).some(function (key) { return !allowed[key]; })) {
    return 'Preview callback payload has unsupported fields.';
  }
  if (payload.schema !== PREVIEW_CALLBACK_SCHEMA
      || payload.event !== 'preview_deploy_succeeded'
      || !validPreviewTimestamp_(payload.callback_at)) {
    return 'Preview callback payload has an unsupported envelope.';
  }
  return previewDeployReceiptError_(payload.receipt);
}

function clearPreviewReady_(state) {
  state.ready = '';
  state.readyRequestId = '';
  state.readyAt = 0;
  state.readyDeployId = '';
  state.readyBuildId = '';
  state.readyCommitRef = '';
  state.readyPublishedAt = '';
  return state;
}

/** Pure, replay-safe adoption of one authenticated Netlify onSuccess callback. */
function adoptPreviewCallback_(state, payload, expectedSiteId, now) {
  state = normalisePreviewPublishState_(state);
  var error = previewCallbackPayloadError_(payload);
  if (error) return { ok: false, state: state, error: error };
  var receipt = payload.receipt;
  if (!expectedSiteId || String(receipt.site_id) !== String(expectedSiteId)) {
    return { ok: false, state: state, error: 'Preview callback site does not match.' };
  }

  if (state.lastDeployId === receipt.deploy_id) {
    return { ok: true, state: state, duplicate: true, adopted: false, invalidated: false };
  }
  var deployedAt = Date.parse(receipt.built_at);
  if (state.lastDeployAt > deployedAt) {
    return { ok: true, state: state, stale: true, adopted: false, invalidated: false };
  }
  state.lastDeployId = receipt.deploy_id;
  state.lastDeployAt = deployedAt;
  state.lastCheckAt = now == null ? Date.now() : Number(now);

  if (receipt.verified === true) {
    var expected = {
      branch: state.branch,
      revision: state.desired,
      requestId: state.requestId,
      requestedAt: state.requestedAt,
      siteId: expectedSiteId
    };
    if (state.requested !== state.desired || !previewReceiptMatches_(receipt, expected)) {
      return { ok: true, state: state, stale: true, adopted: false, invalidated: false };
    }
    state.ready = state.desired;
    state.readyRequestId = state.requestId;
    state.readyAt = state.lastCheckAt;
    state.readyDeployId = receipt.deploy_id;
    state.readyBuildId = receipt.build_id;
    state.readyCommitRef = receipt.commit_ref;
    state.readyPublishedAt = payload.callback_at;
    state.nextAttemptAt = 0;
    state.lastError = '';
    return { ok: true, state: state, adopted: true, invalidated: false };
  }

  var replacedReady = state.ready !== '';
  var replacedCurrentReady = state.ready === state.desired;
  var readyBelongsToCurrentRequest = replacedCurrentReady
    && state.readyRequestId === state.requestId;
  clearPreviewReady_(state);
  if (readyBelongsToCurrentRequest) {
    state.requested = '';
    state.requestId = '';
    state.requestedAt = '';
    state.accepted = '';
    state.acceptedAt = 0;
    state.attempts = 0;
    state.lastAttemptAt = 0;
    state.nextAttemptAt = 0;
    state.lastHttpStatus = 0;
  }
  if (replacedReady) {
    state.lastError = 'The stable develop Preview was replaced by an unverified deploy.';
  }
  return { ok: true, state: state, adopted: false, invalidated: replacedReady };
}

/**
 * Read readiness only from authenticated callback state. Private Preview access
 * deliberately makes no anonymous request to preview_url.
 */
function checkPreviewReceipt_(cfg, expected, now, state) {
  var configError = previewPublishConfigurationError_(cfg);
  if (configError) return { ok: false, configured: false, ready: false, error: configError };
  state = normalisePreviewPublishState_(state);
  var ready = state.ready === expected.revision
    && state.readyRequestId === expected.requestId
    && state.readyDeployId !== '';
  return {
    ok: true,
    configured: true,
    ready: ready,
    status: 0,
    receipt: ready ? {
      request_id: state.readyRequestId,
      deploy_id: state.readyDeployId,
      build_id: state.readyBuildId,
      commit_ref: state.readyCommitRef
    } : null,
    error: ''
  };
}

function previewBuildPayload_(state) {
  return {
    schema: 1,
    target: 'preview',
    branch: state.branch,
    registry_revision: state.requested,
    request_id: state.requestId,
    requested_at: state.requestedAt
  };
}

function recordPreviewAttempt_(state, result, now) {
  state.attempts += 1;
  state.lastAttemptAt = now;
  state.lastHttpStatus = Number(result.status || 0);
  if (result.ok) {
    state.accepted = state.requested;
    state.acceptedAt = now;
    // A 2xx means Netlify accepted this logical request. It must never cause an
    // automatic duplicate deploy merely because the authenticated completion
    // callback is delayed or unavailable. Explicit manual retry remains possible.
    state.nextAttemptAt = 0;
    state.lastError = '';
  } else {
    state.nextAttemptAt = state.attempts >= PREVIEW_MAX_ATTEMPTS
      ? 0 : now + previewRetryDelayMs_(state.attempts);
    state.lastError = String(result.error || 'Preview Hook failed.')
      .replace(/\s+/g, ' ').slice(0, 300);
  }
  return state;
}

/**
 * Reconcile one Preview content request. `forceRequest` is used only by the
 * explicit menu action; hourly calls create or retry a request only when
 * automation is explicitly set to Preview. Switching automation to off is a
 * hard stop for Hook POSTs, while receipt reconciliation remains read-only.
 */
function maintainPreviewPublish_(ss, cfg, options) {
  options = options || {};
  var now = options.now == null ? Date.now() : Number(options.now);
  var snapshot = previewRegistrySchema_() === 2
    ? registryV2Snapshot_(registryV2Spreadsheet_(), cfg, 'preview')
    : registrySnapshot_(ss, cfg, 'preview');
  if (!snapshot || !validRegistryRevision_(snapshot.registry_revision)) {
    throw new Error('Preview Registry produced an invalid registry_revision; no build was requested.');
  }
  var state = observePreviewDesired_(readPreviewPublishState_(),
    String(cfg.preview_branch || '').trim(), snapshot.registry_revision);
  var priorReady = state.ready;
  var priorReadyRequestId = state.readyRequestId;
  var expected = {
    branch: state.branch,
    revision: state.desired,
    requestId: state.requested === state.desired ? state.requestId : '',
    requestedAt: state.requested === state.desired ? state.requestedAt : ''
  };
  var receipt = checkPreviewReceipt_(cfg, expected, now, state);
  state.lastCheckAt = now;
  state.lastHttpStatus = Number(receipt.status || state.lastHttpStatus || 0);
  if (receipt.ready) {
    state.ready = state.desired;
    state.readyRequestId = String((receipt.receipt && receipt.receipt.request_id) || '');
    state.readyAt = now;
    state.nextAttemptAt = 0;
    state.lastError = '';
  } else if (receipt.error) {
    state.lastError = String(receipt.error).replace(/\s+/g, ' ').slice(0, 300);
  }

  if (options.forceRequest) {
    state = requestPreviewRevision_(state, now);
  } else if (options.allowAutoRequest !== false && autoPublishTarget_(cfg) === 'preview'
      && state.ready !== state.desired && state.requested !== state.desired) {
    state = requestPreviewRevision_(state, now);
  }

  var attemptResult = null;
  var pending = state.requested === state.desired
    && !(state.ready === state.desired && state.readyRequestId === state.requestId);
  var due = state.nextAttemptAt > 0 && now >= state.nextAttemptAt;
  var hookPostsEnabled = options.forceRequest === true || autoPublishTarget_(cfg) === 'preview';
  if (options.allowAttempt !== false && hookPostsEnabled
      && receipt.configured !== false && pending && due
      && state.attempts < PREVIEW_MAX_ATTEMPTS) {
    var request = configuredBuildRequest_(cfg, 'preview');
    attemptResult = triggerBuildRequest_(request, previewBuildPayload_(state));
    state = recordPreviewAttempt_(state, attemptResult, now);
  }

  state = writePreviewPublishState_(state);
  return {
    snapshot: snapshot,
    state: state,
    phase: previewPublishPhase_(state, now),
    receipt: receipt,
    becameReady: state.ready === state.desired
      && (priorReady !== state.ready || priorReadyRequestId !== state.readyRequestId),
    attempted: attemptResult !== null,
    attemptResult: attemptResult
  };
}

/** Build the configured non-production branch and leave main untouched. */
function publishPreview() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    SpreadsheetApp.getUi().alert('Preview build was not started',
      'Another Registry action is still running. Try again shortly.',
      SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  try {
    var ss = SpreadsheetApp.getActive();
    var cfg = readConfig_(ss);
    var run = maintainPreviewPublish_(ss, cfg, { forceRequest: true, allowAttempt: true });
    var result = run.attemptResult;
    if (!run.attempted || !result || !result.ok) {
      var error = result && result.error ? result.error
        : (run.receipt.error || 'Preview build could not be requested safely.');
      logEvent_('publish-error', 'Manual Preview request blocked or failed: '
        + safeErrorMessage_(error));
      SpreadsheetApp.getUi().alert('Preview build was not started', error,
        SpreadsheetApp.getUi().ButtonSet.OK);
      return;
    }

    logEvent_('publish', 'Manual Preview request ' + run.state.requestId.slice(0, 12)
      + ' / ' + run.state.requested.slice(0, 19)
      + ' accepted by Netlify (HTTP ' + result.status + '); not ready yet.');
    ss.toast('Preview request accepted; readiness will be verified separately.', 'Preview', 8);
    showPreviewBuildResult_(result.branch, cfg.preview_url, cfg.preview_url_branch,
      cfg.production_branch);
  } finally {
    lock.releaseLock();
  }
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

function previewStateTime_(milliseconds) {
  var n = Number(milliseconds || 0);
  return n > 0 ? new Date(n).toISOString() : '—';
}

/** Reconcile once and show status. This menu action never calls a Build Hook. */
function showPreviewPublishStatus() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    SpreadsheetApp.getUi().alert('Preview status is busy',
      'Another Registry action is still running. Try again shortly.',
      SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  try {
    var ss = SpreadsheetApp.getActive();
    var cfg = readConfig_(ss);
    var run = maintainPreviewPublish_(ss, cfg,
      { allowAttempt: false, allowAutoRequest: false });
    var state = run.state;
    var labels = {
      ready: 'Up to date',
      accepted: 'Accepted — waiting for authenticated deploy callback',
      'verification-timeout': 'Verification timed out — manual retry required',
      requested: 'Requested — waiting to be accepted',
      'retry-scheduled': 'Retry scheduled',
      'retry-exhausted': 'Retry exhausted — use Build preview branch to start a new request',
      dirty: 'Changes waiting',
      unknown: 'Status unavailable'
    };
    var phase = run.phase;
    var autoTarget = autoPublishTarget_(cfg);
    var nextRetry = state.nextAttemptAt > 0 ? previewStateTime_(state.nextAttemptAt) : '—';
    var html = '<div style="font:13px/1.55 Arial;padding:6px 10px">'
      + '<p><b>' + htmlEscape_(labels[phase] || phase) + '</b></p>'
      + '<table style="border-collapse:collapse">'
      + '<tr><td style="padding:3px 16px 3px 0">Branch</td><td><code>'
      + htmlEscape_(state.branch || '—') + '</code></td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Desired revision</td><td><code>'
      + htmlEscape_(state.desired ? state.desired.slice(0, 19) : '—') + '</code></td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Request ID</td><td><code>'
      + htmlEscape_(state.requestId ? state.requestId.slice(0, 12) : '—') + '</code></td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Accepted</td><td>'
      + htmlEscape_(previewStateTime_(state.acceptedAt)) + '</td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Verified ready</td><td>'
      + htmlEscape_(previewStateTime_(state.readyAt)) + '</td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Attempts</td><td>'
      + htmlEscape_(state.attempts + ' / ' + PREVIEW_MAX_ATTEMPTS) + '</td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Next retry</td><td>'
      + htmlEscape_(nextRetry) + '</td></tr>'
      + '<tr><td style="padding:3px 16px 3px 0">Auto publish</td><td><code>'
      + htmlEscape_(autoTarget) + '</code></td></tr></table>';
    if (state.lastError) {
      html += '<p style="color:#8a3b12"><b>Last check:</b> '
        + htmlEscape_(state.lastError) + '</p>';
    }
    if (phase === 'dirty' && autoTarget === 'off') {
      html += '<p>Automatic publishing is off. Use <b>Build preview branch</b> when ready.</p>';
    }
    if (phase === 'verification-timeout') {
      html += '<p>The Hook was accepted, so hourly sync will not create a duplicate deploy. '
        + 'Check Netlify, then use <b>Build preview branch</b> only if an explicit retry is needed.</p>';
    }
    html += '<p style="color:#555">Accepted means Netlify accepted the Hook. Ready is shown only '
      + 'after a successful develop deploy sends a matching HMAC-authenticated callback.</p></div>';
    SpreadsheetApp.getUi().showModalDialog(
      HtmlService.createHtmlOutput(html).setWidth(570).setHeight(430),
      'Preview publish status');
  } finally {
    lock.releaseLock();
  }
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

function triggerBuildRequest_(request, payload) {
  if (!request.ok) return request;
  var response = triggerBuild_(request.hookUrl, payload);
  response.target = request.target;
  response.branch = request.branch;
  return response;
}

/** POST one secret Hook URL and report the real HTTP outcome. */
function triggerBuild_(hookUrl, payload) {
  try {
    var response = UrlFetchApp.fetch(hookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
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
 *   ?token=...&action=manifest          → site config + all healthy Live demos
 *   ?token=...&action=manifest&audience=preview
 *                                       → healthy Live + Draft demos
 *   ?token=...&action=file&id=FILE_ID   → HTML content for the same audience
 *   ?token=...&action=file&id=PICTURE_FILE_ID
 *                                       → that demo's dataset picture, as
 *                                         { mime, base64 } for the build to
 *                                         write back out as a file
 *   &registry_revision=sha256:...        → bind manifest/file reads to one
 *                                         deterministic Registry snapshot
 * The default/production audience is Live-only. Preview is a closed, explicit
 * audience; Archived, missing and unreadable rows are never served. Files must
 * also be physically located in the configured registry folder (or one direct
 * demo sub-folder).
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

/** Registry v2 lives in a separate owner-only Sheet until explicit cutover. */
function registryV2Spreadsheet_() {
  var id = PropertiesService.getScriptProperties()
    .getProperty(REGISTRY_V2_SPREADSHEET_ID_PROPERTY);
  if (!id) throw new Error('Registry v2 Sheet ID is not configured.');
  return SpreadsheetApp.openById(String(id));
}

function registrySchema_(raw) {
  var value = String(raw || '').trim() || '1';
  if (value !== '1' && value !== '2') {
    return { ok: false, error: 'schema must be 1 or 2' };
  }
  return { ok: true, value: Number(value) };
}

function previewRegistrySchema_() {
  var value = '';
  try {
    if (typeof PropertiesService !== 'undefined' && PropertiesService
        && typeof PropertiesService.getScriptProperties === 'function') {
      value = PropertiesService.getScriptProperties()
        .getProperty(PREVIEW_REGISTRY_SCHEMA_PROPERTY);
    }
  } catch (ignored) { value = ''; }
  return String(value || '').trim() === '2' ? 2 : 1;
}

function registryAudience_(raw) {
  var value = String(raw || '').trim().toLowerCase() || 'production';
  if (value !== 'production' && value !== 'preview') {
    return { ok: false, error: 'audience must be production or preview' };
  }
  return { ok: true, value: value };
}

function registryDemoVisible_(demo, audience) {
  if (!demo) return false;
  var check = String(demo.file_check || '').trim().toLowerCase();
  if (check === 'missing' || /\bunreadable\b/.test(check) || /\bpage empty\b/.test(check)) {
    return false;
  }
  var status = String(demo.status || '').trim();
  return status === 'Live' || (audience === 'preview' && status === 'Draft');
}

function registryFileKind_(visible, id) {
  if (visible.some(function (d) { return d.file_id === id; })) return 'page';
  if (visible.some(function (d) {
    return d.picture_file_id !== '' && d.picture_file_id === id;
  })) return 'picture';
  return '';
}

function registryDemoForFile_(visible, id, kind) {
  for (var i = 0; i < visible.length; i++) {
    if (kind === 'page' && visible[i].file_id === id) return visible[i];
    if (kind === 'picture' && visible[i].picture_file_id === id) return visible[i];
  }
  return null;
}

function registryFileStampMs_(file) {
  try {
    var value = file.getLastUpdated();
    return isDate_(value) ? value.getTime() : NaN;
  } catch (ignored) { return NaN; }
}

/**
 * last_modified is the newest sync time across a demo's page, provenance and
 * picture. Therefore an individual page/picture may legitimately be older;
 * only a Drive timestamp newer than that aggregate proves a post-sync change.
 * Invalid timestamps fail closed until syncDrive repairs the row.
 */
function registryFileChangedAfterSync_(demo, fileStampMs) {
  var stored = Date.parse(String((demo && demo.last_modified) || ''));
  if (!isFinite(stored) || !isFinite(fileStampMs)) return true;
  return fileStampMs > stored;
}

/** JSON with recursively sorted object keys. Array order is deliberately significant. */
function stableJson_(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(function (item) { return stableJson_(item); }).join(',') + ']';
  }
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableJson_(value[key]);
    }).join(',') + '}';
  }
  var encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var unsigned = b < 0 ? b + 256 : b;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

/** One deterministic, audience-scoped Registry view shared by manifest and file responses. */
function registrySnapshot_(ss, cfg, audience) {
  var site = {
    title: cfg.site_title || 'AI for Science demos',
    tagline: cfg.site_tagline || '',
    categories: readCategories_(ss)
  };
  var demos = readDemos_(ss).filter(function (d) {
    return registryDemoVisible_(d, audience);
  });
  var material = {
    schema: REGISTRY_REVISION_SCHEMA,
    audience: audience,
    site: site,
    demos: demos
  };
  return {
    audience: audience,
    site: site,
    demos: demos,
    registry_revision: 'sha256:' + sha256Hex_(stableJson_(material))
  };
}

function registryV2Clean_(value) {
  return String(value == null ? '' : value).trim();
}

function registryV2Number_(value, fallback) {
  var number = Number(value);
  return isFinite(number) ? number : fallback;
}

function registryV2List_(value) {
  if (Array.isArray(value)) return value.map(registryV2Clean_).filter(Boolean);
  return registryV2Clean_(value).split(/[,;|\n]+/).map(registryV2Clean_).filter(Boolean);
}

function registryV2ContainsCjk_(value) {
  return typeof value === 'string'
    && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
      .test(value);
}

function registryV2AssertEnglishRows_(sheetName, rows) {
  rows.forEach(function (row) {
    row.forEach(function (value) {
      if (registryV2ContainsCjk_(value)) {
        throw new Error('Registry v2 sheet ' + sheetName + ' must use English-only text.');
      }
    });
  });
}

function registryV2Table_(ss, sheetName, expectedHeaders, projectHeaders) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Registry v2 is missing sheet ' + sheetName + '.');
  var lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('Registry v2 sheet ' + sheetName + ' has no header.');
  var lastRow = Math.max(sheet.getLastRow(), 1);
  return registryV2RowsFromGrid_(sheetName,
    sheet.getRange(1, 1, lastRow, lastColumn).getValues(),
    expectedHeaders, projectHeaders);
}

function registryV2RowsFromGrid_(sheetName, grid, expectedHeaders, projectHeaders) {
  if (!grid || !grid.length || !grid[0].length) {
    throw new Error('Registry v2 sheet ' + sheetName + ' has no header.');
  }
  registryV2AssertEnglishRows_(sheetName, grid);
  var headers = grid[0].map(registryV2Clean_);
  var accepted = {};
  var canonical = [];
  if (projectHeaders) {
    REGISTRY_V2_PROJECT_FIELDS.forEach(function (field) {
      accepted[field[0].toLowerCase()] = field[0];
      accepted[field[1].toLowerCase()] = field[0];
      canonical.push(field[0]);
    });
  } else {
    expectedHeaders.forEach(function (header) {
      accepted[String(header).toLowerCase()] = header;
      canonical.push(header);
    });
  }
  var keys = [];
  var seen = {};
  headers.forEach(function (header) {
    var key = accepted[String(header).toLowerCase()];
    if (!key || seen[key]) {
      throw new Error('Registry v2 sheet ' + sheetName + ' has an invalid header.');
    }
    seen[key] = true;
    keys.push(key);
  });
  canonical.forEach(function (key) {
    if (!seen[key]) throw new Error('Registry v2 sheet ' + sheetName + ' is missing ' + key + '.');
  });
  return grid.slice(1)
    .map(function (row, rowIndex) {
      if (!row.some(function (value) { return value !== '' && value != null; })) return null;
      var object = { _row_number: rowIndex + 2 };
      keys.forEach(function (key, columnIndex) { object[key] = row[columnIndex]; });
      return object;
    })
    .filter(function (row) { return row !== null; });
}

var REGISTRY_V2_COMPILE_SHEETS = [
  'Projects', '_Registry', '_Taxonomy', '_Facets', '_Assets', '_Config'
];

/** Capture all compiler inputs, including formulas, without changing the workbook. */
function registryV2WorkbookState_(ss) {
  var state = {};
  REGISTRY_V2_COMPILE_SHEETS.forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('Registry v2 is missing sheet ' + sheetName + '.');
    var rows = Math.max(sheet.getLastRow(), 1);
    var columns = sheet.getLastColumn();
    if (columns < 1) throw new Error('Registry v2 sheet ' + sheetName + ' has no header.');
    var range = sheet.getRange(1, 1, rows, columns);
    var values = range.getValues();
    var formulas = typeof range.getFormulas === 'function'
      ? range.getFormulas()
      : Array.from({ length: rows }, function () {
        return Array.from({ length: columns }, function () { return ''; });
      });
    state[sheetName] = {
      rows: rows,
      columns: columns,
      values: values,
      formulas: formulas
    };
  });
  return state;
}

function registryV2RowsFromState_(state, sheetName, expectedHeaders, projectHeaders) {
  if (!state || !state[sheetName]) {
    throw new Error('Registry v2 compiler state is missing sheet ' + sheetName + '.');
  }
  return registryV2RowsFromGrid_(sheetName, state[sheetName].values,
    expectedHeaders, projectHeaders);
}

function registryV2WorkbookStatesEqual_(left, right) {
  for (var s = 0; s < REGISTRY_V2_COMPILE_SHEETS.length; s++) {
    var name = REGISTRY_V2_COMPILE_SHEETS[s];
    var a = left && left[name];
    var b = right && right[name];
    if (!a || !b || a.rows !== b.rows || a.columns !== b.columns) return false;
    for (var r = 0; r < a.rows; r++) {
      for (var c = 0; c < a.columns; c++) {
        if (!sameCellValue_(a.values[r][c], b.values[r][c])
            || a.formulas[r][c] !== b.formulas[r][c]) return false;
      }
    }
  }
  return true;
}

function registryV2AutoIngestContext_() {
  var id = PropertiesService.getScriptProperties()
    .getProperty(REGISTRY_V2_SPREADSHEET_ID_PROPERTY);
  if (!id) return { enabled: false };
  var spreadsheet = SpreadsheetApp.openById(String(id));
  return {
    enabled: true,
    spreadsheet: spreadsheet,
    spreadsheet_id: String(id),
    before: registryV2WorkbookState_(spreadsheet)
  };
}

function registryV2CloneState_(state) {
  var out = {};
  REGISTRY_V2_COMPILE_SHEETS.forEach(function (name) {
    out[name] = {
      rows: state[name].rows,
      columns: state[name].columns,
      values: state[name].values.map(function (row) { return row.slice(); }),
      formulas: state[name].formulas.map(function (row) { return row.slice(); })
    };
  });
  return out;
}

function registryV2HeaderMap_(header, projectHeaders) {
  var out = {};
  header.forEach(function (value, index) {
    var key = registryV2Clean_(value).toLowerCase();
    if (projectHeaders) {
      REGISTRY_V2_PROJECT_FIELDS.forEach(function (field) {
        if (key === field[0].toLowerCase() || key === field[1].toLowerCase()) {
          out[field[0]] = index;
        }
      });
    } else {
      out[key] = index;
    }
  });
  return out;
}

function registryV2SetRowField_(row, headerMap, key, value) {
  if (!Object.prototype.hasOwnProperty.call(headerMap, key)) {
    throw new Error('Registry v2 is missing column ' + key + '.');
  }
  row[headerMap[key]] = value;
}

function registryV2EnglishFolderName_(value) {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(String(value || '').trim());
}

function registryV2Audience_(value) {
  value = registryV2Clean_(value);
  return ['General', 'Intro', 'Intermediate', 'Advanced'].indexOf(value) !== -1
    ? value : 'General';
}

function registryV2AutoRead_(item) {
  return item.registryRead || readDemo_(item);
}

function registryV2AppendStateRow_(table, values, formulas) {
  table.values.push(values.slice());
  table.formulas.push((formulas || values.map(function () { return ''; })).slice());
  table.rows++;
  return table.rows;
}

function registryV2AutoProjectRow_(header, demoId, title, summary, dataSource,
    audience, department, subtopic, task, methods) {
  var map = registryV2HeaderMap_(header, true);
  var row = header.map(function () { return ''; });
  registryV2SetRowField_(row, map, 'status', 'Draft');
  registryV2SetRowField_(row, map, 'readiness', '');
  registryV2SetRowField_(row, map, 'preview_url', '');
  registryV2SetRowField_(row, map, 'title', title);
  registryV2SetRowField_(row, map, 'card_summary', summary);
  registryV2SetRowField_(row, map, 'department', department);
  registryV2SetRowField_(row, map, 'subtopic', subtopic);
  registryV2SetRowField_(row, map, 'task', task);
  registryV2SetRowField_(row, map, 'methods', methods);
  registryV2SetRowField_(row, map, 'card_image', '');
  registryV2SetRowField_(row, map, 'image_alt', '');
  registryV2SetRowField_(row, map, 'audience', audience);
  registryV2SetRowField_(row, map, 'featured', false);
  registryV2SetRowField_(row, map, 'data_source', dataSource);
  registryV2SetRowField_(row, map, 'public_permission', 'Preview only');
  registryV2SetRowField_(row, map, 'demo_id', demoId);
  return row;
}

function registryV2FacetRowsFor_(demoId, type, ids, header) {
  var map = registryV2HeaderMap_(header, false);
  return ids.map(function (id, index) {
    var row = header.map(function () { return ''; });
    registryV2SetRowField_(row, map, 'demo_id', demoId);
    registryV2SetRowField_(row, map, 'facet_type', type);
    registryV2SetRowField_(row, map, 'term_id', id);
    registryV2SetRowField_(row, map, 'display_order', index + 1);
    return row;
  });
}

function registryV2ProjectProjection_(project, taxonomyIndex) {
  var department = registryV2ResolveHumanTerm_(
    project.department, 'departments', taxonomyIndex);
  var subtopic = registryV2ResolveHumanTerm_(project.subtopic, 'subtopics', taxonomyIndex);
  if (department && subtopic
      && taxonomyIndex.subtopics[subtopic].department_id !== department) {
    throw new Error('Registry v2 Projects has a Department / Subtopic mismatch.');
  }
  return {
    department_id: department,
    subtopic_id: subtopic,
    task_ids: registryV2ResolveHumanList_(project.task, 'tasks', taxonomyIndex),
    method_ids: registryV2ResolveHumanList_(project.methods, 'methods', taxonomyIndex)
  };
}

function registryV2SeedTerm_(value, group, taxonomyIndex) {
  var key = registryV2LookupKey_(value);
  if (!key) return '';
  var id = taxonomyIndex.lookup[group][key];
  return id ? taxonomyIndex[group][id].label : '';
}

function registryV2SeedList_(value, group, taxonomyIndex) {
  var labels = [];
  var seen = {};
  var items = registryV2List_(value);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var key = registryV2LookupKey_(item);
    var id = key && taxonomyIndex.lookup[group][key];
    if (!id || seen[id]) return '';
    seen[id] = true;
    labels.push(taxonomyIndex[group][id].label);
  }
  return labels.join(', ');
}

function registryV2AutoPlan_(before, cfg, items, v1ByFileId) {
  var target = registryV2CloneState_(before);
  var projects = registryV2RowsFromState_(before, 'Projects', [], true);
  var registry = registryV2RowsFromState_(
    before, '_Registry', REGISTRY_V2_HEADERS._Registry, false);
  var taxonomyRows = registryV2RowsFromState_(
    before, '_Taxonomy', REGISTRY_V2_HEADERS._Taxonomy, false);
  var taxonomy = registryV2Taxonomy_(taxonomyRows);
  var taxonomyIndex = registryV2TaxonomyIndex_(taxonomy, taxonomyRows);
  var registryMap = registryV2HeaderMap_(target._Registry.values[0], false);
  var projectsById = {};
  projects.forEach(function (project) {
    var id = registryV2Clean_(project.demo_id);
    if (!id || projectsById[id]) throw new Error('Registry v2 Projects has duplicate identity.');
    projectsById[id] = project;
  });
  var registryById = {};
  var registryByFile = {};
  var usedSlugs = {};
  registry.forEach(function (source) {
    var id = registryV2Clean_(source.demo_id);
    var fileId = registryV2Clean_(source.file_id);
    var slug = registryV2Clean_(source.slug);
    if (!id || registryById[id] || !fileId || registryByFile[fileId]
        || !slug || usedSlugs[slug]) {
      throw new Error('Registry v2 has duplicate or missing page identity.');
    }
    registryById[id] = source;
    registryByFile[fileId] = source;
    usedSlugs[slug] = true;
  });
  if (Object.keys(projectsById).length !== Object.keys(registryById).length
      || Object.keys(projectsById).some(function (id) { return !registryById[id]; })) {
    throw new Error('Registry v2 Projects and _Registry identities do not match.');
  }

  var seen = {};
  var added = 0;
  var skipped = 0;
  var events = [];
  items.forEach(function (item) {
    var fileId = String(item.file.getId());
    if (seen[fileId]) return;
    seen[fileId] = true;
    if (registryByFile[fileId]) return;
    // V2's creation boundary is deliberately narrower than legacy v1.
    if (!item.folderName) return;
    if (!registryV2EnglishFolderName_(item.folderName)) {
      skipped++;
      events.push({ event: 'sync-v2-skip', details:
        'Skipped non-English Registry v2 folder "' + item.folderName + '".' });
      return;
    }
    if ((item.notes || []).some(function (note) {
      return /^primary page unclear\b/i.test(String(note || ''));
    })) {
      skipped++;
      events.push({ event: 'sync-v2-conflict', details: 'Skipped Registry v2 folder "'
        + item.folderName + '" because its primary HTML page is unclear.' });
      return;
    }
    var slug = slugify_(item.folderName);
    var demoId = 'demo-' + slug;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
        || projectsById[demoId] || registryById[demoId] || usedSlugs[slug]) {
      skipped++;
      events.push({ event: 'sync-v2-conflict', details: 'Skipped Registry v2 folder "'
        + item.folderName + '" because its identity conflicts with an existing project.' });
      return;
    }
    var read = registryV2AutoRead_(item);
    var v1 = v1ByFileId[fileId] || [];
    var meta = read.meta || {};
    var title = registryV2Clean_(meta.title)
      || registryV2Clean_(v1[COLS.TITLE - 1])
      || extractTitle_(read.html, item.file.getName());
    var summary = registryV2Clean_(meta.card_summary || meta.description)
      || registryV2Clean_(v1[COLS.DESCRIPTION - 1]);
    var dataSource = registryV2Clean_(meta.data_source)
      || registryV2Clean_(v1[COLS.DATA_SOURCE - 1]);
    if (registryV2ContainsCjk_(title)) title = registryV2Clean_(item.folderName);
    if (registryV2ContainsCjk_(summary)) summary = '';
    if (registryV2ContainsCjk_(dataSource)) dataSource = '';
    var audience = registryV2Audience_(meta.audience || v1[COLS.AUDIENCE - 1]);
    // Initial metadata is only a convenience seed. Keep an exact taxonomy
    // value and quietly leave an unrecognised natural-language value empty so
    // the new Draft is blocked for owner review. Once present in Projects,
    // any later non-empty unknown value remains a strict compiler error.
    var department = registryV2SeedTerm_(meta.department, 'departments', taxonomyIndex);
    var subtopic = registryV2SeedTerm_(meta.subtopic, 'subtopics', taxonomyIndex);
    var task = registryV2SeedList_(
      meta.task_type || v1[COLS.TASK_TYPE - 1], 'tasks', taxonomyIndex);
    var methods = registryV2SeedList_(
      meta.methods || meta.method || v1[COLS.METHOD - 1], 'methods', taxonomyIndex);
    if (department && subtopic) {
      var seededDepartment = registryV2ResolveHumanTerm_(
        department, 'departments', taxonomyIndex);
      var seededSubtopic = registryV2ResolveHumanTerm_(subtopic, 'subtopics', taxonomyIndex);
      if (taxonomyIndex.subtopics[seededSubtopic].department_id !== seededDepartment) {
        subtopic = '';
      }
    }
    var projected = registryV2ProjectProjection_({
      department: department, subtopic: subtopic, task: task, methods: methods
    }, taxonomyIndex);
    var projectRow = registryV2AutoProjectRow_(target.Projects.values[0], demoId,
      title, summary, dataSource, audience, department, subtopic, task, methods);
    var projectRowNumber = registryV2AppendStateRow_(target.Projects, projectRow);
    var registryRow = target._Registry.values[0].map(function () { return ''; });
    registryV2SetRowField_(registryRow, registryMap, 'schema_version', 2);
    registryV2SetRowField_(registryRow, registryMap, 'row_number', projectRowNumber);
    registryV2SetRowField_(registryRow, registryMap, 'demo_id', demoId);
    registryV2SetRowField_(registryRow, registryMap, 'entry_type', 'project');
    registryV2SetRowField_(registryRow, registryMap, 'slug', slug);
    registryV2SetRowField_(registryRow, registryMap, 'status', 'Draft');
    registryV2SetRowField_(registryRow, registryMap, 'readiness', 'blocked');
    registryV2SetRowField_(registryRow, registryMap, 'featured', false);
    registryV2SetRowField_(registryRow, registryMap, 'sort_order', projectRowNumber - 1);
    registryV2SetRowField_(registryRow, registryMap, 'title', title);
    registryV2SetRowField_(registryRow, registryMap, 'card_summary', summary);
    registryV2SetRowField_(registryRow, registryMap, 'department_id', projected.department_id);
    registryV2SetRowField_(registryRow, registryMap, 'subtopic_id', projected.subtopic_id);
    registryV2SetRowField_(registryRow, registryMap, 'task_ids', projected.task_ids.join(', '));
    registryV2SetRowField_(registryRow, registryMap, 'method_ids', projected.method_ids.join(', '));
    registryV2SetRowField_(registryRow, registryMap, 'audience', audience);
    registryV2SetRowField_(registryRow, registryMap, 'data_source_label', dataSource);
    registryV2SetRowField_(registryRow, registryMap, 'public_page_permission', 'Preview only');
    registryV2SetRowField_(registryRow, registryMap, 'card_asset_id', '');
    registryV2SetRowField_(registryRow, registryMap, 'file_id', fileId);
    registryV2SetRowField_(registryRow, registryMap, 'file_check',
      registryV2Clean_(v1[COLS.FILE_CHECK - 1]) || 'missing');
    registryV2SetRowField_(registryRow, registryMap, 'date_added',
      isoOrString_(v1[COLS.DATE_ADDED - 1]));
    registryV2AppendStateRow_(target._Registry, registryRow);
    projectsById[demoId] = registryV2RowsFromGrid_(
      'Projects', [target.Projects.values[0], projectRow], [], true)[0];
    projectsById[demoId]._row_number = projectRowNumber;
    registryById[demoId] = registryV2RowsFromGrid_(
      '_Registry', [target._Registry.values[0], registryRow],
      REGISTRY_V2_HEADERS._Registry, false)[0];
    registryById[demoId]._row_number = target._Registry.rows;
    registryByFile[fileId] = registryById[demoId];
    usedSlugs[slug] = true;
    added++;
  });

  // Re-project every human-owned Projects row. No Projects human field is ever
  // changed here; only its hidden machine representation is reconciled.
  var desiredFacets = [];
  Object.keys(projectsById).forEach(function (demoId) {
    var project = projectsById[demoId];
    var source = registryById[demoId];
    var projection = registryV2ProjectProjection_(project, taxonomyIndex);
    var registryRow = target._Registry.values[source._row_number - 1];
    registryV2SetRowField_(registryRow, registryMap, 'status', project.status);
    registryV2SetRowField_(registryRow, registryMap, 'featured', project.featured);
    registryV2SetRowField_(registryRow, registryMap, 'title', project.title);
    registryV2SetRowField_(registryRow, registryMap, 'card_summary', project.card_summary);
    registryV2SetRowField_(registryRow, registryMap, 'department_id', projection.department_id);
    registryV2SetRowField_(registryRow, registryMap, 'subtopic_id', projection.subtopic_id);
    registryV2SetRowField_(registryRow, registryMap, 'task_ids', projection.task_ids.join(', '));
    registryV2SetRowField_(registryRow, registryMap, 'method_ids', projection.method_ids.join(', '));
    registryV2SetRowField_(registryRow, registryMap, 'audience', project.audience);
    registryV2SetRowField_(registryRow, registryMap, 'data_source_label', project.data_source);
    registryV2SetRowField_(registryRow, registryMap, 'public_page_permission', project.public_permission);
    var v1 = v1ByFileId[registryV2Clean_(source.file_id)];
    registryV2SetRowField_(registryRow, registryMap, 'file_check',
      v1 ? registryV2Clean_(v1[COLS.FILE_CHECK - 1]) || 'missing' : 'missing');
    desiredFacets = desiredFacets.concat(
      registryV2FacetRowsFor_(demoId, 'task', projection.task_ids, target._Facets.values[0]),
      registryV2FacetRowsFor_(demoId, 'method', projection.method_ids, target._Facets.values[0]));
  });
  target._Facets.values = [target._Facets.values[0]].concat(desiredFacets);
  target._Facets.formulas = target._Facets.values.map(function (row) {
    return row.map(function () { return ''; });
  });
  target._Facets.rows = target._Facets.values.length;

  var compiled = registryV2CompileState_(null, cfg, 'preview', target);
  var previewBase = registryV2PreviewBaseUrl_(compiled.config);
  var statusPlan = registryV2WritePlan_(compiled, target, previewBase);
  statusPlan.project_writes.forEach(function (write) {
    target.Projects.values[write.row - 1][statusPlan.project_readiness_column - 1]
      = write.readiness;
    target.Projects.values[write.row - 1][statusPlan.project_preview_column - 1]
      = write.preview_formula ? 'Open Preview' : '';
    target.Projects.formulas[write.row - 1][statusPlan.project_preview_column - 1]
      = write.preview_formula;
  });
  statusPlan.registry_writes.forEach(function (write) {
    target._Registry.values[write.row - 1][statusPlan.registry_readiness_column - 1]
      = write.readiness;
  });
  return {
    target: target,
    compiled: compiled,
    added: added,
    skipped: skipped,
    events: events,
    checked: Object.keys(projectsById).length - added,
    before_rows: {
      Projects: before.Projects.rows,
      _Registry: before._Registry.rows,
      _Facets: before._Facets.rows
    }
  };
}

function registryV2RestCell_(value, formula) {
  if (formula) return { userEnteredValue: { formulaValue: formula } };
  if (value === '' || value == null) return { userEnteredValue: {} };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (typeof value === 'number' && isFinite(value)) {
    return { userEnteredValue: { numberValue: value } };
  }
  return { userEnteredValue: { stringValue: isoOrString_(value) || String(value) } };
}

function registryV2RestRow_(values, formulas) {
  return { values: values.map(function (value, index) {
    return registryV2RestCell_(value, formulas && formulas[index]);
  }) };
}

function registryV2SheetsMetadata_(spreadsheetId) {
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/'
    + encodeURIComponent(spreadsheetId)
    + '?fields=sheets(properties(sheetId,title),tables(tableId,name,range))';
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Registry v2 could not inspect its native tables (HTTP '
      + response.getResponseCode() + ').');
  }
  var body = JSON.parse(response.getContentText());
  var sheets = {};
  (body.sheets || []).forEach(function (sheet) {
    var title = sheet.properties && sheet.properties.title;
    if (!title) return;
    var tables = sheet.tables || [];
    sheets[title] = {
      sheet_id: sheet.properties.sheetId,
      table_id: tables.length === 1 ? tables[0].tableId : '',
      table_name: tables.length === 1 ? tables[0].name : '',
      table_range: tables.length === 1 ? tables[0].range : null,
      table_count: tables.length
    };
  });
  if (!sheets.Projects || sheets.Projects.table_count !== 1
      || sheets.Projects.table_name !== 'ProjectsCatalogV2'
      || !sheets.Projects.table_id) {
    throw new Error('Registry v2 Projects must remain a native Google Sheets table.');
  }
  ['_Registry', '_Facets'].forEach(function (name) {
    if (!sheets[name] || sheets[name].table_count !== 0) {
      throw new Error('Registry v2 machine sheet ' + name + ' must remain a plain grid.');
    }
  });
  return sheets;
}

function registryV2VerifyTableMetadata_(metadata, before) {
  var range = metadata.Projects.table_range || {};
  if (Number(range.startRowIndex || 0) !== 0
      || Number(range.startColumnIndex || 0) !== 0
      || Number(range.endColumnIndex) !== before.Projects.columns
      || Number(range.endRowIndex) !== before.Projects.rows) {
    throw new Error('Registry v2 Projects table range does not match its current workbook.');
  }
}

function registryV2UpdateRequest_(sheetId, rowIndex, columnIndex, cell) {
  return { updateCells: {
    range: {
      sheetId: sheetId,
      startRowIndex: rowIndex,
      endRowIndex: rowIndex + 1,
      startColumnIndex: columnIndex,
      endColumnIndex: columnIndex + 1
    },
    rows: [{ values: [cell] }],
    fields: 'userEnteredValue'
  } };
}

function registryV2BatchWrite_(spreadsheetId, before, plan, metadata) {
  metadata = metadata || registryV2SheetsMetadata_(spreadsheetId);
  var requests = [];
  ['Projects', '_Registry'].forEach(function (name) {
    var oldRows = before[name].rows;
    var target = plan.target[name];
    for (var r = 1; r < Math.min(oldRows, target.rows); r++) {
      for (var c = 0; c < target.columns; c++) {
        var valueChanged = !sameCellValue_(before[name].values[r][c], target.values[r][c]);
        var formulaChanged = before[name].formulas[r][c] !== target.formulas[r][c];
        if (!valueChanged && !formulaChanged) continue;
        requests.push(registryV2UpdateRequest_(metadata[name].sheet_id, r, c,
          registryV2RestCell_(target.values[r][c], target.formulas[r][c])));
      }
    }
    if (target.rows > oldRows) {
      var append = target.values.slice(oldRows).map(function (row, index) {
        return registryV2RestRow_(row, target.formulas[oldRows + index]);
      });
      requests.push({ appendCells: {
        tableId: metadata[name] && metadata[name].table_id || undefined,
        sheetId: metadata[name] && metadata[name].table_id
          ? undefined : metadata[name].sheet_id,
        rows: append,
        fields: 'userEnteredValue'
      } });
    }
  });

  var facets = plan.target._Facets;
  var maxFacetRows = Math.max(before._Facets.rows, facets.rows);
  for (var fr = 1; fr < maxFacetRows; fr++) {
    for (var fc = 0; fc < facets.columns; fc++) {
      var desiredValue = fr < facets.rows ? facets.values[fr][fc] : '';
      var oldValue = fr < before._Facets.rows ? before._Facets.values[fr][fc] : '';
      var desiredFormula = fr < facets.rows ? facets.formulas[fr][fc] : '';
      var oldFormula = fr < before._Facets.rows ? before._Facets.formulas[fr][fc] : '';
      if (sameCellValue_(oldValue, desiredValue) && oldFormula === desiredFormula) continue;
      if (fr < before._Facets.rows) {
        requests.push(registryV2UpdateRequest_(metadata._Facets.sheet_id, fr, fc,
          registryV2RestCell_(desiredValue, desiredFormula)));
      }
    }
  }
  if (facets.rows > before._Facets.rows) {
    requests.push({ appendCells: {
      tableId: metadata._Facets.table_id || undefined,
      sheetId: metadata._Facets.table_id ? undefined : metadata._Facets.sheet_id,
      rows: facets.values.slice(before._Facets.rows).map(function (row) {
        return registryV2RestRow_(row, null);
      }),
      fields: 'userEnteredValue'
    } });
  }
  if (!requests.length) return;
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/'
    + encodeURIComponent(spreadsheetId) + ':batchUpdate';
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
    payload: JSON.stringify({ requests: requests })
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('Registry v2 guarded batch write failed (HTTP '
      + response.getResponseCode() + ').');
  }
}

function registryV2AutoIngest_(context, cfg, items, v1ByFileId) {
  var plan = registryV2AutoPlan_(context.before, cfg, items, v1ByFileId);
  var checked = registryV2WorkbookState_(context.spreadsheet);
  if (!registryV2WorkbookStatesEqual_(context.before, checked)) {
    throw new Error('Registry v2 changed during Drive scan. No v2 cells were updated.');
  }
  // Metadata inspection is read-only; perform one final full-grid check after it.
  var metadata = registryV2SheetsMetadata_(context.spreadsheet_id);
  registryV2VerifyTableMetadata_(metadata, context.before);
  var aboutToWrite = registryV2WorkbookState_(context.spreadsheet);
  if (!registryV2WorkbookStatesEqual_(context.before, aboutToWrite)) {
    throw new Error('Registry v2 changed before writing. No v2 cells were updated.');
  }
  registryV2BatchWrite_(context.spreadsheet_id, context.before, plan, metadata);
  SpreadsheetApp.flush();
  var afterSheet = SpreadsheetApp.openById(context.spreadsheet_id);
  var after = registryV2WorkbookState_(afterSheet);
  if (!registryV2WorkbookStatesEqual_(plan.target, after)) {
    throw new Error('Registry v2 auto-ingest could not verify the completed write.');
  }
  (plan.events || []).forEach(function (event) {
    logEvent_(event.event, event.details);
  });
  return {
    enabled: true,
    added: plan.added,
    checked: plan.checked,
    skipped: plan.skipped,
    registry_revision: plan.compiled.registry_revision
  };
}

function registryV2Config_(rows) {
  var config = {};
  rows.forEach(function (row) {
    var key = registryV2Clean_(row.key);
    if (!key || Object.prototype.hasOwnProperty.call(config, key)) {
      throw new Error('Registry v2 _Config has an invalid key.');
    }
    config[key] = row.value;
  });
  if (String(config.schema_version || '') !== '2') {
    throw new Error('Registry v2 _Config schema_version must be 2.');
  }
  return config;
}

function registryV2Taxonomy_(rows) {
  var result = { departments: [], subtopics: [], tasks: [], methods: [] };
  var groups = {
    department: 'departments', departments: 'departments',
    subtopic: 'subtopics', subtopics: 'subtopics',
    task: 'tasks', tasks: 'tasks', method: 'methods', methods: 'methods'
  };
  var ids = {};
  rows.forEach(function (row) {
    var type = registryV2Clean_(row.term_type).toLowerCase();
    var group = groups[type];
    var id = registryV2Clean_(row.term_id);
    if (!group || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids[id]) {
      throw new Error('Registry v2 _Taxonomy has an invalid term.');
    }
    if (row.active !== true && row.active !== false) {
      throw new Error('Registry v2 taxonomy active values must be booleans.');
    }
    ids[id] = true;
    var term = { id: id, label: registryV2Clean_(row.label), active: row.active };
    if (group === 'departments') {
      term.short_label = registryV2Clean_(row.short_label);
      term.description = registryV2Clean_(row.description);
      term.display_order = registryV2Number_(row.display_order, 0);
      term.theme_key = registryV2Clean_(row.theme_key);
      term.icon_key = registryV2Clean_(row.icon_key);
    } else if (group === 'subtopics') {
      term.department_id = registryV2Clean_(row.parent_id);
      term.display_order = registryV2Number_(row.display_order, 0);
    }
    result[group].push(term);
  });
  return result;
}

function registryV2PageHealthy_(value) {
  var check = registryV2Clean_(value).toLowerCase();
  return /^ok(?:\b|\s|[-—:])/.test(check) || /^check assets:/.test(check);
}

function registryV2Visible_(demo, audience) {
  if (!demo || demo.readiness !== 'ready' || !registryV2PageHealthy_(demo.file_check)) {
    return false;
  }
  if (demo.status === 'Live') return demo.public_page_permission === 'Public';
  return audience === 'preview' && demo.status === 'Draft'
    && (demo.public_page_permission === 'Public'
      || demo.public_page_permission === 'Preview only');
}

function registryV2LookupKey_(value) {
  return registryV2Clean_(value).toLowerCase().replace(/\s+/g, ' ');
}

function registryV2TaxonomyIndex_(taxonomy, taxonomyRows) {
  var index = {
    departments: {}, subtopics: {}, tasks: {}, methods: {},
    lookup: { departments: {}, subtopics: {}, tasks: {}, methods: {} }
  };
  Object.keys(index).forEach(function (group) {
    if (group === 'lookup') return;
    taxonomy[group].forEach(function (term) { index[group][term.id] = term; });
  });
  var groups = {
    department: 'departments', departments: 'departments',
    subtopic: 'subtopics', subtopics: 'subtopics',
    task: 'tasks', tasks: 'tasks', method: 'methods', methods: 'methods'
  };
  taxonomyRows.forEach(function (row) {
    var group = groups[registryV2Clean_(row.term_type).toLowerCase()];
    var id = registryV2Clean_(row.term_id);
    if (!group || !index[group][id]) return;
    var candidates = [id, row.label, row.short_label]
      .concat(registryV2List_(row.aliases));
    candidates.forEach(function (candidate) {
      var key = registryV2LookupKey_(candidate);
      if (!key) return;
      var current = index.lookup[group][key];
      if (current && current !== id) index.lookup[group][key] = null;
      else if (current === undefined) index.lookup[group][key] = id;
    });
  });
  return index;
}

function registryV2ResolveHumanTerm_(value, group, taxonomyIndex) {
  var key = registryV2LookupKey_(value);
  if (!key) return '';
  var id = key ? taxonomyIndex.lookup[group][key] : '';
  if (!id) throw new Error('Registry v2 Projects has an unknown or ambiguous taxonomy value.');
  return id;
}

function registryV2ResolveHumanList_(value, group, taxonomyIndex) {
  var ids = registryV2List_(value).map(function (item) {
    return registryV2ResolveHumanTerm_(item, group, taxonomyIndex);
  });
  if (ids.length !== Object.keys(ids.reduce(function (out, id) {
    out[id] = true;
    return out;
  }, {})).length) {
    throw new Error('Registry v2 Projects has a duplicate taxonomy selection.');
  }
  return ids;
}

function registryV2SameIdSet_(left, right) {
  if (left.length !== right.length) return false;
  var leftSorted = left.slice().sort();
  var rightSorted = right.slice().sort();
  for (var i = 0; i < leftSorted.length; i++) {
    if (leftSorted[i] !== rightSorted[i]) return false;
  }
  return true;
}

function registryV2HumanTaxonomy_(project, source, demoFacets, taxonomyIndex) {
  var resolved = {
    department_id: registryV2ResolveHumanTerm_(
      project.department, 'departments', taxonomyIndex),
    subtopic_id: registryV2ResolveHumanTerm_(
      project.subtopic, 'subtopics', taxonomyIndex),
    task_ids: registryV2ResolveHumanList_(project.task, 'tasks', taxonomyIndex),
    method_ids: registryV2ResolveHumanList_(project.methods, 'methods', taxonomyIndex)
  };
  var indexedTasks = demoFacets.task.map(function (item) { return item.id; });
  var indexedMethods = demoFacets.method.map(function (item) { return item.id; });
  var subtopic = resolved.subtopic_id
    ? taxonomyIndex.subtopics[resolved.subtopic_id] : null;
  if (resolved.department_id && subtopic
      && subtopic.department_id !== resolved.department_id) {
    throw new Error('Registry v2 Projects has a Department / Subtopic mismatch.');
  }
  if (resolved.department_id !== registryV2Clean_(source.department_id)
      || resolved.subtopic_id !== registryV2Clean_(source.subtopic_id)
      || !registryV2SameIdSet_(resolved.task_ids, indexedTasks)
      || !registryV2SameIdSet_(resolved.method_ids, indexedMethods)) {
    throw new Error('Registry v2 human taxonomy does not match its hidden index.');
  }
  return resolved;
}

function registryV2ReadinessError_(demo, project, taxonomyIndex) {
  if (demo.entry_type !== 'project') return 'entry_type';
  if (demo.status !== 'Live' && demo.status !== 'Draft' && demo.status !== 'Archived') {
    return 'status';
  }
  if (demo.status === 'Archived') return 'archived';
  if (!demo.title || !demo.card_summary) return 'card copy';
  if (project.featured !== true && project.featured !== false) return 'featured';
  if (['General', 'Intro', 'Intermediate', 'Advanced'].indexOf(demo.audience) === -1) {
    return 'audience';
  }
  var department = taxonomyIndex.departments[demo.department_id];
  var subtopic = taxonomyIndex.subtopics[demo.subtopic_id];
  if (!department || department.active !== true || !subtopic || subtopic.active !== true
      || subtopic.department_id !== demo.department_id) return 'taxonomy';
  if (!demo.task_ids.length || demo.task_ids.some(function (id) {
    return !taxonomyIndex.tasks[id] || taxonomyIndex.tasks[id].active !== true;
  })) return 'task';
  if (!demo.method_ids.length || demo.method_ids.some(function (id) {
    return !taxonomyIndex.methods[id] || taxonomyIndex.methods[id].active !== true;
  })) return 'method';
  if (!demo.file_id || !registryV2PageHealthy_(demo.file_check)) return 'source file';
  if (demo.status === 'Live' && demo.public_page_permission !== 'Public') {
    return 'public permission';
  }
  if (demo.status === 'Draft'
      && ['Public', 'Preview only'].indexOf(demo.public_page_permission) === -1) {
    return 'preview permission';
  }
  return '';
}

function registryV2AllowedParentIds_(file, rootId) {
  var parents = file.getParents();
  var allowed = [];
  while (parents.hasNext()) {
    var parent = parents.next();
    var id = String(parent.getId());
    if (id === String(rootId) || folderHasParentId_(parent, rootId)) allowed.push(id);
  }
  allowed.sort();
  return allowed;
}

function registryV2DriveInfo_(cfg, fileId, kind) {
  var rootId = folderIdFromUrl_(cfg && cfg.drive_folder_url);
  if (!rootId || !/^[-\w]{10,}$/.test(String(fileId || ''))) return null;
  var file = DriveApp.getFileById(String(fileId));
  var mime = registryV2Clean_(file.getMimeType()).toLowerCase();
  if (mime === DRIVE_SHORTCUT_MIME) return null;
  var name = String(file.getName() || '');
  var extensionMatch = /\.([A-Za-z0-9]+)$/.exec(name);
  var extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
  if (kind === 'page') {
    if (!/\.html?$/.test(name.toLowerCase()) && mime.indexOf('html') === -1) return null;
  } else if (kind === 'asset') {
    if (!REGISTRY_V2_IMAGE_MIME_BY_EXTENSION[extension]
        || mime !== REGISTRY_V2_IMAGE_MIME_BY_EXTENSION[extension]) return null;
  } else {
    return null;
  }
  var parents = registryV2AllowedParentIds_(file, rootId);
  if (!parents.length) return null;
  var stamp = registryFileStampMs_(file);
  if (!isFinite(stamp)) return null;
  return {
    file: file, id: String(fileId), name: name, mime: mime, extension: extension,
    parent_ids: parents, modified_ms: stamp
  };
}

function registryV2SharesParent_(left, right) {
  return left.parent_ids.some(function (id) { return right.parent_ids.indexOf(id) !== -1; });
}

function registryV2SameDriveInfo_(left, right) {
  return left && right && left.id === right.id && left.name === right.name
    && left.mime === right.mime && left.modified_ms === right.modified_ms
    && stableJson_(left.parent_ids) === stableJson_(right.parent_ids);
}

function registryV2CompileState_(ss, cfg, audience, workbookState) {
  var state = workbookState || registryV2WorkbookState_(ss);
  var projects = registryV2RowsFromState_(state, 'Projects', [], true);
  var registry = registryV2RowsFromState_(
    state, '_Registry', REGISTRY_V2_HEADERS._Registry, false);
  var taxonomyRows = registryV2RowsFromState_(
    state, '_Taxonomy', REGISTRY_V2_HEADERS._Taxonomy, false);
  var facets = registryV2RowsFromState_(
    state, '_Facets', REGISTRY_V2_HEADERS._Facets, false);
  var assets = registryV2RowsFromState_(
    state, '_Assets', REGISTRY_V2_HEADERS._Assets, false);
  var v2Config = registryV2Config_(
    registryV2RowsFromState_(state, '_Config', REGISTRY_V2_HEADERS._Config, false));
  var taxonomy = registryV2Taxonomy_(taxonomyRows);
  var taxonomyIndex = registryV2TaxonomyIndex_(taxonomy, taxonomyRows);
  var projectsById = {};
  projects.forEach(function (project) {
    var id = registryV2Clean_(project.demo_id);
    if (!id || projectsById[id]) throw new Error('Registry v2 Projects has duplicate identity.');
    projectsById[id] = project;
  });
  var registryIds = {};
  registry.forEach(function (source) {
    var id = registryV2Clean_(source.demo_id);
    if (!id || registryIds[id]) throw new Error('Registry v2 _Registry has duplicate identity.');
    registryIds[id] = true;
  });
  var projectIds = Object.keys(projectsById);
  var sourceIds = Object.keys(registryIds);
  if (projectIds.length !== sourceIds.length
      || projectIds.some(function (id) { return !registryIds[id]; })) {
    throw new Error('Registry v2 Projects and _Registry identities do not match.');
  }
  var facetsByDemo = {};
  facets.forEach(function (facet) {
    var id = registryV2Clean_(facet.demo_id);
    var type = registryV2Clean_(facet.facet_type).toLowerCase();
    if (type !== 'task' && type !== 'method') return;
    if (!facetsByDemo[id]) facetsByDemo[id] = { task: [], method: [] };
    facetsByDemo[id][type].push({
      id: registryV2Clean_(facet.term_id),
      order: registryV2Number_(facet.display_order, 0)
    });
  });
  Object.keys(facetsByDemo).forEach(function (id) {
    ['task', 'method'].forEach(function (type) {
      facetsByDemo[id][type].sort(function (a, b) { return a.order - b.order; });
    });
  });
  var assetsByDemo = {};
  var assetsById = {};
  assets.forEach(function (asset) {
    var id = registryV2Clean_(asset.asset_id);
    var demoId = registryV2Clean_(asset.demo_id);
    if (!id || assetsById[id]) throw new Error('Registry v2 _Assets has duplicate identity.');
    assetsById[id] = asset;
    if (registryV2Clean_(asset.role) === 'card_image') {
      if (!assetsByDemo[demoId]) assetsByDemo[demoId] = [];
      assetsByDemo[demoId].push(asset);
    }
  });
  Object.keys(assetsByDemo).forEach(function (id) {
    if (assetsByDemo[id].length > 1) {
      throw new Error('Registry v2 permits only one card image per project.');
    }
  });

  var publicDemos = [];
  var readiness = [];
  var fileSources = {};
  var assetSources = {};
  var seenFiles = {};
  var seenSlugs = {};
  registry.forEach(function (source) {
    var demoId = registryV2Clean_(source.demo_id);
    var project = projectsById[demoId];
    if (!project) throw new Error('Registry v2 _Registry has no matching Project.');
    var fileId = registryV2Clean_(source.file_id);
    var slug = registryV2Clean_(source.slug);
    if (!fileId || seenFiles[fileId] || !slug || seenSlugs[slug]) {
      throw new Error('Registry v2 has duplicate or missing page identity.');
    }
    seenFiles[fileId] = true;
    seenSlugs[slug] = true;
    var demoFacets = facetsByDemo[demoId] || { task: [], method: [] };
    var humanTaxonomy = registryV2HumanTaxonomy_(
      project, source, demoFacets, taxonomyIndex);
    var demo = {
      demo_id: demoId,
      entry_type: registryV2Clean_(source.entry_type) || 'project',
      slug: slug,
      status: registryV2Clean_(project.status),
      readiness: '',
      featured: project.featured === true,
      sort_order: registryV2Number_(source.sort_order, Number(source.row_number) || 0),
      title: registryV2Clean_(project.title),
      card_summary: registryV2Clean_(project.card_summary),
      department_id: humanTaxonomy.department_id,
      subtopic_id: humanTaxonomy.subtopic_id,
      task_ids: humanTaxonomy.task_ids,
      method_ids: humanTaxonomy.method_ids,
      audience: registryV2Clean_(project.audience),
      data_source_label: registryV2Clean_(project.data_source),
      public_page_permission: registryV2Clean_(project.public_permission),
      card_asset: null,
      file_id: fileId,
      file_check: registryV2Clean_(source.file_check),
      date_added: isoOrString_(source.date_added)
    };
    var readinessError = registryV2ReadinessError_(demo, project, taxonomyIndex);
    var readinessStatus = demo.status === 'Archived'
      ? 'not_applicable' : readinessError ? 'blocked' : 'ready';
    readiness.push({
      demo_id: demoId,
      project_row: project._row_number,
      registry_row: source._row_number,
      project_status: demo.status,
      slug: slug,
      status: readinessStatus,
      issue: readinessError
    });
    demo.readiness = readinessStatus === 'ready' ? 'ready' : 'blocked';
    if (!registryV2Visible_(demo, audience)) return;
    delete demo.readiness;
    var pageInfo = registryV2DriveInfo_(cfg, fileId, 'page');
    if (!pageInfo) {
      if (demo.status === 'Live') {
        throw new Error('Registry v2 page is outside the Drive boundary.');
      }
      return;
    }
    fileSources[fileId] = pageInfo;

    var selectedImage = registryV2Clean_(project.card_image);
    if (selectedImage) {
      if (selectedImage.indexOf('/') !== -1 || selectedImage.indexOf('\\') !== -1
          || selectedImage === '.' || selectedImage === '..') {
        throw new Error('Registry v2 Card Image must be a direct-child file name.');
      }
      var cardRows = assetsByDemo[demoId] || [];
      var asset = cardRows.length === 1 ? cardRows[0] : null;
      if (!asset || registryV2Clean_(source.card_asset_id) !== registryV2Clean_(asset.asset_id)) {
        throw new Error('Registry v2 selected Card Image has no indexed asset.');
      }
      if (registryV2Clean_(asset.source_type).toLowerCase() !== 'drive'
          || registryV2Clean_(asset.external_url)) {
        throw new Error('Registry v2 external card images are not enabled.');
      }
      if (registryV2Clean_(asset.sync_status) !== 'ok') {
        throw new Error('Registry v2 Card Image sync_status must be ok.');
      }
      var assetInfo = registryV2DriveInfo_(cfg,
        registryV2Clean_(asset.drive_file_id), 'asset');
      if (!assetInfo || assetInfo.name !== selectedImage
          || registryV2Clean_(asset.source_file_name) !== selectedImage
          || !registryV2SharesParent_(pageInfo, assetInfo)) {
        throw new Error('Registry v2 Card Image is not beside its project page.');
      }
      var publicPath = registryV2Clean_(asset.public_path);
      var publicExtension = (/\.([A-Za-z0-9]+)$/.exec(publicPath) || [])[1] || '';
      if (!/^assets\/cards\/[a-z0-9][a-z0-9/_-]*\.(?:avif|gif|jpe?g|png|webp)$/.test(publicPath)
          || publicExtension.toLowerCase() !== assetInfo.extension
          || registryV2Clean_(asset.mime_type).toLowerCase() !== assetInfo.mime) {
        throw new Error('Registry v2 Card Image metadata does not match Drive.');
      }
      var assetId = registryV2Clean_(asset.asset_id);
      demo.card_asset = {
        asset_id: assetId,
        public_path: publicPath,
        alt_text: registryV2Clean_(project.image_alt)
      };
      if (!demo.card_asset.alt_text) throw new Error('Registry v2 Card Image needs alt text.');
      assetSources[assetId] = {
        row: asset, info: assetInfo, page_info: pageInfo,
        public_path: publicPath
      };
    }
    publicDemos.push(demo);
  });
  publicDemos.sort(function (a, b) {
    return Number(a.sort_order) - Number(b.sort_order) || a.demo_id.localeCompare(b.demo_id);
  });
  var site = {
    title: registryV2Clean_(v2Config.site_title) || 'AI for Science demos',
    tagline: registryV2Clean_(v2Config.site_tagline)
  };
  var sourceState = {
    pages: Object.keys(fileSources).sort().map(function (id) {
      var info = fileSources[id];
      return { id: id, modified_ms: info.modified_ms, parent_ids: info.parent_ids };
    }),
    assets: Object.keys(assetSources).sort().map(function (id) {
      var info = assetSources[id].info;
      return { id: id, drive_file_id: info.id, modified_ms: info.modified_ms,
        parent_ids: info.parent_ids };
    })
  };
  var material = {
    schema: REGISTRY_V2_REVISION_SCHEMA,
    audience: audience,
    site: site,
    taxonomy: taxonomy,
    demos: publicDemos,
    sources: sourceState
  };
  return {
    audience: audience, site: site, taxonomy: taxonomy, demos: publicDemos,
    files_by_id: fileSources, assets_by_id: assetSources,
    readiness: readiness,
    config: v2Config,
    workbook_state: state,
    registry_revision: 'sha256:' + sha256Hex_(stableJson_(material))
  };
}

/** Build-facing view. A blocked Live row keeps the API fail-closed. */
function registryV2Snapshot_(ss, cfg, audience) {
  var compiled = registryV2CompileState_(ss, cfg, audience);
  var blockedLive = compiled.readiness.filter(function (item) {
    return item.project_status === 'Live' && item.status !== 'ready';
  })[0];
  if (blockedLive) {
    throw new Error('Registry v2 Live project is not ready: '
      + (blockedLive.issue || 'needs review') + '.');
  }
  return {
    audience: compiled.audience,
    site: compiled.site,
    taxonomy: compiled.taxonomy,
    demos: compiled.demos,
    files_by_id: compiled.files_by_id,
    assets_by_id: compiled.assets_by_id,
    registry_revision: compiled.registry_revision
  };
}

function registryV2ReadinessText_(item) {
  if (item.status === 'not_applicable') return '— Archived';
  if (item.status === 'ready') {
    return item.project_status === 'Draft'
      ? '✅ Preview ready' : '✅ Publication ready';
  }
  var labels = {
    'entry_type': 'Record Type',
    'status': 'Status',
    'archived': 'Archived',
    'card copy': 'Card Summary',
    'featured': 'Featured',
    'audience': 'Audience',
    'taxonomy': 'Department / Subtopic',
    'task': 'Task Type',
    'method': 'Methods',
    'source file': 'Source File Check',
    'public permission': 'Public Permission',
    'preview permission': 'Public Permission'
  };
  return '⛔ Action needed: ' + (labels[item.issue] || 'Needs review');
}

function registryV2PreviewPageUrl_(baseUrl, slug) {
  var base = registryV2Clean_(baseUrl);
  var cleanSlug = registryV2Clean_(slug);
  if (!isSafeHttpsUrl_(base) || !cleanSlug) return '';
  if (base.slice(-1) !== '/') base += '/';
  return base + 'demos/' + encodeURIComponent(cleanSlug) + '/';
}

function registryV2PreviewBaseUrl_(config) {
  var base = registryV2Clean_(config && config.preview_base_url);
  if (!isSafeHttpsUrl_(base) || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(base)) {
    throw new Error('Registry v2 _Config preview_base_url must be a valid HTTPS base URL.');
  }
  return base;
}

function registryV2ProjectColumn_(header, fieldKey) {
  for (var i = 0; i < REGISTRY_V2_PROJECT_FIELDS.length; i++) {
    if (REGISTRY_V2_PROJECT_FIELDS[i][0] !== fieldKey) continue;
    var label = REGISTRY_V2_PROJECT_FIELDS[i][1];
    for (var c = 0; c < header.length; c++) {
      var value = registryV2Clean_(header[c]).toLowerCase();
      if (value === fieldKey.toLowerCase() || value === label.toLowerCase()) return c + 1;
    }
  }
  throw new Error('Registry v2 Projects is missing ' + fieldKey + '.');
}

function registryV2MachineColumn_(header, fieldKey) {
  for (var c = 0; c < header.length; c++) {
    if (registryV2Clean_(header[c]).toLowerCase() === fieldKey.toLowerCase()) return c + 1;
  }
  throw new Error('Registry v2 _Registry is missing ' + fieldKey + '.');
}

function registryV2WritePlan_(compiled, state, previewBaseUrl) {
  var projectsGrid = state.Projects.values;
  var registryGrid = state._Registry.values;
  var projectReadinessColumn = registryV2ProjectColumn_(projectsGrid[0], 'readiness');
  var projectPreviewColumn = registryV2ProjectColumn_(projectsGrid[0], 'preview_url');
  var registryReadinessColumn = registryV2MachineColumn_(registryGrid[0], 'readiness');
  var projectWrites = [];
  var registryWrites = [];

  compiled.readiness.forEach(function (item) {
    if (!projectsGrid[item.project_row - 1] || !registryGrid[item.registry_row - 1]) {
      throw new Error('Registry v2 identity points outside its current physical row.');
    }
    var previewUrl = item.status === 'ready'
      ? registryV2PreviewPageUrl_(previewBaseUrl, item.slug) : '';
    projectWrites.push({
      row: item.project_row,
      readiness: registryV2ReadinessText_(item),
      preview_formula: previewUrl
        ? '=HYPERLINK("' + previewUrl + '","Open Preview")' : ''
    });
    registryWrites.push({ row: item.registry_row, readiness: item.status });
  });
  projectWrites.sort(function (a, b) { return a.row - b.row; });
  registryWrites.sort(function (a, b) { return a.row - b.row; });
  return {
    project_readiness_column: projectReadinessColumn,
    project_preview_column: projectPreviewColumn,
    registry_readiness_column: registryReadinessColumn,
    project_writes: projectWrites,
    registry_writes: registryWrites
  };
}

function registryV2ContiguousRuns_(writes) {
  var runs = [];
  writes.forEach(function (write) {
    var current = runs[runs.length - 1];
    if (!current || write.row !== current[current.length - 1].row + 1) {
      current = [];
      runs.push(current);
    }
    current.push(write);
  });
  return runs;
}

function registryV2StateMatchesWrite_(state, before, plan) {
  for (var s = 0; s < REGISTRY_V2_COMPILE_SHEETS.length; s++) {
    var sheetName = REGISTRY_V2_COMPILE_SHEETS[s];
    var current = state[sheetName];
    var original = before[sheetName];
    if (!current || !original || current.rows !== original.rows
        || current.columns !== original.columns) return false;
    for (var r = 0; r < current.rows; r++) {
      for (var c = 0; c < current.columns; c++) {
        var managed = (sheetName === 'Projects'
            && (c + 1 === plan.project_readiness_column
              || c + 1 === plan.project_preview_column))
          || (sheetName === '_Registry' && c + 1 === plan.registry_readiness_column);
        if (managed) continue;
        if (!sameCellValue_(current.values[r][c], original.values[r][c])
            || current.formulas[r][c] !== original.formulas[r][c]) return false;
      }
    }
  }
  for (var i = 0; i < plan.project_writes.length; i++) {
    var projectWrite = plan.project_writes[i];
    if (!sameCellValue_(state.Projects.values[projectWrite.row - 1]
      [plan.project_readiness_column - 1], projectWrite.readiness)) return false;
    if (state.Projects.formulas[projectWrite.row - 1][plan.project_preview_column - 1]
        !== projectWrite.preview_formula) return false;
    var expectedPreviewDisplay = projectWrite.preview_formula ? 'Open Preview' : '';
    if (!sameCellValue_(state.Projects.values[projectWrite.row - 1]
      [plan.project_preview_column - 1],
      expectedPreviewDisplay)) return false;
  }
  for (var j = 0; j < plan.registry_writes.length; j++) {
    var registryWrite = plan.registry_writes[j];
    if (!sameCellValue_(state._Registry.values[registryWrite.row - 1]
      [plan.registry_readiness_column - 1], registryWrite.readiness)) return false;
  }
  return true;
}

/** Explicit owner action; it never publishes, installs triggers, or runs setup(). */
function refreshRegistryV2Status() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('Registry v2 status refresh is already running.');
  }
  try {
    var v2Sheet = registryV2Spreadsheet_();
    var cfg = readConfig_(registrySpreadsheet_());

    var before = registryV2WorkbookState_(v2Sheet);
    var compiled = registryV2CompileState_(v2Sheet, cfg, 'preview', before);
    var previewBaseUrl = registryV2PreviewBaseUrl_(compiled.config);
    var plan = registryV2WritePlan_(compiled, before, previewBaseUrl);

    // Editors are not governed by ScriptLock. Re-read every compiler input,
    // including formulas, and verify the revision before the first write.
    var checked = registryV2WorkbookState_(v2Sheet);
    if (!registryV2WorkbookStatesEqual_(before, checked)) {
      throw new Error('Registry v2 status refresh stopped: the Sheet changed during compilation. No cells were updated.');
    }
    var checkedCompile = registryV2CompileState_(v2Sheet, cfg, 'preview', checked);
    if (checkedCompile.registry_revision !== compiled.registry_revision) {
      throw new Error('Registry v2 status refresh stopped: the Registry revision changed. No cells were updated.');
    }
    var aboutToWrite = registryV2WorkbookState_(v2Sheet);
    if (!registryV2WorkbookStatesEqual_(before, aboutToWrite)) {
      throw new Error('Registry v2 status refresh stopped: the Sheet changed before writing. No cells were updated.');
    }

    var projects = v2Sheet.getSheetByName('Projects');
    var registry = v2Sheet.getSheetByName('_Registry');
    registryV2ContiguousRuns_(plan.project_writes).forEach(function (run) {
      projects.getRange(run[0].row, plan.project_readiness_column, run.length, 1)
        .setValues(run.map(function (write) { return [write.readiness]; }));
      projects.getRange(run[0].row, plan.project_preview_column, run.length, 1)
        .setFormulas(run.map(function (write) { return [write.preview_formula]; }));
    });
    registryV2ContiguousRuns_(plan.registry_writes).forEach(function (run) {
      registry.getRange(run[0].row, plan.registry_readiness_column, run.length, 1)
        .setValues(run.map(function (write) { return [write.readiness]; }));
    });
    SpreadsheetApp.flush();

    var after = registryV2WorkbookState_(v2Sheet);
    var afterCompile = registryV2CompileState_(v2Sheet, cfg, 'preview', after);
    if (afterCompile.registry_revision !== compiled.registry_revision
        || !registryV2StateMatchesWrite_(after, before, plan)) {
      throw new Error('Registry v2 status refresh could not verify the completed write.');
    }
    var ready = compiled.readiness.filter(function (item) {
      return item.status === 'ready';
    }).length;
    var summary = ready + ' ready, ' + (compiled.readiness.length - ready)
      + ' blocked or archived.';
    if (typeof v2Sheet.toast === 'function') v2Sheet.toast(summary, 'Registry v2', 6);
    return { ok: true, ready: ready, total: compiled.readiness.length,
      registry_revision: compiled.registry_revision };
  } finally {
    lock.releaseLock();
  }
}

function registryV2ReadBlob_(cfg, expectedInfo, kind) {
  var before = registryV2DriveInfo_(cfg, expectedInfo.id, kind);
  if (!registryV2SameDriveInfo_(before, expectedInfo)) {
    throw new Error('Registry v2 source changed before reading.');
  }
  if (kind === 'asset' && typeof before.file.getSize === 'function'
      && Number(before.file.getSize()) > REGISTRY_V2_MAX_CARD_ASSET_BYTES) {
    throw new Error('Registry v2 card image is too large.');
  }
  var blob = before.file.getBlob();
  var after = registryV2DriveInfo_(cfg, expectedInfo.id, kind);
  if (!registryV2SameDriveInfo_(after, expectedInfo)) {
    throw new Error('Registry v2 source changed while reading.');
  }
  return blob;
}

function registryV2UnsignedBytes_(bytes) {
  return bytes.map(function (value) { return value < 0 ? value + 256 : value; });
}

function registryV2ImageBytesMatch_(bytes, extension) {
  var b = registryV2UnsignedBytes_(bytes);
  if (extension === 'png') {
    return b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78
      && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10;
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  }
  if (extension === 'gif') {
    var gif = String.fromCharCode.apply(null, b.slice(0, 6));
    return gif === 'GIF87a' || gif === 'GIF89a';
  }
  if (extension === 'webp') {
    return b.length >= 12 && String.fromCharCode.apply(null, b.slice(0, 4)) === 'RIFF'
      && String.fromCharCode.apply(null, b.slice(8, 12)) === 'WEBP';
  }
  if (extension === 'avif') {
    if (b.length < 16 || String.fromCharCode.apply(null, b.slice(4, 8)) !== 'ftyp') {
      return false;
    }
    var limit = Math.min(b.length - 3, 64);
    for (var offset = 8; offset < limit; offset += 4) {
      var brand = String.fromCharCode.apply(null, b.slice(offset, offset + 4));
      if (brand === 'avif' || brand === 'avis') return true;
    }
    return false;
  }
  return false;
}

function registryV2Response_(snapshot, cfg, action, id) {
  if (action === 'file') {
    var expectedPage = snapshot.files_by_id[id];
    if (!expectedPage) return { ok: false, error: 'unknown file id' };
    var pageBlob = registryV2ReadBlob_(cfg, expectedPage, 'page');
    var html = pageBlob.getDataAsString();
    if (!registryV2Clean_(html)) return { ok: false, error: 'could not read file' };
    return { ok: true, audience: snapshot.audience,
      registry_revision: snapshot.registry_revision, id: id, html: html };
  }
  if (action === 'asset') {
    var source = snapshot.assets_by_id[id];
    if (!source) return { ok: false, error: 'unknown asset id' };
    var blob = registryV2ReadBlob_(cfg, source.info, 'asset');
    var bytes = blob.getBytes();
    if (!bytes.length || bytes.length > REGISTRY_V2_MAX_CARD_ASSET_BYTES
        || !registryV2ImageBytesMatch_(bytes, source.info.extension)) {
      return { ok: false, error: 'could not read asset' };
    }
    return {
      ok: true,
      kind: 'card_image',
      id: id,
      mime: source.info.mime,
      size: bytes.length,
      extension: source.info.extension,
      base64: Utilities.base64Encode(bytes),
      registry_revision: snapshot.registry_revision
    };
  }
  return {
    ok: true,
    schema_version: 2,
    audience: snapshot.audience,
    registry_revision: snapshot.registry_revision,
    generated: new Date().toISOString(),
    site: snapshot.site,
    taxonomy: snapshot.taxonomy,
    demos: snapshot.demos
  };
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    var unsigned = b < 0 ? b + 256 : b;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function previewCallbackSignature_(rawPayload, secret) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(
    String(rawPayload), String(secret), Utilities.Charset.UTF_8));
}

function constantTimeHexEqual_(left, right) {
  left = String(left || '').toLowerCase();
  right = String(right || '').toLowerCase();
  var different = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var i = 0; i < length; i++) {
    different |= (left.charCodeAt(i % Math.max(left.length, 1)) || 0)
      ^ (right.charCodeAt(i % Math.max(right.length, 1)) || 0);
  }
  return different === 0;
}

/** Authenticated completion sink used only by the develop onSuccess plugin. */
function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.action !== 'preview_callback') {
    return jsonOut_({ ok: false, error: 'unknown action' });
  }
  var contents = String(e && e.postData && e.postData.contents || '');
  if (!contents || contents.length > PREVIEW_CALLBACK_MAX_BYTES) {
    return jsonOut_({ ok: false, error: 'invalid callback envelope' });
  }
  var outer;
  try { outer = JSON.parse(contents); }
  catch (ignored) { return jsonOut_({ ok: false, error: 'invalid callback envelope' }); }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)
      || Object.keys(outer).length !== 2
      || typeof outer.payload !== 'string'
      || !/^[0-9a-f]{64}$/i.test(String(outer.signature || ''))
      || outer.payload.length > PREVIEW_CALLBACK_MAX_BYTES) {
    return jsonOut_({ ok: false, error: 'invalid callback envelope' });
  }

  var properties = PropertiesService.getScriptProperties();
  var secret = String(properties.getProperty(PREVIEW_CALLBACK_SECRET_PROPERTY) || '');
  var expectedSiteId = String(properties.getProperty(NETLIFY_SITE_ID_PROPERTY) || '');
  if (secret.length < 32 || !expectedSiteId) {
    return jsonOut_({ ok: false, error: 'Preview callback is not configured.' });
  }
  var expectedSignature = previewCallbackSignature_(outer.payload, secret);
  if (!constantTimeHexEqual_(outer.signature, expectedSignature)) {
    return jsonOut_({ ok: false, error: 'invalid callback signature' });
  }

  // Only the authenticated raw string is parsed as the semantic payload.
  var payload;
  try { payload = JSON.parse(outer.payload); }
  catch (ignored2) { return jsonOut_({ ok: false, error: 'invalid callback payload' }); }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonOut_({ ok: false, error: 'Preview callback is busy.' });
  }
  try {
    var adopted = adoptPreviewCallback_(readPreviewPublishState_(), payload,
      expectedSiteId, Date.now());
    if (!adopted.ok) return jsonOut_({ ok: false, error: adopted.error });
    writePreviewPublishState_(adopted.state);
    var deployId = String(payload.receipt.deploy_id);
    if (adopted.adopted) {
      logEvent_('publish-ready', 'Authenticated Preview request '
        + adopted.state.readyRequestId.slice(0, 12) + ' is ready at revision '
        + adopted.state.ready.slice(0, 19) + ' / deploy ' + deployId.slice(0, 12) + '.');
    } else if (adopted.invalidated) {
      logEvent_('publish-stale', 'An unverified develop deploy '
        + deployId.slice(0, 12) + ' replaced the last verified Preview.');
    }
    return jsonOut_({
      ok: true,
      event: 'preview_callback',
      deploy_id: deployId,
      adopted: adopted.adopted === true,
      duplicate: adopted.duplicate === true,
      stale: adopted.stale === true,
      invalidated: adopted.invalidated === true
    });
  } finally {
    lock.releaseLock();
  }
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

  var audienceResult = registryAudience_(p.audience);
  if (!audienceResult.ok) return jsonOut_({ ok: false, error: audienceResult.error });
  var audience = audienceResult.value;
  var schemaResult = registrySchema_(p.schema);
  if (!schemaResult.ok) return jsonOut_({ ok: false, error: schemaResult.error });
  if (schemaResult.value === 2) {
    if (p.action && p.action !== 'manifest' && p.action !== 'file'
        && p.action !== 'asset') {
      return jsonOut_({ ok: false, error: 'unknown action' });
    }
    var v2Snapshot;
    try {
      v2Snapshot = registryV2Snapshot_(registryV2Spreadsheet_(), cfg, audience);
    } catch (v2SnapshotError) {
      return jsonOut_({ ok: false, error: 'registry v2 unavailable' });
    }
    var v2ExpectedRevision = String(p.registry_revision || '').trim();
    if (v2ExpectedRevision && v2ExpectedRevision !== v2Snapshot.registry_revision) {
      return jsonOut_({
        ok: false,
        error: 'registry revision changed',
        registry_revision: v2Snapshot.registry_revision
      });
    }
    if ((p.action === 'file' || p.action === 'asset') && !p.id) {
      return jsonOut_({ ok: false,
        error: p.action === 'asset' ? 'unknown asset id' : 'unknown file id' });
    }
    try {
      return jsonOut_(registryV2Response_(v2Snapshot, cfg,
        p.action || 'manifest', String(p.id || '')));
    } catch (v2ReadError) {
      return jsonOut_({ ok: false,
        error: p.action === 'asset' ? 'could not read asset' : 'could not read file' });
    }
  }
  if (p.action && p.action !== 'manifest' && p.action !== 'file') {
    return jsonOut_({ ok: false, error: 'unknown action' });
  }
  var snapshot = registrySnapshot_(ss, cfg, audience);
  var expectedRevision = String(p.registry_revision || '').trim();
  if (expectedRevision && expectedRevision !== snapshot.registry_revision) {
    return jsonOut_({
      ok: false,
      error: 'registry revision changed',
      registry_revision: snapshot.registry_revision
    });
  }
  var visible = snapshot.demos;

  if (p.action === 'file') {
    if (!p.id) return jsonOut_({ ok: false, error: 'unknown file id' });
    var kind = registryFileKind_(visible, p.id);
    if (!kind) return jsonOut_({ ok: false, error: 'unknown file id' });
    var matchedDemo = registryDemoForFile_(visible, p.id, kind);
    try {
      var file = registryDriveFile_(cfg, p.id, kind);
      if (!file) return jsonOut_({ ok: false, error: 'unknown file id' });
      var stampBefore = registryFileStampMs_(file);
      if (registryFileChangedAfterSync_(matchedDemo, stampBefore)) {
        return jsonOut_({
          ok: false,
          error: 'registry source changed; run Drive sync and retry',
          registry_revision: snapshot.registry_revision
        });
      }
      var blob = file.getBlob();
      var stampAfter = registryFileStampMs_(file);
      if (stampAfter !== stampBefore
          || registryFileChangedAfterSync_(matchedDemo, stampAfter)) {
        return jsonOut_({
          ok: false,
          error: 'registry source changed while reading; run Drive sync and retry',
          registry_revision: snapshot.registry_revision
        });
      }
      if (kind === 'page') {
        var pageHtml = blob.getDataAsString();
        if (!String(pageHtml || '').trim()) {
          return jsonOut_({ ok: false, error: 'could not read file' });
        }
        return jsonOut_({
          ok: true,
          audience: audience,
          registry_revision: snapshot.registry_revision,
          id: p.id,
          html: pageHtml
        });
      }
      return jsonOut_({
        ok: true, audience: audience, registry_revision: snapshot.registry_revision, id: p.id,
        mime: String(blob.getContentType() || 'application/octet-stream'),
        base64: Utilities.base64Encode(blob.getBytes())
      });
    } catch (err) {
      return jsonOut_({ ok: false, error: 'could not read file' });
    }
  }

  // default: manifest
  return jsonOut_({
    ok: true,
    audience: audience,
    registry_revision: snapshot.registry_revision,
    generated: new Date().toISOString(),
    site: snapshot.site,
    demos: visible
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

/** Compare exact Drive/Sheet timestamps; never hide an edit made within 60 seconds. */
function driveStampChanged_(stored, current) {
  if (!isDate_(stored) || !isDate_(current)) return true;
  return stored.getTime() !== current.getTime();
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
  if (isShortcutFile_(f)) return false;
  var name = f.getName().toLowerCase();
  if (/\.html?$/.test(name)) return true;
  var mime = String(f.getMimeType() || '').toLowerCase();
  return mime.indexOf('html') !== -1;
}

function isImageFile_(f) {
  if (isShortcutFile_(f)) return false;
  if (IMAGE_EXT.test(String(f.getName()))) return true;
  return String(f.getMimeType() || '').toLowerCase().indexOf('image/') === 0;
}

function isShortcutFile_(f) {
  try { return String(f.getMimeType() || '').toLowerCase() === DRIVE_SHORTCUT_MIME; }
  catch (e) {
    throw new Error('Drive sync stopped: MIME lookup failed for file "'
      + driveEntryName_(f) + '". No registry changes were written.');
  }
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
