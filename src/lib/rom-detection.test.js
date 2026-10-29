import { describe, expect, it } from 'vitest';
import {
  detectMagic,
  getCore,
  isZipFile,
  pickBestZipEntry,
} from './rom-detection.js';

describe('detectMagic', () => {
  it('detecta cabeçalho NES', () => {
    const bytes = Uint8Array.from([0x4e, 0x45, 0x53, 0x1a, 0x00, 0x00, 0x00]);
    expect(detectMagic(bytes)).toBe('nes');
  });

  it('detecta ISO PSP', () => {
    const bytes = new Uint8Array(0x8030);
    bytes[0x8001] = 0x43;
    bytes[0x8002] = 0x44;
    bytes[0x8003] = 0x30;
    bytes[0x8004] = 0x30;
    bytes[0x8005] = 0x31;
    bytes[0x8008] = 0x50;
    bytes[0x8009] = 0x53;
    bytes[0x800a] = 0x50;
    bytes[0x800b] = 0x20;
    bytes[0x800c] = 0x47;
    bytes[0x800d] = 0x41;
    bytes[0x800e] = 0x4d;
    bytes[0x800f] = 0x45;

    expect(detectMagic(bytes)).toBe('psp');
  });
});

describe('getCore', () => {
  it('respeita o sistema forçado durante a seleção', () => {
    const previous = globalThis.systemSelect;
    globalThis.systemSelect = { value: 'snes' };

    try {
      expect(getCore('game.bin')).toBe('snes');
    } finally {
      if (previous === undefined) delete globalThis.systemSelect;
      else globalThis.systemSelect = previous;
    }
  });

  it('detecta extensão conhecida para SNES', () => {
    expect(getCore('super.smc')).toBe('snes');
  });

  it('retorna null para extensão desconhecida', () => {
    expect(getCore('arquivo.unknown')).toBeNull();
  });
});

describe('isZipFile', () => {
  it('reconhece ZIP pela assinatura PK', () => {
    const header = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    expect(isZipFile(header, 'game.bin')).toBe(true);
  });

  it('reconhece extension .zip', () => {
    expect(isZipFile(null, 'games.zip')).toBe(true);
  });
});

describe('pickBestZipEntry', () => {
  it('ordena entradas por tipo de ROM e tamanho', () => {
    const entries = [
      { name: 'readme.txt', uncompressedSize: 200 },
      { name: 'game.smc', uncompressedSize: 1024 },
      { name: 'other.bin', uncompressedSize: 500 },
    ];

    const result = pickBestZipEntry(entries);
    expect(result[0].entry.name).toBe('game.smc');
    expect(result[1].entry.name).toBe('other.bin');
  });
});
