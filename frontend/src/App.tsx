import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Spinner } from '@/components/ui';
import DashboardPage from '@/pages/dashboard';
import ProductsPage from '@/pages/products';
import KeywordsPage from '@/pages/keywords';
import CrawlJobsPage from '@/pages/crawl-jobs';
import CrawlRunsPage from '@/pages/crawl-runs';

const ProductDetailPage = lazy(() => import('@/pages/product-detail'));

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route
          path="products/:id"
          element={
            <Suspense
              fallback={
                <div className="flex justify-center py-16">
                  <Spinner className="h-6 w-6" />
                </div>
              }
            >
              <ProductDetailPage />
            </Suspense>
          }
        />
        <Route path="keywords" element={<KeywordsPage />} />
        <Route path="crawl-jobs" element={<CrawlJobsPage />} />
        <Route path="crawl-runs" element={<CrawlRunsPage />} />
        <Route
          path="*"
          element={<p className="py-16 text-center text-sm text-slate-500">Page not found</p>}
        />
      </Route>
    </Routes>
  );
}
