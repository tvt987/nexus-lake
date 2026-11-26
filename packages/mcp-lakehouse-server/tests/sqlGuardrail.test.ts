import { describe, expect, it } from 'vitest';
import { validateReadOnlySql } from '../src/sqlGuardrail.js';

describe('SQL Read-Only AST Guardrail', () => {
  it('allows clean SELECT, WITH CTE, DESCRIBE, SHOW, and EXPLAIN statements', () => {
    const validQueries = [
      'SELECT region, COUNT(*) FROM transactions GROUP BY region;',
      'WITH top_risk AS (SELECT * FROM transactions WHERE risk_score > 0.8) SELECT * FROM top_risk LIMIT 20',
      'DESCRIBE transactions',
      'SHOW TABLES',
      'EXPLAIN SELECT * FROM transactions WHERE voucher_code = \'DROP TABLE\'',
    ];

    for (const q of validQueries) {
      const res = validateReadOnlySql(q);
      expect(res.allowed, `Expected allowed for: ${q}`).toBe(true);
    }
  });

  it('ignores forbidden words when safely inside string literals or comments', () => {
    const sql = `
      -- Note: do not DELETE old rows
      SELECT tx_id, voucher_code
      FROM transactions
      /* DROP TABLE comment ignored */
      WHERE voucher_code = 'DELETE_ME_VIP'
      LIMIT 10;
    `;
    const res = validateReadOnlySql(sql);
    expect(res.allowed).toBe(true);
    expect(res.detectedTables).toContain('transactions');
  });

  it('blocks DDL and DML mutations (DROP, DELETE, UPDATE, INSERT, ATTACH, COPY, PRAGMA)', () => {
    const malicious = [
      'DROP TABLE transactions',
      'DELETE FROM transactions WHERE risk_score < 0.1',
      'UPDATE transactions SET amount_usd = 0',
      "INSERT INTO transactions VALUES ('TX-1')",
      "ATTACH 'evil.db' AS evil",
      "COPY transactions TO '/tmp/leak.csv'",
      'PRAGMA enable_object_cache=true',
      "SELECT * FROM read_csv_auto('/etc/passwd')",
    ];

    for (const q of malicious) {
      const res = validateReadOnlySql(q);
      expect(res.allowed, `Expected blocked for: ${q}`).toBe(false);
      expect(res.reason).toBeTruthy();
    }
  });

  it('blocks stacked multi-statement SQL injection attempts', () => {
    const res = validateReadOnlySql('SELECT * FROM transactions LIMIT 5; DROP TABLE transactions;');
    expect(res.allowed).toBe(false);
    expect(res.statementType).toBe('MULTI_STATEMENT');
  });

  it('rejects empty queries and unterminated string literals', () => {
    expect(validateReadOnlySql('   -- only comment').allowed).toBe(false);
    expect(validateReadOnlySql("SELECT * FROM transactions WHERE region = 'APAC").allowed).toBe(false);
  });
});
