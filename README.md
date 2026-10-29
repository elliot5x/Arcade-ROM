# Arcade ROM

Emulador de jogos retrô executado no navegador. Selecione uma ROM do dispositivo ou arraste o arquivo para a página para iniciar o jogo.

O projeto não inclui ROMs. Use apenas jogos e arquivos auxiliares que você tenha direito de utilizar.

## Recursos

- Carregamento de arquivos locais por seleção ou arrastar e soltar.
- Detecção automática de alguns sistemas por extensão e assinatura do arquivo, com seleção manual do sistema quando necessário.
- Inspeção de arquivos ZIP com até 128 entradas e seleção da ROM a extrair.
- Limite de 5 GiB para ROMs diretas.
- Execução isolada em um `iframe`, com a ROM referenciada por Blob URL em vez de ser copiada por `postMessage`.
- A ROM local é processada no navegador; ela não é enviada a um servidor pelo site. O EmulatorJS e os dados do núcleo são carregados sob demanda de `cdn.emulatorjs.org`, portanto é necessária conexão à internet.

Arquivos 7Z e RAR não são descompactados pelo aplicativo. Alguns sistemas também exigem BIOS ou arquivos auxiliares que não são fornecidos pelo projeto.

## Compatibilidade e requisitos

- Navegadores modernos com suporte a WebAssembly, Blob URLs, IndexedDB e módulos JavaScript.
- Chrome, Edge e Firefox atuais têm a melhor cobertura. Navegadores incorporados podem bloquear scripts CDN, o iframe isolado ou `SharedArrayBuffer`.
- O uso em `localhost` ou HTTPS é recomendado. PSP, N64 e outros núcleos com threads podem exigir `SharedArrayBuffer`.
- A aplicação é responsiva, mas núcleos complexos precisam de CPU, memória e GPU modernas.
- PSX, PSP, Arcade, sistemas de disco e alguns consoles podem precisar do sistema selecionado manualmente.

Sistemas comuns e formatos aceitos estão apresentados pela interface. Quando houver ambiguidade, selecione o sistema antes de iniciar. O formato anunciado pelo arquivo não garante compatibilidade com todos os núcleos do EmulatorJS.

## Arquivos 7Z, RAR e BIOS

- Arquivos ZIP são inspecionados localmente com JSZip. Arquivos com mais de 128 entradas são rejeitados para evitar consumo excessivo de memória.
- Arquivos 7Z/RAR são encaminhados ao EmulatorJS sem descompactação pelo site. O navegador ou o núcleo precisa oferecer suporte ao formato.
- BIOS necessários dependem do núcleo. O projeto não distribui BIOS; eles só podem ser usados quando você tiver autorização.
- Carregue arquivos auxiliares ou configure BIOS conforme os formatos aceitos pelo núcleo antes de iniciar novamente.

## Isolamento de origem

Núcleos PSP, N64 e alguns WASM podem usar threads. Isso exige `SharedArrayBuffer`, disponível somente com HTTPS ou localhost e com headers COOP/COEP:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Este projeto usa `coi-serviceworker.min.js` para tornar GitHub Pages compatível. Em desenvolvimento local, use uma origem local isolada e recarregue após o primeiro ajuste do serviço. Para PSP/N64:

1. Confirme `window.crossOriginIsolated === true` no console do navegador.
2. Remova bloqueadores que possam impedir o `coi-serviceworker`.
3. Teste em HTTP de localhost ou HTTPS; conteúdo HTTP misto não é permitido em HTTPS.
4. Recarregue uma segunda vez se a página foi carregada antes do Service Worker ficar ativo.

## Solução de problemas

### ROM não é identificada

Escolha o sistema manualmente ou confirme a extensão. Extensões ambíguas como `.bin`, arquivos sem extensão e discos podem exigir seleção manual.

### PSP ou N64 não inicia

Verifique o isolamento de origem, memória disponível e suporte WebAssembly/SharedArrayBuffer. Alguns navegadores móveis bloqueiam threads independentemente da página.

### ZIP inválido ou sem ROM reconhecida

Confira se o arquivo não está protegido por senha, se contém ROMs em formato suportado e se possui menos de 128 entradas. Evite ZIPs com arquivos auxiliares dentro de múltiplas camadas.

### BIOS ausente ou núcleo incompatível

Confira mensagens específicas do EmulatorJS. Reutilize BIOS apenas quando estiver autorizado e configure o caminho/nome esperado pelo núcleo.

## Executar localmente

Requer Node.js 24 ou superior.

```sh
npm ci
npm run dev
```

Abra o endereço local exibido pelo Vite. Para gerar a versão de produção:

```sh
npm run build
```

Build de produção local:

```sh
npm run build
npm run preview
```

O build compatível com GitHub Pages usa:

```sh
npm run build:site
```

## Testes e qualidade

```sh
npm test
npm run test:watch
npm run test:coverage
npm run lint
npm run format:check
```

### Docker

Com Docker Compose instalado:

```sh
docker compose up --build
```

Abra `http://localhost:5173`.

## Publicação no GitHub Pages

O workflow do GitHub Pages gera o site com o caminho base `/Arcade-ROM/`. Para gerar o mesmo build localmente:

```sh
npm run build:site
```

## Tecnologias

- Vite para desenvolvimento e build do site.
- JSZip para inspecionar e extrair entradas de arquivos ZIP.
- EmulatorJS, carregado sob demanda do CDN oficial, para executar os jogos.
