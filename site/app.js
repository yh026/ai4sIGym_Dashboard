(function () {
  var q = document.getElementById('q');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var showing = document.getElementById('showing');
  var empty = document.getElementById('empty');
  var grid = document.getElementById('grid');
  var active = { category: '', task: '' };

  function apply() {
    var s = q.value.trim().toLowerCase();
    var n = 0;
    cards.forEach(function (c) {
      var ok = (!s || c.getAttribute('data-search').indexOf(s) !== -1)
        && (!active.category || c.getAttribute('data-category') === active.category)
        && (!active.task || c.getAttribute('data-task') === active.task);
      c.hidden = !ok;
      if (ok) n++;
    });
    var filtered = s || active.category || active.task;
    showing.textContent = filtered ? 'showing ' + n + ' of ' + cards.length : '';
    empty.hidden = n !== 0;
    grid.hidden = n === 0;
  }

  chips.forEach(function (chip) {
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', function () {
      var g = chip.getAttribute('data-group');
      var v = chip.getAttribute('data-value');
      active[g] = active[g] === v ? '' : v;
      chips.forEach(function (c) {
        if (c.getAttribute('data-group') === g) {
          c.setAttribute('aria-pressed', String(active[g] === c.getAttribute('data-value')));
        }
      });
      apply();
    });
  });

  q.addEventListener('input', apply);
  apply();
})();
