// POST /api/report?key=MFC_SECRET   body: {"contactId":"..."}  (sent by the GHL "MFC – 1" Custom Webhook)
// 1. reads the contact's calculator answers from GHL
// 2. renders the Mortgage Freedom Report PDF
// 3. uploads it to the Media Library (public link) and to the contact's "SMWM Calc Report" file field
// 4. writes the link to "SMWM Calc Report URL" and adds the tag smwm-calc-report-ready
const { renderPdf } = require('../lib/render');

const API = 'https://services.leadconnectorhq.com';
const LOCATION_ID = 'BOPw9TAczSRgLZCpM1Ur';
const F = {
  balance: 'MVSH3JBREFhGkE7XQ9xj', rate: 'aW51vZ1br49ftLMGrrvm', repay: '0Ce2Sb9IKQWZmyFecyhG',
  offset: 'FtMJa2zAf09bIcxiut67', savings: 'KXalSfOaDFjYQWlNHO4Q', value: 'xr9P3Sq4bZ5Ht60imhJx',
  income: 'HBXMlAuh2oj1EbXTmu3m', deps: 'LEQ8lzDBhH0pO1FE4fNw', debts: 'Jaov5G1p9Cy3X11xOn7R',
  reportFile: 'EMUFz2LOceqXpWatpDF9', reportUrl: 'MlZ6WA0pXS9FczyzhnSM',
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

module.exports = async (req, res) => {
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
    await ghl('POST', '/contacts/' + contactId + '/tags', { tags: ['smwm-calc-report-ready'] });

    return res.status(200).json({ ok: true, url, eligible, fileSaved });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
