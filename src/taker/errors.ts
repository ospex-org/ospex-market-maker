/** Only locally authored, input-free diagnostics may cross the CLI boundary. */
export type TakerErrorCode = 'TAKER_CONFIG' | 'TAKER_LOCK' | 'TAKER_STATE' | 'TAKER_JOURNAL' | 'TAKER_RECONCILE' | 'TAKER_KEYSTORE' | 'TAKER_RUNTIME';
export class TakerError extends Error {
  constructor(readonly code: TakerErrorCode, message: string) {
    super(message);
    this.name = 'TakerError';
  }
}

export function safeTakerError(error: unknown): string {
  if (error instanceof TakerError) return `${error.code}: ${error.message}`;
  // Do not trust a foreign error's code, message, cause, stack or serialization.
  return 'TAKER_RUNTIME: Taker stopped on an unexpected error. Inspect config and the private journal; do not reset its cap. Raw SDK/keystore details are hidden. The maker is unaffected.';
}
