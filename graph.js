/**
 * Shared Microsoft Graph app-only token client.
 * Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
 */
const CFG = {
  tenant: process.env.MS_TENANT_ID,
  clientId: process.env.MS_CLIENT_ID,
  clientSecret: process.env.MS_CLIENT_SECRET,
};

function graphConfigured() {
  return !!(CFG.tenant && CFG.clientId && CFG.clientSecret);
}

let tokenCache = { token: null, exp: 0 };
async function getGraphToken() {
  if (!graphConfigured()) throw new Error('Microsoft Graph is not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)');
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch(`https://login.microsoftonline.com/${CFG.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token request failed: ' + (data.error_description || res.status));
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in * 1000) };
  return tokenCache.token;
}

async function graphFetch(pathOrUrl, opts = {}) {
  const token = await getGraphToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : 'https://graph.microsoft.com/v1.0' + pathOrUrl;
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}),
  }));
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph ${opts.method || 'GET'} ${pathOrUrl} failed (${res.status}): ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return data;
}

module.exports = { graphConfigured, getGraphToken, graphFetch };
