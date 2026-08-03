(function () {
  'use strict';

  // Project-library search and filters.
  var q = document.getElementById('q');
  var grid = document.getElementById('grid');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.project-card'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var clear = document.getElementById('clear-filters');
  var showing = document.getElementById('showing');
  var empty = document.getElementById('empty');
  var activeFilters = {};

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function hasFilters() {
    var hasQuery = q && q.value.trim();
    var hasActiveChip = Object.keys(activeFilters).some(function (key) {
      return Boolean(activeFilters[key]);
    });
    return Boolean(hasQuery || hasActiveChip);
  }

  function applyFilters() {
    if (!grid || !showing || !empty) return;
    var search = q ? q.value.trim().toLowerCase() : '';
    var visible = 0;

    cards.forEach(function (card) {
      var matches = !search || (card.getAttribute('data-search') || '').indexOf(search) !== -1;
      Object.keys(activeFilters).forEach(function (group) {
        if (activeFilters[group] && card.getAttribute('data-' + group) !== activeFilters[group]) matches = false;
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
      activeFilters[group] = activeFilters[group] === value ? '' : value;
      chips.forEach(function (candidate) {
        if (candidate.getAttribute('data-group') === group) {
          candidate.setAttribute('aria-pressed', String(
            activeFilters[group] === candidate.getAttribute('data-value')
          ));
        }
      });
      applyFilters();
    });
  });

  if (q) q.addEventListener('input', applyFilters);
  if (clear) {
    clear.addEventListener('click', function () {
      activeFilters = {};
      if (q) {
        q.value = '';
        q.focus();
      }
      chips.forEach(function (chip) { chip.setAttribute('aria-pressed', 'false'); });
      applyFilters();
    });
  }
  applyFilters();

  // Interactive science-map state shared by the art regions and HTML labels.
  var map = document.querySelector('.science-map');
  var markers = Array.prototype.slice.call(document.querySelectorAll('.map-marker'));
  var hotspots = Array.prototype.slice.call(document.querySelectorAll('.map-hotspot-link'));
  var regionEffects = Array.prototype.slice.call(document.querySelectorAll('.map-region-effect'));
  var closeTimer = 0;

  function cancelClose() {
    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = 0;
  }

  function setMapDomain(domainId) {
    cancelClose();
    if (map) map.setAttribute('data-active-domain', domainId || '');
    if (map) map.classList.toggle('has-active-domain', Boolean(domainId));
    regionEffects.forEach(function (effect) {
      effect.classList.toggle('is-active', effect.getAttribute('data-domain') === domainId);
    });
    hotspots.forEach(function (hotspot) {
      hotspot.classList.toggle('is-active', hotspot.getAttribute('data-domain') === domainId);
    });
    markers.forEach(function (marker) {
      var selected = marker.getAttribute('data-domain') === domainId;
      marker.classList.toggle('is-active', selected);
      var label = marker.querySelector('.map-domain-label');
      if (label) label.setAttribute('aria-expanded', String(selected));
      var popover = marker.querySelector('.domain-popover');
      if (popover) popover.hidden = !selected;
    });
  }

  function scheduleClose() {
    cancelClose();
    closeTimer = window.setTimeout(function () { setMapDomain(''); }, 140);
  }

  hotspots.forEach(function (hotspot) {
    hotspot.addEventListener('mouseenter', function () {
      setMapDomain(hotspot.getAttribute('data-domain'));
    });
    hotspot.addEventListener('mouseleave', scheduleClose);
  });

  markers.forEach(function (marker) {
    marker.addEventListener('mouseenter', function () {
      setMapDomain(marker.getAttribute('data-domain'));
    });
    marker.addEventListener('mouseleave', scheduleClose);
    marker.addEventListener('focusin', function () {
      setMapDomain(marker.getAttribute('data-domain'));
    });
    marker.addEventListener('focusout', function (event) {
      if (!marker.contains(event.relatedTarget)) scheduleClose();
    });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var focusedPopover = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('.domain-popover') : null;
    var marker = focusedPopover && focusedPopover.closest('.map-marker');
    var label = marker && marker.querySelector('.map-domain-label');
    if (label) label.focus();
    setMapDomain('');
  });

  // Touching an illustrated region opens a bottom sheet; mouse clicks still navigate.
  var dialog = document.getElementById('map-dialog');
  var dialogContent = document.getElementById('map-dialog-content');
  var dialogClose = document.getElementById('map-dialog-close');
  var dialogReturnTarget = null;

  function markerFor(domainId) {
    return markers.find(function (marker) {
      return marker.getAttribute('data-domain') === domainId;
    });
  }

  function openDomainDialog(domainId) {
    if (!dialog || !dialogContent || typeof dialog.showModal !== 'function') return false;
    var marker = markerFor(domainId);
    var source = marker && marker.querySelector('.domain-popover-inner');
    if (!source) return false;
    setMapDomain(domainId);
    dialogContent.innerHTML = source.outerHTML;
    var title = dialogContent.querySelector('h3');
    if (title) title.id = 'map-dialog-title';
    dialog.setAttribute('aria-labelledby', title ? 'map-dialog-title' : '');
    var markerLabel = marker && marker.querySelector('.map-domain-label');
    var mobileLabel = document.querySelector('.mobile-domain-link[data-domain="' + domainId + '"]');
    dialogReturnTarget = [markerLabel, mobileLabel].find(function (candidate) {
      return candidate && candidate.getClientRects().length;
    }) || markerLabel || mobileLabel;
    dialog.style.setProperty('--domain-color', window.getComputedStyle(marker).getPropertyValue('--domain-color'));
    dialog.showModal();
    return true;
  }

  hotspots.forEach(function (hotspot) {
    var pointerType = '';
    hotspot.addEventListener('pointerdown', function (event) {
      pointerType = event.pointerType || '';
    });
    hotspot.addEventListener('pointercancel', function () { pointerType = ''; });
    hotspot.addEventListener('click', function (event) {
      var touchActivation = pointerType === 'touch' || pointerType === 'pen';
      pointerType = '';
      if (touchActivation && openDomainDialog(hotspot.getAttribute('data-domain'))) {
        event.preventDefault();
      }
    });
  });

  if (dialogClose && dialog) {
    dialogClose.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', function () {
      if (dialogReturnTarget && typeof dialogReturnTarget.focus === 'function') {
        try {
          dialogReturnTarget.focus({ preventScroll: true });
        } catch (error) {
          dialogReturnTarget.focus();
        }
      }
      dialogReturnTarget = null;
      setMapDomain('');
    });
  }
})();
