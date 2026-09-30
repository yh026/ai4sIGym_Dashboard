'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stable, safeRoute } = require('./registry-v3');
const { decoratePage, datasetPlaceholder } = require('./project-pages');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (ok,message) => { if (!ok) throw new Error('Registry v3: ' + message); };

function scopedUrl(base, action, audience, id, revision) {
  const url = new URL(base);
  for (const key of ['schema','action','audience','id','registry_revision','status']) url.searchParams.delete(key);
  url.searchParams.set('schema','3'); url.searchParams.set('action',action);
  url.searchParams.set('audience',audience);
  if (id) url.searchParams.set('id',id);
  if (revision) url.searchParams.set('registry_revision',revision);
  return url.toString();
}

function validateManifest(manifest, policy, expectedInstance) {
  check(manifest && manifest.ok !== false && manifest.schema_version === 3, 'invalid manifest');
  check(manifest.audience === policy.audience, 'audience mismatch');
  if (manifest.environment === 'sandbox') {
    check(policy.netlify === true && policy.context === 'branch-deploy' && policy.branch === 'develop' && policy.audience === 'preview', 'sandbox requires Netlify develop');
    check(expectedInstance && manifest.registry_instance === expectedInstance, 'sandbox instance not pinned in branch environment');
  }
  const { ok, registry_revision, ...body } = manifest;
  check('sha256:' + sha(stable(body)) === registry_revision, 'manifest checksum mismatch');
  check(Array.isArray(manifest.demos) && Array.isArray(manifest.bundles), 'project bundles required');
  const projects = new Map(manifest.demos.map(d => [d.demo_id,d]));
  check(projects.size === manifest.demos.length, 'duplicate project');
  const ids = new Set(), routes = new Set(), bundles = new Set();
  for (const b of manifest.bundles) {
    const project = projects.get(b.demo_id);
    check(project && !bundles.has(b.demo_id), 'duplicate or orphan bundle'); bundles.add(b.demo_id);
    const base = 'demos/' + project.slug + '/';
    const roles = new Set();
    for (const p of b.pages) {
      check(!roles.has(p.role), 'duplicate page role'); roles.add(p.role);
      const allowed = { insight:base+'index.html',legacy:base+'index.html',workflow:base+'workflow.html',resource_page:base+'workflow-resources.html' };
      check(p.role === 'dataset' ? p.route === base+'dataset.html' || /^datasets\/[a-z0-9-]+\/index\.html$/.test(p.route) : p.route === allowed[p.role], 'page route does not match role');
      check(p.state === 'Ready' || (p.state === 'Placeholder' && p.role === 'dataset' && p.source === null), 'invalid page state');
    }
    check(b.layout === 'single' ? roles.size === 1 && roles.has('legacy') : b.layout === 'three-page' && ['insight','dataset','workflow'].every(r=>roles.has(r)) && !roles.has('legacy'), 'incomplete bundle');
    for (const item of b.pages.concat(b.resources)) {
      const id = item.page_id || item.resource_id;
      check(typeof id === 'string' && id && !ids.has(id), 'duplicate file identity'); ids.add(id);
      check(safeRoute(item.route) && !routes.has(item.route), 'duplicate or unsafe output path'); routes.add(item.route);
      if (item.resource_id) check(item.role === 'card' ? /^assets\/cards\/[a-z0-9-]+\.(?:jpe?g|png|webp)$/.test(item.route) : item.route.startsWith(base+'resources/'), 'resource outside project');
      if (item.state !== 'Placeholder') check(item.source && /^[a-f0-9]{64}$/.test(item.source.sha256) && Number.isSafeInteger(item.source.size) && item.source.size > 0 && item.source.size <= 25*1024*1024, 'invalid source descriptor');
    }
    check(b.pages.some(p=>p.page_id===project.file_id && ['insight','legacy'].includes(p.role)), 'entry file mismatch');
  }
  check(projects.size === bundles.size, 'missing project bundle');
  return manifest;
}

