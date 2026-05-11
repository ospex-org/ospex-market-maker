#!/usr/bin/env node
/**
 * ospex-mm — reference market maker CLI for Ospex.
 *
 * v0 scaffold. The command surface is specified in docs/DESIGN.md §3;
 * implementations land in Phase 1+. This stub exists so the project builds
 * and the `ospex-mm` binary resolves.
 */

const COMMANDS = ['doctor', 'quote', 'run', 'cancel-stale', 'status', 'summary'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function printUsage(): void {
  process.stdout.write(
    [
      'ospex-mm — reference market maker for Ospex (v0 scaffold)',
      '',
      `commands: ${COMMANDS.join(', ')}`,
      '',
      'See docs/DESIGN.md for the design. Implementations are in progress;',
      'this is a scaffold — do not run it against real funds.',
      '',
    ].join('\n'),
  );
}

function main(argv: readonly string[]): number {
  const cmd = argv[2];
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    printUsage();
    return 0;
  }
  if (isCommand(cmd)) {
    process.stderr.write(`ospex-mm ${cmd}: not yet implemented (v0 scaffold)\n`);
    return 1;
  }
  process.stderr.write(`ospex-mm: unknown command "${cmd}"\n`);
  printUsage();
  return 2;
}

process.exit(main(process.argv));
