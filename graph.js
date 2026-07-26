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

/* upload raw bytes (PUT file content). Returns the created driveItem JSON.
   For files up to ~4MB a simple PUT works; larger files use an upload session. */
async function graphUploadFile(driveId, parentItemId, fileName, buffer, contentType) {
  const token = await getGraphToken();
  const safeName = encodeURIComponent(fileName);
  if (buffer.length <= 4 * 1024 * 1024) {
    const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}:/${safeName}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType || 'application/octet-stream' },
      body: buffer,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Graph upload failed (${res.status}): ${JSON.stringify(data.error || data).slice(0, 300)}`);
    return data;
  }
  /* large file: create an upload session and send in chunks */
  const sess = await graphFetch(`/drives/${driveId}/items/${parentItemId}:/${safeName}:/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  });
  const uploadUrl = sess.uploadUrl;
  const chunkSize = 5 * 1024 * 1024;
  let start = 0;
  let last = null;
  while (start < buffer.length) {
    const end = Math.min(start + chunkSize, buffer.length);
    const chunk = buffer.slice(start, end);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      },
      body: chunk,
    });
    last = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(`Graph chunk upload failed (${res.status})`);
    start = end;
  }
  return last;
}

/* download raw bytes of a drive item; returns a Buffer */
async function graphDownloadFile(driveId, itemId) {
  const token = await getGraphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`Graph download failed (${res.status})`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

module.exports = { graphConfigured, getGraphToken, graphFetch, graphUploadFile, graphDownloadFile };
