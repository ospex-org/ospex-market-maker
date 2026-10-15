import { expect, it } from 'vitest';
import { safeTakerError, TakerError } from '../src/taker/errors.js';

it('prints only locally classified errors, never arbitrary SDK errors or nested causes', () => {
  expect(safeTakerError(new TakerError('TAKER_CONFIG', 'capUSDC must be positive'))).toBe('TAKER_CONFIG: capUSDC must be positive');
  const secret = 'rpc-credential-and-signed-bytes';
  const foreign = Object.assign(new Error(secret, { cause: { raw: secret } }), { code: 'TAKER_CONFIG' });
  for (const error of [foreign, { message: secret, code: 'TAKER_JOURNAL', cause: secret }, secret]) {
    expect(safeTakerError(error)).toContain('TAKER_RUNTIME');
    expect(safeTakerError(error)).not.toContain(secret);
  }
});
