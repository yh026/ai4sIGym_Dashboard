/* Optional method downloads. Scientific controls and payloads stay in the page. */
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('ais-workflow-data').textContent);
  const skills = new Map(data.skills.map(skill => [skill.id, skill]));
  const element = (tag, attributes = {}, text) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const link = (label, href, filename, primary = false) => element('a', {
    class: 'ais-resource-button' + (primary ? ' ais-primary' : ''), href, download: filename,
  }, label);
  const size = bytes => (bytes / 1024 / 1024).toFixed(1) + ' MB';

  if (data.workflow) {
    const overview = element('section', { class: 'ais-workflow-overview', id: 'ais-complete-workflow', 'aria-label': 'Complete workflow Skill' });
    const description = element('div');
    description.append(element('strong', {}, data.workflow.title + ' Skill'),
      element('p', {}, 'Prepare data → compare embeddings → cluster → evaluate → create a Notebook with your own data.'));
    overview.append(description, link('Download workflow Skill ↓', data.workflow.zip, data.workflow.filename, true));
    document.getElementById('ribbon').before(overview);
  }

  const toolbar = element('section', { class: 'ais-resource-toolbar', 'aria-label': 'Workflow resources' });
  const intro = element('div');
  intro.append(element('strong', {}, 'Workflow resources'));
  if (data.skills.length) intro.append(element('p', {}, data.skills.length + ' reusable method skills'));
  const actions = element('div', { class: 'ais-resource-actions' });
  actions.append(element('a', { class: 'ais-resource-button', href: '#ais-notebook', 'data-fold-target': 'ais-notebook' }, 'Notebook & run files'));
  if (data.all) actions.append(link('Download all method skills ↓', data.all, 'tbb-analysis-skills.zip'));
  toolbar.append(intro, actions);
  document.getElementById('ribbon').after(toolbar);

  const notebookSection = element('section', { class: 'fold card', id: 'ais-notebook' });
  const notebookHead = element('h2');
  const foldButton = element('button', { class: 'fold-head', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ais-notebook-body' });
  foldButton.append(element('span', {}, 'Notebook and outputs'), element('span', { class: 'fold-sub' }, 'executed analysis, inputs and reproducibility'));
  notebookHead.append(foldButton);
  const notebookBody = element('div', { class: 'fold-body', id: 'ais-notebook-body', 'data-folded': '' });
  const runIntro = element('div', { class: 'ais-notebook-intro' });
  runIntro.append(element('h3', {}, 'Explore the executed analysis'),
    element('p', {}, 'Read the saved figures and results in Jupyter, or download the run files with the input data, analysis plan, results and caches.'));
  const runActions = element('div', { class: 'ais-resource-actions' });
  runActions.append(link('Notebook · ' + size(data.notebookBytes), data.notebook, 'aisgym.ipynb', true),
    link('Run package · ' + size(data.notebookPackageBytes), data.notebookPackage, 'tbb-notebook.zip'));
  runIntro.append(runActions,
    element('p', { class: 'ais-resource-note' }, 'Re-running requires the SciDGL environment and runtime. Setup and file paths are explained in the package README.'),
    element('p', { class: 'ais-resource-note' }, 'The Notebook reconstructs this workflow. Some refitted nonlinear results differ from the original page; its findings and limitations describe those differences.'));
  notebookBody.append(runIntro);
  notebookSection.append(notebookHead, notebookBody);
  document.getElementById('glossary').after(notebookSection);
  window.PCFolds.bind();

  // Availability belongs to the containing chapter. Several method nodes may
  // share a chapter; only their explicitly associated methods appear here.
  const chapterSkills = new Map();
  for (const binding of data.bindings) {
    if (!binding.skillIds.length) continue;
    const chapter = document.getElementById(binding.target)?.closest('section.fold');
    if (!chapter) throw new Error('Missing method download chapter: ' + binding.target);
    if (!chapterSkills.has(chapter)) chapterSkills.set(chapter, new Set());
    for (const id of binding.skillIds) chapterSkills.get(chapter).add(id);
  }
  if (!chapterSkills.size) return;

  const chapters = [...document.querySelectorAll('section.fold')];
  const railHost = element('div', { class: 'ais-workflow-chapters' });
  chapters[0].before(railHost);
  for (const chapter of chapters) railHost.append(chapter);
  const railLine = element('div', { class: 'ais-skill-rail-line', 'aria-hidden': 'true' });
  const railTitle = element('span', { class: 'ais-skill-rail-title', 'aria-hidden': 'true', title: 'Bright nodes have downloadable method Skills' }, 'SKILLS');
  railHost.append(railLine, railTitle);
  document.querySelector('.fold-controls').classList.add('ais-has-skill-rail');

  const menu = element('aside', { id: 'ais-method-download-menu', class: 'ais-method-menu',
    role: 'region', 'aria-labelledby': 'ais-method-menu-title', hidden: '' });
  document.body.append(menu);
  let activeMarker = null;
  function closeMenu(returnFocus = true) {
    const marker = activeMarker;
    menu.hidden = true;
    activeMarker = null;
    marker?.setAttribute('aria-expanded', 'false');
    if (returnFocus && marker?.isConnected) marker.focus({ preventScroll: true });
  }
  function positionMenu() {
    if (menu.hidden || !activeMarker) return;
    const marker = activeMarker.getBoundingClientRect();
    const bottom = Math.min(innerHeight, document.getElementById('ais-page-navigation')?.getBoundingClientRect().top ?? innerHeight);
    if (marker.bottom < 0 || marker.top > bottom) { closeMenu(false); return; }
    menu.style.maxHeight = Math.max(100, bottom - 24) + 'px';
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(12, marker.left - bounds.width - 8) + 'px';
    menu.style.top = Math.max(12, Math.min(marker.top + 4, bottom - bounds.height - 12)) + 'px';
  }
  function openMenu(marker, title, ids) {
    if (activeMarker === marker) { closeMenu(); return; }
    closeMenu(false);
    const heading = element('div', { class: 'ais-method-menu-heading' });
    const titleGroup = element('div');
    titleGroup.append(element('span', { class: 'ais-method-menu-eyebrow' }, 'SKILL DOWNLOADS'),
      element('h3', { id: 'ais-method-menu-title' }, title),
      element('p', {}, ids.size + (ids.size === 1 ? ' reusable method' : ' reusable methods')));
    const close = element('button', { type: 'button', class: 'ais-method-menu-close', 'aria-label': 'Close Skill downloads' }, '×');
    close.addEventListener('click', () => closeMenu());
    heading.append(titleGroup, close);
    const downloads = element('div', { class: 'ais-method-menu-links' });
    for (const id of ids) {
      const skill = skills.get(id);
      const download = element('a', { class: 'ais-method-link', href: skill.zip, download: skill.filename,
        'data-method-skill': id, 'aria-label': 'Download ' + skill.title + ' Skill' });
      download.append(element('span', {}, skill.title), element('span', { 'aria-hidden': 'true' }, '↓'));
      downloads.append(download);
    }
    menu.replaceChildren(heading, downloads, element('p', { class: 'ais-method-menu-note' }, 'Use these methods with your own data.'));
    activeMarker = marker;
    marker.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    positionMenu();
    if (!menu.hidden) downloads.querySelector('a').focus({ preventScroll: true });
  }

  const markers = chapters.map(chapter => {
    const head = chapter.querySelector(':scope > h2');
    const title = head.querySelector('.fold-head > span').textContent.trim();
    const ids = chapterSkills.get(chapter);
    const marker = ids ? element('button', { type: 'button', class: 'ais-rail-marker ais-has-methods',
      'data-skill-chapter': chapter.id, 'aria-label': title + ': download ' + ids.size + (ids.size === 1 ? ' Skill' : ' Skills'),
      'aria-expanded': 'false', 'aria-controls': menu.id,
      title: title + ' · ' + ids.size + (ids.size === 1 ? ' Skill available' : ' Skills available') })
      : element('span', { class: 'ais-rail-marker', 'aria-hidden': 'true', title: title + ' · no Skill downloads' });
    if (ids) marker.addEventListener('click', () => openMenu(marker, title, ids));
    head.after(marker);
    return { chapter, head, marker };
  });

  let frame = 0;
  function scheduleLayout() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const host = railHost.getBoundingClientRect();
      const positions = markers.map(({ chapter, head, marker }) => {
        const bounds = head.getBoundingClientRect();
        const centre = bounds.top + bounds.height / 2;
        marker.style.top = centre - chapter.getBoundingClientRect().top - 22 + 'px';
        return centre - host.top;
      });
      railLine.style.top = positions[0] + 'px';
      railLine.style.height = positions.at(-1) - positions[0] + 'px';
      positionMenu();
    });
  }
  const observer = new ResizeObserver(scheduleLayout);
  observer.observe(railHost);
  for (const { chapter, head } of markers) { observer.observe(chapter); observer.observe(head); }
  window.addEventListener('resize', scheduleLayout);
  window.addEventListener('scroll', positionMenu, { passive: true });
  document.addEventListener('pointerdown', event => {
    if (activeMarker && !menu.contains(event.target) && !activeMarker.contains(event.target)) closeMenu(false);
  });
  document.addEventListener('focusin', event => {
    if (activeMarker && !menu.contains(event.target) && !activeMarker.contains(event.target)) closeMenu(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && activeMarker) {
      event.preventDefault(); event.stopPropagation(); closeMenu();
    }
  }, true);
  scheduleLayout();
})();
