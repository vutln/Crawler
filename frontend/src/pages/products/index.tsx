import { Button, Card, EmptyState, ErrorState, Pagination, Spinner } from '@/components/ui';
import { useExportProductsCsv, useProducts } from '@/hooks/useProducts';
import { useProductsQueryParams } from '@/hooks/useProductsQueryParams';
import type { ProductExportQuery, ProductListQuery } from '@/types/api';
import { ProductsFilterBar } from './components/ProductsFilterBar';
import { ProductsTable } from './components/ProductsTable';

export default function ProductsPage() {
  const { filters, setFilters, reset, query, hasActiveFilters } = useProductsQueryParams();
  const { data, isPending, isFetching, isError, error, refetch } = useProducts(query);
  const exportCsv = useExportProductsCsv();

  const toggleSort = (key: typeof filters.sortBy) =>
    setFilters({
      sortBy: key,
      sortOrder: filters.sortBy === key && filters.sortOrder === 'desc' ? 'asc' : 'desc',
    });

  const handleExport = () => {
    /**
     * Strip paging, then send the rest of `query` untouched so the CSV always
     * matches this screen — including filters added later.
     *
     * Required, not tidiness: ExportProductsDto omits page/pageSize and the API's
     * ValidationPipe runs forbidNonWhitelisted, so leaving them in is a hard 400.
     * Deleting rather than destructuring because the two discarded names would be
     * unused bindings, which this project's lint rejects.
     */
    const filtersOnly = { ...query } as Partial<ProductListQuery>;
    delete filtersOnly.page;
    delete filtersOnly.pageSize;
    exportCsv.mutate(filtersOnly as ProductExportQuery);
  };

  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Products</h1>
        <div className="flex items-baseline gap-3">
          <span className="tnum text-xs text-slate-500">
            {data ? `${total.toLocaleString()} tracked` : '—'}
          </span>
          {/*
            In the header, not the filter bar: that bar is already six controls, and
            export is an action, not a filter. The row count in the label is what
            makes the scope unambiguous — it exports everything matching, not the page.
          */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            disabled={exportCsv.isPending || total === 0}
            testId="export-csv"
          >
            {exportCsv.isPending ? (
              <span className="flex items-center gap-1.5">
                <Spinner /> Exporting…
              </span>
            ) : (
              `Export CSV${total > 0 ? ` (${total.toLocaleString()})` : ''}`
            )}
          </Button>
        </div>
      </header>

      <ProductsFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={reset}
        hasActiveFilters={hasActiveFilters}
        isRefreshing={isFetching && !isPending}
      />

      <Card>
        <ProductsTable
          items={data?.items ?? []}
          isPending={isPending}
          isFetching={isFetching}
          sortBy={filters.sortBy}
          sortOrder={filters.sortOrder}
          onSortChange={toggleSort}
        />

        {isError && <ErrorState error={error} onRetry={() => void refetch()} />}

        {!isPending &&
          !isError &&
          data?.items.length === 0 &&
          (hasActiveFilters ? (
            <EmptyState
              title="No products match these filters"
              description="Try widening the price range or clearing the search."
              action={{ label: 'Clear filters', onClick: reset }}
            />
          ) : (
            <EmptyState
              title="No products collected yet"
              description="Run a crawl to start collecting products and price history."
              action={{ label: 'Go to Crawl Jobs', to: '/crawl-jobs' }}
            />
          ))}

        {!isError && (data?.total ?? 0) > 0 && (
          <div className="border-t border-slate-100">
            <Pagination
              page={filters.page}
              pageSize={filters.pageSize}
              total={data?.total ?? 0}
              onPageChange={(page) => setFilters({ page })}
              onPageSizeChange={(pageSize) => setFilters({ pageSize })}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
