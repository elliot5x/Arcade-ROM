// ---------------------------------------------------------------------------
// Arcade ROM — controlador do emulador (arquitetura estilo RomsFUN)
// Fluxo: arquivo local -> Blob URL (zero-cópia, gerenciado pelo navegador) ->
//        inspeção .zip (JSZip, apenas índice central) -> seleção do binário ->
//        iframe isolado -> o emulador baixa direto do Blob URL -> cleanup agressivo.
// ---------------------------------------------------------------------------
import JSZip from 'jszip';

const DATA_PATH = 'https://cdn.emulatorjs.org/stable/data/';
const BOOT_TIMEOUT_MS = 20000;
const MAX_ROM_BYTES = 5 * 1024 * 1024 * 1024;      // 5 GB — Blobs grandes vão para o disco, não estouram o heap
const MAX_ZIP_ENTRIES = 128;                        // zips bomba / arquivos com milhares de entradas
const PROBE_BYTES = 512;                            // sniff de assinatura mágica no cabeçalho
const CONTROLLER_PROFILE_KEY = 'arcade-rom-controller-profile-v1';
const EXTENSIONS_BY_SYSTEM = {
  nes: ['nes', 'unf', 'unif'], snes: ['smc', 'sfc', 'fig', 'swc'], gb: ['gb', 'gbc'],
  gba: ['gba'], nds: ['nds'], n64: ['n64', 'z64', 'v64'],
  psx: ['pbp', 'chd', 'cue', 'ccd', 'm3u'], psp: ['psp', 'iso'],
  segaMD: ['gen', 'md', 'smd'], sega32x: ['32x'], segaMS: ['sms'], segaGG: ['gg'],
  atari2600: ['a26'], atari5200: ['a52'], atari7800: ['a78'], lynx: ['lnx'], jaguar: ['jag'],
  vb: ['vb'], c64: ['d64', 'd71', 'd81', 't64', 'prg'], amiga: ['adf'], pce: ['pce'], pcfx: ['pcfx'],
  ngp: ['ngp'], ws: ['ws', 'wsc'], coleco: ['col'], arcade: ['zip', '7z']
};

const uploadView = document.getElementById('uploadView');
const emulatorView = document.getElementById('emulatorView');
const emulatorHost = document.getElementById('emulatorHost');
const romInput = document.getElementById('romInput');
const systemSelect = document.getElementById('systemSelect');
const dropzone = document.getElementById('dropzone');
const uploadStatus = document.getElementById('uploadStatus');
const emulatorLogs = document.getElementById('emulatorLogs');
const dropOverlay = document.getElementById('dropOverlay');
const catalogSection = document.getElementById('catalogSection');
const catalogList = document.getElementById('catalogList');
const catalogSummary = document.getElementById('catalogSummary');
const cleanupToast = document.getElementById('cleanupToast');
const removeButton = document.getElementById('removeRom');
const startWithSystemButton = document.getElementById('startWithSystem');
const controllerStatus = document.getElementById('controllerStatus');
const controllerReset = document.getElementById('resetControls');

let activeFrame = null;
let controllerSyncTimer = null;
let operation = 0;          // token de geração: invalida trabalho assíncrono órfão
let dragDepth = 0;
let pendingFile = null;
let bootTimeout = null;
let logStartedAt = 0;
let activeRomUrl = null;   // Blob URL corrente — revogado no cleanup

function revokeRomUrl() {
  if (activeRomUrl) { URL.revokeObjectURL(activeRomUrl); activeRomUrl = null; }
}

function createRomUrl(blobOrFile) {
  revokeRomUrl();
  activeRomUrl = URL.createObjectURL(blobOrFile);
  return activeRomUrl;
}

function loadControllerProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(CONTROLLER_PROFILE_KEY) || '{}');
    return profile && typeof profile === 'object' ? profile : {};
  } catch {
    return {};
  }
}

