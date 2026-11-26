import React, { useMemo, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

interface VirtualResultsTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  heightClass?: string;
}

function formatCell(col: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-[var(--text-muted)] italic">NULL</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span
        className={`px-1.5 py-0.5 rounded font-mono-tech text-[10px] ${
          value
            ? 'bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
            : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
        }`}
      >
        {value ? 'TRUE' : 'FALSE'}
      </span>
    );
  }
  if (typeof value === 'number') {
    if (col.includes('risk')) {
      const high = value >= 0.75;
      return (
        <span
          className={`font-mono-tech ${
            high ? 'text-[var(--accent-signal)] font-semibold' : 'text-[var(--text-primary)]'
          }`}
        >
          {value.toFixed(4)}
        </span>
      );
    }
    if (col.includes('usd') || col.includes('amount') || col.includes('volume')) {
      return (
        <span className="font-mono-tech text-[var(--text-primary)]">
          ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      );
    }
    if (col.includes('pct') || col.includes('rate')) {
      return <span className="font-mono-tech text-[var(--accent-cyan)]">{value.toFixed(2)}%</span>;
    }
    return <span className="font-mono-tech">{value.toLocaleString('en-US')}</span>;
  }
  return <span className="font-mono-tech text-[var(--text-secondary)]">{String(value)}</span>;
}

export const VirtualResultsTable: React.FC<VirtualResultsTableProps> = ({
  columns,
  rows,
  heightClass = 'h-[260px]',
}) => {
  const [sorting, setSorting] = useState<SortingState>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columns.map((col) => ({
        id: col,
        accessorFn: (row) => row[col],
        header: col,
        cell: (info) => formatCell(col, info.getValue()),
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  if (columns.length === 0) {
    return (
      <div
        className={`${heightClass} flex items-center justify-center text-xs font-mono-tech text-[var(--text-muted)]`}
      >
        Execute a SQL query to inspect vectorized results.
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0;

  return (
    <div
      ref={scrollContainerRef}
      data-testid="virtual-results-grid"
      className={`${heightClass} overflow-auto relative bg-[var(--bg-inset)]`}
    >
      <table className="w-full border-collapse text-left text-[11px]">
        <thead className="sticky top-0 z-10 bg-[var(--bg-elevated)] nexus-hairline-b">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="px-3 py-2 font-mono-tech text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] whitespace-nowrap cursor-pointer select-none border-r border-[var(--border-hairline)] last:border-r-0"
                  >
                    <div className="flex items-center gap-1">
                      <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      {sorted === 'asc' ? (
                        <ArrowUp className="w-3 h-3 text-[var(--accent-cyan)]" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="w-3 h-3 text-[var(--accent-signal)]" />
                      ) : (
                        <ArrowUpDown className="w-2.5 h-2.5 opacity-40" />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr>
              <td style={{ height: `${paddingTop}px` }} colSpan={columns.length} />
            </tr>
          )}
          {virtualItems.map((vRow) => {
            const row = tableRows[vRow.index];
            return (
              <tr
                key={row.id}
                className="border-b border-[var(--border-hairline)] hover:bg-[var(--bg-elevated)] transition-colors"
                style={{ height: '30px' }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="px-3 py-1 whitespace-nowrap border-r border-[var(--border-hairline)] last:border-r-0"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr>
              <td style={{ height: `${paddingBottom}px` }} colSpan={columns.length} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