async function loadV3Registry(base, policy, getJson, expectedRevision, env=process.env) {
  const fetchManifest = revision => getJson(scopedUrl(base,'manifest',policy.audience,'',revision),'Registry v3 manifest');
  const manifest = validateManifest(await fetchManifest(expectedRevision),policy,env.AIS_REGISTRY_INSTANCE);
  if (expectedRevision) check(manifest.registry_revision===expectedRevision,'requested revision changed');
  const index = new Map(manifest.bundles.flatMap(b=>b.pages.concat(b.resources)).map(p=>[p.page_id||p.resource_id,p]));
  const cache = new Map();
  async function bytes(id,revision) {
    check(revision===manifest.registry_revision,'revision mismatch');
    const item=index.get(id);check(item && item.source,'file absent from selected release');
    if(cache.has(id))return cache.get(id);
    const result=await getJson(scopedUrl(base,item.page_id?'page':'resource',policy.audience,id,revision),'Registry v3 content',36*1024*1024);
    check(result.ok===true && result.registry_revision===revision && result.registry_instance===manifest.registry_instance && result.id===id,'content identity or revision mismatch');
    const value = item.page_id ? Buffer.from(result.html||'','utf8') : Buffer.from(result.base64||'','base64');
    check(value.length===item.source.size && sha(value)===item.source.sha256,'source content changed');
    cache.set(id,value);return value;
  }
  return {
    schemaVersion:2, protocolVersion:3, registryInstance:manifest.registry_instance,
    taxonomy:manifest.taxonomy,site:manifest.site,demos:manifest.demos,
    audience:manifest.audience,registryRevision:manifest.registry_revision,bundles:manifest.bundles,
    getHtml:async (id,revision)=>({html:(await bytes(id,revision)).toString('utf8'),registryRevision:revision}),
    getRevision:async revision=>{
      const final=validateManifest(await fetchManifest(revision),policy,env.AIS_REGISTRY_INSTANCE);
      check(final.registry_instance===manifest.registry_instance,'Registry instance changed');return final.registry_revision;
    },
    async getProjectPages(demos,revision) {
      // Apps Script performs a fresh Sheet and source check on every request.
      // A small bound avoids a long serial build without flooding its quota.
      const selected = new Set(demos.map(d=>d.demo_id));
      const pending = manifest.bundles.filter(b=>selected.has(b.demo_id))
        .flatMap(b=>b.pages.concat(b.resources)).filter(item=>item.source)
        .map(item=>item.page_id||item.resource_id).filter(id=>!cache.has(id));
      for(let i=0;i<pending.length;i+=3) await Promise.all(pending.slice(i,i+3).map(id=>bytes(id,revision)));
      const output=new Map();
      const template=fs.readFileSync(path.join(__dirname,'../site/dataset-placeholder.html'),'utf8');
      for(const demo of demos) {
        const bundle=manifest.bundles.find(b=>b.demo_id===demo.demo_id);
        const routes=Object.fromEntries(bundle.pages.map(p=>[p.role,p.route]));
        const project={slug:demo.slug,title:demo.title,resource_page:routes.resource_page};
        const pages=[];
        for(const p of bundle.pages) {
          const html=p.state==='Placeholder'?datasetPlaceholder(template,demo.title):(await bytes(p.page_id,revision)).toString('utf8');
          if(p.role==='legacy')continue;
          const role=p.role==='resource_page'?'workflow':p.role;
          const pageRoutes=p.role==='resource_page'?{...routes,workflow:p.route}:routes;
          pages.push({path:p.route,html:decoratePage(html,role,pageRoutes,project)});
        }
        for(const r of bundle.resources) pages.push({path:r.route,bytes:await bytes(r.resource_id,revision)});
        if(bundle.layout!=='single')output.set(demo.slug,pages);
        else if(pages.length)output.set(demo.slug,pages.concat({path:routes.legacy,html:(await bytes(demo.file_id,revision)).toString('utf8'),legacy:true}));
      }
      return output;
    },
  };
}

module.exports={scopedUrl,validateManifest,loadV3Registry};
