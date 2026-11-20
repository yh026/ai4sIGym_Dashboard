#!/usr/bin/env python3
"""Build identical localhost fixtures; --download-assets permits fetching public root images."""
import argparse, hashlib, json, re, shutil, urllib.request
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--download-assets',action='store_true')
p.add_argument('--root',type=Path,default=Path('.local/netlify-manager/satellite'))
p.add_argument('--resources',type=Path,default=Path('private-inputs/satellite/resources'))
a=p.parse_args()
source=a.root/'input/index.html'
assert hashlib.sha1(source.read_bytes()).hexdigest()=='75c93380ad66d3041726bc0e2ea907f2e40f0129'
baseline=json.loads(Path('private-inputs/production-baseline.json').read_text())
canonical_names={Path(row['path']).name.lower():Path(row['path']).name for row in baseline['files']}
slug='demos/from-twelve-thousand-numbers-to-a-codebook'
# Resource names are case insensitive on the published host. Preserve the exact URLs in HTML.
for row in baseline['files']:
 if not row['path'].startswith('/'+slug+'/resources/'):continue
 name=Path(row['path']).name
 matches=[x for x in a.resources.iterdir() if x.name.lower()==name.lower()]
 assert len(matches)==1, name
 blob=matches[0].read_bytes()
 assert len(blob)==row['size_bytes'] and hashlib.sha1(blob).hexdigest()==row['sha1'],name
for mode in ['before','after']:
 dest=a.root/'fixture'/mode/slug;dest.mkdir(parents=True,exist_ok=True)
 resource=dest/'resources'
 if resource.is_symlink():resource.unlink()
 resource.mkdir(exist_ok=True)
 for original in a.resources.iterdir():
  name=canonical_names.get(original.name.lower(),original.name) if mode=='after' else original.name
  target=resource/name
  obsolete=resource/original.name
  if mode=='after' and name!=original.name and obsolete.is_symlink():obsolete.unlink()
  if not target.exists():target.symlink_to(original.resolve())
 shutil.copy2(source,dest/'index.html')
 if mode=='after':shutil.copytree(a.root/'package',dest,dirs_exist_ok=True)
for asset in sorted(set(re.findall(r'/assets/[^"\s<>\)]+',source.read_text()))):
 cache=a.root/'fixture/before'/asset.lstrip('/')
 if not cache.exists():
  if not a.download_assets:raise SystemExit('Missing cached '+asset+'; rerun with --download-assets')
  cache.parent.mkdir(parents=True,exist_ok=True)
  cache.write_bytes(urllib.request.urlopen('https://aisigym.netlify.app'+asset).read())
 assert hashlib.sha256(cache.read_bytes()).hexdigest()==Path(asset).stem,asset
 target=a.root/'fixture/after'/asset.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(cache,target)
print('Prepared hash-verified exact Production and overlay localhost fixtures.')
