// ---------------------------------------------------------------------------
// Arcade ROM — controlador do emulador (arquitetura estilo RomsFUN)
// Fluxo: arquivo local -> Blob URL (zero-cópia, gerenciado pelo navegador) ->
//        inspeção .zip (JSZip, apenas índice central) -> seleção do binário ->
//        iframe isolado -> o emulador baixa direto do Blob URL -> cleanup agressivo.
// ---------------------------------------------------------------------------
import packageJson from '../package.json';
import { detectCore } from './system-detection.js';
import { bootErrorGuidance, bootTimeoutFor, coreNeedsThreads } from './emulator-boot.js';
import { extractZipEntry, inspectZip, isZipFile } from './zip-inspector.js';
import { setLiveStatus, updateDragState } from './ui.js';

const APP_VERSION = packageJson.version;
const DATA_PATH = 'https://cdn.emulatorjs.org/stable/data/';
const MAX_ROM_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB — Blobs grandes vão para o disco, não estouram o heap
const PROBE_BYTES = 0x8100;
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
let operation = 0; // token de geração: invalida trabalho assíncrono órfão
let dragDepth = 0;
let pendingFile = null;
let bootTimeout = null;
let logStartedAt = 0;
let gameStarted = false; // evita que 'emulator-ready' tardio reabra um timeout após o jogo iniciar
let activeRomUrl = null; // Blob URL corrente — revogado no cleanup

function revokeRomUrl() {
  if (activeRomUrl) {
    URL.revokeObjectURL(activeRomUrl);
    activeRomUrl = null;
  }
}

function createRomUrl(blobOrFile) {
  revokeRomUrl();
  activeRomUrl = URL.createObjectURL(blobOrFile);
  return activeRomUrl;
}

