import { Card, SiteBadge } from '@/components/ui';
import type { CrawlJob, CrawlRun } from '@/types';

export function CrawlJobHeader({job, runs}: {job: CrawlJob, runs: CrawlRun[]}) {

    return (
        <Card className="p-4">
            <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col items-start justify-center gap-2">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-xl font-semibold">{job.name}</h1>
                    </div>
                    <SiteBadge marketplace={job.marketplace} />
                </div>
                <div className="flex flex-col items-start justify-center gap-2">
                    <span className="text-center">{runs.length} Runs</span>
                </div>
            </div>
        </Card>
    )
}
