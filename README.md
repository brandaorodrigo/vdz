# vdz

Transmissão ao vivo de uma janela do Windows para o navegador. O vídeo e o áudio vão direto de quem transmite para quem assiste (WebRTC). O servidor só entrega as páginas e encaminha as mensagens que abrem essa conexão. Ele não recebe nem reenvia a mídia.

Versão atual: **2.2.0**. Interface em português.

## Requisitos

- [Node.js](https://nodejs.org/) com npm.
- Para transmitir pelo app: Windows, com o .NET Framework 4.x (o `csc.exe` que já vem em `Framework64\v4.0.30319`). Não há SDK à parte.
- Quem assiste só precisa de um navegador com WebRTC.

Não há servidor TURN. Quem estiver atrás de NAT simétrico pode não conectar. Os STUN usados estão em `public/common.js` (Google e Cloudflare).

## Como rodar

```bash
npm install
npm start
```

`npm start` sobe um servidor local em `http://localhost:3000`. Com ele no ar:

- **Assistir** — abra `http://localhost:3000`. A página inicial é um mosaico de até quatro listas. Cada nome abre o player em `/video?id=<nome>`.
- **Transmitir no navegador** — abra `http://localhost:3000/stream`. A captura usa o seletor do próprio browser (`getDisplayMedia`), com áudio do sistema se o browser oferecer.

`npm run app` compila `electron/win-audio.exe` se o fonte em C# estiver mais novo e abre o Electron. Essa janela não usa o servidor local: carrega `https://vdz.onrender.com/stream?version=2.2.0` (`streamUrl` em `electron/main.js`). No app, o vídeo é a janela escolhida e o áudio é o loopback WASAPI do processo dessa janela, não o áudio do Chromium. Quem assiste essa live abre o mesmo host, `https://vdz.onrender.com`.

`npm run dist` gera o instalador NSIS `vdz_2.2.0.exe` (um clique, por usuário, atalho "vdz", idioma pt-BR). O executável nativo entra em `resources/win-audio.exe`. `electron/win-audio.exe` não vai para o git. O app de desenvolvimento e o empacotado usam a mesma URL de produção.

## Uso

1. Quem transmite escolhe a janela, um nome e a qualidade, e entra no ar. O nome vira o id da live: só `[a-z0-9]`, no máximo 40 caracteres. Dois transmissores não compartilham o mesmo nome.
2. Quem assiste vê o nome na lista e abre o player. O vídeo começa mudo para o autoplay passar. O volume vai de 0 a 100% e é o `volume` do `<video>`.
3. Parar o compartilhamento encerra a live. Quem estava assistindo volta para a lista.

Qualidade padrão na transmissão: 720p, 60 fps, 4 Mb. As opções de bitrate são 2, 4, 8 e 16 Mb.

No Electron, `/list` e `/video` redirecionam para `/update`. A tela de transmissão só continua se `?version=` for exatamente `2.2.0`. O botão de download, na atualização e no primeiro quadro do mosaico (`/list?unique=1`), baixa o instalador no GitHub Releases: `https://github.com/brandaorodrigo/vdz/releases/download/2.2.0/vdz_2.2.0.exe`.

Quem assiste chama `GET /ping` ao abrir o player e de novo a cada 1 minuto. Quem transmite chama no mesmo intervalo só enquanto a live está no ar. A resposta é `204`, para o host não dormir por inatividade.

## Páginas

| Rota | Papel |
| --- | --- |
| `/` | Mosaico de 1 a 4 listas |
| `/list` | Quem está no ar |
| `/video?id=` | Player de uma live |
| `/stream` | Captura, prévia e ofertas WebRTC |
| `/update` | Pede para baixar o instalador da versão atual |
| `/ping` | Keep-alive vazio |

A versão está em `package.json`, na checagem de `public/stream.html` e nas URLs de download de `public/list.html` e `public/update.html`. Ao mudar a versão, os quatro lugares precisam acompanhar.

## O que cada arquivo faz

| Arquivo | Papel |
| --- | --- |
| `server.js` | HTTP estático e WebSocket na mesma porta. Exporta `{ listen, close }`; rodado direto, escuta a porta 3000. |
| `public/index.html`, `list.html`, `video.html` | Mosaico, lista e player |
| `public/stream.html` | Transmissão |
| `public/common.js` | Servidores STUN e `showError` |
| `public/styles.css` | CSS em uso |
| `electron/main.js`, `preload.js` | Janela Electron, escolha da fonte e PCM |
| `electron/win-audio.cs` | Loopback WASAPI do processo da janela |

O protocolo não tem autenticação nem sala além do nome. Um nome é público para quem alcança o servidor.
