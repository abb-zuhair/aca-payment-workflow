/**
 * Attachment storage.
 *
 * Two backends, chosen by admin config (config key 'attachStore'):
 *  - local  (default): files live on the server disk under DATA_DIR/uploads
 *  - onedrive: files are uploaded to ONE shared OneDrive/SharePoint folder via
 *              Microsoft Graph, and only their drive item reference is kept in
 *              the DB — so Railway's disk isn't filled up.
 *
 * Existing local attachments keep working regardless of the current setting:
 * the serve path checks each attachment row for a drive/item id and streams
 * from OneDrive when present, else from local disk.
 *
 * Config shape:
 *   { mode:'local'|'onedrive', shareLink, driveId, itemId, folderName }
 * driveId/itemId identify the target FOLDER (resolved from the admin's share link).
 */
const fs = require('fs');
const { graphFetch, graphUploadFile, graphDownloadFile, graphConfigured } = require('./graph');
const { getConfig, setConfig } = require('./db');

const DEFAULT_ATTACH_STORE = { mode: 'local', shareLink: '', driveId: '', itemId: '', folderName: '' };

function getAttachStore() {
  return Object.assign({}, DEFAULT_ATTACH_STORE, getConfig('attachStore', {}));
}
function setAttachStore(c) { setConfig('attachStore', c); }

function encodeShareLink(url) {
  const b64 = Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return 'u!' + b64;
}
/* resolve a folder share link to its drive + item id (must be a FOLDER) */
async function resolveFolderLink(url) {
  const item = await graphFetch(`/shares/${encodeShareLink(url)}/driveItem?$select=id,name,folder,parentReference`);
  if (!item.folder) throw new Error('That link points to a file, not a folder. Share the folder that will hold attachments.');
  return { driveId: item.parentReference.driveId, itemId: item.id, folderName: item.name };
}

/* make a stable, identifiable filename for the shared folder */
function cloudName(requestId, idx, originalName) {
  const safe = String(originalName || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(-120);
  return `${requestId}__${idx}__${safe}`;
}

/**
 * Persist an uploaded file (multer temp file on disk) according to the current
 * store setting. Returns { path, driveId, itemId } to store in the attachments row.
 * In onedrive mode the local temp file is uploaded then deleted.
 */
async function persistUpload(file, requestId, idx) {
  const store = getAttachStore();
  if (store.mode === 'onedrive' && store.driveId && store.itemId) {
    const buf = fs.readFileSync(file.path);
    const uploaded = await graphUploadFile(store.driveId, store.itemId, cloudName(requestId, idx, file.originalname), buf, file.mimetype);
    try { fs.unlinkSync(file.path); } catch (e) {}
    return { path: '', driveId: store.driveId, itemId: uploaded.id };
  }
  /* local mode: keep multer's file on disk */
  return { path: file.path, driveId: null, itemId: null };
}

/* stream/serve an attachment row to an Express response */
async function serveAttachment(a, res) {
  if (a.drive_id && a.item_id) {
    const buf = await graphDownloadFile(a.drive_id, a.item_id);
    res.setHeader('Content-Type', a.type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.name)}"`);
    return res.end(buf);
  }
  if (!a.path || !fs.existsSync(a.path)) { res.status(410).send('File no longer available'); return; }
  res.setHeader('Content-Type', a.type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.name)}"`);
  fs.createReadStream(a.path).pipe(res);
}

module.exports = {
  getAttachStore, setAttachStore, resolveFolderLink,
  persistUpload, serveAttachment, graphConfigured,
  DEFAULT_ATTACH_STORE,
};
