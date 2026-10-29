export const BOOT_TIMEOUT_MS = 20000;
export const CORE_COMPILE_TIMEOUT_MS = 300000;
export const LONG_BOOT_STAGE = /compilando o núcleo|iniciando o jogo/i;
export const THREAD_REQUIRED_CORES = new Set(['n64', 'nds', 'psp']);

export function bootTimeoutFor(stage) {
  return LONG_BOOT_STAGE.test(stage)
    ? CORE_COMPILE_TIMEOUT_MS
    : BOOT_TIMEOUT_MS;
}

export function coreNeedsThreads(core) {
  return THREAD_REQUIRED_CORES.has(core);
}

export function bootErrorGuidance(errorMessage = '') {
  const message = errorMessage.toLowerCase();
  if (
    message.includes('sharedarraybuffer') ||
    message.includes('crossorigin') ||
    message.includes('cross-origin')
  ) {
    return 'N64 ou PSP podem exigir isolamento de origem (COOP/COEP). Use HTTPS ou localhost e confirme que o site permite SharedArrayBuffer.';
  }
  if (message.includes('bios')) {
    return 'Este sistema pode exigir um arquivo BIOS compatível e configurado. Consulte o guia de BIOS do núcleo do EmulatorJS.';
  }
  return null;
}
