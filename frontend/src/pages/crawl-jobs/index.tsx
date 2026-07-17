import { Link } from 'react-router-dom';
import { CreateJobForm } from './components/CreateJobForm';
import { JobsTable } from './components/JobsTable';

export default function CrawlJobsPage() {
  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Crawl Jobs</h1>
        {/*
          The runs table used to be the third panel on this page. It moved to its own
          route: a sweep emits one run per keyword per site per day, which is far too
          much to sit under a three-row job list.
        */}
        <Link to="/crawl-runs" className="text-xs text-slate-500 underline">
          View all runs →
        </Link>
      </header>

      <p className="text-xs text-slate-500">
        A sweep collects keywords on one site, on a schedule. What it collects is configured in{' '}
        <Link to="/keywords" className="text-slate-700 underline">
          Keywords
        </Link>
        .
      </p>

      <CreateJobForm />
      <JobsTable />
    </div>
  );
}
