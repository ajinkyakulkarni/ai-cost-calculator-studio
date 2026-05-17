import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://calc.ajinkya.ai/?_=r3', { waitUntil: 'networkidle' });
await page.evaluate(() => { const o = document.querySelector('#welcome-overlay'); if (o) o.remove(); });
await page.evaluate(() => {
  for (const el of document.querySelectorAll('.sr-advanced')) el.style.display = 'block';
});
await page.waitForTimeout(800);
const v1 = await page.evaluate(() => {
  const el = document.getElementById('s-retry');
  const r = el.getBoundingClientRect();
  return { value: el.value, rect: { w: r.width, h: r.height } };
});
console.log('after CSS override:', JSON.stringify(v1));
// Try .fill() instead
await page.locator('#s-retry').fill('20');
await page.waitForTimeout(800);
const v2 = await page.evaluate(() => {
  const el = document.getElementById('s-retry');
  return { value: el.value };
});
console.log('after fill(20):', JSON.stringify(v2));
// Also dispatch trusted input
await page.evaluate(() => {
  const el = document.getElementById('s-retry');
  el.value = '20';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(800);
const cost = await page.locator('#cb-num').textContent();
console.log('cost after:', cost);
await browser.close();
