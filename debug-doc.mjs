import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://calc.ajinkya.ai/?_=docd', { waitUntil: 'networkidle' });
await page.evaluate(() => { const o = document.querySelector('#welcome-overlay'); if (o) o.remove(); document.body.classList.remove('config-basic'); });
await page.waitForTimeout(800);
const baseline = await page.locator('#cb-num').textContent();
console.log('baseline:', baseline);

// Set s-doc-pdfs to 10 via direct value + trusted event
await page.evaluate(() => {
  const el = document.getElementById('s-doc-pdfs');
  console.log('s-doc-pdfs exists?', !!el, 'value before:', el?.value);
});

await page.locator('#s-doc-pdfs').focus();
for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1500);

const r = await page.evaluate(() => ({
  cost: document.getElementById('cb-num')?.textContent,
  pdfs: document.getElementById('s-doc-pdfs')?.value,
  pages: document.getElementById('s-doc-pages')?.value,
  tokPage: document.getElementById('s-doc-tok-page')?.value,
  stagesPct: document.getElementById('s-doc-stages-pct')?.value,
}));
console.log('after nudge:', r);
console.log('extra tokens per q expected:', (parseFloat(r.pdfs)||0) * (parseFloat(r.pages)||0) * (parseFloat(r.tokPage)||0) * (parseFloat(r.stagesPct)||0) / 100);

// Direct engine call
const eng = await page.evaluate(() => {
  const r = CostEngine.compute(window.workload, { hosting: 'api' });
  const r2 = CostEngine.compute(window.workload, { hosting: 'api', extraInputTokensPerQuery: 50000 });
  return { base: r?.api?.monthly_with_retry, withExtra: r2?.api?.monthly_with_retry };
});
console.log('engine: base vs with extra:', eng);
await browser.close();
