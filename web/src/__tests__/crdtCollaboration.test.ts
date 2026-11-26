import { describe, expect, it } from 'vitest';
import { SplitPeerCrdtController } from '../engine/crdtCollaboration';

describe('SplitPeerCrdtController (Yjs CRDT + Offline Partition)', () => {
  it('synchronizes edits instantaneously when online', () => {
    const crdt = new SplitPeerCrdtController('SELECT 1;');
    crdt.applyTextEdit('saigon', 'SELECT 1, region FROM transactions;');

    const snap = crdt.getSnapshots();
    expect(snap.isDiverged).toBe(false);
    expect(snap.peerA.sqlText).toBe('SELECT 1, region FROM transactions;');
    expect(snap.peerB.sqlText).toBe('SELECT 1, region FROM transactions;');
    crdt.dispose();
  });

  it('diverges during offline partition and converges losslessly on CRDT reconnect', () => {
    const crdt = new SplitPeerCrdtController('SELECT * FROM transactions;');
    crdt.severNetworkLink();
    expect(crdt.isPartitioned()).toBe(true);

    // Concurrent conflicting edits on both independent Y.Doc instances
    crdt.applyTextEdit('saigon', '-- SAIGON_TAG\nSELECT * FROM transactions;');
    crdt.applyTextEdit('san-francisco', 'SELECT * FROM transactions;\n-- SF_TAG');

    const diverged = crdt.getSnapshots();
    expect(diverged.isDiverged).toBe(true);
    expect(diverged.peerA.pendingLocalOps).toBeGreaterThan(0);
    expect(diverged.peerB.pendingLocalOps).toBeGreaterThan(0);

    const report = crdt.reconnectAndSync();
    expect(report.converged).toBe(true);
    expect(report.totalMergedBytes).toBeGreaterThan(0);

    const converged = crdt.getSnapshots();
    expect(converged.isDiverged).toBe(false);
    expect(converged.peerA.sqlText).toBe(converged.peerB.sqlText);
    expect(converged.peerA.sqlText).toContain('SAIGON_TAG');
    expect(converged.peerA.sqlText).toContain('SF_TAG');
    crdt.dispose();
  });
});
