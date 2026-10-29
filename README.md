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
