import { Card, EmptyState, ErrorState, Pagination } from '@/components/ui';
import { useProducts } from '@/hooks/useProducts';
import { useProductsQueryParams } from '@/hooks/useProductsQueryParams';
import { ProductsFilterBar } from './components/ProductsFilterBar';
import { ProductsTable } from './components/ProductsTable';

export default function ProductsPage() {
  const { filters, setFilters, reset, query, hasActiveFilters } = useProductsQueryParams();
  const { data, isPending, isFetching, isError, error, refetch } = useProducts(query);

  const toggleSort = (key: typeof filters.sortBy) =>
    setFilters({
      sortBy: key,
      sortOrder: filters.sortBy === key && filters.sortOrder === 'desc' ? 'asc' : 'desc',
    });

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Products</h1>
        <span className="tnum text-xs text-slate-500">
          {data ? `${data.total.toLocaleString()} tracked` : '—'}
        </span>
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
