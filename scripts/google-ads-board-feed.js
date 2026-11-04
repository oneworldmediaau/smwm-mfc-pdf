/**
 * SmartMoney board report: Google Ads spend feed.
 * Paste into Google Ads → Tools → Bulk actions → Scripts → (+) New script, authorise, then schedule it Hourly.
 * Works in a single Google Ads account, or in a manager (MCC) account (it sends every account under it).
 * Each run sends daily campaign cost, clicks and conversions to the board report. The first run sends
 * everything since 1 Nov 2025; after that it re-sends the last 30 days (Google revises recent numbers).
 */
var ENDPOINT = 'https://smwm-mfc-pdf-five.vercel.app/api/board';
var KEY = '5273e34e21c89c9b3177b7c1f1db544c18867939';

function main() {
  if (typeof AdsManagerApp !== 'undefined') {
    var it = AdsManagerApp.accounts().get();
    while (it.hasNext()) { var a = it.next(); AdsManagerApp.select(a); sendAccount(); }
  } else {
    sendAccount();
  }
}

function call(method, action, query, payload) {
  var opts = { method: method, muteHttpExceptions: true, contentType: 'application/json', headers: { Authorization: 'Bearer ' + KEY } };
  if (payload) opts.payload = JSON.stringify(payload);
  var r = UrlFetchApp.fetch(ENDPOINT + '?a=' + action + (query || ''), opts);
  if (r.getResponseCode() !== 200) throw new Error('Board report said ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText());
}

function sendAccount() {
  var acc = AdsApp.currentAccount();
  var account = { id: acc.getCustomerId(), name: acc.getName() };
  var range = call('get', 'since', '&account=' + encodeURIComponent(account.id));
  var q = 'SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions ' +
    'FROM campaign WHERE segments.date BETWEEN "' + range.since + '" AND "' + range.until + '"';
  var rows = [], it = AdsApp.search(q);
  while (it.hasNext()) {
    var r = it.next();
    rows.push({ campaign_id: String(r.campaign.id), campaign_name: r.campaign.name, status: r.campaign.status, day: r.segments.date,
      spend: Number(r.metrics.costMicros || 0) / 1e6, impressions: Number(r.metrics.impressions || 0), clicks: Number(r.metrics.clicks || 0),
      conversions: Number(r.metrics.conversions || 0) });
  }
  for (var i = 0; i < rows.length; i += 2000) call('post', 'ingest', '', { account: account, rows: rows.slice(i, i + 2000) });
  Logger.log(account.name + ': sent ' + rows.length + ' rows (' + range.since + ' to ' + range.until + ')');
}
