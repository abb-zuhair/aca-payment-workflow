/**
 * Email notifications via Microsoft Graph (app-only / client credentials).
 *
 * Required env vars — if any is missing, emails are skipped and logged instead,
 * so the app works fine without email configured:
 *   MS_TENANT_ID      Entra tenant ID
 *   MS_CLIENT_ID      App registration (client) ID
 *   MS_CLIENT_SECRET  Client secret value
 *   MAIL_FROM         Mailbox to send from, e.g. payments@aca.edu.kw
 * Optional:
 *   APP_URL           Public URL of this app, used for links in emails
 */
const { audit } = require('./db');
const { getGraphToken } = require('./graph');

const CFG = {
  tenant: process.env.MS_TENANT_ID,
  clientId: process.env.MS_CLIENT_ID,
  clientSecret: process.env.MS_CLIENT_SECRET,
  from: process.env.MAIL_FROM,
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
};

function isConfigured() {
  return !!(CFG.tenant && CFG.clientId && CFG.clientSecret && CFG.from);
}


async function sendMail(toList, subject, html) {
  const to = (toList || []).filter(Boolean);
  if (!to.length) return { skipped: 'no recipients with email addresses' };
  if (!isConfigured()) return { skipped: 'email not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MAIL_FROM)' };
  const token = await getGraphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(CFG.from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: to.map(a => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: false,
    }),
  });
  if (res.status !== 202) {
    const body = await res.text();
    throw new Error('Graph sendMail failed (' + res.status + '): ' + body.slice(0, 200));
  }
  return { sent: to };
}

/* ---------- templates ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money(r) { return esc(r.currency) + ' ' + Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 }); }
function link(r) {
  if (!CFG.appUrl) return '';
  return `<p><a href="${CFG.appUrl}" style="background:#C9962C;color:#12283D;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">Open Payment Workflow</a></p>`;
}
function shell(title, rows, extra) {
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #DCD5C3;border-radius:10px;overflow:hidden;">
    <div style="background:#12283D;color:#F1EEE4;padding:14px 20px;border-bottom:3px solid #C9962C;">
      <b>Sama Educational Co.</b> — Payment Request Workflow
    </div>
    <div style="padding:20px;color:#212533;font-size:14px;">
      <h2 style="margin:0 0 12px;font-size:17px;color:#12283D;">${title}</h2>
      <table style="border-collapse:collapse;width:100%;font-size:13.5px;">
        ${rows.map(([k, v]) => `<tr><td style="padding:5px 10px 5px 0;color:#666B78;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:5px 0;"><b>${v}</b></td></tr>`).join('')}
      </table>
      ${extra || ''}
      ${link()}
      <p style="color:#666B78;font-size:12px;margin-bottom:0;">This is an automated message from the ACA payment approval system.</p>
    </div>
  </div>`;
}
function baseRows(r) {
  return [
    ['Reference', esc(r.id)],
    ['Requested by', esc(r.requestorName) + ' (' + esc(r.department) + ')'],
    ['Payee', esc(r.payeeName)],
    ['Amount', money(r)],
    ['Description', esc(r.description)],
  ];
}

const STAGE_LABELS = { accountant: 'Accountant', budget: 'Budget Supervisor', finance: 'Finance Manager' };

/**
 * Fire-and-forget notification; result recorded in the audit log.
 * kind: 'stage' | 'approved' | 'rejected'
 */
function notify(kind, r, recipients, detail) {
  let subject, html;
  if (kind === 'stage') {
    subject = `[Action needed] Payment request ${r.id} — awaiting ${STAGE_LABELS[detail.stage]} approval`;
    html = shell(`A payment request needs your approval (${STAGE_LABELS[detail.stage]})`, baseRows(r));
  } else if (kind === 'approved') {
    subject = `[Approved] Payment request ${r.id} — all approvals complete`;
    html = shell('All approvals complete — ready for printing & final signature', baseRows(r).concat([['Completed', esc(new Date(r.completedAt).toUTCString())]]),
      `<p>The form can now be printed from the Accountant's <b>Ready to print</b> tab for the final physical signature.</p>`);
  } else if (kind === 'rejected') {
    subject = `[Rejected] Payment request ${r.id} — at ${esc(r.rejectedStage)} stage`;
    html = shell('Payment request rejected', baseRows(r).concat([['Rejected at', esc(r.rejectedStage)], ['Reason', esc(r.rejectionReason)]]));
  } else return;

  sendMail(recipients, subject, html)
    .then(res => {
      if (res.skipped) audit(r.id, 'System', `Email skipped (${res.skipped}) — would notify: ${recipients.filter(Boolean).join(', ') || 'nobody'} — ${subject}`);
      else audit(r.id, 'System', `Email sent to ${res.sent.join(', ')} — ${subject}`);
    })
    .catch(err => audit(r.id, 'System', `Email FAILED (${err.message}) — intended for: ${recipients.filter(Boolean).join(', ')}`));
}

module.exports = { notify, isConfigured, mailFrom: () => CFG.from || null };
