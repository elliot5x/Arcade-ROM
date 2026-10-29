export const EXTENSIONS_BY_SYSTEM = {
  nes: ['nes', 'unf', 'unif'],
  snes: ['smc', 'sfc', 'fig', 'swc'],
  gb: ['gb', 'gbc'],
  gba: ['gba'],
  nds: ['nds'],
  n64: ['n64', 'z64', 'v64'],
  psx: ['pbp', 'chd', 'cue', 'ccd', 'm3u', 'iso', 'img', 'bin'],
  psp: ['pbp'],
  segaMD: ['gen', 'md', 'smd'],
  sega32x: ['32x'],
  segaMS: ['sms'],
  segaGG: ['gg'],
  atari2600: ['a26'],
  atari5200: ['a52'],
  atari7800: ['a78'],
  lynx: ['lnx'],
  jaguar: ['jag'],
  vb: ['vb'],
  c64: ['d64', 'd71', 'd81', 't64', 'prg'],
  amiga: ['adf'],
  pce: ['pce'],
  pcfx: ['pcfx'],
  ngp: ['ngp'],
  ws: ['ws', 'wsc'],
  coleco: ['col'],
  arcade: ['zip', '7z'],
};

export function detectMagic(bytes) {
  if (!bytes?.length) return null;

  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  if (ascii.startsWith('PlayStation')) return 'psx';
  if (ascii.startsWith('NES\x1a') || hex.startsWith('4e45531a')) return 'nes';
  if (hex.startsWith('50534547') || hex.startsWith('45414743') || ascii.includes('SEGA')) return 'segaMD';
  if (hex.startsWith('8000000c') || hex.startsWith('37804012')) return 'n64';
  if (ascii.startsWith('ATARI') || hex.startsWith('41544152')) return 'atari2600';
  if (hex.startsWith('434f5059') || ascii.includes('SEGA MEGA')) return 'segaMD';
  if (
    bytes.length >= 0x8030 &&
    bytes[0x8001] === 0x43 &&
    bytes[0x8002] === 0x44 &&
    bytes[0x8003] === 0x30 &&
    bytes[0x8004] === 0x30 &&
    bytes[0x8005] === 0x31
  ) {
    const systemId = new TextDecoder('latin1').decode(bytes.subarray(0x8008, 0x8028));
    return systemId.startsWith('PSP') ? 'psp' : 'psx';
  }
  return null;
}

export function detectCore(fileName, firstBytes = null, selectedSystem = 'auto') {
  if (selectedSystem !== 'auto') return selectedSystem;

  const extension = String(fileName).toLowerCase().split('.').pop();
  if (firstBytes) {
    const magic = detectMagic(firstBytes);
    if (magic) return magic;
  }

  for (const [system, extensions] of Object.entries(EXTENSIONS_BY_SYSTEM)) {
    if (system !== 'arcade' && extensions.includes(extension)) return system;
  }

  const ambiguous = { bin: 'psx', zip: null, '7z': null, rar: null, dsk: null, dol: null, wad: null };
  return Object.hasOwn(ambiguous, extension) ? ambiguous[extension] : null;
}
