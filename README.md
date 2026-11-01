# SMWM Mortgage Freedom Report – PDF function

Called by the GHL workflow "MFC – 1" (Custom Webhook):

POST https://<your-project>.vercel.app/api/report?key=<MFC_SECRET>
Body: {"contactId":"{{contact.id}}"}

It reads the contact's calculator answers, builds the PDF, uploads it to the
Media Library and the contact's "SMWM Calc Report" field, writes the link to
"SMWM Calc Report URL" and adds the tag `smwm-calc-report-ready`.

Environment variables (Vercel → Settings → Environment Variables):
- GHL_TOKEN   = the "SMWM Calc PDF" private integration token
- MFC_SECRET  = any long random string (also used in the webhook URL)
