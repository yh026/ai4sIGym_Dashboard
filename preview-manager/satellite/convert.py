#!/usr/bin/env python3
"""Create a bounded Insight-only overlay from the hash-verified published HTML."""
import argparse, base64, hashlib, json, re
from urllib.parse import urlsplit
from pathlib import Path

BASE_SHA1 = '75c93380ad66d3041726bc0e2ea907f2e40f0129'
SLUG = 'from-twelve-thousand-numbers-to-a-codebook'

def convert(source, output):
    raw = source.read_bytes()
    assert hashlib.sha1(raw).hexdigest() == BASE_SHA1, 'Input must match the recorded Production Insight, not a prerelease'
    output.mkdir(parents=True, exist_ok=True)
    assets = []
    baseline = json.loads((Path(__file__).resolve().parents[2] / 'private-inputs/production-baseline.json').read_text())
    canonical = {row['path'].lower():row['path'] for row in baseline['files']}
    canonical_changes = {}
    def canonical_url(match):
        value = match.group(0)
        parts = urlsplit(value)
        absolute = parts.path if parts.path.startswith('/') else '/demos/' + SLUG + '/' + parts.path
        target = canonical.get(absolute.lower())
        if not target or target == absolute: return value
        replacement = target if parts.path.startswith('/') else target[len('/demos/' + SLUG + '/'):]
        if parts.query: replacement += '?' + parts.query
        if parts.fragment: replacement += '#' + parts.fragment
        canonical_changes[value] = replacement
        return replacement
    original_generated = set((output/'resources/data').glob('*'))
    # On the case-insensitive macOS filesystem, remove old mixed-case names before writing.
    for obsolete in original_generated:
        if obsolete.name != obsolete.name.lower() and obsolete.is_file(): obsolete.unlink()
    original_generated = {p for p in original_generated if p.name == p.name.lower()}

    def save(folder, name, raw):
        path = Path('resources') / folder / name
        dest = output / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        assets.append({'path':str(path),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        return str(path)
    def data(name, value):
        return save('data', name.lower()+'.json', json.dumps(value,separators=(',',':'),ensure_ascii=False).encode())
    def script(name, text): return save('data',name+'.js',text.encode())
    seen = {}
    def image(m):
        mime, encoded = m.group(1), m.group(2)
        blob = base64.b64decode(encoded)
        digest = hashlib.sha256(blob).hexdigest()
        if digest not in seen:
            ext = {'jpeg':'jpg','png':'png','webp':'webp','gif':'gif'}[mime]
            seen[digest] = save('images',digest+'.'+ext,blob)
        return seen[digest]
    normalized = re.sub(r'''(?:/assets/|resources/)[A-Za-z0-9_./-]+(?:[?#][^\s"'<>)]*)?''', canonical_url, raw.decode())
    html = re.sub(r'data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)',image,normalized)
    scripts = list(re.finditer(r'<script[^>]*>(.*?)</script>',html,re.S))
    payload_match = re.search(r'<script type="application/json" id="payload">(.*?)</script>',html,re.S)
    D = json.loads(payload_match.group(1))
    main = scripts[5].group(1)
    E, end = json.JSONDecoder().raw_decode(main[len('const E='):])
    core = main[len('const E=')+end+1:]
    split = core.index('const ASSOCIATION=')
    assoc = core[split:]
    A, aend = json.JSONDecoder().raw_decode(assoc[len('const ASSOCIATION='):])
    association_code = assoc[len('const ASSOCIATION=')+aend+1:]
    core = core[:split]
    codes = D.pop('codes')
    code_urls = {k:data('codes-'+k,v) for k,v in codes.items()}
    D['codes'] = {}
    inspection = E.pop('inspection')
    feature_urls = {name:data('features-'+name,model) for name,model in inspection.pop('models').items()}
    inspection['models'] = {}
    E['inspection'] = inspection
    urls = {'payload':data('reconstruction',D),'evidence':data('classification',E),'association':data('association',A),'codes':code_urls,'features':feature_urls}
    core = core.replace("q('reconstructionK').addEventListener('change',e=>{k=Number(e.target.value);activeCode=null;update()});", "q('reconstructionK').addEventListener('change',async e=>{const requested=Number(e.target.value);try{await Satellite.ensureCodes(requested)}catch(error){e.target.value=String(k);q('selectedMetrics').textContent='Unable to load this codebook. Choose it again to retry.';return}if(Number(e.target.value)!==requested)return;k=requested;activeCode=null;update()});")
    core = core.replace("const model=data.models[name];if(!model)return null;", "if(!Satellite.classificationVisible)return null;const model=data.models[name];if(!model){Satellite.ensureFeatures(name).then(paintSelected).catch(()=>{histogramCaption.textContent='Unable to load saved features. Choose a model to retry.'});return null;}")
    urls['core'] = script('explorers',core)
    urls['associationCode'] = script('association-explorer',association_code)
    urls['mistakesCode'] = script('mistakes',scripts[7].group(1))
    # Keep the shared theme/phone/fold code immediate; D is populated before the scientific code runs.
    html = html.replace(payload_match.group(0),'<script>const D = {codes:{}}; const E = {}; const ASSOCIATION = {};</script>')
    html = html.replace('const D = JSON.parse(document.getElementById("payload").textContent);','')
    html = html.replace(scripts[5].group(0),'')
    html = html.replace(scripts[7].group(0),'')
    film = scripts[6].group(1)
    film = film.replace('function openImage(name, k) {','async function openImage(name, k) {\n    await Satellite.ready();\n    if(k)await Satellite.ensureCodes(Number(k));')
    film = film.replace("else film.addEventListener('loadedmetadata', go, { once: true });", "else { film.addEventListener('loadedmetadata', go, { once: true }); film.load(); }")
    html = html.replace(scripts[6].group(0),'')
    # Browser native lazy loading applies to real images; the film remains fully playable.
    html = re.sub(r'<img\b', '<img loading="lazy" decoding="async"',html)
    html = html.replace('preload="metadata"','preload="none"')
    loader = (Path(__file__).with_name('loader.js')).read_text().replace('/*ASSET_URLS*/',json.dumps(urls,separators=(',',':')))
    loader_url = script('satellite-loader',loader)
    html = html.replace('</body>',f'<script src="{loader_url}"></script><script id="vs-film-sync-js">{film}</script></body>')
    current_generated = {output / asset['path'] for asset in assets}
    for obsolete in original_generated - current_generated:
        if obsolete.is_file(): obsolete.unlink()
    (output/'index.html').write_text(html)
    (output/'demo.json').write_text(json.dumps({'schema':1,'slug':SLUG,'pages':{'insight':'index.html'}},indent=2)+'\n')
    report = {'schema':1,'input':{'bytes':len(raw),'sha1':BASE_SHA1,'sha256':hashlib.sha256(raw).hexdigest()},'output_html_bytes':len(html.encode()),'canonicalized_urls':canonical_changes,'unique_images':len(seen),'assets':assets,'scope':'Insight overlay only; existing dataset, workflow, films and resources are retained by the merge.'}
    (output.parent/'conversion-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='assets'},indent=2))

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('source',type=Path);p.add_argument('output',type=Path)
    a=p.parse_args();convert(a.source,a.output)
