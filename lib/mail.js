// Send an internal email through GHL (finds or creates a GHL contact for the address).
import { ghl, LOCATION_ID } from './speed.js';

export async function contactIdFor(email, name) {
  const d = await ghl('GET', '/contacts/search/duplicate?' + new URLSearchParams({ locationId: LOCATION_ID, email }));
  if (d.contact && d.contact.id) return d.contact.id;
  const parts = String(name || 'Team Member').split(' ');
  const c = await ghl('POST', '/contacts/upsert', { locationId: LOCATION_ID, email, firstName: parts[0], lastName: parts.slice(1).join(' ') || 'Team', tags: ['internal-report'] });
  return (c.contact && c.contact.id) || c.id;
}
export async function sendEmail(email, name, subject, html) {
  const contactId = await contactIdFor(email, name);
  await ghl('POST', '/conversations/messages', { type: 'Email', contactId, subject, html, emailTo: email });
}
