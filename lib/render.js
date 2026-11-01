// Renders the Mortgage Freedom Report to a PDF buffer from the calculator answers.
const fs = require('fs');
const path = require('path');

const PRINT_CSS = `
  @page{size:A4;margin:10mm 0 12mm}
  html,body{background:#FFFFFF!important}
  :root{padding:0!important}
  body{padding:0 10mm!important;font-size:14px}
  .sent,.wrap>.fine{display:none!important}
  .wrap{max-width:none!important;gap:10px}
  .report{border:0!important;border-radius:0!important}
  .cover{border-radius:14px;padding:26px!important}
  .sec{padding:16px 4px!important}
  .sec h2{break-after:avoid}
  .kpi{flex-basis:100px!important}
  .kpi.hl{flex-basis:180px!important;box-shadow:none!important;transform:none!important}
  .chart svg{max-height:250px}
  .ctaband{border-radius:14px;break-inside:avoid}
  .win,.eqn,.levers,.accres,.steps,.miles{break-inside:avoid}
  .sec:has(.steps),#acc-sec,.sec:has(.asp),.sec:has(#r-chart){break-inside:avoid}
  #assume{font-size:10.5px;margin-top:8px}
`;

const COMPLIANCE = 'All strategies and information provided on this website are general advice only and does not take into consideration any of your personal circumstances. Please arrange an appointment to seek personal financial and taxation advice prior to acting on this information. SmartMoney Wealth Management is the parent company of SmartMoney Financial Services Pty Ltd (ABN: 67 618 468 741) a Corporate Authorised Representative (No: 001265087) of Bluewater Financial Advisors Pty Ltd (ABN: 99 153 118 533) the holder of the Australian Financial Services Licence no. 411846. Copyright © SmartMoney Wealth Management. All Rights Reserved. Financial Services Guide: smartmoneygroup.com.au/wp-content/uploads/2026/05/FSG-V6.0.pdf';

const FOOTER = '<div style="width:100%;font:8px Arial;color:#8A8F8A;padding:0 12mm;display:flex;justify-content:space-between"><span>SmartMoney · Mortgage Freedom Report</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';

async function launch() {
  if (process.env.CHROME_PATH) {
    const puppeteer = require('puppeteer-core');
    return puppeteer.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  }
  const cm = await import('@sparticuz/chromium');
  const chromium = cm.default || cm;
  const pm = await import('puppeteer-core');
  const puppeteer = pm.default || pm;
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });
}

// answers: {first,last,email,balance,rate,repay,offset,savings,value,income,deps,debts}
async function renderPdf(answers) {
  const html = fs.readFileSync(path.join(__dirname, 'report.html'), 'utf8')
    .replace('<script>', '<script>window.MFC_PRELOAD=' + JSON.stringify(answers).replace(/</g, '\\u003c') + ';</script><script>');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Australia/Sydney');
    await page.setViewport({ width: 900, height: 1200 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 25000 });
    await page.waitForFunction('window.MFC_READY===true', { timeout: 10000 });
    await page.addStyleTag({ content: PRINT_CSS });
    await page.evaluate((t) => {
      const f = document.createElement('p');
      f.className = 'fine';
      f.style.cssText = 'font-size:10.5px;color:#5E6B60;margin-top:6px';
      f.textContent = t;
      document.getElementById('s-full').appendChild(f);
    }, COMPLIANCE);
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMediaType('print');
    const eligible = await page.evaluate(() => !document.getElementById('acc-sec').hidden);
    const pdf = await page.pdf({
      format: 'A4', scale: 0.9, printBackground: true,
      margin: { top: '10mm', bottom: '12mm', left: '0', right: '0' },
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: FOOTER,
    });
    return { pdf: Buffer.from(pdf), eligible };
  } finally {
    await browser.close();
  }
}

module.exports = { renderPdf };
