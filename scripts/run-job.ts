import { closeDb } from "../src/db";
import { executeJob, isJobName, JOBS } from "../src/jobs";

/**
 * Usage: npm run job:<name> [-- --period=YYYY-MM] [-- --now=ISO-8601]
 *        node job.mjs <name> [...]   (inside the Docker image)
 */
async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || !isJobName(name)) {
    console.error(`Usage: run-job <${Object.keys(JOBS).join("|")}> [--period=YYYY-MM] [--now=ISO]`);
    process.exit(2);
  }
  const args = Object.fromEntries(
    rest.map((a) => a.replace(/^--/, "").split("=") as [string, string]).filter(([k, v]) => k && v),
  );
  const result = await executeJob(name, {
    period: args.period,
    now: args.now ? new Date(args.now) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  await closeDb();
  process.exit(result.ok ? 0 : 1);
}

void main();
