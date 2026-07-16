import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/products', label: 'Products', end: false },
  { to: '/crawl-jobs', label: 'Crawl Jobs', end: false },
];

export function AppShell() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-2.5">
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            E-Commerce Collector
          </span>
          <nav className="flex gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-2.5 py-1 text-sm transition-colors',
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <a
            href="http://localhost:3000/api/docs"
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto text-xs text-slate-400 hover:text-slate-700"
          >
            API docs ↗
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
