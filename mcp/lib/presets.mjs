/* presets.mjs — list + load the bundled example workloads. The example files
 * ARE the workload at top level (deployment, shapes, …). */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(new URL('../../public/examples', import.meta.url).pathname);

export function listPresets() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const name = f.replace(/\.json$/, '');
    const w = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const dep = w.deployment || {};
    return { name, title: dep.name || name, one_line: dep.description || '' };
  });
}

export function loadPreset(name) {
  const p = path.join(DIR, `${String(name).replace(/[^a-z0-9-]/gi, '')}.json`);
  if (!fs.existsSync(p)) throw new Error(`unknown preset: ${name}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
