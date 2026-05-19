// Fresh-clone smoke: the executable form of the README's Development checklist.
// Runs install (frozen lockfile), build, typecheck, lint, test, and `mm --help`
// in series. Streams each child's stdout/stderr through; exits 1 on the first
// failure so the operator sees the FIRST thing wrong, not a cascade.
import { spawn } from 'node:child_process';

const STEPS = [
  ['install (frozen lockfile)', 'yarn', ['install', '--frozen-lockfile']],
  ['build',                     'yarn', ['build']],
  ['typecheck',                 'yarn', ['typecheck']],
  ['lint',                      'yarn', ['lint']],
  ['test',                      'yarn', ['test']],
  ['mm --help (CLI surface)',   'yarn', ['mm', '--help']],
];

const t0 = Date.now();
for (let i = 0; i < STEPS.length; i++) {
  const [label, cmd, args] = STEPS[i];
  const header = `[${i + 1}/${STEPS.length}] ${label}`;
  process.stdout.write(`\n${header}\n    > ${cmd} ${args.join(' ')}\n`);

  const t = Date.now();
  const code = await run(cmd, args);
  const elapsed = ((Date.now() - t) / 1000).toFixed(1);

  if (code !== 0) {
    process.stdout.write(`\n  FAIL (${elapsed}s, exit ${code})\n`);
    process.stdout.write(`Smoke aborted at step ${i + 1}. Fix the failure above and re-run.\n`);
    process.exit(1);
  }
  process.stdout.write(`  ok (${elapsed}s)\n`);
}

const total = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\nAll ${STEPS.length} smoke checks passed in ${total}s.\n`);

function run(cmd, args) {
  return new Promise((resolve) => {
    // shell:true is required on Windows so `yarn` (a .cmd shim) resolves via PATH.
    // Args are hardcoded literals — no user input — so shell injection isn't a concern.
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`\n  spawn error: ${err.message}\n`);
      resolve(1);
    });
  });
}
