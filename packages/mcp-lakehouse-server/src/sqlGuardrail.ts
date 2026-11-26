export interface SqlGuardrailResult {
  allowed: boolean;
  statementType: string;
  normalizedSql: string;
  detectedTables: string[];
  reason?: string;
  blockedKeyword?: string;
}

const ALLOWED_LEADING_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'DESCRIBE',
  'SHOW',
]);

const FORBIDDEN_KEYWORDS = new Set([
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'ATTACH',
  'DETACH',
  'COPY',
  'EXPORT',
  'IMPORT',
  'INSTALL',
  'LOAD',
  'PRAGMA',
  'CALL',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'SET',
  'COMMIT',
  'ROLLBACK',
  'BEGIN',
  'TRANSACTION',
  'OUTFILE',
  'DUMPFILE',
]);

interface Token {
  type: 'word' | 'string' | 'semicolon' | 'symbol';
  value: string;
}

/**
 * Lexical tokenizer that strips SQL comments (-- and /* ... *\/)
 * while accurately preserving single- and double-quoted literals.
 */
function tokenizeSql(sql: string): { tokens: Token[]; unterminatedError?: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // Whitespace
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Single-line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i + 1 < n) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        return { tokens, unterminatedError: 'Unterminated block comment in SQL query.' };
      }
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      let literal = "'";
      i += 1;
      let closed = false;
      while (i < n) {
        literal += sql[i];
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            literal += "'";
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        return { tokens, unterminatedError: 'Unterminated string literal in SQL query.' };
      }
      tokens.push({ type: 'string', value: literal });
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      let ident = '';
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') {
            ident += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        ident += sql[i];
        i += 1;
      }
      if (!closed) {
        return { tokens, unterminatedError: 'Unterminated quoted identifier in SQL query.' };
      }
      tokens.push({ type: 'word', value: ident });
      continue;
    }

    // Semicolon
    if (ch === ';') {
      tokens.push({ type: 'semicolon', value: ';' });
      i += 1;
      continue;
    }

    // Word / identifier / keyword
    if (/[A-Za-z_]/.test(ch)) {
      let word = '';
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) {
        word += sql[i];
        i += 1;
      }
      tokens.push({ type: 'word', value: word });
      continue;
    }

    // Numbers or symbols
    tokens.push({ type: 'symbol', value: ch });
    i += 1;
  }

  return { tokens };
}

/**
 * Enforces strict read-only SQL execution policy for MCP lakehouse queries.
 * Blocks DDL, DML, multi-statement stacking, file exfiltration, and unsafe functions.
 */
export function validateReadOnlySql(rawSql: string, maxLength = 8000): SqlGuardrailResult {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    return {
      allowed: false,
      statementType: 'EMPTY',
      normalizedSql: '',
      detectedTables: [],
      reason: 'SQL query cannot be empty.',
    };
  }

  if (trimmed.length > maxLength) {
    return {
      allowed: false,
      statementType: 'OVERSIZED',
      normalizedSql: '',
      detectedTables: [],
      reason: `SQL query exceeds maximum allowed length of ${maxLength} characters.`,
    };
  }

  const { tokens, unterminatedError } = tokenizeSql(trimmed);
  if (unterminatedError) {
    return {
      allowed: false,
      statementType: 'MALFORMED',
      normalizedSql: '',
      detectedTables: [],
      reason: unterminatedError,
    };
  }

  if (tokens.length === 0) {
    return {
      allowed: false,
      statementType: 'EMPTY',
      normalizedSql: '',
      detectedTables: [],
      reason: 'SQL query contains only comments or whitespace.',
    };
  }

  // Reject multi-statement stacked queries (only allow a single optional trailing semicolon)
  const semicolonIndices = tokens
    .map((t, idx) => (t.type === 'semicolon' ? idx : -1))
    .filter((idx) => idx !== -1);

  if (
    semicolonIndices.length > 1 ||
    (semicolonIndices.length === 1 && semicolonIndices[0] !== tokens.length - 1)
  ) {
    return {
      allowed: false,
      statementType: 'MULTI_STATEMENT',
      normalizedSql: trimmed,
      detectedTables: [],
      reason: 'Stacked multi-statement SQL execution is strictly forbidden.',
      blockedKeyword: ';',
    };
  }

  const meaningfulTokens =
    semicolonIndices.length === 1 ? tokens.slice(0, tokens.length - 1) : tokens;

  const firstWord = meaningfulTokens.find((t) => t.type === 'word');
  const statementType = firstWord ? firstWord.value.toUpperCase() : 'UNKNOWN';

  if (!ALLOWED_LEADING_KEYWORDS.has(statementType)) {
    return {
      allowed: false,
      statementType,
      normalizedSql: trimmed,
      detectedTables: [],
      reason: `Statement type "${statementType}" is not permitted in read-only lakehouse mode. Allowed: SELECT, WITH, EXPLAIN, DESCRIBE, SHOW.`,
      blockedKeyword: statementType,
    };
  }

  // Scan all non-string word tokens for forbidden keywords or dangerous DuckDB file/network readers
  const detectedTables = new Set<string>();

  for (let i = 0; i < meaningfulTokens.length; i += 1) {
    const tok = meaningfulTokens[i];
    if (tok.type !== 'word') continue;

    const upper = tok.value.toUpperCase();

    if (FORBIDDEN_KEYWORDS.has(upper)) {
      return {
        allowed: false,
        statementType,
        normalizedSql: trimmed,
        detectedTables: [...detectedTables],
        reason: `Forbidden SQL keyword "${upper}" detected by read-only AST guardrail.`,
        blockedKeyword: upper,
      };
    }

    // Block DuckDB external file/HTTP exfiltration functions
    if (
      upper.startsWith('READ_CSV') ||
      upper.startsWith('READ_PARQUET') ||
      upper.startsWith('READ_JSON') ||
      upper === 'HTTP_GET' ||
      upper === 'GLOB'
    ) {
      return {
        allowed: false,
        statementType,
        normalizedSql: trimmed,
        detectedTables: [...detectedTables],
        reason: `External I/O function "${upper}" is disabled in sandboxed MCP queries.`,
        blockedKeyword: upper,
      };
    }

    if ((upper === 'FROM' || upper === 'JOIN') && i + 1 < meaningfulTokens.length) {
      const nextTok = meaningfulTokens[i + 1];
      if (nextTok.type === 'word' && nextTok.value.toUpperCase() !== 'SELECT') {
        detectedTables.add(nextTok.value.toLowerCase());
      }
    }
  }

  const normalizedSql = trimmed.replace(/;\s*$/, '');

  return {
    allowed: true,
    statementType,
    normalizedSql,
    detectedTables: [...detectedTables],
  };
}
