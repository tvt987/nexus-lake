import type { GenerativeWidget, SavedNotebook, StorageTelemetry } from '../types/lakehouse';

const DB_NAME = 'nexus-lake-local-v1';
const DB_VERSION = 1;
const STORE_NOTEBOOKS = 'notebooks';
const STORE_WIDGETS = 'widgets';
const STORE_META = 'meta';

export interface UploadedTableMeta {
  name: string;
  rowCount: number;
  uploadedAt: string;
}

const DEFAULT_NOTEBOOKS: SavedNotebook[] = [
  {
    id: 'nb-fraud-triage',
    title: 'APAC-VN Voucher Fraud Triage',
    sql: `SELECT
  store_id,
  voucher_code,
  COUNT(*) AS flagged_txs,
  ROUND(SUM(amount_usd), 2) AS exposure_usd,
  ROUND(AVG(risk_score), 4) AS avg_risk
FROM transactions
WHERE region = 'APAC-VN' AND is_anomaly = true
GROUP BY store_id, voucher_code
ORDER BY exposure_usd DESC
LIMIT 25;`,
    updatedAt: '2026-11-26T09:15:00Z',
    tags: ['fraud', 'voucher', 'apac-vn'],
  },
  {
    id: 'nb-sla-audit',
    title: 'P99 Latency SLA Breach Audit',
    sql: `SELECT
  region,
  COUNT(*) AS total_txs,
  ROUND(QUANTILE_CONT(latency_ms, 0.99), 1) AS p99_ms,
  SUM(CASE WHEN latency_ms > 250 THEN 1 ELSE 0 END) AS sla_breaches
FROM transactions
GROUP BY region
ORDER BY p99_ms DESC;`,
    updatedAt: '2026-11-26T08:40:00Z',
    tags: ['latency', 'p99', 'sla'],
  },
];

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NOTEBOOKS)) {
          db.createObjectStore(STORE_NOTEBOOKS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_WIDGETS)) {
          db.createObjectStore(STORE_WIDGETS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function putIntoStore<T>(storeName: string, value: T): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function deleteFromStore(storeName: string, key: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadSavedNotebooks(): Promise<SavedNotebook[]> {
  const existing = await getAllFromStore<SavedNotebook>(STORE_NOTEBOOKS);
  if (existing.length > 0) {
    return existing.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  for (const nb of DEFAULT_NOTEBOOKS) {
    await putIntoStore(STORE_NOTEBOOKS, nb);
  }
  return [...DEFAULT_NOTEBOOKS];
}

export async function saveNotebook(nb: SavedNotebook): Promise<void> {
  await putIntoStore(STORE_NOTEBOOKS, nb);
}

export async function deleteNotebook(id: string): Promise<void> {
  await deleteFromStore(STORE_NOTEBOOKS, id);
}

export async function loadPinnedWidgets(): Promise<GenerativeWidget[]> {
  return getAllFromStore<GenerativeWidget>(STORE_WIDGETS);
}

export async function savePinnedWidget(widget: GenerativeWidget): Promise<void> {
  await putIntoStore(STORE_WIDGETS, widget);
}

export async function removePinnedWidget(id: string): Promise<void> {
  await deleteFromStore(STORE_WIDGETS, id);
}

export async function recordUploadedTableMeta(meta: UploadedTableMeta): Promise<void> {
  await putIntoStore(STORE_META, { key: `upload:${meta.name}`, ...meta });
}

export async function clearAllLocalStorage(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_NOTEBOOKS, STORE_WIDGETS, STORE_META], 'readwrite');
      tx.objectStore(STORE_NOTEBOOKS).clear();
      tx.objectStore(STORE_WIDGETS).clear();
      tx.objectStore(STORE_META).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getStorageTelemetry(): Promise<StorageTelemetry> {
  const [notebooks, widgets, metas] = await Promise.all([
    getAllFromStore<SavedNotebook>(STORE_NOTEBOOKS),
    getAllFromStore<GenerativeWidget>(STORE_WIDGETS),
    getAllFromStore<{ key: string }>(STORE_META),
  ]);

  let hasOpfs = false;
  let usageBytes = 0;
  let quotaBytes = 0;

  if (typeof navigator !== 'undefined' && navigator.storage) {
    try {
      if (typeof navigator.storage.getDirectory === 'function') {
        await navigator.storage.getDirectory();
        hasOpfs = true;
      }
      if (typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        usageBytes = est.usage ?? 0;
        quotaBytes = est.quota ?? 0;
      }
    } catch {
      // OPFS/Storage estimate unavailable in restricted mode
    }
  }

  const backend: StorageTelemetry['backend'] =
    typeof indexedDB === 'undefined'
      ? 'Memory'
      : hasOpfs
        ? 'IndexedDB + OPFS'
        : 'IndexedDB';

  return {
    backend,
    notebooksCount: notebooks.length,
    uploadedTablesCount: metas.filter((m) => m.key.startsWith('upload:')).length,
    pinnedWidgetsCount: widgets.length,
    usageBytes,
    quotaBytes,
  };
}
