import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps public taker files about behavior, not internal task or reviewer metadata', () => {
  const files = ['README.md', 'CONTRIBUTING.md', 'docs/DESIGN.md', 'docs/HOUSE_TAKER.md', 'ospex-taker.example.yaml', 'src/ospex/taker.ts',
    ...readdirSync('src/taker').map(f => `src/taker/${f}`),
    ...readdirSync('tests').filter(f => f.startsWith('taker-')).map(f => `tests/${f}`)];
  const names = [['Vin', 'ce'], ['Clau', 'de Code']].map(parts => parts.join(''));
  for (const file of files) {
    // The pre-existing house-bettor notice is a separate operator settings ruling.
    const text = readFileSync(file, 'utf8').replace(/## Run 2 house-bettor notice[\s\S]*?(?=## Separate house taker)/, '');
    expect(text, file).not.toMatch(/OSP-\d+|S[1-4]-\d+/);
    for (const name of names) expect(text, file).not.toContain(name);
    for (const parts of [['Draft code,', ' not activated'], ['prerequisites to', ' card completion'], ['draft implementation,', ' not activated']]) {
      expect(text, file).not.toContain(parts.join(''));
    }
  }
});
