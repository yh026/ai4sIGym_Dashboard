import { importPackage, newDemoDescriptor, planChanges } from './shared/package.mjs';

// The desk intentionally keeps parsed packages bound to their exact demo and baseline.
const $ = (id) => document.getElementById(id);
const roles = ['insight', 'workflow', 'dataset'];
const roleNames = { insight: 'Insight', workflow: 'Workflow', dataset: 'Dataset' };
const kindNames = { added: 'Added', replaced: 'Replaced', reused: 'Reused', removed: 'Removed' };
let state = null,
  catalog = {},
  slug = '',
  review = null;
let loading = false,
  preparing = false,
  uploading = false,
  granting = false;
let revision = 0,
  requestId = 0,
  importId = 0,
  controller = null;
let ready = false,
  loadedSlug = '';
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const bytes = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '—';
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
  return `${(number / 1024 ** 2).toFixed(1)} MiB`;
};
const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const dateValue = (value) => {
  if (!value) return 0;
  const parsed = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateLabel = (value) =>
  dateValue(value)
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(dateValue(value))
    : 'Date unavailable';
const demoTitle = (demo) => (typeof demo?.title === 'string' ? demo.title : demo?.slug || 'Untitled demo');
const selectedDemo = () => catalog[slug] || null;
const currentBase = () => state?.latest?.[slug]?.id || state?.anchor || state?.production || '';
let releaseBusy = false;
let newInputs = [],
  customAddress = false;
const locked = () => uploading || granting || releaseBusy;
const canImport = () => ready && !loading && !locked() && Boolean(selectedDemo());
const validReview = () =>
  review && review.slug === slug && review.revision === revision && review.base === currentBase();
function safeURL(value, base = location.origin) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
function link(label, value, className) {
  const href = safeURL(value);
  if (!href) return null;
  const node = element('a', label, className);
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}
function notify(message = '', tone = 'info', version = null) {
  const box = $('notice');
  box.replaceChildren();
  box.hidden = !message;
  box.dataset.tone = tone;
  box.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  if (message) box.append(element('span', message));
  const pinned = version && link('Open this Preview', version.url || version.pages?.insight);
  if (pinned) {
    box.append(document.createTextNode(' '), pinned);
  }
}
function updateControls() {
  const enabled = canImport();
  $('demoSelect').disabled = locked() || !Object.keys(catalog).length;
  for (const anchor of navigation.values()) anchor.setAttribute('aria-disabled', String(locked()));
  $('refreshState').disabled = locked();
  $('newDemoFields').disabled = !isOwner() || loading || locked();
  $('createNewDemo').disabled = !newInputs.length || locked();
  $('packageInput').disabled = !enabled || preparing;
  $('folderInput').disabled = !enabled || preparing;
  $('dropZone').setAttribute('aria-disabled', String(!enabled || preparing));
  $('clearReview').disabled = uploading || loading;
  const valid = validReview();
  const hasOperations = valid && (review.files.length > 0 || review.remove.length > 0);
  $('confirmUpload').disabled = !enabled || preparing || !hasOperations;
  $('confirmUpload').textContent = uploading ? 'Updating Preview…' : 'Update Preview';
  for (const input of $('grantForm').querySelectorAll('input,button'))
    input.disabled = !isOwner() || locked() || loading;
  for (const button of $('grantList').querySelectorAll('button')) button.disabled = locked() || loading;

  $('workspace').setAttribute('aria-busy', String(loading));
}
function invalidateReview() {
  revision += 1;
  importId += 1;
  preparing = false;
  review = null;
  $('packageInput').value = '';
  $('folderInput').value = '';
  $('reviewSection').hidden = true;
  $('diffRows').replaceChildren();
  $('diffSummary').replaceChildren();
  $('importState').textContent = 'Ready to import';
  if (!uploading) $('uploadRegion').hidden = true;
  updateControls();
}
async function deskRequest(action, { method = 'GET', body, signal, selectedSlug } = {}) {
  const query = new URLSearchParams({ action });
  if (selectedSlug !== undefined) query.set('slug', selectedSlug);
  const options = { method, credentials: 'same-origin', signal };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json', 'X-Gym-Preview': '1' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/.netlify/functions/desk?' + query, options);
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error('The service returned an invalid response. Refresh and try again.');
  }
  if (!response.ok) {
    const detail = typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message;
    const error = new Error(
      detail ||
        (response.status === 401
          ? 'Sign in to access the preview desk.'
          : response.status === 403
            ? 'This account does not have access.'
            : `Request failed (${response.status})`),
    );
    error.status = response.status;
    throw error;
  }
  return value;
}
function renderCatalog() {
  const picker = $('demoSelect');
  picker.replaceChildren(element('option', 'Select a demo'));
  picker.firstChild.value = '';
  for (const demo of demos()) {
    const option = element('option', demoTitle(demo));
    option.value = demo.slug;
    picker.append(option);
  }
  picker.value = slug;
}
const demos = () => Object.values(catalog).sort((a, b) => demoTitle(a).localeCompare(demoTitle(b), 'en'));
const isOwner = () => Boolean(state?.who?.owner ?? state?.owner);
const reviewVersion = (name) => state?.reviewVersions?.[name] || '';
const checklistPending = new Map();
let grantChoicesInitialized = false;
const navigation = new Map(
  [...$('deskNav').querySelectorAll('a[data-view]')].map((anchor) => [anchor.dataset.view, anchor]),
);
const releaseViews = new Set(['publish', 'files', 'restore-demo', 'restore-site', 'receipts']);
const ownerView = (name) => name === 'new' || name === 'access' || releaseViews.has(name);
const descriptions = {
  new: 'Upload a three-page demo to share its first private Preview.',
  upload: 'Choose an existing demo and select the files you want to update.',
  publish: 'Select the Previews you reviewed. Their pages and assets will be released together.',
  files: 'Upload one package to release a demo and sync its Preview to the same files.',
  'restore-demo':
    'Return one demo to an earlier Production version. Other demos keep their current versions.',
  'restore-site':
    'Choose an earlier version for the whole public site. Review the affected demos before restoring.',
  receipts: 'Open a receipt for its pages, file changes and transfer details.',
  access: 'Give members permission to update Previews for the demos they maintain.',
};
function readRoute() {
  const url = new URL(location.href);
  const requested = url.searchParams.get('view');
  const slug = url.searchParams.get('slug') || '';
  const receipt = url.hash.startsWith('#receipt-') ? url.hash : '';
  if (receipt && (!requested || requested === 'release' || requested === 'receipts'))
    return { view: 'receipts', receipt, slug: '' };
  // Existing bookmarks used one release page, and upload links used only a slug.
  const view =
    requested === 'release'
      ? 'publish'
      : navigation.has(requested)
        ? requested
        : slug
          ? 'upload'
          : 'overview';
  return { view, receipt: '', slug: view === 'upload' ? slug : '' };
}
const initialRoute = readRoute();
let view = initialRoute.view;
function writeRoute(method = 'replaceState', receipt = '') {
  const params = new URLSearchParams();
  if (view === 'upload' && slug) params.set('slug', slug);
  else if (view !== 'overview') params.set('view', view);
  const path = location.pathname + (params.size ? '?' + params : '') + (view === 'receipts' ? receipt : '');
  if (path !== location.pathname + location.search + location.hash) history[method](null, '', path);
}
function toggleMenu(open) {
  $('menuToggle').setAttribute('aria-expanded', String(open));
  $('sidebarContent').classList.toggle('is-open', open);
}
function renderView() {
  const privatePage = releaseViews.has(view);
  for (const group of $('deskNav').querySelectorAll('[data-owner-nav]')) group.hidden = !isOwner();
  for (const [name, anchor] of navigation) {
    if (name === view) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  for (const name of ['overview', 'new', 'upload', 'access'])
    $(name + 'Section').hidden = name !== view || (ownerView(name) && !isOwner());
  $('releaseSection').hidden = !privatePage || !isOwner();
  for (const panel of $('releaseSection').querySelectorAll('[data-release-panel]'))
    panel.hidden = !panel.dataset.releasePanel.split(' ').includes(view);
  $('pageTitle').textContent = navigation.get(view).textContent;
  document.title = $('pageTitle').textContent + ' · Instrumentation Gym';
  $('pageDescription').textContent = descriptions[view] || '';
  $('pageDescription').hidden = !descriptions[view];
  $('privateScope').hidden = !privatePage;
}
function openView(next, { method = 'pushState', receipt = '', selectedSlug, focus = true } = {}) {
  if (locked()) return;
  const previous = view;
  view = state && !isOwner() && ownerView(next) ? 'overview' : next;
  if (view === 'upload' && selectedSlug !== undefined) slug = selectedSlug;
  writeRoute(method, receipt);
  renderView();
  toggleMenu(false);
  if (previous !== view && !loading) {
    notify();
    releaseNotice();
    $('releaseProgressRegion').hidden = true;
    revealedReceiptHash = '';
  }
  if (focus) {
    window.scrollTo(0, 0);
    $('pageTitle').focus({ preventScroll: true });
  }
  if (view === 'upload' && selectedSlug !== undefined && loadedSlug !== selectedSlug)
    return loadState(selectedSlug);
  if (
    view === 'overview' &&
    previous !== 'overview' &&
    (previous === 'new' || (!validReview() && !preparing))
  )
    return loadState('');
  if (!releaseViews.has(view) || !isOwner()) return;
  const missingReceipt = receipt && !releaseState?.receipts?.some((r) => receipt === '#receipt-' + r.id);
  if (
    !releaseState ||
    (view === 'receipts' && previous !== view) ||
    missingReceipt ||
    (!releaseViews.has(previous) && !releaseDraft) ||
    savedRelease?.id
  )
    return loadRelease(releaseSlug);
  renderRelease();
}
function pageLinks(demo, preview) {
  const group = element('div', undefined, 'page-links');
  for (const role of roles) {
    const descriptor = demo.pages?.[role];
    const path = typeof descriptor === 'string' ? descriptor : descriptor?.path;
    const placeholder = !preview && descriptor?.state?.toLowerCase() === 'placeholder';
    const url = preview
      ? state?.latest?.[demo.slug]?.pages?.[role] ||
        (role === 'insight' ? state?.latest?.[demo.slug]?.url : null)
      : path && state?.origin
        ? safeURL(path, state.origin)
        : null;
    const anchor = link(roleNames[role], url);
    if (anchor) {
      const description = `${roleNames[role]} · ${preview ? 'Preview' : 'Production'} · ${demoTitle(demo)}${placeholder ? ' (placeholder page)' : ''} (opens in a new tab)`;
      anchor.setAttribute('aria-label', description);
      anchor.title = description;
    }
    group.append(anchor || element('span', '—', 'unavailable'));
    if (!anchor) group.lastChild.setAttribute('aria-label', `${roleNames[role]} unavailable`);
  }
  return group;
}
function isReviewed(name) {
  const version = reviewVersion(name);
  return Boolean(version && state?.checklist?.[name] === version);
}
function compareLatest(a, b) {
  return (
    dateValue(state?.latest?.[b.slug]?.created) - dateValue(state?.latest?.[a.slug]?.created) ||
    demoTitle(a).localeCompare(demoTitle(b), 'en') ||
    a.slug.localeCompare(b.slug, 'en')
  );
}
function renderOverview() {
  const focusedSlug = document.activeElement?.dataset?.checklistSlug;
  let restoreFocus = null;
  const rows = $('overviewRows');
  const focusedIndex = focusedSlug
    ? Array.from(rows.querySelectorAll('[data-checklist-slug]')).indexOf(document.activeElement)
    : -1;
  rows.replaceChildren();
  const sort = isOwner() ? $('demoSort').value : 'latest';
  const all = demos().sort((a, b) => {
    if (sort === 'name')
      return demoTitle(a).localeCompare(demoTitle(b), 'en') || a.slug.localeCompare(b.slug, 'en');
    if (sort === 'unchecked') {
      const reviewedOrder = Number(isReviewed(a.slug)) - Number(isReviewed(b.slug));
      if (reviewedOrder) return reviewedOrder;
    }
    return compareLatest(a, b);
  });
  const query = $('demoSearch').value.trim().toLowerCase();
  const shown = all.filter((demo) => (demoTitle(demo) + ' ' + demo.slug).toLowerCase().includes(query));
  $('catalogCount').textContent = state ? all.filter((demo) => demo.published !== false).length : '—';
  $('previewCount').textContent = state ? all.filter((demo) => state.latest?.[demo.slug]).length : '—';
  $('reviewStat').hidden = !isOwner();
  $('doneCount').textContent = all.filter((demo) => isReviewed(demo.slug)).length;
  $('resultCount').textContent = query && state ? `Showing ${shown.length} of ${all.length} demos` : '';
  $('checklistHeading').hidden = !isOwner();
  $('sortControl').hidden = !isOwner();
  $('checklistHelp').hidden = !isOwner();
  for (const demo of shown) {
    const row = element('tr');
    row.dataset.reviewed = String(isOwner() && isReviewed(demo.slug));
    const title = element('th');
    title.scope = 'row';
    title.append(element('span', demoTitle(demo), 'demo-name'), element('span', demo.slug, 'demo-slug'));
    const production = element('td');
    production.dataset.label = 'Production';
    production.append(
      demo.published === false
        ? element('span', 'Not published yet', 'empty-preview')
        : pageLinks(demo, false),
    );
    const preview = element('td');
    preview.dataset.label = 'Preview';
    preview.append(
      state?.latest?.[demo.slug] ? pageLinks(demo, true) : element('span', 'No preview', 'empty-preview'),
    );
    const created = state?.latest?.[demo.slug]?.created;
    if (created) preview.append(element('span', `Updated ${dateLabel(created)}`, 'updated'));
    row.append(title, production, preview);
    if (isOwner()) {
      const cell = element('td', undefined, 'checklist-cell');
      cell.dataset.label = 'My checklist';
      const label = element('label', undefined, 'checklist-label');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.checklistSlug = demo.slug;
      if (focusedSlug === demo.slug) restoreFocus = checkbox;
      const version = reviewVersion(demo.slug);
      checkbox.checked = isReviewed(demo.slug);
      checkbox.disabled = !version || loading;
      checkbox.setAttribute('aria-disabled', String(checklistPending.has(demo.slug)));
      checkbox.setAttribute('aria-busy', String(checklistPending.has(demo.slug)));
      checkbox.addEventListener('click', (event) => {
        if (checklistPending.has(demo.slug)) event.preventDefault();
      });
      checkbox.setAttribute('aria-label', `Reviewed and published: ${demoTitle(demo)}`);
      checkbox.addEventListener('change', () => saveChecklist(demo.slug, version, checkbox.checked));
      label.append(
        checkbox,
        element(
          'span',
          checklistPending.has(demo.slug) ? 'Saving…' : checkbox.checked ? 'Done' : 'Mark done',
        ),
      );
      cell.append(label);
      row.append(cell);
    }
    rows.append(row);
  }
  if (!shown.length) {
    const row = element('tr'),
      cell = element(
        'td',
        loading
          ? 'Loading demos…'
          : query
            ? 'No demos match your search.'
            : 'No accessible demos. Contact the owner for access.',
      );
    cell.colSpan = isOwner() ? 4 : 3;
    row.append(cell);
    rows.append(row);
  }
  if (restoreFocus) {
    // Keep the next review within reach when the completed row moves to the bottom.
    const inPlace =
      sort === 'unchecked' && focusedIndex >= 0
        ? rows.querySelectorAll('[data-checklist-slug]')[focusedIndex]
        : null;
    (inPlace || restoreFocus).focus({ preventScroll: true });
  }
}
async function saveChecklist(name, version, checked) {
  if (!isOwner() || checklistPending.has(name) || reviewVersion(name) !== version || loading) return;
  const token = Symbol(name);
  const epoch = requestId;
  checklistPending.set(name, token);
  renderOverview();
  try {
    const result = await deskRequest('checklist', { method: 'POST', body: { slug: name, version, checked } });
    if (result.slug !== name || result.version !== version || result.checked !== checked)
      throw new Error('The saved checklist did not match this request. Refresh to check its current state.');
    if (epoch !== requestId || reviewVersion(name) !== version) {
      notify('The demo list changed while saving. Refresh to confirm the checklist.');
      return;
    }
    state.checklist = { ...(state.checklist || {}) };
    if (checked) state.checklist[name] = version;
    else delete state.checklist[name];
    notify();
  } catch (error) {
    if (error.status === 409 && view === 'overview' && epoch === requestId) {
      await loadState('', {
        message: 'The overview has been refreshed. Review the current version before marking it.',
      });
    } else {
      notify(`Could not save the check. ${error.message}`, 'error');
    }
  } finally {
    if (checklistPending.get(name) === token) checklistPending.delete(name);
    renderOverview();
  }
}
function renderIdentity() {
  $('identityRole').textContent = isOwner() ? 'Owner' : state?.who ? 'Invited member' : 'Not connected';
  $('identityEmail').textContent = state?.who?.email || state?.who?.id || 'Checking access';
}
function editGrant(grant) {
  $('grantEmail').value = grant.email || '';
  for (const checkbox of $('grantChoices').querySelectorAll('input'))
    checkbox.checked = (grant.slugs || []).includes(checkbox.value);
  updateGrantSelection();
  $('grantEmail').focus();
  notify('Member permissions loaded. Adjust the demos and save.');
}
function updateGrantSelection() {
  const choices = Array.from($('grantChoices').querySelectorAll('input'));
  const count = choices.filter((checkbox) => checkbox.checked).length;
  $('grantSelectionCount').textContent = `${count} of ${choices.length} selected`;
}
function selectGrants(checked) {
  if (!isOwner() || locked() || loading) return;
  for (const checkbox of $('grantChoices').querySelectorAll('input')) checkbox.checked = checked;
  updateGrantSelection();
}
function renderGrants() {
  const choices = $('grantChoices'),
    list = $('grantList');
  const selected = new Set(
    Array.from(choices.querySelectorAll('input'))
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value),
  );
  const focusedSlug = document.activeElement?.dataset?.grantSlug;
  let restoreFocus = null;
  choices.replaceChildren();
  list.replaceChildren();
  if (!isOwner()) {
    grantChoicesInitialized = false;
    $('grantEmail').value = '';
    updateGrantSelection();
    return;
  }
  for (const demo of demos()) {
    const label = element('label', undefined, 'grant-choice'),
      checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.value = demo.slug;
    checkbox.dataset.grantSlug = demo.slug;
    checkbox.checked = grantChoicesInitialized && selected.has(demo.slug);
    checkbox.addEventListener('change', updateGrantSelection);
    if (focusedSlug === demo.slug) restoreFocus = checkbox;
    label.append(checkbox, element('span', demoTitle(demo)));
    choices.append(label);
  }
  grantChoicesInitialized = true;
  updateGrantSelection();
  if (restoreFocus) restoreFocus.focus({ preventScroll: true });
  const grants = Array.isArray(state.grants) ? state.grants : [];
  if (!grants.length) list.append(element('p', 'No member upload permissions yet.', 'empty-note'));
  for (const grant of grants) {
    const row = element('div', undefined, 'grant-member'),
      description = element('div');
    description.append(element('strong', grant.email || 'Email unavailable'));
    description.append(
      element(
        'p',
        (grant.slugs || []).map((name) => demoTitle(catalog[name] || { slug: name })).join(', ') ||
          'No demos granted',
        'subtle',
      ),
    );
    const actions = element('div', undefined, 'member-actions'),
      edit = element('button', 'Edit', 'button secondary'),
      revoke = element('button', 'Revoke all', 'button danger');
    edit.type = revoke.type = 'button';
    edit.addEventListener('click', () => editGrant(grant));
    revoke.addEventListener('click', () => saveGrant(grant.email, []));
    actions.append(edit, revoke);
    row.append(description, actions);
    list.append(row);
  }
}
function render() {
  renderCatalog();
  const category = $('newDemoCategory'),
    previousCategory = category.value;
  category.replaceChildren(
    new Option('Choose a category', ''),
    ...(state?.categories || []).map((c) => new Option(c.name, c.id)),
  );
  category.value = previousCategory;
  renderOverview();
  renderIdentity();
  renderGrants();
  $('uploadContext').textContent = selectedDemo()
    ? 'Add the pages and resources for this demo.'
    : 'Select a demo to enable file import.';
  $('importState').hidden = !selectedDemo();
  if (state && ownerView(view) && !isOwner()) {
    view = 'overview';
    writeRoute();
  }
  renderView();
  updateControls();
}
async function loadState(requestedSlug = '', { message = '' } = {}) {
  if (locked()) return;
  const id = ++requestId;
  controller?.abort();
  controller = new AbortController();
  invalidateReview();
  ready = false;
  loading = true;
  slug = requestedSlug;
  render();
  notify('Loading demos and versions…', 'loading');
  try {
    const value = await deskRequest(requestedSlug ? 'state' : 'overview', {
      selectedSlug: requestedSlug || undefined,
      signal: controller.signal,
    });
    if (id !== requestId) return;
    if (!value || !value.catalog || typeof value.catalog !== 'object')
      throw new Error('The service did not return a valid demo catalog.');
    catalog = Object.fromEntries(
      Object.entries(value.catalog)
        .filter(([name, demo]) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && demo && typeof demo === 'object')
        .map(([name, demo]) => [name, { ...demo, slug: name }]),
    );
    if (requestedSlug && (!catalog[requestedSlug] || (value.selected && value.selected !== requestedSlug)))
      throw new Error('This demo is unavailable. Select another demo or contact the owner.');
    state = value;
    loadedSlug = requestedSlug;
    ready = Boolean(requestedSlug);
    notify(message);
  } catch (error) {
    if (id !== requestId || error.name === 'AbortError') return;
    ready = false;
    notify(`Could not load the workspace: ${error.message} Use Refresh to try again.`, 'error');
  } finally {
    if (id === requestId) {
      loading = false;
      render();
    }
  }
}
function renderReview() {
  $('reviewSection').hidden = false;
  $('diffRows').replaceChildren();
  $('diffSummary').replaceChildren();
  $('reviewContext').textContent =
    `${demoTitle(selectedDemo())} · Baseline ${review.base} · ${review.files.length} imported files`;
  for (const kind of ['added', 'replaced', 'reused', 'removed']) {
    const count = review.changes.filter((change) => change.kind === kind).length;
    const chip = element('span', `${kindNames[kind]} ${count}`, 'diff-count');
    chip.dataset.kind = kind;
    $('diffSummary').append(chip);
  }
  for (const change of review.changes) {
    const row = element('tr');
    row.dataset.kind = change.kind;
    row.append(
      element('td', kindNames[change.kind] || change.kind),
      element('td', change.path),
      element('td', change.kind === 'removed' ? bytes(change.before?.size) : bytes(change.after?.size)),
    );
    $('diffRows').append(row);
  }
  const changed = review.changes.filter((change) => change.kind !== 'reused');
  const uploadSize = changed
    .filter((change) => change.after)
    .reduce((sum, change) => sum + change.after.size, 0);
  $('reviewBytes').textContent = changed.length
    ? `${changed.length} changes · ${bytes(uploadSize)} in changed files. Existing content will be reused.`
    : 'All files match the current version. This Preview update will reuse them.';
  $('importState').textContent = changed.length ? 'Ready to confirm' : 'Content unchanged';
}
async function preparePackage(resolveInputs) {
  if (!canImport() || preparing) return;
  invalidateReview();
  const id = ++importId,
    capturedSlug = slug,
    capturedRevision = revision,
    base = currentBase(),
    demo = selectedDemo(),
    baseline = state.files || {};
  preparing = true;
  $('importState').textContent = 'Checking files';
  updateControls();
  notify('Reading files and checking page dependencies…', 'loading');
  try {
    const inputs = await resolveInputs();
    if (id !== importId || capturedSlug !== slug || capturedRevision !== revision) return;
    if (inputs.some((input) => /\.zip$/i.test(input.path)) && inputs.length !== 1)
      throw new Error('Select a ZIP on its own, or choose a complete folder.');
    const imported = await importPackage(inputs, demo, baseline);
    if (id !== importId || capturedSlug !== slug || capturedRevision !== revision || !ready) return;
    const changes = planChanges(baseline, imported.files, imported.remove);
    review = { ...imported, changes, slug: capturedSlug, base, revision: capturedRevision };
    renderReview();
    notify('Files checked. Review the changes, then select Update Preview.');
  } catch (error) {
    if (id !== importId || capturedSlug !== slug || capturedRevision !== revision) return;
    review = null;
    $('importState').textContent = 'Import incomplete';
    notify(`Could not import: ${error.message}`, 'error');
  } finally {
    if (id === importId) {
      preparing = false;
      updateControls();
    }
  }
}
function pickerInputs(files) {
  return Array.from(files, (file) => ({ path: file.webkitRelativePath || file.name, blob: file }));
}
function suggestedAddress(name) {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 100)
    .replace(/^-|-$/g, '');
}
$('newDemoTitle').addEventListener('input', () => {
  if (!customAddress) $('newDemoSlug').value = suggestedAddress($('newDemoTitle').value);
  $('newDemoSlug').setCustomValidity('');
});
$('newDemoSlug').addEventListener('input', () => {
  customAddress = Boolean($('newDemoSlug').value);
  $('newDemoSlug').setCustomValidity('');
});
let newSelectionId = 0;
function selectNewPackage(inputs) {
  if (!inputs.length) {
    newInputs = [];
    $('newDemoSelection').textContent = 'No package selected';
    updateControls();
    return;
  }
  const zipped = inputs.length === 1 && /\.zip$/i.test(inputs[0].path);
  if (!zipped && !inputs.every((file) => file.path.includes('/'))) {
    selectNewPackage([]);
    notify('Choose one ZIP or a complete folder.', 'error');
    return;
  }
  newInputs = inputs;
  $('newDemoSelection').textContent = zipped
    ? inputs[0].path
    : inputs[0].path.split('/')[0] + ' · ' + counted(inputs.length, 'file');
  $('newDemoProgress').hidden = true;
  notify();
  updateControls();
}
for (const [picker, other] of [
  ['newDemoZip', 'newDemoFolder'],
  ['newDemoFolder', 'newDemoZip'],
]) {
  $(picker).addEventListener('change', () => {
    if (!$(picker).files.length) return;
    $(other).value = '';
    newSelectionId++;
    selectNewPackage(pickerInputs($(picker).files));
  });
}
$('newDemoForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!isOwner() || locked() || !newInputs.length) return;
  const details = {
    title: $('newDemoTitle').value.trim(),
    slug: $('newDemoSlug').value.trim(),
    departmentId: $('newDemoCategory').value,
  };
  const address = $('newDemoSlug');
  if (Object.hasOwn(catalog, details.slug)) {
    address.setCustomValidity(
      'This demo address is already in use. Choose another address or open Update a Preview for the existing demo.',
    );
    address.reportValidity();
    return;
  }
  const progress = $('newDemoProgress');
  uploading = true;
  updateControls();
  progress.hidden = false;
  progress.textContent = 'Checking the three pages and their files…';
  notify();
  try {
    const demo = newDemoDescriptor(details);
    const { production, files } = await deskRequest('new-demo-state');
    const pkg = await importPackage(newInputs, demo, files, { registration: details });
    const { submitPackage } = await import('./upload.mjs');
    const head = await submitPackage({
      ...pkg,
      slug: demo.slug,
      base: production,
      onProgress(p) {
        progress.textContent =
          p.message + (p.neededBytes ? ' · ' + bytes(p.uploadedBytes) + ' / ' + bytes(p.neededBytes) : '');
      },
    });
    if (head?.slug !== demo.slug || !roles.every((role) => head.pages?.[role]))
      throw new Error('The service did not return all three Preview links. Refresh the overview.');
    $('newDemoForm').reset();
    newInputs = [];
    customAddress = false;
    $('newDemoSelection').textContent = 'No package selected';
    $('demoSearch').value = '';
    $('demoSort').value = 'unchecked';
    releaseState = null;
    uploading = false;
    await openView('overview');
    if (state?.latest?.[demo.slug]?.id === head.id)
      notify(demo.title + ' is ready. Open its three Preview pages below.');
    else notify(demo.title + ' was created. Refresh the overview to see all three pages.', 'info', head);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    uploading = false;
    progress.hidden = true;
    updateControls();
  }
});
function readDirectory(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}
async function walkEntry(entry, prefix = '') {
  const path = prefix + entry.name;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ path, blob: file }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader(),
    children = [];
  while (true) {
    const batch = await readDirectory(reader);
    if (!batch.length) break;
    children.push(...batch);
  }
  const result = [];
  for (const child of children) result.push(...(await walkEntry(child, path + '/')));
  return result;
}
async function confirmPackage() {
  if (!canImport() || !validReview() || preparing || uploading) return;
  const captured = review;
  if (!captured.files.length && !captured.remove.length) return;
  uploading = true;
  updateControls();
  $('uploadRegion').hidden = false;
  $('uploadProgress').value = 0;
  $('uploadMessage').textContent = 'Preparing upload';
  $('uploadBytes').textContent = '';
  notify('Updating Preview. Keep this page open.', 'loading');
  try {
    const { submitPackage } = await import('./upload.mjs');
    const version = await submitPackage({
      slug: captured.slug,
      base: captured.base,
      files: captured.files,
      remove: captured.remove,
      onProgress(progress) {
        if (!uploading || captured.slug !== slug) return;
        $('uploadMessage').textContent = progress.message || 'Uploading';
        const uploaded = Math.max(0, Number(progress.uploadedBytes) || 0),
          needed = Math.max(0, Number(progress.neededBytes) || 0);
        $('uploadProgress').value = needed ? Math.min(100, (uploaded / needed) * 100) : 0;
        $('uploadBytes').textContent = `${bytes(uploaded)} / ${bytes(needed)}`;
      },
    });
    if (!version || !version.id || (version.slug && version.slug !== captured.slug))
      throw new Error('The service did not return a valid preview. Refresh to check its status.');
    if (slug !== captured.slug || revision !== captured.revision) return;
    const files = { ...(state.files || {}) };
    for (const file of captured.files) files[file.path] = { sha1: file.sha1, size: file.size };
    for (const path of captured.remove) delete files[path];
    state = {
      ...state,
      files,
      latest: { ...(state.latest || {}), [captured.slug]: version },
      reviewVersions: { ...(state.reviewVersions || {}), [captured.slug]: version.id },
      checklist: { ...(state.checklist || {}) },
    };
    delete state.checklist[captured.slug];
    uploading = false;
    releaseState = null;
    invalidateReview();
    render();
    notify('Preview updated. Its links are available in Demo overview.', 'info', version);
    $('uploadProgress').value = 100;
  } catch (error) {
    ready = false;
    invalidateReview();
    notify(`Could not confirm the Preview update. ${error.message} Refresh before trying again.`, 'error');
  } finally {
    uploading = false;
    updateControls();
  }
}
async function saveGrant(email, slugs) {
  if (!isOwner() || locked() || loading) return;
  granting = true;
  updateControls();
  notify('Saving member permissions…', 'loading');
  try {
    await deskRequest('grant', { method: 'POST', body: { email: email.trim(), slugs } });
    granting = false;
    $('grantEmail').value = '';
    for (const checkbox of $('grantChoices').querySelectorAll('input')) checkbox.checked = false;
    updateGrantSelection();
    await loadState(slug, {
      message: slugs.length
        ? 'Member permissions saved.'
        : 'All upload permissions for this email were revoked.',
    });
  } catch (error) {
    notify(`Could not save permissions: ${error.message}`, 'error');
  } finally {
    granting = false;
    updateControls();
  }
}
$('demoSelect').addEventListener('change', () => {
  loadState($('demoSelect').value);
  writeRoute();
});
$('refreshState').addEventListener('click', async () => {
  if (releaseViews.has(view)) {
    if (!state) await loadState('');
    if (isOwner()) return loadRelease(releaseSlug);
    return;
  }
  await loadState(view === 'upload' ? slug : '');
});
$('demoSearch').addEventListener('input', renderOverview);
$('demoSort').addEventListener('change', renderOverview);
$('selectAllGrants').addEventListener('click', () => selectGrants(true));
$('clearGrantSelection').addEventListener('click', () => selectGrants(false));
$('menuToggle').addEventListener('click', () =>
  toggleMenu($('menuToggle').getAttribute('aria-expanded') !== 'true'),
);
$('menuToggle')
  .closest('aside')
  .addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('menuToggle').getAttribute('aria-expanded') === 'true') {
      toggleMenu(false);
      $('menuToggle').focus();
    }
  });
