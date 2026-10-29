import { describe, expect, it } from 'vitest';
import { detectCore, detectMagic, EXTENSIONS_BY_SYSTEM } from './system-detection.js';

function bytes(values) {
  return Uint8Array.from(values);
}

describe('detectCore', () => {
  it.each([
    ['game.nes', 'nes'],
    ['game.sfc', 'snes'],
    ['game.gba', 'gba'],
    ['game.z64', 'n64'],
    ['game.bin', 'psx'],
    ['game.zip', null],
    ['game.7z', null],
    ['game.rar', null],
  ])('detects %s as %s from its extension', (fileName, expected) => {
    expect(detectCore(fileName)).toBe(expected);
  });

  it('uses an explicit system selection', () => {
    expect(detectCore('unknown.bin', null, 'psp')).toBe('psp');
  });

  it('detects NES, PlayStation and N64 signatures', () => {
    expect(detectMagic(bytes([0x4e, 0x45, 0x53, 0x1a]))).toBe('nes');
    expect(detectMagic(new TextEncoder().encode('PlayStation'))).toBe('psx');
    expect(detectMagic(bytes([0x80, 0x00, 0x00, 0x0c]))).toBe('n64');
  });

  it('distinguishes PSP and PlayStation ISO9660 discs', () => {
    const pspDisc = new Uint8Array(0x8030);
    pspDisc.set(new TextEncoder().encode('CD001'), 0x8001);
    pspDisc.set(new TextEncoder().encode('PSP GAME'), 0x8008);
    expect(detectMagic(pspDisc)).toBe('psp');

    const psxDisc = new Uint8Array(0x8030);
    psxDisc.set(new TextEncoder().encode('CD001'), 0x8001);
    psxDisc.set(new TextEncoder().encode('PLAYSTATION'), 0x8008);
    expect(detectMagic(psxDisc)).toBe('psx');
  });

  it('contains the supported direct ROM extensions', () => {
    expect(EXTENSIONS_BY_SYSTEM.nes).toContain('nes');
    expect(EXTENSIONS_BY_SYSTEM.psx).toContain('chd');
  });
});
