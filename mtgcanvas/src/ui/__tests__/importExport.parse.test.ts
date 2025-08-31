import { describe, it, expect } from 'vitest';
import { extractBaseCardName, parseDecklist } from '../importExport';

describe('importExport parsing', () => {
  it('keeps Fallout Vault names with numbers and colon', () => {
    const line = '2 Vault 112: Sadistic Simulation';
    const parsed = parseDecklist(line);
    expect(parsed).toEqual([{ name: 'Vault 112: Sadistic Simulation', count: 2 }]);
  });
  it('keeps multiple Fallout Vault lines', () => {
    const text = [
      '2 Vault 112: Sadistic Simulation',
      '2 Vault 87: Forced Evolution',
      "2 Vault 11: Voter's Dilemma",
    ].join('\n');
    const parsed = parseDecklist(text);
    expect(parsed).toEqual([
      { name: 'Vault 112: Sadistic Simulation', count: 2 },
      { name: 'Vault 87: Forced Evolution', count: 2 },
      { name: "Vault 11: Voter's Dilemma", count: 2 },
    ]);
  });
  it('still strips set code and collector number at end', () => {
    const line = 'Forest (MH3) 318';
    expect(extractBaseCardName(line)).toBe('Forest');
  });
});