function saveControllerProfile(profile) {
  if (!profile || typeof profile !== 'object') return;
  localStorage.setItem(CONTROLLER_PROFILE_KEY, JSON.stringify(profile));
}

// O próprio EmulatorJS salva o remapeamento por jogo. Também copiamos o último
// controlSettings para um perfil global, pois jogadores esperam que o controle
// configurado continue igual ao abrir outra ROM ou outro núcleo.
function syncControllerProfile(frame) {
  if (!frame?.contentWindow) return;
  try {
    for (let index = 0; index < frame.contentWindow.localStorage.length; index += 1) {
      const key = frame.contentWindow.localStorage.key(index);
      if (!key?.startsWith('ejs-') || !key.endsWith('-settings')) continue;
      const saved = JSON.parse(frame.contentWindow.localStorage.getItem(key));
      if (saved?.controlSettings && typeof saved.controlSettings === 'object') {
        saveControllerProfile(saved.controlSettings);
        return;
      }
    }
  } catch { /* O armazenamento pode ficar bloqueado em modo privado. */ }
}

function updateControllerStatus() {
  if (!controllerStatus) return;
  const gamepads = navigator.getGamepads?.().filter(Boolean) ?? [];
  const dot = controllerStatus.parentElement?.querySelector('.controller-dot');
  if (!gamepads.length) {
    controllerStatus.textContent = 'Nenhum controle detectado';
    controllerStatus.dataset.connected = 'false';
    if (dot) dot.style.background = '#777';
    return;
  }
  controllerStatus.textContent = gamepads.map((gamepad, index) => gamepad.id || `Controle ${index + 1}`).join(' · ');
  controllerStatus.dataset.connected = 'true';
  if (dot) dot.style.background = 'var(--good)';
}

window.addEventListener('gamepadconnected', updateControllerStatus);
window.addEventListener('gamepaddisconnected', updateControllerStatus);
updateControllerStatus();
setInterval(updateControllerStatus, 1500);

// ---------------------------------------------------------------------------
// Status / log
// ---------------------------------------------------------------------------
function setUploadStatus(message, kind = '') {
  uploadStatus.textContent = message;
  uploadStatus.dataset.kind = kind;
}

function resetEmulatorLogs() {
  logStartedAt = performance.now();
  emulatorLogs.replaceChildren();
}

