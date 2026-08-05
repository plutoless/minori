const { chromium } = require(process.argv[2]);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const issues = [];
  const summary = [];

  for (const variant of ['A', 'B', 'C']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type())) issues.push(`${variant} console ${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', error => issues.push(`${variant} pageerror: ${error.message}`));
    await page.goto(`http://127.0.0.1:4173/?variant=${variant}`, { waitUntil: 'networkidle' });
    const visibleId = await page.locator('main.variant:visible').getAttribute('id');
    const switcherVisible = await page.locator('.variant-switcher').isVisible();
    summary.push(`${variant}: ${visibleId}, switcher=${switcherVisible}`);
    await page.screenshot({ path: variant === 'A' ? 'prototypes/roadmap/preview-a.png' : `/tmp/minori-roadmap-${variant.toLowerCase()}.png`, fullPage: true });
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => issues.push(`mobile pageerror: ${error.message}`));
  await page.goto('http://127.0.0.1:4173/?variant=C', { waitUntil: 'networkidle' });
  await page.locator('[data-scenario="write"]').click();
  const preview = await page.locator('#phone-chat').innerText();
  await page.keyboard.press('ArrowLeft');
  const afterArrow = new URL(page.url()).searchParams.get('variant');
  summary.push(`mobile: write-preview=${preview.includes('第二阶段')}, arrow=${afterArrow}`);
  await page.screenshot({ path: '/tmp/minori-roadmap-mobile.png', fullPage: true });

  await browser.close();
  console.log(summary.join('\n'));
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('console/page errors: 0');
  }
})();
