#!/usr/bin/env node
import { Command } from 'commander';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, formatUSDC } from './config.js';
import { Journal, lockTaker } from './store.js';
import { Taker } from './engine.js';
import { createTakerGateway } from '../ospex/taker.js';
import { unlockKeystoreSigner } from '../ospex/index.js';

interface Options { config: string; live?: boolean; once?: boolean }
const program = new Command().name('ospex-taker').description('Independent house taker. Shadow by default; never approves or controls the maker.');
for (const command of ['init', 'status', 'run']) {
  program.command(command)
    .requiredOption('-c, --config <file>', 'separate taker YAML configuration')
    .option('--live', 'live only together with mode.dryRun: false')
    .option('--once', 'one scan/reconciliation pass (run only)')
    .action(async (options: Options) => {
      const config = loadConfig(options.config);
      const dryRun = config.mode.dryRun || options.live !== true;
      const release = lockTaker(config);
      let stop = false;
      const controller = new AbortController();
      const onStop = (): void => { stop = true; controller.abort(); };
      try {
        const journal = new Journal(config, dryRun, command === 'init');
        if (command === 'init') {
          console.log(`Initialized ${dryRun ? 'shadow' : 'live'} journal for a NEW taker. No wallet opened, approval or transaction sent. Preserve this journal permanently.`);
          return;
        }
        if (command === 'status') {
          console.log(`${dryRun ? 'Shadow' : 'Live'} journal: spent ${formatUSDC(journal.spentWei6)} USDC; reserved ${formatUSDC(journal.reservedWei6)}; cap ${config.capUSDC}; unresolved takes ${journal.pending.length}. Allowance is not the spend ledger.`);
          return;
        }
        process.on('SIGINT', onStop);
        process.on('SIGTERM', onStop);
        let signer;
        if (!dryRun) {
          const passphrase = process.env.OSPEX_TAKER_PASSPHRASE;
          if (!passphrase) throw new Error('Live taker needs OSPEX_TAKER_PASSPHRASE via its private process environment, never a command argument.');
          signer = await unlockKeystoreSigner(config.wallet.keystorePath, passphrase);
          delete process.env.OSPEX_TAKER_PASSPHRASE;
          if ((await signer.getAddress()).toLowerCase() !== config.wallet.address.toLowerCase()) throw new Error('Taker keystore/address mismatch.');
        }
        const taker = new Taker(config, journal, createTakerGateway(config, signer), Date.now, () => stop);
        console.log(`${dryRun ? 'SHADOW: no wallet unlocked or transactions possible.' : 'LIVE: explicit two-key gate enabled.'} Stop only this process with SIGINT/SIGTERM. Maker is independent.`);
        let lastMessage: string | null = null;
        do {
          let message: string | null;
          try { message = await taker.tick(); }
          catch { throw new Error('Taker read, record or preflight failed. Stop and inspect the private journal; maker is unaffected. No automatic retry of uncertain takes.'); }
          if (message !== null && message !== lastMessage) console.log(message);
          lastMessage = message;
          if (options.once || stop) break;
          try { await sleep(config.pollIntervalMs, undefined, { signal: controller.signal }); }
          catch { if (!stop) throw new Error('Taker poll wait failed.'); }
        } while (!stop);
      } finally {
        process.off('SIGINT', onStop);
        process.off('SIGTERM', onStop);
        release();
      }
    });
}
// Never dump SDK/keystore exception causes: RPC failures may embed signed bytes.
program.parseAsync().catch(() => {
  console.error('Taker stopped on an error. Validate config, its separate state/lock, wallet identity and finite allowance. Restore/reconcile uncertain records; do not reset the cap journal. The maker is unaffected.');
  process.exitCode = 1;
});
