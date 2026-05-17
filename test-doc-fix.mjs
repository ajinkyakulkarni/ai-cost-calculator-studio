import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://calc.ajinkya.ai/?_=docfix', { waitUntil: 'networkidle' });
await page.evaluate(() => { const o = document.querySelector('#welcome-overlay'); if (o) o.remove(); document.body.classList.remove('config-basic'); });
await page.waitForTimeout(800);
const baseline = await page.locator('#cb-num').textContent();
console.log('baseline:', baseline);
// Set s-doc-pdfs to 10 via .fill()
await page.locator('#s-doc-pdfs').fill('10');
await page.locator('#s-doc-pdfs').dispatchEvent('input');
await page.waitForTimeout(1500);
const r = await page.evaluate(() => ({
  cost: document.getElementById('cb-num')?.textContent,
  pdfs: document.getElementById('s-doc-pdfs')?.value,
}));
console.log('after s-doc-pdfs=10:', r);
// Direct engine compute
const eng = await page.evaluate(() => {
  const r0 = CostEngine.compute(window.workload, { hosting: 'api', extraInputTokensPerQuery: 0 });
  const rN = CostEngine.compute(window.workload, { hosting: 'api', extraInputTokensPerQuery: 50000 });
  return { base: r0?.api?.monthly_with_retry, withExtra: rN?.api?.monthly_with_retry };
});
console.log('engine direct:', eng);
await browser.close();