function updateControllerStatus() {
  if (!controllerStatus) return;
  // FIX: getGamepads() devolve array-like (não necessariamente Array) em alguns navegadores.
  const gamepads = Array.from(navigator.getGamepads?.() ?? []).filter(Boolean);
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
window.addEventListener('error', (event) => {
  const detail = event.error?.stack || event.message || 'Erro não identificado na página.';
  appendEmulatorLog(`Erro da página: ${detail}`, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const detail = reason?.stack || reason?.message || String(reason || 'Promessa rejeitada sem motivo.');
  appendEmulatorLog(`Promise rejeitada: ${detail}`, 'error');
});
const appVersion = document.getElementById('appVersion');
if (appVersion) appVersion.textContent = `v${APP_VERSION}`;

updateControllerStatus();
setInterval(updateControllerStatus, 1500);

// ---------------------------------------------------------------------------
// Status / log
// ---------------------------------------------------------------------------
function setUploadStatus(message, kind = '') {
  setLiveStatus(uploadStatus, message, kind);
}

function resetEmulatorLogs() {
  logStartedAt = performance.now();
  emulatorLogs.replaceChildren();
}

function appendEmulatorLog(message, kind = 'info') {
  const elapsed = Math.max(0, (performance.now() - logStartedAt) / 1000)
    .toFixed(1)
    .padStart(4, '0');
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
  const timeout = bootTimeoutFor(stage);
  bootTimeout = window.setTimeout(() => {
    if (activeFrame !== frame) return;
    bootTimeout = null;
    const seconds = Math.round(timeout / 1000);
    appendEmulatorLog(`Tempo esgotado (${seconds}s) na etapa: ${stage}.`, 'error');
    failEmulatorBoot(frame, `O emulador não respondeu durante a etapa “${stage}” em ${seconds} segundos.`);
  }, timeout);
}

// Chamado sempre que o emulador sai de cena (erro, troca ou remoção de ROM).
// Destruir o iframe devolve o heap do WASM ao GC de uma vez.
async function cleanupEmulator(frame, { silent = false } = {}) {
  clearBootTimeout();
  revokeRomUrl();
  if (frame) {
    frame.removeEventListener('load', frame.__onLoad || (() => {}));
    frame.__onLoad = null;
    try {
      frame.contentWindow?.close?.();
    } catch {
      /* sandbox */
    }
    // FIX: com srcdoc presente, definir src não navega — o srcdoc tem prioridade.
    // Remover o atributo primeiro para realmente liberar o documento do emulador.
    frame.removeAttribute('srcdoc');
    frame.src = 'about:blank';
    frame.remove();
  }
  emulatorHost.replaceChildren();
  if (!silent) {
    cleanupToast.hidden = false;
    // cede um frame para o GC coletar o heap do WASM antes de reapresentar a UI
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
  const guidance = bootErrorGuidance(message);
  if (guidance) {
    appendEmulatorLog(guidance, 'warning');
    setUploadStatus(`${message} ${guidance}`, 'error');
  }
  uploadView.hidden = false;
  emulatorView.hidden = true;
  startWithSystemButton.hidden = true;
  releasePendingFile();
}

// Teclado/gamepad só chegam ao EmulatorJS se o iframe tiver o foco da página.
function focusEmulator(frame = activeFrame) {
  try {
    frame?.focus();
    frame?.contentWindow?.focus();
  } catch {
    /* sandbox */
  }
}
emulatorHost.addEventListener('pointerdown', () => focusEmulator());

function releasePendingFile() {
  pendingFile = null;
}

async function stopEmulator({ silent = false } = {}) {
  operation += 1;
  startWithSystemButton.hidden = true;
  releasePendingFile();
  const frame = activeFrame;
  activeFrame = null;
  await cleanupEmulator(frame, { silent });
  emulatorView.hidden = true;
  uploadView.hidden = false;
  setUploadStatus('', '');
}

// ---------------------------------------------------------------------------
// Detecção de sistema: extensão + sniff de assinatura binária
// ---------------------------------------------------------------------------
function getCore(fileName, firstBytes = null) {
  const selectedSystem = systemSelect.value;
  return detectCore(fileName, firstBytes, selectedSystem);
}

// ---------------------------------------------------------------------------
// Inspeção de arquivo: ZIP -> lista de ROMs candidatas (JSZip)
// ---------------------------------------------------------------------------
async function probeBlob(blob) {
  try {
    return new Uint8Array(await blob.slice(0, PROBE_BYTES).arrayBuffer());
  } catch {
    return null;
  }
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
    li.addEventListener('keydown', (event) => {
      if (event.target !== li) return; // não duplicar o clique quando o foco está no botão
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
    li.append(info, play);
    catalogList.append(li);
  });
  requestAnimationFrame(() => catalogList.querySelector('.catalog-play')?.focus());
}

function hideCatalog() {
  catalogSection.hidden = true;
  catalogList.replaceChildren();
}

// ---------------------------------------------------------------------------
// Documento do iframe (núcleo isolado do app; recebe a ROM por Blob URL)
// ---------------------------------------------------------------------------
function emulatorDocument() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#game{width:100%;height:100%;margin:0;background:#000;overflow:hidden}#game{display:flex;align-items:center;justify-content:center}</style></head><body><div id="game"></div><script>
    // FIX: antes usava { once: true } — qualquer mensagem (de extensões, por exemplo)
    // consumia o listener antes do 'boot-rom' chegar. Agora só remove após o boot válido.
    function onBootMessage(event) {
      if (event.source !== parent || event.data?.type !== 'boot-rom' || typeof event.data.romUrl !== 'string') return;
      removeEventListener('message', onBootMessage);
      const { romUrl, core, name, threads } = event.data;
      parent.postMessage({ type: 'rom-received' }, '*');
      window.EJS_player = '#game';
      window.EJS_core = core;
      // Blob URL: o EmulatorJS baixa direto do Blob — o navegador gerencia a
      // memória (pode paginar para disco), sem duplicar a ROM no iframe.
      window.EJS_gameUrl = romUrl;
      window.EJS_gameName = name;
      window.EJS_pathtodata = '${DATA_PATH}';
      window.EJS_startOnLoaded = true;
      window.EJS_cacheConfig = { enabled: false };
      window.EJS_defaultOptions = { 'audio-latency': '256ms' };
      // Núcleos pesados (PSP/PPSSPP, N64, NDS) usam threads WASM, que exigem SharedArrayBuffer
      // (página com crossOriginIsolated). Só ativa quando o ambiente suporta.
      if (threads) window.EJS_threads = true;
      window.EJS_ready = () => parent.postMessage({ type: 'emulator-ready' }, '*');
      window.EJS_onGameStart = () => parent.postMessage({ type: 'game-started' }, '*');
      // console.error do EmulatorJS é barulhento e na maioria das vezes não fatal;
      // só promovemos a erro fatal o que indica falha real de memória/WASM.
      const FATAL_CONSOLE = /requires threads|out of memory|memory access out of bounds|RuntimeError|Aborted|SharedArrayBuffer|WebAssembly/i;
      ['error', 'warn'].forEach(level => {
        const original = console[level].bind(console);
        console[level] = (...args) => {
          original(...args);
          const message = args.map(value => value?.stack || value?.message || String(value)).join(' ');
          const fatal = level === 'error' && FATAL_CONSOLE.test(message);
          parent.postMessage({ type: fatal ? 'emulator-error' : 'emulator-warning', message }, '*');
        };
      });
      addEventListener('error', event => {
        const target = event.target;
        const failedResource = target?.src || target?.href;
        if (failedResource) {
          // Só falha de <script> é fatal; imagens/estilos/fontes opcionais não devem abortar o boot.
          const fatal = target.tagName === 'SCRIPT';
          parent.postMessage({ type: fatal ? 'emulator-error' : 'emulator-warning', message: 'Falha ao carregar recurso do emulador: ' + failedResource }, '*');
          return;
        }
        const location = event.filename ? ' @ ' + event.filename + ':' + event.lineno + ':' + event.colno : '';
        // Falha interna do leitor de gamepad do EmulatorJS: afeta só o controle, não o jogo.
        // Antes isso derrubava o emulador inteiro (e com ele teclado e mouse).
        if (String(event.error?.stack || '').includes('GamepadHandler')) {
          parent.postMessage({ type: 'emulator-warning', message: 'Falha no leitor de gamepad do EmulatorJS (jogo continua): ' + (event.error?.message || event.message) }, '*');
          return;
        }
        // "Script error." = exceção num script cross-origin (CDN) sanitizada pelo navegador.
        if (event.message === 'Script error.' || event.message === 'Script error.\\n') {
          parent.postMessage({ type: 'emulator-warning', message: 'Erro interno não identificado em script do emulador (cross-origin, sem detalhes).' }, '*');
          return;
        }
        parent.postMessage({ type: 'emulator-error', message: event.error?.stack || (event.message || 'Erro inesperado no emulador.') + location }, '*');
      }, true);
      addEventListener('unhandledrejection', event => parent.postMessage({ type: 'emulator-error', message: event.reason?.stack || event.reason?.message || String(event.reason || 'Falha ao carregar o jogo.') }, '*'));
      // "Script error." aparece porque os scripts do CDN são carregados sem o atributo crossorigin: o navegador
      // esconde a mensagem real. Marcando todo <script> criado aqui como anonymous, o erro vem com detalhes.
      // Contorno para o bug do GamepadHandler do EmulatorJS: ele guarda os controles num array por posição
      // mas consulta por gamepad.index. Se o seu controle tem index 1, 2... (ex.: um controle virtual ocupa
      // o 0), a consulta volta undefined e dá "reading 'id'". Aqui os controles conectados são repassados
      // compactados, com index 0, 1, 2... igual à posição, o que também mantém o jogador 1 no primeiro controle.
      if (navigator.getGamepads) {
        const realGetGamepads = navigator.getGamepads.bind(navigator);
        navigator.getGamepads = () => Array.from(realGetGamepads() || [])
          .filter(pad => pad && pad.connected)
          .map((pad, position) => new Proxy(pad, {
            get(target, key) {
              if (key === 'index') return position;
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          }));
      }
      const nativeCreateElement = document.createElement.bind(document);
      document.createElement = (tag, ...rest) => {
        const element = nativeCreateElement(tag, ...rest);
        if (String(tag).toLowerCase() === 'script') element.crossOrigin = 'anonymous';
        return element;
      };
      const loader = document.createElement('script');
      loader.src = window.EJS_pathtodata + 'loader.js';
      parent.postMessage({ type: 'loader-start' }, '*');
      loader.onload = () => {
        parent.postMessage({ type: 'loader-ready' }, '*');
        let constructionChecks = 0;
        const constructionProbe = setInterval(() => {
          constructionChecks += 1;
          if (window.EJS_emulator) {
            clearInterval(constructionProbe);
            parent.postMessage({ type: 'emulator-construction-started' }, '*');
          } else if (constructionChecks >= 300) {
            clearInterval(constructionProbe);
            parent.postMessage({ type: 'emulator-error', message: 'O EmulatorJS não criou o emulador após o loader carregar.' }, '*');
          }
        }, 1000);
      };
      loader.onerror = () => parent.postMessage({ type: 'loader-error' }, '*');
      document.head.append(loader);
    }
    addEventListener('message', onBootMessage);
  <${'/'}script></body></html>`;
}

// ---------------------------------------------------------------------------
// Pipeline principal: origem -> Blob -> (ZIP?) -> iframe
// ---------------------------------------------------------------------------
async function startRom(source, requestedCore = null, { displayName = null } = {}) {
  // FIX: antes stopEmulator() não era aguardado. Sua continuação (após o await interno)
  // rodava depois do boot começar e zerava activeFrame / escondia o emulador,
  // fazendo o app ignorar todas as mensagens do iframe.
  await stopEmulator({ silent: true });
  hideCatalog();
  const currentOperation = operation;

  // --- normaliza origem: File | { blob | bytes, name, displayName? }
  let blob;
  let blobName;
  if (source instanceof File) {
    blob = source;
    blobName = source.name;
  } else {
    blob = source.blob instanceof Blob ? source.blob : new Blob([source.bytes], { type: 'application/octet-stream' });
    blobName = source.name;
    displayName = displayName ?? source.displayName ?? null; // FIX: displayName do objeto era ignorado
  }

  // --- sniff inicial (só o cabeçalho, barato)
  const probe = await probeBlob(blob);
  if (currentOperation !== operation) return;

  const forcedSystem = requestedCore || (systemSelect.value !== 'auto' ? systemSelect.value : null);
  // Arcade (MAME/FBNeo) precisa do .zip inteiro: não descompactar.
  const unzip = isZipFile(probe, blobName) && !['arcade', 'mame2003'].includes(forcedSystem);

  // FIX: antes um .zip sem sistema escolhido pedia o sistema ANTES de inspecionar o conteúdo
  // (getCore devolve null para 'zip'). Agora o ZIP é aberto primeiro e o sistema sai do arquivo interno.
  let core = null;
  if (!unzip) {
    core = requestedCore || getCore(blobName, probe);
    if (!core) {
      pendingFile = { blob, name: blobName, displayName };
      startWithSystemButton.hidden = false;
      setUploadStatus(`Arquivo “${blobName}” selecionado. Escolha o sistema do jogo e inicie.`, '');
      return;
    }
  }
  startWithSystemButton.hidden = true;

  try {
    if (unzip) {
      resetEmulatorLogs();
      setUploadStatus(`Inspecionando ${blobName}...`, '');
      appendEmulatorLog(`ZIP detectado: ${blobName} — lendo índice...`);
      const inspection = await inspectZip(blob);
      if (currentOperation !== operation) return;

      if (inspection.mode === 'menu') {
        renderCatalog(
          `${inspection.total} arquivos no ZIP · ${inspection.entries.length} jogáveis`,
          inspection.entries.map((item) => ({
            label: item.entry.name,
            meta: `${item.extension.toUpperCase()} · descomprimido: ${formatBytes(item.entry.uncompressedSize)}`,
          })),
          async (index) => {
            const chosen = inspection.entries[index];
            try {
              setUploadStatus(`Extraindo ${chosen.entry.name}...`, '');
              const payload = await extractZipEntry(chosen.entry);
              const extracted = {
                blob: payload,
                name: chosen.entry.name.split('/').pop(),
                displayName: `${blobName} › ${chosen.entry.name}`,
              };
              hideCatalog();
              await startRom(extracted, requestedCore);
            } catch (error) {
              setUploadStatus(`Falha ao extrair “${chosen.entry.name}”: ${error.message}`, 'error');
            }
          },
        );
        setUploadStatus(`O ZIP contém ${inspection.entries.length} jogos possíveis. Escolha abaixo.`, '');
        return;
      }

      const innerName = inspection.entry.name.split('/').pop();
      appendEmulatorLog(`Extraindo ${innerName} como Blob...`);
      const payload = await extractZipEntry(inspection.entry);
      if (currentOperation !== operation) return;
      appendEmulatorLog(`Descomprimido: ${formatBytes(payload.size)}.`, 'success');
      const innerProbe = await probeBlob(payload);
      if (currentOperation !== operation) return;
      const innerCore = requestedCore || getCore(innerName, innerProbe);
      if (!innerCore) {
        // FIX: antes seguia com core null e quebrava no boot; agora pede o sistema.
        pendingFile = {
          blob: payload,
          name: innerName,
          displayName: displayName || `${blobName} › ${inspection.entry.name}`,
        };
        startWithSystemButton.hidden = false;
        setUploadStatus(`Não foi possível identificar o sistema de “${innerName}”. Escolha o sistema e inicie.`, '');
        return;
      }
      return bootWithBlob(
        payload,
        innerName,
        innerCore,
        currentOperation,
        displayName || `${blobName} › ${inspection.entry.name}`,
      );
    }

    // --- arquivo direto: zero cópias — o Blob/File é gerenciado pelo navegador
    if (blob.size > MAX_ROM_BYTES)
      throw new Error(`Arquivo de ${formatBytes(blob.size)} excede o limite de ${formatBytes(MAX_ROM_BYTES)}.`);
    return bootWithBlob(blob, blobName, core, currentOperation, displayName);
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
// `fileName` é o nome real (com extensão) enviado ao emulador; `displayName` é só para a UI.
function bootWithBlob(blob, fileName, core, currentOperation, displayName) {
  if (currentOperation !== operation) return;
  resetEmulatorLogs();
  gameStarted = false;
  document.getElementById('romName').textContent = displayName || fileName;
  document.getElementById('romCore').textContent = `Núcleo: ${core.toUpperCase()}`;
  uploadView.hidden = true;
  emulatorView.hidden = false;
  appendEmulatorLog(`ROM selecionada: ${fileName} (${formatBytes(blob.size)})`);

  // PSP (PPSSPP) só roda com threads WASM, que exigem SharedArrayBuffer => página com crossOriginIsolated.
  // Sem isso o EmulatorJS falha no meio do boot com erros confusos (ex.: "reading 'AL'"). Falha cedo e explica.
  if (coreNeedsThreads(core) && !window.crossOriginIsolated) {
    const message = `${core.toUpperCase()} precisa de isolamento de origem (COOP/COEP) para usar threads WASM. Adicione o coi-serviceworker ao site e recarregue a página duas vezes.`;
    appendEmulatorLog(message, 'error');
    setUploadStatus(message, 'error');
    uploadView.hidden = false;
    emulatorView.hidden = true;
    return;
  }

  // FIX: antes era `new Promise(() => {...})` que nunca resolvia; agora é uma função síncrona
  // com try/catch, e erros de montagem realmente caem no failEmulatorBoot.
  try {
    const frame = document.createElement('iframe');
    frame.className = 'emulator-frame';
    frame.title = `Emulador: ${displayName || fileName}`;
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-downloads allow-same-origin allow-pointer-lock allow-modals allow-forms',
    );
    frame.tabIndex = 0;
    frame.setAttribute('allow', 'autoplay; gamepad; fullscreen; cross-origin-isolated');
    frame.__onLoad = () => {
      if (activeFrame !== frame) return;
      appendEmulatorLog(`Enviando Blob URL da ROM (${formatBytes(blob.size)})...`);
      watchBootProgress(frame, 'aguardando confirmação de recebimento da ROM');
      const romUrl = createRomUrl(blob);
      frame.contentWindow.postMessage(
        {
          type: 'boot-rom',
          romUrl,
          core,
          name: fileName,
          threads: window.crossOriginIsolated === true,
        },
        '*',
      );
    };
    frame.addEventListener('load', frame.__onLoad, { once: true });
    frame.srcdoc = emulatorDocument();
    activeFrame = frame;
    emulatorHost.replaceChildren(frame);
    watchBootProgress(frame, 'aguardando inicialização do EmulatorJS');
  } catch (error) {
    if (operation !== currentOperation) return;
    appendEmulatorLog(`Falha no boot: ${error.message}`, 'error');
    return failEmulatorBoot(activeFrame, error.message);
  }
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
  // Remove apenas as configurações que o próprio EmulatorJS salvou (ejs-*-settings).
  try {
    const keysToRemove = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('ejs-') && key.endsWith('-settings')) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* armazenamento bloqueado */
  }
  appendEmulatorLog('Configurações de controle do EmulatorJS restauradas. Reabra a ROM para aplicar.', 'success');
});

removeButton.addEventListener('click', async () => {
  if (!window.confirm('Remover a ROM atual e liberar a memória do emulador?')) return;
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
window.addEventListener('message', (event) => {
  if (!activeFrame || event.source !== activeFrame.contentWindow) return;
  const frame = activeFrame;
  switch (event.data?.type) {
    case 'rom-received':
      appendEmulatorLog('ROM recebida pelo emulador.');
      watchBootProgress(frame, 'carregando o loader do EmulatorJS');
      break;
    case 'loader-start':
      appendEmulatorLog('Baixando loader.js...');
      watchBootProgress(frame, 'baixando loader.js');
      break;
    case 'loader-ready':
      appendEmulatorLog(
        `Loader carregado; inicializando core ${document.getElementById('romCore').textContent.replace('Núcleo: ', '')}...`,
      );
      watchBootProgress(frame, 'baixando e compilando o núcleo');
      break;
    case 'emulator-construction-started':
      appendEmulatorLog('EmulatorJS criado; baixando e compilando o núcleo…', 'info');
      watchBootProgress(frame, 'baixando e compilando o núcleo');
      break;
    case 'emulator-ready':
      appendEmulatorLog('WebAssembly inicializado; núcleo pronto.', 'success');
      // FIX: antes limpava o timeout e nunca mais vigiava — se o jogo travasse, ficava infinito.
      if (gameStarted) clearBootTimeout();
      else watchBootProgress(frame, 'iniciando o jogo');
      break;
    case 'loader-error':
      clearBootTimeout();
      appendEmulatorLog('Falha ao baixar loader.js. Verifique a conexão com a internet.', 'error');
      void failEmulatorBoot(
        frame,
        'Não foi possível carregar o EmulatorJS (loader.js). Verifique a conexão e tente novamente.',
      );
      break;
    case 'game-started':
      gameStarted = true;
      clearBootTimeout();
      focusEmulator(frame);
      appendEmulatorLog('Jogo iniciado.', 'success');
      break;
    case 'emulator-warning':
      appendEmulatorLog(`Aviso do emulador: ${event.data.message}`, 'warning');
      break;
    case 'emulator-error':
      clearBootTimeout();
      appendEmulatorLog(`Erro do emulador: ${event.data.message}`, 'error');
      void failEmulatorBoot(frame, `Erro do emulador: ${event.data.message}`);
      break;
    default:
      break;
  }
});

// Drag & drop
document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  updateDragState({ overlay: dropOverlay, dropzone }, true);
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    updateDragState({ overlay: dropOverlay, dropzone }, false);
  }
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  updateDragState({ overlay: dropOverlay, dropzone }, false);
  if (event.dataTransfer?.files.length) receiveFiles(event.dataTransfer.files);
});
