(function () {
  'use strict';

  var q = document.getElementById('q');
  var grid = document.getElementById('grid');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.project-card'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var clear = document.getElementById('clear-filters');
  var showing = document.getElementById('showing');
  var empty = document.getElementById('empty');
  var active = {};

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function hasFilters() {
    var hasQuery = q && q.value.trim();
    var hasActiveChip = Object.keys(active).some(function (key) { return Boolean(active[key]); });
    return Boolean(hasQuery || hasActiveChip);
  }

  function applyFilters() {
    if (!grid || !showing || !empty) return;

    var search = q ? q.value.trim().toLowerCase() : '';
    var visible = 0;

    cards.forEach(function (card) {
      var matches = !search || (card.getAttribute('data-search') || '').indexOf(search) !== -1;
      Object.keys(active).forEach(function (group) {
        if (active[group] && card.getAttribute('data-' + group) !== active[group]) matches = false;
      });
      card.hidden = !matches;
      if (matches) visible++;
    });

    var filtered = hasFilters();
    showing.textContent = filtered
      ? 'Showing ' + visible + ' of ' + plural(cards.length, 'project')
      : plural(cards.length, 'project');
    if (clear) clear.hidden = !filtered;
    empty.hidden = visible !== 0;
    grid.hidden = visible === 0;
  }

  chips.forEach(function (chip) {
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', function () {
      var group = chip.getAttribute('data-group');
      var value = chip.getAttribute('data-value');
      active[group] = active[group] === value ? '' : value;

      chips.forEach(function (candidate) {
        if (candidate.getAttribute('data-group') === group) {
          candidate.setAttribute('aria-pressed', String(
            active[group] === candidate.getAttribute('data-value')
          ));
        }
      });
      applyFilters();
    });
  });

  if (q) q.addEventListener('input', applyFilters);

  if (clear) {
    clear.addEventListener('click', function () {
      active = {};
      if (q) {
        q.value = '';
        q.focus();
      }
      chips.forEach(function (chip) { chip.setAttribute('aria-pressed', 'false'); });
      applyFilters();
    });
  }

  applyFilters();

  var atlasLayer = document.querySelector('.atlas-domain-layer');
  var domainLinks = Array.prototype.slice.call(document.querySelectorAll('.atlas-domain'));

  function highlightDomain(selected) {
    domainLinks.forEach(function (link) {
      link.classList.toggle('is-dimmed', Boolean(selected && link !== selected));
    });
  }

  domainLinks.forEach(function (link) {
    link.addEventListener('mouseenter', function () { highlightDomain(link); });
    link.addEventListener('focus', function () { highlightDomain(link); });
    link.addEventListener('blur', function () { highlightDomain(null); });
  });

  if (atlasLayer) atlasLayer.addEventListener('mouseleave', function () { highlightDomain(null); });
})();
