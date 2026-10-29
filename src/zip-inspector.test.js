import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { inspectZip, MAX_ZIP_ENTRIES, rankZipEntries } from './zip-inspector.js';

async function zipBytes(files) {
  const zip = new JSZip();
  Object.entries(files).forEach(([name, contents]) => zip.file(name, contents));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('inspectZip', () => {
  it('selects a single ROM from a ZIP', async () => {
    const bytes = await zipBytes({ 'readme.txt': 'notes', 'game.sfc': 'rom-data' });
    const result = await inspectZip(bytes);
    expect(result.mode).toBe('single');
    expect(result.entry.name).toBe('game.sfc');
  });

  it('offers multiple ROM candidates in deterministic priority order', async () => {
    const bytes = await zipBytes({
      'games/second.nes': 'smaller',
      'games/first.gba': 'larger ROM data',
      '__MACOSX/games/ignored.nes': 'metadata',
    });
    const result = await inspectZip(bytes);
    expect(result.mode).toBe('menu');
    expect(result.entries.some(({ entry }) => entry.name.includes('__MACOSX'))).toBe(false);
    expect(result.entries.map(({ entry }) => entry.name)).toEqual(['games/second.nes', 'games/first.gba']);
  });

  it('rejects invalid and empty ZIP archives with useful errors', async () => {
    await expect(inspectZip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/ZIP válido/i);
    await expect(inspectZip(await zipBytes({ 'folder/': '' }))).rejects.toThrow(/não contém arquivos/i);
  });

  it('rejects ZIPs with no recognized ROM extension', async () => {
    await expect(inspectZip(await zipBytes({ 'document.txt': 'text' }))).rejects.toThrow(
      /Nenhum arquivo de ROM reconhecido/i,
    );
  });

  it('rejects archives beyond the entry limit', async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => [`rom-${index}.nes`, 'data']),
    );
    await expect(inspectZip(await zipBytes(files))).rejects.toThrow(/limite 128/i);
  });

  it('ignores hidden metadata and ranks recognized extensions', () => {
    const entries = [
      { name: '__MACOSX/.game.nes', uncompressedSize: 100 },
      { name: 'game.nes', uncompressedSize: 20 },
      { name: 'game.iso', uncompressedSize: 10 },
    ];
    expect(rankZipEntries(entries).map(({ entry }) => entry.name)).toEqual(['game.nes', 'game.iso']);
  });
});
