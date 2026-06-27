import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../server.mjs', import.meta.url).pathname],
});
const client = new Client({ name: 'test', version: '0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map(t => t.name);
ok('lists six tools', ['list_presets','load_preset','get_schema','validate_workload','compute_cost','make_share_link'].every(t => tools.includes(t)));

const prompts = (await client.listPrompts()).prompts.map(p => p.name);
ok('lists cost_interview prompt', prompts.includes('cost_interview'));

const w = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const res = await client.callTool({ name: 'compute_cost', arguments: { workload: w } });
const payload = JSON.parse(res.content[0].text);
ok('compute_cost returns a headline over stdio', payload.headline_monthly_usd > 0);

await client.close();
console.log(`\nmcp-protocol: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
