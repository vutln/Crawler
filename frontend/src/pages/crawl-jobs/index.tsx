import { CreateJobForm } from './components/CreateJobForm';
import { JobsTable } from './components/JobsTable';
import { RunsTable } from './components/RunsTable';

export default function CrawlJobsPage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold text-slate-900">Crawl Jobs</h1>
      <CreateJobForm />
      <JobsTable />
      <RunsTable />
    </div>
  );
}
