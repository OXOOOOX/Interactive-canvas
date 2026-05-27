const DB_NAME = 'dream-catcher-file-store';
const DB_VERSION = 1;
const FILE_STORE = 'files';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function putRecord(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

async function getRecord(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const req = tx.objectStore(FILE_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function fileToMeta(file, mode, id = crypto.randomUUID()) {
  return {
    id,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    mode,
    status: 'ready',
    pathLabel: file.webkitRelativePath || file.name,
    updatedAt: Date.now(),
  };
}

function inferMimeType(name = '') {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  return 'application/octet-stream';
}

export function supportsMappedFiles() {
  return typeof window.showOpenFilePicker === 'function';
}

export async function createCopyAttachment(file) {
  const meta = fileToMeta(file, 'copy');
  await putRecord({ ...meta, blob: file, handle: null, broken: false });
  return meta;
}

export async function createMappedAttachment() {
  if (!supportsMappedFiles()) {
    throw new Error('当前浏览器不支持映射模式');
  }

  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: 'PDF、图片和常用文件',
        accept: {
          'application/pdf': ['.pdf'],
          'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'],
          'text/*': ['.txt', '.md', '.csv'],
        },
      },
    ],
  });
  let file = null;
  try {
    file = await handle.getFile();
  } catch (err) {
    const meta = {
      id: crypto.randomUUID(),
      name: handle.name || '映射文件',
      type: inferMimeType(handle.name),
      size: 0,
      mode: 'mapped',
      status: 'permission-blocked',
      pathLabel: handle.name || '浏览器未开放完整路径',
      updatedAt: Date.now(),
    };
    await putRecord({ ...meta, blob: null, handle, broken: false, lastError: err?.message || 'getFile blocked' });
    return meta;
  }

  const meta = fileToMeta(file, 'mapped');
  await putRecord({ ...meta, blob: file, handle, broken: false });
  return meta;
}

export async function listAttachments() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const req = tx.objectStore(FILE_STORE).getAll();
    req.onsuccess = () => {
      const records = (req.result || [])
        .map(({ blob, handle, ...meta }) => meta)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(records);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateAttachmentBlob(attachmentId, blob, updates = {}) {
  const record = await getRecord(attachmentId);
  if (!record) {
    throw new Error('附件不存在');
  }
  const nextRecord = {
    ...record,
    ...updates,
    blob,
    size: blob?.size || updates.size || record.size || 0,
    type: updates.type || blob?.type || record.type,
    mode: updates.mode || 'copy',
    status: updates.status || 'ready',
    broken: false,
    handle: updates.handle === undefined ? null : updates.handle,
    updatedAt: Date.now(),
  };
  await putRecord(nextRecord);
  const { blob: _blob, handle: _handle, ...meta } = nextRecord;
  return meta;
}

export async function getAttachmentFile(attachmentId) {
  const record = await getRecord(attachmentId);
  if (!record) {
    return { file: null, record: null, status: 'missing' };
  }

  if (record.mode === 'mapped' && record.handle) {
    try {
      const file = await record.handle.getFile();
      const nextRecord = {
        ...record,
        blob: file,
        name: file.name,
        type: file.type || record.type,
        size: file.size,
        status: 'ready',
        pathLabel: file.webkitRelativePath || record.pathLabel || file.name,
        broken: false,
        updatedAt: Date.now(),
      };
      await putRecord(nextRecord);
      return { file, record: nextRecord, status: 'mapped' };
    } catch (err) {
      const fallback = record.blob
        ? { ...record, mode: 'copy', status: 'broken-copy', broken: true, brokenAt: Date.now(), handle: null, lastError: err?.message || 'getFile blocked' }
        : { ...record, status: 'permission-blocked', broken: false, lastError: err?.message || 'getFile blocked' };
      await putRecord(fallback);
      return { file: record.blob || null, record: fallback, status: fallback.status };
    }
  }

  return { file: record.blob || null, record, status: record.status || (record.broken ? 'broken-copy' : 'copy') };
}