for (const [name, anchor] of navigation) {
  anchor.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openView(name);
  });
}
window.addEventListener('popstate', () => {
  if (locked()) return writeRoute('replaceState', view === 'receipts' ? revealedReceiptHash : '');
  const route = readRoute();
  openView(route.view, { method: 'replaceState', receipt: route.receipt, selectedSlug: route.slug });
});
$('packageInput').addEventListener('change', (event) => {
  const inputs = pickerInputs(event.target.files);
  if (inputs.length) preparePackage(() => Promise.resolve(inputs));
});
$('folderInput').addEventListener('change', (event) => {
  const inputs = pickerInputs(event.target.files);
  if (inputs.length) preparePackage(() => Promise.resolve(inputs));
});
$('clearReview').addEventListener('click', () => {
  invalidateReview();
  notify('Import cleared. You can select other files.');
});
$('confirmUpload').addEventListener('click', confirmPackage);
$('grantForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const email = $('grantEmail');
  if (!email.validity.valid) {
    notify('Enter a valid member email address.', 'error');
    email.focus();
    return;
  }
  saveGrant(
    $('grantEmail').value,
    Array.from($('grantChoices').querySelectorAll('input:checked'), (input) => input.value),
  );
});
function bindDropZone(dropZone, enabled, onFiles) {
  let dragDepth = 0;
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (enabled()) {
      dragDepth += 1;
      dropZone.classList.add('is-dragging');
    }
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = enabled() ? 'copy' : 'none';
  });
  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('is-dragging');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('is-dragging');
    if (!enabled()) return;
    const items = Array.from(event.dataTransfer?.items || []),
      fallback = pickerInputs(event.dataTransfer?.files || []);
    const entries = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.webkitGetAsEntry?.())
      .filter(Boolean);
    onFiles(async () => {
      if (!entries.length) return fallback;
      const result = [];
      for (const entry of entries) result.push(...(await walkEntry(entry)));
      return result;
    });
  });
}
bindDropZone($('dropZone'), () => canImport() && !preparing, preparePackage);
bindDropZone(
  $('newDemoDrop'),
  () => view === 'new' && isOwner() && !locked() && !loading,
  async (getFiles) => {
    const selected = ++newSelectionId;
    selectNewPackage([]);
    try {
      const inputs = await getFiles();
      if (selected !== newSelectionId || locked() || view !== 'new') return;
      $('newDemoZip').value = '';
      $('newDemoFolder').value = '';
      selectNewPackage(inputs);
    } catch (error) {
      if (selected === newSelectionId && view === 'new')
        notify('Could not read this package. ' + error.message, 'error');
    }
  },
);
for (const type of ['dragover', 'drop'])
  window.addEventListener(type, (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
// Release state is isolated from normal preview files, grants, and checklist state.
let releaseState = null,
  releaseSlug = '',
  releaseDraft = null,
  releaseRequest = 0,
  releaseLoading = false;
const releaseStorageKey = 'gym-production-release-operation-v1';
let savedRelease = null;
try {
  savedRelease = JSON.parse(localStorage.getItem(releaseStorageKey) || 'null');
} catch {}
function rememberRelease(job) {
  savedRelease = job;
  try {
    if (job) localStorage.setItem(releaseStorageKey, JSON.stringify(job));
    else localStorage.removeItem(releaseStorageKey);
  } catch {}
}
function releaseNotice(message = '', error = false) {
  $('releaseNotice').textContent = message;
  $('releaseNotice').hidden = !message;
  $('releaseNotice').dataset.tone = error ? 'error' : 'info';
  $('releaseNotice').setAttribute('role', error ? 'alert' : 'status');
}
function releaseControls() {
  const disabled =
    releaseBusy || releaseLoading || !isOwner() || !releaseState?.available || Boolean(releaseState.pending);
  $('releaseDemo').disabled = disabled;
  for (const id of ['releasePackageInput', 'releaseFolderInput']) $(id).disabled = disabled || !releaseSlug;
  updateReviewedControls();
  $('directRelease').disabled = disabled || !releaseDraft || releaseDraft.slug !== releaseSlug;
  $('rollbackTarget').disabled = disabled || !rollbackVersions().length;
  $('restoreRelease').disabled = disabled || !rollbackSelection();
  updateControls();
}
const reviewedDrafts = new Map();
const reviewedStorageKey = 'gym-production-reviewed-selection-v1';
try {
  const saved = JSON.parse(sessionStorage.getItem(reviewedStorageKey) || '[]');
  for (const [name, draft] of saved) reviewedDrafts.set(name, { ...draft, loading: false, request: 0 });
} catch {}
function saveReviewedDrafts() {
  try {
    sessionStorage.setItem(
      reviewedStorageKey,
      JSON.stringify(
        [...reviewedDrafts].map(([name, draft]) => [
          name,
          {
            checked: draft.checked,
            head: draft.head,
            url: draft.url,
            resolvedUrl: draft.resolvedUrl,
            source: draft.source,
          },
        ]),
      ),
    );
  } catch {}
}
function reviewHead(name) {
  return releaseState?.reviewPreviews?.[name] || releaseState?.previews?.[name] || null;
}
function reviewedDraft(name) {
  if (!reviewedDrafts.has(name))
    reviewedDrafts.set(name, {
      checked: false,
      head: reviewHead(name),
      url: '',
      resolvedUrl: '',
      source: 'review',
      loading: false,
      error: '',
      request: 0,
    });
  const draft = reviewedDrafts.get(name);
  if (!draft.checked && draft.source === 'review' && !draft.url) draft.head = reviewHead(name);
  return draft;
}
function checkedReviewedDrafts() {
  return [...reviewedDrafts].filter(([name, draft]) => draft.checked && releaseState?.catalog?.[name]);
}
function reviewedSelection() {
  const checked = checkedReviewedDrafts();
  if (
    !checked.length ||
    checked.some(
      ([, draft]) =>
        !draft.head?.id || draft.loading || draft.error || draft.url.trim() !== draft.resolvedUrl,
    )
  )
    return null;
  return Object.fromEntries(checked.map(([name, draft]) => [name, draft.head.id]));
}
function updateReviewedControls() {
  const checked = checkedReviewedDrafts();
  const unresolved = checked.filter(
    ([, draft]) => !draft.head?.id || draft.loading || draft.error || draft.url.trim() !== draft.resolvedUrl,
  ).length;
  $('reviewedSelectionCount').textContent =
    `${counted(checked.length, 'demo')} selected${unresolved ? ' · ' + counted(unresolved, 'version') + ' unresolved' : ''}`;
  $('promoteRelease').disabled =
    releaseBusy ||
    releaseLoading ||
    !isOwner() ||
    !releaseState?.available ||
    Boolean(releaseState.pending) ||
    !reviewedSelection();
  for (const input of $('reviewedSelections').querySelectorAll('input,button'))
    input.disabled = releaseBusy || releaseLoading || !isOwner();
}
function chooseReviewedHead(name, head, source) {
  if (!head?.id || releaseBusy || releaseLoading) return;
  const draft = reviewedDraft(name);
  draft.request += 1;
  draft.loading = false;
  draft.head = head;
  draft.source = source;
  draft.url = '';
  draft.resolvedUrl = '';
  draft.error = '';
  saveReviewedDrafts();
  renderReviewedSelections();
}
async function loadReviewedRow(name) {
  if (!isOwner() || releaseBusy || releaseLoading) return;
  const draft = reviewedDraft(name),
    url = draft.url.trim();
  if (!url) {
    draft.error = 'Enter a fixed Preview URL first.';
    renderReviewedSelections();
    return;
  }
  const request = ++draft.request;
  draft.loading = true;
  draft.error = '';
  renderReviewedSelections();
  try {
    const params = new URLSearchParams({ action: 'production-preview', slug: name, preview: url });
    const response = await fetch('/.netlify/functions/desk?' + params, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
    if (request !== draft.request || draft.url.trim() !== url) return;
    if (!value.preview?.id || value.preview.slug !== name)
      throw new Error('The service returned a Preview for a different demo.');
    draft.head = value.preview;
    draft.resolvedUrl = url;
    draft.source = 'custom';
    draft.error = '';
  } catch (error) {
    if (request === draft.request && draft.url.trim() === url)
      draft.error = `Could not load this version: ${error.message}`;
  } finally {
    if (request === draft.request) {
      draft.loading = false;
      saveReviewedDrafts();
      renderReviewedSelections();
    }
  }
}
function renderReviewedSelections() {
  const container = $('reviewedSelections');
  const active = document.activeElement;
  const focusKey = active?.dataset?.reviewControl;
  const selectionStart = active?.selectionStart,
    selectionEnd = active?.selectionEnd;
  let restoreFocus = null;
  const rememberFocus = (node, key) => {
    node.dataset.reviewControl = key;
    if (focusKey === key) restoreFocus = node;
  };
  container.replaceChildren();
  const query = $('reviewedSearch').value.trim().toLowerCase();
  const demos = Object.entries(releaseState?.catalog || {}).sort((a, b) =>
    demoTitle(a[1]).localeCompare(demoTitle(b[1]), 'en'),
  );
  let shown = 0;
  for (const [name, demo] of demos) {
    const draft = reviewedDraft(name);
    if (!(demoTitle(demo) + ' ' + name).toLowerCase().includes(query)) continue;
    shown += 1;
    const row = element('div', undefined, 'reviewed-row');
    row.dataset.selected = String(draft.checked);
    const label = element('label', undefined, 'reviewed-check');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = draft.checked;
    rememberFocus(checkbox, 'check:' + name);
    checkbox.setAttribute('aria-label', `Publish reviewed Preview: ${demoTitle(demo)} (${name})`);
    checkbox.addEventListener('change', () => {
      draft.checked = checkbox.checked;
      saveReviewedDrafts();
      renderReviewedSelections();
    });
    const title = element('span');
    title.append(element('span', demoTitle(demo), 'demo-name'), element('span', name, 'demo-slug'));
    label.append(checkbox, title);
    row.append(label);
    const version = element('div', undefined, 'reviewed-row-version');
    if (draft.head?.id) releasePageLinks(version, draft.head, `${demoTitle(demo)} fixed reviewed Preview`);
    else version.append(element('span', 'No Preview available', 'subtle'));
    const sourceButtons = element('div', undefined, 'reviewed-sources');
    const realHead = reviewHead(name),
      effective = releaseState?.previews?.[name];
    if (realHead?.id && (draft.head?.id !== realHead.id || draft.url)) {
      const reset = element('button', 'Use latest reviewed Preview', 'button quiet');
      reset.type = 'button';
      rememberFocus(reset, 'review:' + name);
      reset.addEventListener('click', () => chooseReviewedHead(name, realHead, 'review'));
      sourceButtons.append(reset);
    }
    if (effective?.id && effective.id !== realHead?.id && effective.id !== draft.head?.id) {
      const synced = element('button', 'Use synced Preview', 'button quiet');
      synced.type = 'button';
      rememberFocus(synced, 'private:' + name);
      synced.addEventListener('click', () => chooseReviewedHead(name, effective, 'private'));
      sourceButtons.append(synced);
    }
    row.append(version);
    const custom = element('details', undefined, 'reviewed-custom');
    custom.hidden = !draft.checked;
    custom.open = Boolean(draft.optionsOpen ?? (draft.url || draft.source === 'custom'));
    custom.addEventListener('toggle', () => {
      if (custom.isConnected) draft.optionsOpen = custom.open;
    });
    const summary = element('summary', 'Version options');
    rememberFocus(summary, 'options:' + name);
    custom.append(summary);
    if (draft.head?.id) custom.append(element('p', 'Selected version · ' + draft.head.id, 'receipt-id'));
    custom.append(sourceButtons);
    const urlLabel = element('label', 'Earlier fixed Preview URL');
    urlLabel.htmlFor = 'reviewed-url-' + name;
    const input = element('input');
    input.id = 'reviewed-url-' + name;
    input.type = 'text';
    input.inputMode = 'url';
    input.value = draft.url;
    input.autocomplete = 'off';
    rememberFocus(input, 'url:' + name);
    input.setAttribute('aria-label', `Fixed Preview URL for ${demoTitle(demo)} (${name})`);
    const status = element(
      'p',
      draft.loading
        ? 'Loading this version…'
        : draft.error || (draft.url.trim() !== draft.resolvedUrl ? 'Load this URL before publishing.' : ''),
      'reviewed-row-status',
    );
    status.id = 'reviewed-status-' + name;
    status.setAttribute('role', draft.error ? 'alert' : 'status');
    input.setAttribute('aria-describedby', status.id);
    input.setAttribute('aria-invalid', String(Boolean(draft.error)));
    row.setAttribute('aria-busy', String(draft.loading));
    input.addEventListener('input', () => {
      draft.url = input.value;
      draft.request += 1;
      draft.loading = false;
      draft.error = '';
      input.setAttribute('aria-invalid', 'false');
      status.textContent = draft.url.trim() !== draft.resolvedUrl ? 'Load this URL before publishing.' : '';
      saveReviewedDrafts();
      updateReviewedControls();
    });
    const load = element('button', 'Load version', 'button secondary');
    load.type = 'button';
    rememberFocus(load, 'load:' + name);
    load.setAttribute('aria-label', `Load fixed Preview version for ${demoTitle(demo)}`);
    load.addEventListener('click', () => loadReviewedRow(name));
    const urlRow = element('div', undefined, 'release-url-row');
    urlRow.append(input, load);
    custom.append(urlLabel, urlRow, status);
    row.append(custom);
    container.append(row);
  }
  if (!shown)
    container.append(
      element('p', query ? 'No demos match your search.' : 'No Previews available.', 'empty-note'),
    );
  updateReviewedControls();
  if (restoreFocus) {
    restoreFocus.focus({ preventScroll: true });
    if (selectionStart != null && typeof restoreFocus.setSelectionRange === 'function')
      restoreFocus.setSelectionRange(selectionStart, selectionEnd);
  }
}
function renderReviewedReceipt(item, receipt) {
  const table = element('table', undefined, 'reviewed-receipt-table');
  const header = element('thead'),
    heading = element('tr');
  for (const title of ['Demo', 'Fixed reviewed source', 'Released result']) {
    const th = element('th', title);
    th.scope = 'col';
    heading.append(th);
  }
  header.append(heading);
  table.append(header);
  const body = element('tbody');
  for (const [name, id] of Object.entries(receipt.sourceVersions)) {
    const row = element('tr'),
      title = element('th', releaseDemoNames([name]));
    title.scope = 'row';
    const source = element('td'),
      result = element('td');
    source.dataset.label = 'Reviewed source';
    result.dataset.label = 'Released result';
    source.append(element('p', id, 'receipt-id'));
    releasePageLinks(
      source,
      receipt.sourcePreviews?.[name],
      `${releaseDemoNames([name])} fixed reviewed source`,
    );
    const pages =
      receipt.production?.demoPages?.[name] ||
      ((receipt.slugs || []).length === 1 ? receipt.production?.pages : null);
    if (pages) releasePageLinks(result, { pages }, `${releaseDemoNames([name])} released result`);
    else result.append(element('span', 'Result links unavailable', 'subtle'));
    row.append(title, source, result);
    body.append(row);
  }
  table.append(body);
  item.append(table);
}
function releasePageLinks(container, head, description = 'release result') {
  const group = element('div', undefined, 'page-links');
  for (const role of roles) {
    const anchor = link(roleNames[role], head?.pages?.[role]);
    if (anchor) {
      anchor.setAttribute('aria-label', `${roleNames[role]} ${description} (opens in a new tab)`);
      group.append(anchor);
    }
  }
  container.append(group);
}
let revealedReceiptHash = '';
function renderReceipts() {
  const list = $('releaseReceipts');
  const openIds = new Set(
    [...list.querySelectorAll('details.receipt-disclosure[open]')].map((node) => node.parentElement.id),
  );
  list.replaceChildren();
  const receipts = [...(releaseState?.receipts || [])].sort(
    (a, b) => dateValue(b.created) - dateValue(a.created),
  );
  if (!receipts.length)
    list.append(element('p', 'No Production releases since this desk was connected.', 'empty-note'));
  const archive = releaseState?.archive || [];
  const archived = new Set(archive.map((receipt) => receipt.id));
  const archiveSection = element('details', undefined, 'receipt-disclosure');
  archiveSection.append(element('summary', 'Private rehearsal archive (' + archive.length + ')'));
  archiveSection.open = archive.some((receipt) => location.hash === '#receipt-' + receipt.id);
  if (archive.length) list.append(archiveSection);
  if (releaseState?.pending) {
    const retry = element('button', 'Check pending Production operation', 'button secondary');
    retry.addEventListener('click', async () => {
      const id = releaseState.pending;
      await completeRelease(async () => {
        const { resumeRelease } = await import('./upload.mjs');
        return resumeRelease(id, releaseProgress, { retry: true });
      });
    });
    list.prepend(retry);
  }
  let anchorTarget = null;
  for (const receipt of [...receipts, ...archive]) {
    const article = element('article', undefined, 'release-receipt');
    article.id = 'receipt-' + receipt.id;
    const details = element('details', undefined, 'receipt-disclosure');
    const summary = element('summary', undefined, 'receipt-summary');
    const heading = element('span', undefined, 'receipt-heading');
    const action = receipt.rollback
      ? receipt.rollback.scope === 'site'
        ? 'Whole site restored'
        : 'Demo restored'
      : receipt.mode === 'direct'
        ? 'Files published and Preview synced'
        : receipt.mode === 'preview'
          ? 'Preview created'
          : 'Reviewed ' +
            (Object.keys(receipt.sourceVersions || {}).length > 1
              ? 'Previews published'
              : 'Preview published');
    heading.append(
      element('strong', action),
      element('span', releaseDemoNames(receipt.slugs || []), 'subtle'),
    );
    summary.append(heading, element('span', dateLabel(receipt.created), 'receipt-date'));
    const item = element('div', undefined, 'receipt-body');
    if (location.hash === '#' + article.id) anchorTarget = article;
    details.open = openIds.has(article.id) || article === anchorTarget;
    details.append(summary, item);
    article.append(details);
    item.append(
      element(
        'p',
        receipt.channel === 'cli'
          ? 'Submitted from the command line'
          : `Submitted in the browser · ${bytes(receipt.incomingBytes ?? 0)} uploaded`,
        'receipt-id',
      ),
    );
    item.append(
      element(
        'p',
        `Operation: ${receipt.id}${receipt.production?.id ? ' · Deployment: ' + receipt.production.id : ''}`,
        'receipt-id',
      ),
    );
    const receiptLink = element('a', 'Link to this receipt', 'receipt-id');
    receiptLink.href = location.pathname + '?view=receipts#' + encodeURIComponent(article.id);
    item.append(receiptLink);
    if (receipt.mode === 'promote' && receipt.sourceVersions) renderReviewedReceipt(item, receipt);
    if (receipt.fileChanges)
      item.append(
        element(
          'p',
          `File changes: ${receipt.fileChanges.added} added · ${receipt.fileChanges.replaced} replaced · ${receipt.fileChanges.removed} removed`,
          'subtle',
        ),
      );
    if (receipt.rollback) {
      const rollback = receipt.rollback;
      const affected = rollback.affectedSlugs || receipt.slugs || [];
      item.append(
        element(
          'p',
          `${counted(rollback.changedFiles, 'file')} restored · Affected demos: ${releaseDemoNames(affected)}`,
          'rollback-summary',
        ),
      );
      item.append(
        element(
          'p',
          `Restored from ${rollback.fromRevision} to retained version ${rollback.targetRevision}`,
          'receipt-id',
        ),
      );
      item.append(
        element(
          'p',
          rollback.syncedSlugs?.length
            ? `Tracking previews synced: ${releaseDemoNames(rollback.syncedSlugs)}`
            : 'No pending preview copies were changed.',
          'subtle',
        ),
      );
      if (rollback.scope === 'demo') {
        for (const name of rollback.preservedSlugs || []) {
          const preserved = element('section', undefined, 'rollback-preserved');
          preserved.append(element('h5', 'Later update kept · ' + releaseDemoNames([name])));
          preserved.append(element('p', name, 'receipt-id'));
          if (rollback.preservedPages?.[name])
            releasePageLinks(preserved, { pages: rollback.preservedPages[name] });
          item.append(preserved);
        }
        const unchanged = Object.keys(releaseState.catalog || {}).filter((name) => !affected.includes(name));
        if (unchanged.length) {
          const detail = element('details', undefined, 'unchanged-demos');
          detail.append(
            element('summary', `Unchanged demos (${unchanged.length})`),
            element('p', releaseDemoNames(unchanged), 'subtle'),
          );
          item.append(detail);
        }
      }
    }
    for (const [name, head] of [
      [archived.has(receipt.id) ? 'Rehearsal result' : 'Public Production', receipt.production],
      [
        receipt.rollback
          ? 'Synced tracking Preview'
          : receipt.mode === 'direct'
            ? 'Synced Preview'
            : 'Reviewed Preview',
        receipt.preview,
      ],
    ]) {
      if (!head) continue;
      const section = element('section', undefined, 'release-result');
      section.append(element('h5', name));
      if (receipt.mode === 'promote' && receipt.sourceVersions && head === receipt.production) {
        // Per-demo result links are shown alongside the frozen source versions above.
      } else if (head.demoPages && Object.keys(head.demoPages).length) {
        for (const [slug, pages] of Object.entries(head.demoPages)) {
          const demo = element('div', undefined, 'receipt-demo');
          demo.append(element('h6', releaseDemoNames([slug])));
          releasePageLinks(demo, { pages });
          section.append(demo);
        }
      } else releasePageLinks(section, head);
      const log = Array.isArray(head.uploadLog) ? head.uploadLog : null;
      const mp4 = log?.filter((file) => /\.mp4$/i.test(file.path || ''));
      section.append(
        element(
          'p',
          [
            head.files == null ? '' : counted(head.files, 'file') + ' in result',
            log ? counted(log.length, 'file upload') : '',
            bytes(head.uploadedBytes ?? 0) + ' uploaded',
          ]
            .filter(Boolean)
            .join(' · '),
          'subtle',
        ),
      );
      if (mp4)
        section.append(
          element(
            'p',
            `${counted(mp4.length, 'MP4 upload')} · ${bytes(mp4.reduce((sum, file) => sum + (Number(file.size) || 0), 0))}`,
            'subtle',
          ),
        );
      if (log?.length) {
        const detail = element('details'),
          summary = element('summary', 'View transported files'),
          files = element('ul');
        for (const file of log) files.append(element('li', `${file.path} · ${bytes(file.size)}`));
        detail.append(summary, files);
        section.append(detail);
      }
      item.append(section);
    }
    if (archived.has(receipt.id)) archiveSection.append(article);
    else if (archive.length) list.insertBefore(article, archiveSection);
    else list.append(article);
  }
  if (view === 'receipts' && anchorTarget && revealedReceiptHash !== location.hash) {
    revealedReceiptHash = location.hash;
    anchorTarget.tabIndex = -1;
    anchorTarget.scrollIntoView({ block: 'start' });
    anchorTarget.focus({ preventScroll: true });
  }
}
function renderRelease() {
  $('privateScope').textContent = releaseState?.serving
    ? 'Public Production · aisigym.netlify.app · ' + releaseState.serving.slice(-8)
    : 'Public Production · aisigym.netlify.app';
  const picker = $('releaseDemo');
  picker.replaceChildren(element('option', 'Select a demo'));
  picker.firstChild.value = '';
  for (const [name, demo] of Object.entries(releaseState?.catalog || {}).sort((a, b) =>
    demoTitle(a[1]).localeCompare(demoTitle(b[1]), 'en'),
  )) {
    const option = element('option', demoTitle(demo));
    option.value = name;
    picker.append(option);
  }
  picker.value = releaseSlug;
  if (view === 'publish') renderReviewedSelections();
  if (view === 'restore-demo' || view === 'restore-site') renderRollback();
  if (view === 'receipts') renderReceipts();
  releaseControls();
}
async function loadRelease(name = releaseSlug, preview = '') {
  if (!isOwner() || releaseBusy) return;
  const request = ++releaseRequest;
  releaseSlug = name;
  releaseLoading = true;
  releaseDraft = null;
  $('releaseDiff').hidden = true;
  $('releasePackageInput').value = '';
  $('releaseFolderInput').value = '';
  releaseControls();
  releaseNotice('Loading Production releases…');
  try {
    const query = new URLSearchParams({ action: 'production-state' });
    if (view === 'receipts') query.set('history', '1');
    if (name) query.set('slug', name);
    if (preview) query.set('preview', preview);
    if (location.hash?.startsWith('#receipt-')) query.set('receipt', location.hash.slice('#receipt-'.length));
    const response = await fetch('/.netlify/functions/desk?' + query, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
    if (request !== releaseRequest) return;
    if (!value.catalog || !value.revision || value.target !== 'production')
      throw new Error('The service returned incomplete Production release state.');
    releaseState = value;
    releaseSlug = name && value.selected === name ? name : '';
    releaseNotice(
      value.pending
        ? 'A Production operation is in progress. Open Release receipts for its status.'
        : !value.available
          ? 'The active public deployment or publishing settings changed. Refresh before publishing.'
          : '',
      !value.available && !value.pending,
    );
    renderRelease();
    if (savedRelease?.id && releaseViews.has(view)) {
      if (savedRelease.phase === 'processing') resumeSavedRelease();
      else
        releaseNotice(
          `Operation ${savedRelease.id} was interrupted while sending files. Select the package again to start a new operation.`,
          true,
        );
    }
  } catch (error) {
    if (request === releaseRequest) {
      releaseState = null;
      renderRelease();
      releaseNotice(`Could not load Production releases: ${error.message}`, true);
    }
  } finally {
    if (request === releaseRequest) {
      releaseLoading = false;
      releaseControls();
    }
  }
}
async function prepareRelease(files) {
  if (
    view !== 'files' ||
    !isOwner() ||
    releaseBusy ||
    releaseLoading ||
    !releaseState?.catalog?.[releaseSlug]
  )
    return;
  const request = ++releaseRequest,
    name = releaseSlug,
    revision = releaseState.revision;
  releaseLoading = true;
  releaseDraft = null;
  releaseControls();
  releaseNotice('Checking release files and dependencies…');
  try {
    const inputs = pickerInputs(files);
    if (inputs.some((file) => /\.zip$/i.test(file.path)) && inputs.length !== 1)
      throw new Error('Select one ZIP on its own, or choose a complete folder.');
    const imported = await importPackage(inputs, releaseState.catalog[name], releaseState.files || {});
    if (request !== releaseRequest || name !== releaseSlug || revision !== releaseState.revision) return;
    releaseDraft = { ...imported, slug: name, revision };
    const changes = planChanges(releaseState.files || {}, imported.files, imported.remove);
    const box = $('releaseDiff');
    box.replaceChildren(element('h4', 'Review package changes'));
    box.append(
      element(
        'p',
        `${counted(imported.files.length, 'file')} in package · ${bytes(imported.files.reduce((sum, file) => sum + file.size, 0))}`,
        'subtle',
      ),
    );
    const detail = element('details'),
      summary = element(
        'summary',
        counted(changes.filter((change) => change.kind !== 'reused').length, 'file change'),
      ),
      list = element('ul');
    for (const change of changes)
      list.append(element('li', `${kindNames[change.kind] || change.kind} · ${change.path}`));
    detail.append(summary, list);
    box.append(detail);
    box.hidden = false;
    releaseNotice();
  } catch (error) {
    if (request === releaseRequest) releaseNotice(`Could not import release files: ${error.message}`, true);
  } finally {
    if (request === releaseRequest) {
      releaseLoading = false;
      releaseControls();
    }
  }
}
function releaseProgress(progress) {
  $('releaseProgressRegion').hidden = false;
  $('releaseProgressLabel').textContent = progress.message || 'Processing release…';
  if (progress.neededBytes !== undefined) {
    $('releaseProgress').value = progress.neededBytes
      ? Math.min(100, (100 * progress.uploadedBytes) / progress.neededBytes)
      : 0;
    $('releaseTransport').textContent =
      `Browser file requests: ${progress.fileRequests ?? 0} · ${bytes(progress.uploadedBytes ?? 0)} / ${bytes(progress.neededBytes)} confirmed`;
  }
}
async function completeRelease(task) {
  releaseBusy = true;
  releaseControls();
  releaseNotice('Preparing the release…');
  try {
    const receipt = await task();
    if (!receipt?.id)
      throw new Error(
        'The service did not return a completed operation receipt. Refresh to check its status.',
      );
    rememberRelease(null);
    if (receipt.mode === 'promote') {
      for (const [slug, id] of Object.entries(receipt.sourceVersions || {})) {
        if (reviewedDrafts.get(slug)?.head?.id === id) reviewedDrafts.delete(slug);
      }
      saveReviewedDrafts();
    }
    releaseBusy = false;
    view = 'receipts';
    writeRoute('pushState', '#receipt-' + receipt.id);
    renderView();
    await loadRelease(releaseSlug);
    if (releaseState && !(releaseState.receipts || []).some((item) => item.id === receipt.id)) {
      releaseState.receipts = [receipt, ...(releaseState.receipts || [])];
      renderReceipts();
    }
    $('releaseProgressRegion').hidden = true;
    $('releaseProgress').value = 100;
    $('releaseProgressLabel').textContent = 'Production release complete';
    if (view === 'receipts' && releaseState)
      releaseNotice('Production release completed. Your receipt is open below.');
  } catch (error) {
    releaseNotice(
      `Could not confirm the release: ${error.message} Use Refresh to check saved operations.`,
      true,
    );
  } finally {
    releaseBusy = false;
    releaseControls();
  }
}
function releaseDemoNames(names) {
  return names.map((name) => demoTitle(releaseState?.catalog?.[name] || { slug: name })).join(', ') || 'None';
}
function rollbackVersions() {
  if (view === 'restore-site') return releaseState?.rollback?.site || [];
  if (view === 'restore-demo' && releaseSlug) return releaseState?.rollback?.demo || [];
  return [];
}
function rollbackSelection() {
  return rollbackVersions().find((version) => version.revision === $('rollbackTarget').value) || null;
}
function renderRollback() {
  const picker = $('rollbackTarget');
  const context = [view, view === 'restore-demo' ? releaseSlug : '', releaseState?.revision].join('/');
  const retained = picker.dataset.context === context ? picker.value : '';
  picker.dataset.context = context;
  const versions = rollbackVersions();
  const prompt = element('option', versions.length ? 'Choose a version' : 'No versions available');
  prompt.value = '';
  picker.replaceChildren(prompt);
  for (const version of versions) {
    const option = element(
      'option',
      `${dateLabel(version.created)} · ${version.baseline ? 'Production baseline' : counted(version.changedFiles, 'file change')} · ${version.revision.slice(-6)}`,
    );
    option.value = version.revision;
    picker.append(option);
  }
  picker.value = versions.some((version) => version.revision === retained) ? retained : '';
  renderRollbackImpact();
}
function renderRollbackImpact() {
  const target = rollbackSelection();
  const wholeSite = view === 'restore-site';
  const box = $('rollbackImpact');
  box.replaceChildren();
  $('restoreRelease').textContent = wholeSite ? 'Restore whole public site' : 'Restore selected demo';
  if (!target)
    box.append(
      element(
        'p',
        !wholeSite && !releaseSlug
          ? 'Select a demo to see its earlier versions.'
          : rollbackVersions().length
            ? 'Choose a version to see which demos and files will change.'
            : 'No earlier version is available.',
        'subtle',
      ),
    );
  else {
    box.append(
      element(
        'p',
        `${counted(target.changedFiles, 'file change')} · Affected demos: ${releaseDemoNames(target.slugs || [])}`,
        'rollback-summary',
      ),
    );
    box.append(element('p', `Target revision: ${target.revision}`, 'receipt-id'));
  }
  releaseControls();
}
function rollbackBody() {
  const target = rollbackSelection();
  const wholeSite = view === 'restore-site';
  const selected = wholeSite ? releaseState?.selected : releaseSlug;
  if (!target || !selected || !releaseState?.revision) return null;
  return {
    mode: wholeSite ? 'rollback-site' : 'rollback-demo',
    slug: selected,
    revision: releaseState.revision,
    target: target.revision,
  };
}
async function restoreRelease() {
  if (!isOwner() || releaseBusy || releaseLoading) return;
  const body = rollbackBody();
  if (!body) return;
  const affected = rollbackSelection().slugs;
  if (!confirmProduction(body, affected)) return;
  $('releaseTransport').textContent = 'Browser file requests: 0 · 0 B sent';
  await completeRelease(async () => {
    const { submitRelease } = await import('./upload.mjs');
    return submitRelease({
      body,
      onProgress: releaseProgress,
      onJob(job) {
        rememberRelease(job);
        $('releaseOperation').textContent = `Operation ${job.id}`;
      },
    });
  });
}
function confirmProduction(body, slugs) {
  if (releaseState?.target !== 'production' || !releaseState.available || releaseState.pending) return false;
  const action = body.mode.startsWith('rollback') ? 'Restore' : 'Publish';
  const names = releaseDemoNames(slugs);
  if (!window.confirm(action + ' on the public site aisigym.netlify.app?\n\n' + names)) return false;
  body.destination = 'https://aisigym.netlify.app';
  return true;
}
async function startRelease(mode) {
  if (
    !isOwner() ||
    releaseBusy ||
    releaseLoading ||
    !releaseState ||
    (mode === 'promote' ? view !== 'publish' : view !== 'files' || !releaseSlug)
  )
    return;
  const head = releaseState.previews?.[releaseSlug];
  const selection = mode === 'promote' ? reviewedSelection() : null;
  if (mode === 'promote' && !selection) return;
  if (
    mode === 'direct' &&
    (!releaseDraft || releaseDraft.slug !== releaseSlug || releaseDraft.revision !== releaseState.revision)
  )
    return;
  const body =
    mode === 'promote'
      ? { mode, revision: releaseState.revision, selection: { ...selection } }
      : {
          mode,
          revision: releaseState.revision,
          slug: releaseSlug,
          base: releaseState.currentPreviewId || head?.id || releaseState.production,
          files: releaseDraft.files.map(({ path, sha1, size }) => ({ path, sha1, size })),
          remove: releaseDraft.remove,
        };
  if (!confirmProduction(body, selection ? Object.keys(selection) : [releaseSlug])) return;
  $('releaseTransport').textContent = 'Browser file requests: 0 · 0 B sent';
  await completeRelease(async () => {
    const { submitRelease } = await import('./upload.mjs');
    return submitRelease({
      body,
      files: mode === 'direct' ? releaseDraft.files : [],
      onProgress: releaseProgress,
      onJob(job) {
        rememberRelease(job);
        $('releaseOperation').textContent = `Operation ${job.id}`;
      },
    });
  });
}
async function resumeSavedRelease() {
  if (!savedRelease?.id || releaseBusy) return;
  const id = savedRelease.id;
  $('releaseOperation').textContent = `Operation ${id}`;
  await completeRelease(async () => {
    const { resumeRelease } = await import('./upload.mjs');
    return resumeRelease(id, releaseProgress, { finish: true });
  });
}
$('releaseDemo').addEventListener('change', () => loadRelease($('releaseDemo').value));
$('reviewedSearch').addEventListener('input', renderReviewedSelections);
$('releasePackageInput').addEventListener('change', (event) => {
  if (event.target.files.length) prepareRelease(event.target.files);
});
$('releaseFolderInput').addEventListener('change', (event) => {
  if (event.target.files.length) prepareRelease(event.target.files);
});
$('rollbackTarget').addEventListener('change', renderRollbackImpact);
$('restoreRelease').addEventListener('click', restoreRelease);
$('promoteRelease').addEventListener('click', () => startRelease('promote'));
$('directRelease').addEventListener('click', () => startRelease('direct'));
loadState(initialRoute.slug).then(() => {
  if (!state) return;
  const route = readRoute();
  const resumeAtHome = isOwner() && savedRelease?.phase === 'processing' && route.view === 'overview';
  openView(resumeAtHome ? 'receipts' : route.view, {
    method: 'replaceState',
    receipt: route.receipt,
    focus: false,
  });
});
