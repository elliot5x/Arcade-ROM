import JSZip from 'jszip';
import { EXTENSIONS_BY_SYSTEM } from './system-detection.js';

export const MAX_ZIP_ENTRIES = 128;

const ROM_EXTENSIONS = new Set(
  Object.values(EXTENSIONS_BY_SYSTEM)
    .flat()
    .concat(['iso', 'bin', 'img', 'chd'])
);

export function isZipFile(firstBytes, fileName) {
  if (firstBytes?.[0] === 0x50 && firstBytes?.[1] === 0x4b) return true;
  return /\.zip$/i.test(fileName || '');
}

export function rankZipEntries(entries) {
  return entries
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const extension = name.split('.').pop();
      let score = 0;

      for (const [system, extensions] of Object.entries(EXTENSIONS_BY_SYSTEM)) {
        if (extensions.includes(extension))
          score = Math.max(score, system === 'arcade' ? 1 : 2);
      }
      if (['iso', 'bin', 'img', 'chd'].includes(extension))
        score = Math.max(score, 1);
      if (entry.name.startsWith('__MACOSX/') || entry.name.includes('/.'))
        score = -1;

      return { entry, extension, score };
    })
    .filter((item) => item.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.entry.uncompressedSize - a.entry.uncompressedSize
    );
}

export async function inspectZip(blob) {
  let zip;
  try {
    zip = await JSZip.loadAsync(blob);
  } catch (error) {
    throw new Error(`O arquivo não é um ZIP válido: ${error.message}`);
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (!entries.length) throw new Error('O ZIP não contém arquivos.');
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(
      `ZIP com ${entries.length} entradas (limite ${MAX_ZIP_ENTRIES}). Use um arquivo direto.`
    );
  }

  const candidates = rankZipEntries(entries).filter((item) => item.score > 0);
  const roms = candidates.filter((item) => ROM_EXTENSIONS.has(item.extension));
  const chosen = roms.length ? roms : candidates;
  if (!chosen.length)
    throw new Error('Nenhum arquivo de ROM reconhecido dentro do ZIP.');

  if (chosen.length === 1) {
    return {
      mode: 'single',
      entry: chosen[0].entry,
      candidates: chosen,
      total: entries.length,
    };
  }
  return {
    mode: 'menu',
    entries: chosen,
    candidates: chosen,
    total: entries.length,
  };
}

export async function extractZipEntry(entry) {
  return entry.async('blob');
}
