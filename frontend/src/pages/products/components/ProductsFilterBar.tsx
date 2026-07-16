import { useEffect, useState } from 'react';
import { Button, Card, Input, Select } from '@/components/ui';
import { MARKETPLACE_OPTIONS } from '@/domain/marketplace';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { ProductFilters } from '@/hooks/useProductsQueryParams';
import type { Marketplace } from '@/types/api';

const STOCK_OPTIONS = [
  { value: 'true' as const, label: 'In stock' },
  { value: 'false' as const, label: 'Out of stock' },
];

export function ProductsFilterBar({
  filters,
  onChange,
  onReset,
  hasActiveFilters,
  isRefreshing,
}: {
  filters: ProductFilters;
  onChange: (patch: Partial<ProductFilters>, opts?: { replace?: boolean }) => void;
  onReset: () => void;
  hasActiveFilters: boolean;
  isRefreshing: boolean;
}) {
  // Local mirror so typing feels instant while the URL updates on a debounce.
  const [searchInput, setSearchInput] = useState(filters.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);

  useEffect(() => {
    if (debouncedSearch !== filters.search) {
      // replace: true, or typing pushes one history entry per keystroke.
      onChange({ search: debouncedSearch }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Resync when filters are cleared from elsewhere (e.g. the empty state).
  useEffect(() => {
    if (filters.search === '' && searchInput !== '') setSearchInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search]);

  return (
    <Card className="flex flex-wrap items-center gap-2 p-2">
      <Input
        value={searchInput}
        onChange={setSearchInput}
        placeholder="Search titles…"
        className="w-56"
        testId="product-search"
      />

      <Select<Marketplace>
        value={filters.marketplace ?? ''}
        onChange={(v) => onChange({ marketplace: v })}
        placeholder="All sites"
        options={MARKETPLACE_OPTIONS}
        testId="marketplace-filter"
      />

      <Input
        type="number"
        value={filters.minPrice?.toString() ?? ''}
        onChange={(v) => onChange({ minPrice: v ? Number(v) : undefined })}
        placeholder="Min $"
        className="w-24"
      />
      <Input
        type="number"
        value={filters.maxPrice?.toString() ?? ''}
        onChange={(v) => onChange({ maxPrice: v ? Number(v) : undefined })}
        placeholder="Max $"
        className="w-24"
      />

      <Select<'true' | 'false'>
        value={filters.inStock === undefined ? '' : filters.inStock ? 'true' : 'false'}
        onChange={(v) => onChange({ inStock: v === undefined ? undefined : v === 'true' })}
        placeholder="Any stock"
        options={STOCK_OPTIONS}
      />

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearchInput('');
            onReset();
          }}
        >
          Clear
        </Button>
      )}

      {isRefreshing && <span className="ml-auto text-[11px] text-slate-400">updating…</span>}
    </Card>
  );
}
