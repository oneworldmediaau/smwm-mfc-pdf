// POST /api/report?key=MFC_SECRET   body: {"contactId":"..."}  (sent by the GHL "MFC – 1" Custom Webhook)
// 1. reads the contact's calculator answers from GHL
// 2. renders the Mortgage Freedom Report PDF
// 3. uploads it to the Media Library (public link) and to the contact's "SMWM Calc Report" file field
// 4. adds a results note to the contact
// 5. writes the link to "SMWM Calc Report URL" and adds the tag smwm-calc-report-ready
import { renderPdf } from '../lib/render.js';

const API = 'https://services.leadconnectorhq.com';
const LOCATION_ID = 'BOPw9TAczSRgLZCpM1Ur';
const F = {
  balance: 'MVSH3JBREFhGkE7XQ9xj', rate: 'aW51vZ1br49ftLMGrrvm', repay: '0Ce2Sb9IKQWZmyFecyhG',
  offset: 'FtMJa2zAf09bIcxiut67', savings: 'KXalSfOaDFjYQWlNHO4Q', value: 'xr9P3Sq4bZ5Ht60imhJx',
  income: 'HBXMlAuh2oj1EbXTmu3m', deps: 'LEQ8lzDBhH0pO1FE4fNw', debts: 'Jaov5G1p9Cy3X11xOn7R',
  reportFile: 'EMUFz2LOceqXpWatpDF9', reportUrl: 'MlZ6WA0pXS9FczyzhnSM',
  today: 'K5IQnOuWpiRC7hT8MT4W', free: 'T4w2fjc6frRCIYABakM9', yrs: '72CfaKVZqnv1FEpdwZkz',
  isaved: 'TezvL73i52wmUGsazqxu', total: 'dVneqszJbeVSQV9LW1Vt',
};

function headers(extra) {
  return Object.assign({ Authorization: 'Bearer ' + process.env.GHL_TOKEN, Version: '2021-07-28', Accept: 'application/json' }, extra || {});
}
async function ghl(method, path, body, isForm) {
  const res = await fetch(API + path, {
    method,
    headers: headers(isForm || !body ? {} : { 'Content-Type': 'application/json' }),
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + text.slice(0, 300));
  return data;
}

export default async function handler(req, res) {
  return run(req, res);
}
const run = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!process.env.MFC_SECRET || req.query.key !== process.env.MFC_SECRET) return res.status(401).json({ error: 'bad key' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const contactId = body.contactId || body.contact_id || req.query.contactId;
    if (!contactId) return res.status(400).json({ error: 'contactId missing' });

    const { contact } = await ghl('GET', '/contacts/' + contactId);
    const cf = {}; (contact.customFields || []).forEach((f) => { cf[f.id] = f.value; });
    const n = (id) => { const v = cf[id]; return v === undefined || v === null || v === '' ? null : +String(v).replace(/[^0-9.]/g, ''); };
    const answers = {
      first: contact.firstNameRaw || contact.firstName || '', last: contact.lastNameRaw || contact.lastName || '', email: contact.email || '',
      balance: n(F.balance), rate: n(F.rate), repay: n(F.repay), offset: n(F.offset) || 0, savings: n(F.savings) || 0,
      value: n(F.value), income: n(F.income), deps: cf[F.deps] || '0', debts: n(F.debts) || 0,
    };
    if (!answers.balance || !answers.rate || !answers.value || !answers.income) return res.status(422).json({ error: 'calculator answers missing on contact', answers });

    const { pdf, eligible } = await renderPdf(answers);
    const fileName = ('Mortgage Freedom Report - ' + answers.first + ' ' + answers.last).replace(/[^\w\- ]/g, '').trim() + '.pdf';

    // Media Library upload -> public link for the email
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), fileName);
    fd.append('name', fileName);
    const media = await ghl('POST', '/medias/upload-file', fd, true);
    const url = media.url || media.fileUrl || (media.data && media.data.url);

    // Contact file field (shows on the contact record). Non-fatal if it fails.
    let fileSaved = true;
    try {
      const fd2 = new FormData();
      fd2.append(F.reportFile + '_' + Date.now(), new Blob([pdf], { type: 'application/pdf' }), fileName);
      await ghl('POST', '/forms/upload-custom-files?contactId=' + contactId + '&locationId=' + LOCATION_ID, fd2, true);
    } catch (e) { fileSaved = false; console.error('file field upload failed', e.message); }

    await ghl('PUT', '/contacts/' + contactId, { customFields: [{ id: F.reportUrl, field_value: url || '' }] });

    // Results note on the contact (non-fatal)
    let noteSaved = true;
    try {
      const $ = (v) => (v == null || v === '' ? '–' : '$' + Math.round(+v).toLocaleString('en-AU'));
      const s = (id) => (cf[id] == null || cf[id] === '' ? '–' : String(cf[id]));
      const when = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const note = [
        'MORTGAGE FREEDOM CALCULATOR – ' + when,
        'Result: ' + (eligible ? 'QUALIFIED for the Mortgage Accelerator' : 'Not eligible – three levers only (info report)'),
        '',
        'THEIR ANSWERS',
        'Loan balance: ' + $(answers.balance),
        'Interest rate: ' + answers.rate + '%',
        'Monthly repayment: ' + $(answers.repay),
        'Offset: ' + $(answers.offset),
        'Other savings: ' + $(answers.savings),
        'Home value (their estimate): ' + $(answers.value),
        'Household income: ' + $(answers.income),
        'Dependants: ' + answers.deps,
        'Other loan repayments: ' + $(answers.debts) + ' a month',
        '',
        'THEIR RESULTS',
        "Today's path – debt-free: " + s(F.today),
        (eligible ? 'With the Mortgage Accelerator: ' : 'With the 3 levers: ') + s(F.free),
        'Years sooner: ' + s(F.yrs),
        'Interest saved: ' + $(cf[F.isaved]),
        'Total cost of loan today (balance + interest): ' + $(cf[F.total]),
        'Usable equity (80% LVR): ' + $(Math.max(0, answers.value * 0.8 - answers.balance)),
        '',
        'Report: ' + (url || '–'),
      ].join('\n');
      await ghl('POST', '/contacts/' + contactId + '/notes', { body: note });
    } catch (e) { noteSaved = false; console.error('note failed', e.message); }
    await ghl('POST', '/contacts/' + contactId + '/tags', { tags: ['smwm-calc-report-ready'] });

    return res.status(200).json({ ok: true, url, eligible, fileSaved, noteSaved });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
