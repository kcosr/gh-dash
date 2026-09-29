// Read-only smoke test of gh-dash's GitLab code against a real GitLab instance (the checks are in
// server/gitlab/smoke.ts). Bundle it into one self-contained file that runs with plain `node` (no npm install):
//   node scripts/build-gitlab-smoke.mjs [outfile]
// then: GITLAB_URL=https://gitlab.example.com GITLAB_TOKEN=… node gitlab-smoke.mjs --help
import { main } from '../server/gitlab/smoke';

/** Set by the bundler to the git commit it was built from. */
declare const SMOKE_BUILD: string | undefined;

process.exitCode = await main(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  build: typeof SMOKE_BUILD === 'string' ? SMOKE_BUILD : 'dev',
});
