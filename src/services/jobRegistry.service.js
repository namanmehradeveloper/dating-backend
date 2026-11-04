// Tracks background jobs that run inside the API process (no external queue broker).

/** @type {Map<string, { id: string, name: string, schedule: string, lastStartedAt: string | null, lastFinishedAt: string | null, lastStatus: string, lastError: string | null, lastResult: object | null, runCount: number }>} */
const jobs = new Map();

export function registerJob(id, { name, schedule }) {
  if (jobs.has(id)) return jobs.get(id);
  const entry = {
    id,
    name,
    schedule,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: 'IDLE',
    lastError: null,
    lastResult: null,
    runCount: 0,
  };
  jobs.set(id, entry);
  return entry;
}

export function markJobStarted(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.lastStartedAt = new Date().toISOString();
  job.lastStatus = 'RUNNING';
  job.lastError = null;
}

export function markJobSucceeded(id, result = null) {
  const job = jobs.get(id);
  if (!job) return;
  job.lastFinishedAt = new Date().toISOString();
  job.lastStatus = 'OK';
  job.lastResult = result;
  job.lastError = null;
  job.runCount += 1;
}

export function markJobFailed(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.lastFinishedAt = new Date().toISOString();
  job.lastStatus = 'FAILED';
  job.lastError = error?.message ? String(error.message).slice(0, 300) : 'Unknown error';
  job.runCount += 1;
}

export function listJobs() {
  return [...jobs.values()].map((job) => ({ ...job }));
}
