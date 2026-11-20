/* Scientific assets load at the stage that needs them. All values are exact Production exports. */
(() => {
  'use strict';
  const urls = /*ASSET_URLS*/;
  const pending = new Map();
  const json = url => {
    if (!pending.has(url)) pending.set(url, fetch(url).then(response => {
      if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
      return response.json();
    }).catch(error => { pending.delete(url); throw error; }));
    return pending.get(url);
  };
  const run = src => new Promise((resolve, reject) => {
    const node = document.createElement('script');
    node.src = src; node.onload = () => {
      if (window.PC && PC.installChartZoom) PC.installChartZoom();
      resolve();
    }; node.onerror = reject; document.body.append(node);
  });
  let core;
  const api = window.Satellite = {
    async ensureCodes(k) {
      if (!urls.codes[k]) return;
      if (!D.codes[k]) D.codes[k] = await json(urls.codes[k]);
    },
    async ensureFeatures(name) {
      if (!urls.features[name]) return;
      if (!E.inspection.models[name]) E.inspection.models[name] = await json(urls.features[name]);
    },
    ready() {
      if (!core) core = Promise.all([json(urls.payload), json(urls.evidence)]).then(async ([d,e]) => {
        Object.assign(D,d); Object.assign(E,e);
        await api.ensureCodes(D.default_k);
        await run(urls.core);
      }).catch(error => { core = undefined; throw error; });
      return core;
    }
  };
  function stage(target, load) {
    let loaded;
    const go = () => {
      if (!loaded) loaded = load().catch(error => {
        loaded = undefined;
        let retry = target.querySelector('[data-satellite-retry]');
        if (!retry) {
          retry = document.createElement('button'); retry.dataset.satelliteRetry = '';
          retry.textContent = 'Retry loading interactive figure';
          retry.onclick = () => { retry.remove(); go(); }; target.append(retry);
        }
        console.error(error);
      });
      return loaded;
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); go(); }
    }, {rootMargin:'100px'});
    observer.observe(target);
    target.addEventListener('focusin',go,{once:true});
    return go;
  }
  stage(document.querySelector('.hero-stage'),api.ready);
  stage(document.getElementById('classification'),async () => {
    api.classificationVisible = true; await api.ready();
    if (window.VQExplorer) window.VQExplorer.refreshSelected();
  });
  stage(document.getElementById('local-associations'),async () => {
    await api.ready(); Object.assign(ASSOCIATION,await json(urls.association)); await run(urls.associationCode);
  });
  stage(document.getElementById('network-mistakes'),() => run(urls.mistakesCode));
  const hash = () => {
    if (['#classification','#reconstructionTitle'].includes(location.hash)) api.ready();
  };
  addEventListener('hashchange',hash);hash();
})();
