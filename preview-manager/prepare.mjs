import fs from 'node:fs/promises';
import path from 'node:path';
import rendererTools from '../google-apps-script/publishing-controls/production-release/catalog-renderer.cjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const staging = path.resolve(root, '.preview/desk');
await fs.mkdir(staging, { recursive: true });
await fs.cp(path.join(root, 'public'), staging, { recursive: true });
await fs.cp(path.join(root, 'shared'), path.join(staging, 'shared'), { recursive: true });
await fs.writeFile(
  path.join(staging, '_headers'),
  [
    '/*',
    '  Cache-Control: private, no-store',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  X-Frame-Options: DENY',
    "  Content-Security-Policy: default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    '  X-Robots-Tag: noindex, nofollow',
    '',
  ].join('\n'),
);
// Static imports put the approved renderer inputs inside each function bundle.
// Only the desk directory is served to browsers.
const server = path.join(root, '.preview/functions');
await fs.mkdir(server, { recursive: true });
const sources = Object.fromEntries(
  await Promise.all(
    rendererTools.INPUTS.map(async (name) => [
      name,
      await fs.readFile(path.resolve(root, '..', name), 'utf8'),
    ]),
  ),
);
await fs.writeFile(
  path.join(root, '.preview/catalog-inputs.mjs'),
  'export default ' + JSON.stringify(sources) + ';\n',
);
for (const name of ['desk', 'desk-run-background']) {
  const exports = name === 'desk' ? 'default, config' : 'default';
  await fs.writeFile(
    path.join(server, name + '.mjs'),
    [
      "import sources from '../catalog-inputs.mjs';",
      "import { useCatalogSources } from '../../server/public-catalog.mjs';",
      'useCatalogSources(sources);',
      'export { ' + exports + " } from '../../functions/" + name + ".mjs';",
      '',
    ].join('\n'),
  );
}
console.log(staging);
