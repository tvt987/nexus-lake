import type {
  SavedNotebook,
  SemanticCatalogHit,
  SqlPreset,
  TableSchemaInfo,
} from '../types/lakehouse';

const DIM = 128;

// Domain synonym expansion bridges natural queries ("fraud spikes by region")
// to exact lakehouse schema columns & OLAP presets cleanly without external APIs.
const DOMAIN_SYNONYMS: Record<string, string[]> = {
  fraud: ['anomaly', 'risk_score', 'is_anomaly', 'burst', 'abuse', 'flagged', 'suspicious'],
  spike: ['burst', 'cluster', 'anomaly', 'peak', 'window', 'rolling'],
  spikes: ['burst', 'cluster', 'anomaly', 'peak', 'window'],
  gian: ['fraud', 'anomaly', 'risk_score', 'burst'],
  lan: ['fraud', 'anomaly', 'risk_score'],
  voucher: ['voucher_code', 'redeem', 'abuse', 'promo', 'double'],
  latency: ['latency_ms', 'p99', 'p95', 'p50', 'sla', 'slow', 'quantile'],
  revenue: ['amount_usd', 'gross_volume_usd', 'volume', 'rollup', 'sales', 'ticket'],
  doanh: ['revenue', 'amount_usd', 'volume'],
  thu: ['revenue', 'amount_usd', 'volume'],
  region: ['region', 'apac', 'na', 'eu', 'store_id', 'geographic'],
  khu: ['region', 'store_id'],
  vuc: ['region', 'store_id'],
  moving: ['rolling', 'window', 'hourly', 'average', 'trend', 'time'],
  store: ['store_id', 'supermarket', 'pos', 'retail'],
};

function hashToken(token: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Deterministic 128-dimensional L2-normalized semantic vector encoder.
 * Combines word unigrams, character trigrams, and domain-aligned synonym projection.
 */
export function embedText128d(text: string): Float32Array {
  const vec = new Float32Array(DIM);
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .trim();

  if (!normalized) return vec;

  const words = normalized.split(/\s+/).filter(Boolean);

  const projectTerm = (term: string, weight: number) => {
    const h1 = hashToken(term, 17);
    const h2 = hashToken(term, 53);
    const idx1 = h1 % DIM;
    const idx2 = h2 % DIM;
    const sign1 = (h1 & 1) === 0 ? 1 : -1;
    const sign2 = (h2 & 1) === 0 ? 1 : -1;
    vec[idx1] += weight * sign1;
    vec[idx2] += weight * 0.7 * sign2;
  };

  for (const w of words) {
    projectTerm(w, 1.8);

    // Split snake_case identifiers into sub-tokens
    if (w.includes('_')) {
      for (const part of w.split('_')) {
        if (part.length > 1) projectTerm(part, 1.3);
      }
    }

    // Character 3-grams for fuzzy & morphological similarity
    if (w.length >= 3) {
      for (let i = 0; i <= w.length - 3; i += 1) {
        projectTerm(`#${w.slice(i, i + 3)}`, 0.45);
      }
    }

    // Domain synonym expansion
    const syns = DOMAIN_SYNONYMS[w];
    if (syns) {
      for (const syn of syns) {
        projectTerm(syn, 1.15);
      }
    }
  }

  // L2 normalize
  let normSq = 0;
  for (let i = 0; i < DIM; i += 1) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  if (norm > 1e-8) {
    for (let i = 0; i < DIM; i += 1) vec[i] /= norm;
  }
  return vec;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

interface IndexedEntry {
  hit: Omit<SemanticCatalogHit, 'score'>;
  vector: Float32Array;
}

export class LocalSemanticVectorIndex {
  private entries: IndexedEntry[] = [];

  public rebuild(
    tables: TableSchemaInfo[],
    presets: SqlPreset[],
    notebooks: SavedNotebook[],
  ): void {
    const next: IndexedEntry[] = [];

    for (const table of tables) {
      next.push({
        hit: {
          id: `tbl:${table.name}`,
          kind: 'table',
          title: table.name,
          subtitle: `${table.rowCount.toLocaleString()} rows · ${table.columns.length} cols`,
          sqlSnippet: `SELECT * FROM ${table.name} LIMIT 100;`,
        },
        vector: embedText128d(
          `table ${table.name} ${table.columns.map((c) => `${c.name} ${c.type}`).join(' ')}`,
        ),
      });

      for (const col of table.columns) {
        next.push({
          hit: {
            id: `col:${table.name}.${col.name}`,
            kind: 'column',
            title: `${table.name}.${col.name}`,
            subtitle: `${col.type} column in ${table.name}`,
            sqlSnippet: `SELECT ${col.name}, COUNT(*) AS cnt FROM ${table.name} GROUP BY ${col.name} ORDER BY cnt DESC LIMIT 20;`,
          },
          vector: embedText128d(`column ${col.name} ${col.type} table ${table.name}`),
        });
      }
    }

    for (const p of presets) {
      next.push({
        hit: {
          id: `preset:${p.id}`,
          kind: 'preset',
          title: p.label,
          subtitle: p.description,
          sqlSnippet: p.sql,
        },
        vector: embedText128d(`${p.label} ${p.shortTag} ${p.description} ${p.sql}`),
      });
    }

    for (const nb of notebooks) {
      next.push({
        hit: {
          id: `nb:${nb.id}`,
          kind: 'notebook',
          title: nb.title,
          subtitle: `Saved notebook · ${nb.tags.join(', ')}`,
          sqlSnippet: nb.sql,
        },
        vector: embedText128d(`${nb.title} ${nb.tags.join(' ')} ${nb.sql}`),
      });
    }

    this.entries = next;
  }

  public search(query: string, topK = 6): SemanticCatalogHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const qVec = embedText128d(trimmed);
    const scored: SemanticCatalogHit[] = this.entries.map((entry) => ({
      ...entry.hit,
      score: Number(Math.max(0, cosineSimilarity(qVec, entry.vector)).toFixed(3)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0.08).slice(0, topK);
  }
}
