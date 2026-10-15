#!/usr/bin/env node
import { Command } from 'commander';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, formatUSDC } from './config.js';
import { Journal, lockTaker } from './store.js';
import { Taker } from './engine.js';
import { safeTakerError, TakerError } from './errors.js';
import { createTakerGateway } from '../ospex/taker.js';
import { unlockKeystoreSigner } from '../ospex/index.js';

interface Options { config: string; live?: boolean; once?: boolean; id?: string; replacementHash?: string }
const program = new Command().name('ospex-taker').description('Independent house taker. Shadow by default; never approves or controls the maker.');
for (const command of ['init', 'status', 'run', 'reconcile']) {
  program.command(command)
    .requiredOption('-c, --config <file>', 'separate taker YAML configuration')
    .option('--live', 'live only together with mode.dryRun: false')
    .option('--once', 'one scan/reconciliation pass (run only)')
    .option('--id <decision-id>', 'pending decision to reconcile (reconcile only; see status)')
    .option('--replacement-hash <hash>', 'finalized same-wallet/same-nonce replacement hash (reconcile only)')
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
          for (const attempt of journal.pending) console.log(`Pending decision ${attempt.decision.id}: ${attempt.signed ? `signed ${attempt.signed.txHash}, nonce ${attempt.signed.nonce}` : 'unsigned reservation'}`);
          return;
        }
        if (command === 'reconcile') {
          if (!options.id) throw new TakerError('TAKER_RECONCILE', 'reconcile requires --id from status. Nothing changed.');
          const taker = new Taker(config, journal, createTakerGateway(config));
          console.log(await taker.reconcile(options.id, options.replacementHash));
          return;
        }
        process.on('SIGINT', onStop);
        process.on('SIGTERM', onStop);
        let signer;
        if (!dryRun) {
          const passphrase = process.env.OSPEX_TAKER_PASSPHRASE;
          delete process.env.OSPEX_TAKER_PASSPHRASE;
          if (!passphrase) throw new TakerError('TAKER_KEYSTORE', 'Live taker needs OSPEX_TAKER_PASSPHRASE via its private process environment, never a command argument.');
          try { signer = await unlockKeystoreSigner(config.wallet.keystorePath, passphrase); }
          catch { throw new TakerError('TAKER_KEYSTORE', 'Cannot unlock the dedicated taker keystore. Check its path and private passphrase; details are hidden.'); }
          if ((await signer.getAddress()).toLowerCase() !== config.wallet.address.toLowerCase()) throw new TakerError('TAKER_KEYSTORE', 'Taker keystore/address mismatch.');
        }
        const taker = new Taker(config, journal, createTakerGateway(config, signer), Date.now, () => stop);
        console.log(`${dryRun ? 'SHADOW: no wallet unlocked or transactions possible.' : 'LIVE: explicit two-key gate enabled.'} Stop only this process with SIGINT/SIGTERM. Maker is independent.`);
        let lastMessage: string | null = null;
        do {
          const message = await taker.tick();
          if (message !== null && message !== lastMessage) console.log(message);
          lastMessage = message;
          if (options.once || stop) break;
          try { await sleep(config.pollIntervalMs, undefined, { signal: controller.signal }); }
          catch { if (!stop) throw new TakerError('TAKER_RUNTIME', 'Taker poll wait failed.'); }
        } while (!stop);
      } finally {
        process.off('SIGINT', onStop);
        process.off('SIGTERM', onStop);
        release();
      }
    });
}
// Never dump SDK/keystore exception causes: RPC failures may embed signed bytes.
program.parseAsync().catch((error: unknown) => {
  console.error(safeTakerError(error));
  process.exitCode = 1;
});