function appendEmulatorLog(message, kind = 'info') {
  const elapsed = Math.max(0, (performance.now() - logStartedAt) / 1000).toFixed(1).padStart(4, '0');
  const entry = document.createElement('li');
  const time = document.createElement('span');
  const text = document.createElement('span');
  entry.dataset.kind = kind;
  time.className = 'log-time';
  time.textContent = `[${elapsed}s]`;
  text.className = 'log-message';
  text.textContent = message;
  entry.append(time, text);
  emulatorLogs.append(entry);
  while (emulatorLogs.children.length > 80) emulatorLogs.firstElementChild.remove();
  emulatorLogs.scrollTop = emulatorLogs.scrollHeight;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Ciclo de vida / cleanup
// ---------------------------------------------------------------------------
function clearBootTimeout() {
  window.clearTimeout(bootTimeout);
  bootTimeout = null;
}

function watchBootProgress(frame, stage) {
  clearBootTimeout();
  bootTimeout = window.setTimeout(() => {
    if (activeFrame !== frame) return;
    bootTimeout = null;
    appendEmulatorLog(`Tempo esgotado (20s) na etapa: ${stage}.`, 'error');
    failEmulatorBoot(frame, `O emulador não respondeu durante a etapa “${stage}” em 20 segundos.`);
  }, BOOT_TIMEOUT_MS);
}

// Chamado sempre que o emulador sai de cena (erro, troca ou remoção de ROM).
// A ROM já não existe mais como referência JS — a cópia restante vive dentro do
// iframe, então destruir o iframe devolve o heap ao GC de uma vez.
async function cleanupEmulator(frame, { silent = false } = {}) {
  clearBootTimeout();
  clearInterval(controllerSyncTimer);
  controllerSyncTimer = null;
  revokeRomUrl();
  if (frame) {
    frame.removeEventListener('load', frame.__onLoad || (() => {}));
    frame.__onLoad = null;
    try { frame.contentWindow?.close?.(); } catch { /* sandbox */ }
    frame.src = 'about:blank';   // libera o buffer do srcdoc antes de remover
    frame.remove();
  }
  emulatorHost.replaceChildren();
  if (!silent) {
    cleanupToast.hidden = false;
    // cede um frame para o GC coletar o heap do WASM antes de reapresentar a UI
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    if (cleanupToast.isConnected) cleanupToast.hidden = true;
  }
  return null;
}

async function failEmulatorBoot(frame, message) {
  if (activeFrame === frame) {
    activeFrame = null;
    operation += 1;
  }
  await cleanupEmulator(frame);
  appendEmulatorLog('Boot cancelado. Escolha a ROM novamente para tentar de novo.', 'error');
  setUploadStatus(message, 'error');
  uploadView.hidden = false;
  emulatorView.hidden = true;
  startWithSystemButton.hidden = true;
  releasePendingFile();
}

function releasePendingFile() {
  pendingFile = null;
}

async function stopEmulator() {
  operation += 1;
  startWithSystemButton.hidden = true;
  releasePendingFile();
  activeFrame = await cleanupEmulator(activeFrame);
  emulatorView.hidden = true;
  uploadView.hidden = false;
  setUploadStatus('', '');
}

// ---------------------------------------------------------------------------
// Detecção de sistema: extensão + sniff de assinatura binária
// ---------------------------------------------------------------------------
function getCore(fileName, firstBytes = null) {
  const extension = fileName.toLowerCase().split('.').pop();
  const selectedSystem = systemSelect.value;
  if (selectedSystem !== 'auto') return selectedSystem;

  if (firstBytes) {
    const magic = detectMagic(firstBytes);
    if (magic) return magic;
  }
  for (const [system, extensions] of Object.entries(EXTENSIONS_BY_SYSTEM)) {
    if (system === 'arcade') continue;
    if (extensions.includes(extension)) return system;
  }
  const ambiguous = { iso: 'psx', bin: 'psx', zip: null, '7z': null, rar: null, dsk: null, dol: null, wad: null };
  return Object.hasOwn(ambiguous, extension) ? ambiguous[extension] : null;
}

// Assinaturas mais confiáveis de console retrô (evita pedir sistema ao usuário).
function detectMagic(bytes) {
  const hex = [...bytes.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
  if (ascii.startsWith('NES\x1a') || hex.startsWith('4e45531a')) return 'nes';
  if (hex.startsWith('50534547') /* PSEG */ || hex.startsWith('45414743') /* EAGC */ || ascii.includes('SEGA')) return 'segaMD';
  if (hex.startsWith('8000000c') || hex.startsWith('37804012')) return 'n64';
  if (ascii.startsWith('ATARI') || hex.startsWith('41544152')) return 'atari2600';
  if (hex.startsWith('434f5059') /* COPY */ || ascii.includes('SEGA MEGA')) return 'segaMD';
  if (ascii.includes('CD001')) return 'psx';
  return null;
}

// ---------------------------------------------------------------------------
// Inspeção de arquivo: ZIP -> lista de ROMs candidatas (JSZip, tudo em RAM)
// ---------------------------------------------------------------------------
const ROM_EXTENSIONS = new Set(Object.values(EXTENSIONS_BY_SYSTEM).flat().concat(['iso', 'bin', 'img', 'chd']));

function isZipFile(_blob, fileName, firstBytes = null) {
  if (firstBytes && firstBytes[0] === 0x50 && firstBytes[1] === 0x4b) return true;
  return /\.(zip|7z)$/i.test(fileName || '');
}

function pickBestZipEntry(entries) {
  const scored = entries.map(entry => {
    const extension = entry.name.toLowerCase().split('.').pop();
    let score = 0;
    for (const [system, extensions] of Object.entries(EXTENSIONS_BY_SYSTEM)) {
      if (extensions.includes(extension)) score = Math.max(score, system === 'arcade' ? 1 : 2);
    }
    if (['iso', 'bin', 'img', 'chd'].includes(extension)) score = Math.max(score, 1);
    if (entry.name.startsWith('__MACOSX/') || entry.name.includes('/.')) score = -1;
    return { entry, extension, score };
  }).filter(item => item.score >= 0);
  scored.sort((a, b) => b.score - a.score || b.entry.uncompressedSize - a.entry.uncompressedSize);
  return scored;
}

async function inspectZip(blob) {
  const zip = await JSZip.loadAsync(blob);           // índice central apenas — nada descompactado ainda
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  if (!entries.length) throw new Error('O ZIP não contém arquivos.');
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP com ${entries.length} entradas (limite ${MAX_ZIP_ENTRIES}). Use um arquivo direto.`);
  }
  const candidates = pickBestZipEntry(entries);
  const roms = candidates.filter(item => ROM_EXTENSIONS.has(item.extension));
  const chosen = roms.length ? roms : candidates;

  if (chosen.length === 1) {
    return { mode: 'single', entry: chosen[0].entry, total: entries.length };
  }
  return { mode: 'menu', entries: chosen, total: entries.length };
}

async function extractZipEntry(_blob, entry) {
  // Extrai direto como Blob: entradas grandes ficam sob gestão do navegador
  // (podem ser paginadas para disco) em vez de alocar um Uint8Array inteiro.
  return entry.async('blob');
}

async function probeBlob(blob) {
  try { return new Uint8Array(await blob.slice(0, PROBE_BYTES).arrayBuffer()); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Renderização do seletor de ROMs do arquivo
// ---------------------------------------------------------------------------
function renderCatalog(title, items, onPick) {
  catalogSection.hidden = false;
  catalogSummary.textContent = title;
  catalogList.replaceChildren();
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'catalog-item';
    li.tabIndex = 0;
    const info = document.createElement('div');
    info.className = 'catalog-info';
    const name = document.createElement('span');
    name.className = 'catalog-name';
    name.textContent = item.label;
    const meta = document.createElement('span');
    meta.className = 'catalog-meta';
    meta.textContent = item.meta;
    info.append(name, meta);
    const play = document.createElement('button');
    play.className = 'catalog-play';
    play.type = 'button';
    play.textContent = 'Jogar';
    play.setAttribute('aria-label', `Jogar ${item.label}`);
    const pick = () => onPick(index);
    play.addEventListener('click', pick);
    li.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
    });
    li.append(info, play);
    catalogList.append(li);
  });
}

function hideCatalog() {
  catalogSection.hidden = true;
  catalogList.replaceChildren();
}

// ---------------------------------------------------------------------------
// Documento do iframe (núcleo isolado do app; recebe a ROM por transfer)
// ---------------------------------------------------------------------------
function emulatorDocument(controllerProfile = {}) {
  const serializedProfile = JSON.stringify(controllerProfile).replaceAll('</script>', '<\\/script>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#game{width:100%;height:100%;margin:0;background:#000;overflow:hidden}#game{display:flex;align-items:center;justify-content:center}</style></head><body><div id="game"></div><script>
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.type !== 'boot-rom' || typeof event.data.romUrl !== 'string') return;
      const { romUrl, core, name } = event.data;
      parent.postMessage({ type: 'rom-received' }, '*');
      window.EJS_player = '#game';
      window.EJS_core = core;
      window.EJS_defaultControls = ${serializedProfile};
      // Blob URL: o EmulatorJS baixa direto do Blob — o navegador gerencia a
      // memória (pode paginar para disco), sem duplicar a ROM no iframe.
      window.EJS_gameUrl = romUrl;
      window.EJS_gameName = name;
      window.EJS_pathtodata = '${DATA_PATH}';
      window.EJS_startOnLoaded = true;
      window.EJS_cacheConfig = { enabled: false };
      window.EJS_defaultOptions = { 'audio-latency': '256ms' };
      window.EJS_ready = () => parent.postMessage({ type: 'emulator-ready' }, '*');
      window.EJS_onGameStart = () => parent.postMessage({ type: 'game-started' }, '*');
      addEventListener('error', event => parent.postMessage({ type: 'emulator-error', message: event.message || 'Erro inesperado no emulador.' }, '*'));
      addEventListener('unhandledrejection', event => parent.postMessage({ type: 'emulator-error', message: String(event.reason || 'Falha ao carregar o jogo.') }, '*'));
      const loader = document.createElement('script');
      loader.src = window.EJS_pathtodata + 'loader.js';
      parent.postMessage({ type: 'loader-start' }, '*');
      loader.onload = () => parent.postMessage({ type: 'loader-ready' }, '*');
      loader.onerror = () => parent.postMessage({ type: 'loader-error' }, '*');
      document.head.append(loader);
    }, { once: true });
  <\/script></body></html>`;
}

// ---------------------------------------------------------------------------
// Pipeline principal: origem -> bytes na RAM -> iframe
// ---------------------------------------------------------------------------
async function startRom(source, requestedCore = null, { displayName = null } = {}) {
  stopEmulator();
  hideCatalog();
  const currentOperation = operation;

  // --- normaliza origem: File | { blob | bytes, name }
  let blob;
  let blobName;
  if (source instanceof File) {
    blob = source;
    blobName = source.name;
  } else {
    blob = source.blob instanceof Blob ? source.blob : new Blob([source.bytes], { type: 'application/octet-stream' });
    blobName = source.name;
  }

  // --- sniff inicial (só o cabeçalho, barato)
  const probe = await probeBlob(blob);
  if (currentOperation !== operation) return;

  const core = requestedCore || getCore(blobName, probe);
  if (!core) {
    pendingFile = { blob, name: blobName };
    startWithSystemButton.hidden = false;
    setUploadStatus(`Arquivo “${blobName}” selecionado. Escolha o sistema do jogo e inicie.`, '');
    return;
  }
  startWithSystemButton.hidden = true;

  resetEmulatorLogs();
  setUploadStatus(`Iniciando ${blobName}...`, '');
  document.getElementById('romName').textContent = displayName || blobName;
  document.getElementById('romCore').textContent = `Núcleo: ${core.toUpperCase()}`;
  uploadView.hidden = true;
  emulatorView.hidden = false;
  appendEmulatorLog(`ROM selecionada: ${blobName}`);

  try {
    // --- ZIP? descompacta o binário direto como Blob (zero-cópia)
    if (isZipFile(blob, blobName, probe)) {
      appendEmulatorLog('Arquivo ZIP detectado — inspecionando conteúdo na memória...');
      const inspection = await inspectZip(blob);
      if (currentOperation !== operation) return;
      if (inspection.mode === 'menu') {
        await cleanupEmulator(null, { silent: true });
        uploadView.hidden = false;
        emulatorView.hidden = true;
        renderCatalog(
          `${inspection.total} arquivos no ZIP · ${inspection.entries.length} jogáveis`,
          inspection.entries.map(item => ({
            label: item.entry.name,
            meta: `${item.extension.toUpperCase()} · descomprimido: ${formatBytes(item.entry.uncompressedSize)}`
          })),
          async index => {
            const chosen = inspection.entries[index];
            try {
              setUploadStatus(`Extraindo ${chosen.entry.name}...`, '');
              const payload = await extractZipEntry(blob, chosen.entry);
              const syntheticName = `${blobName}!${chosen.entry.name}`;
              const extracted = { blob: payload, name: chosen.entry.name.split('/').pop(), displayName: syntheticName };
              hideCatalog();
              await startRom(extracted, getCore(chosen.entry.name) ?? requestedCore);
            } catch (error) {
              setUploadStatus(`Falha ao extrair “${chosen.entry.name}”: ${error.message}`, 'error');
            }
          }
        );
        setUploadStatus(`O ZIP contém ${inspection.entries.length} jogos possíveis. Escolha abaixo.`, '');
        return;
      }
      appendEmulatorLog(`Extraindo ${inspection.entry.name} como Blob...`);
      const payload = await extractZipEntry(blob, inspection.entry);
      if (currentOperation !== operation) return;
      appendEmulatorLog(`Descomprimido: ${formatBytes(payload.size)}.`, 'success');
      const innerProbe = await probeBlob(payload);
      const innerCore = getCore(inspection.entry.name, innerProbe);
      return await bootWithBlob(
        payload,
        inspection.entry.name.split('/').pop(),
        innerCore || core,
        currentOperation,
        displayName || `${blobName} (de ${blobName.replace(/\.zip$/i, '')})`
      );
    }

    // --- arquivo direto: zero cópias — o Blob/File é gerenciado pelo navegador
    if (blob.size > MAX_ROM_BYTES) throw new Error(`Arquivo de ${formatBytes(blob.size)} excede o limite de ${formatBytes(MAX_ROM_BYTES)}.`);
    return await bootWithBlob(blob, blobName, core, currentOperation, displayName);
  } catch (error) {
    if (currentOperation === operation) {
      appendEmulatorLog(`Erro no preparo da ROM: ${error.message}`, 'error');
      setUploadStatus(error.message, 'error');
      uploadView.hidden = false;
      emulatorView.hidden = true;
    }
  }
}

// Monta o iframe apontando a ROM por Blob URL — o EmulatorJS baixa direto do
// Blob (gerenciado pelo navegador, pode ficar em disco). Nenhuma cópia do
// buffer passa pelo postMessage: pico de RAM ~= tamanho do Blob, e não o dobro.
function bootWithBlob(blob, blobName, core, currentOperation, displayName) {
  if (currentOperation !== operation) return;
  resetEmulatorLogs();
  document.getElementById('romName').textContent = displayName || blobName;
  document.getElementById('romCore').textContent = `Núcleo: ${core.toUpperCase()}`;
  uploadView.hidden = true;
  emulatorView.hidden = false;

  return new Promise(() => {
    const frame = document.createElement('iframe');
    frame.className = 'emulator-frame';
    frame.title = `Emulador: ${displayName || blobName}`;
    frame.setAttribute('sandbox', 'allow-scripts allow-downloads allow-same-origin');
    frame.__onLoad = () => {
      if (activeFrame !== frame) return;
      appendEmulatorLog(`Enviando Blob URL da ROM (${formatBytes(blob.size)})...`);
      watchBootProgress(frame, 'aguardando confirmação de recebimento da ROM');
      const romUrl = createRomUrl(blob);
      frame.contentWindow.postMessage({ type: 'boot-rom', romUrl, core, name: displayName || blobName }, '*');
    };
    frame.addEventListener('load', frame.__onLoad, { once: true });
    frame.srcdoc = emulatorDocument(loadControllerProfile());
    activeFrame = frame;
    emulatorHost.replaceChildren(frame);
    clearInterval(controllerSyncTimer);
    controllerSyncTimer = setInterval(() => syncControllerProfile(frame), 1000);
    watchBootProgress(frame, 'aguardando inicialização do EmulatorJS');
  }).catch(error => {
    if (operation !== currentOperation) return;
    appendEmulatorLog(`Falha no boot: ${error.message}`, 'error');
    return failEmulatorBoot(activeFrame, error.message);
  });
}

// ---------------------------------------------------------------------------
// Entradas de usuário
// ---------------------------------------------------------------------------
function receiveFiles(files) {
  if (files.length !== 1) {
    setUploadStatus('Selecione ou solte exatamente um arquivo de ROM.', 'error');
    return;
  }
  void startRom(files[0]);
}

romInput.addEventListener('change', () => {
  if (romInput.files?.length) receiveFiles(romInput.files);
  romInput.value = '';
});

controllerReset?.addEventListener('click', () => {
  localStorage.removeItem(CONTROLLER_PROFILE_KEY);
  try {
    const keysToRemove = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('ejs-') && key.endsWith('-settings')) keysToRemove.push(key);
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch { /* Preferência global removida; preferências restritas serão ignoradas pelo iframe. */ }
  controllerStatus?.setAttribute('aria-label', 'Mapeamento de controles restaurado');
  if (activeFrame?.contentWindow) {
    syncControllerProfile(activeFrame);
    localStorage.removeItem(CONTROLLER_PROFILE_KEY);
  }
  appendEmulatorLog('Mapeamento de controles restaurado para os padrões do sistema.', 'success');
});

removeButton.addEventListener('click', async () => {
  await stopEmulator();
  hideCatalog();
  setUploadStatus('ROM removida e memória liberada. Escolha outro arquivo para jogar.');
  romInput.focus();
});

startWithSystemButton.addEventListener('click', () => {
  if (!pendingFile || systemSelect.value === 'auto') {
    setUploadStatus('Escolha um sistema específico antes de iniciar este arquivo.', 'error');
    return;
  }
  const selection = pendingFile;
  releasePendingFile();
  void startRom(selection, systemSelect.value);
});

// Mensagens do iframe isolado
window.addEventListener('message', event => {
  if (event.source !== activeFrame?.contentWindow) return;
  if (event.data?.type === 'rom-received') {
    appendEmulatorLog('ROM recebida pelo emulador.');
    watchBootProgress(activeFrame, 'carregando o loader do EmulatorJS');
  }
  if (event.data?.type === 'loader-start') {
    appendEmulatorLog('Baixando loader.js...');
    watchBootProgress(activeFrame, 'baixando loader.js');
  }
  if (event.data?.type === 'loader-ready') {
    appendEmulatorLog(`Loader carregado; inicializando core ${document.getElementById('romCore').textContent.replace('Núcleo: ', '')}...`);
    watchBootProgress(activeFrame, 'baixando e compilando o núcleo');
  }
  if (event.data?.type === 'emulator-ready') {
    clearBootTimeout();
    appendEmulatorLog('WebAssembly inicializado; núcleo pronto.', 'success');
  }
  if (event.data?.type === 'loader-error') {
    clearBootTimeout();
    appendEmulatorLog('Falha ao baixar loader.js. Verifique a conexão com a internet.', 'error');
    void failEmulatorBoot(activeFrame, 'Não foi possível carregar o EmulatorJS (loader.js). Verifique a conexão e tente novamente.');
  }
  if (event.data?.type === 'game-started') {
    clearBootTimeout();
    appendEmulatorLog('Jogo iniciado.', 'success');
  }
  if (event.data?.type === 'emulator-error') {
    clearBootTimeout();
    appendEmulatorLog(`Erro do emulador: ${event.data.message}`, 'error');
    if (activeFrame) void failEmulatorBoot(activeFrame, `Erro do emulador: ${event.data.message}`);
  }
});

// Drag & drop
document.addEventListener('dragenter', event => {
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
  dropzone.classList.add('is-dragging');
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('dragleave', event => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropOverlay.hidden = true;
    dropzone.classList.remove('is-dragging');
  }
});
document.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  dropzone.classList.remove('is-dragging');
  if (event.dataTransfer?.files.length) receiveFiles(event.dataTransfer.files);
});
