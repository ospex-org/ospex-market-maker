// Post-build: make the CLI entrypoint executable.
//
// `tsc` emits files mode 0644, so `./dist/cli/index.js` (which has a shebang)
// can't be run directly and `yarn link` produces a shim pointing at a
// non-executable file. This sets +x. On Windows `chmodSync` is effectively a
// no-op (no Unix permission bits) — harmless. Runs via the `postbuild` script.
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
if (existsSync(target)) {
  chmodSync(target, 0o755);
}
