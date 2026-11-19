# vdz

Transmissão ao vivo de uma janela do Windows para o navegador. O vídeo e o áudio vão direto de quem transmite para quem assiste (WebRTC). O servidor só entrega as páginas e encaminha as mensagens que abrem essa conexão. Ele não recebe nem reenvia a mídia.

Versão atual: **2.2.0**. Interface e comentários em português.

## Como rodar

- `npm start` sobe só o servidor em `http://localhost:3000` (`node server.js`). Serve para assistir e transmitir pelo navegador, contra esse servidor.
- `npm run app` compila `electron/win-audio.exe` se o `.cs` estiver mais novo e abre o Electron. A janela carrega `streamUrl` em `electron/main.js`: `https://vdz.onrender.com/stream?version=<versão do app>`. Não usa o servidor local, então edição em `public/` não aparece nele.
- `npm run dist` faz o mesmo build do capturador e gera o instalador NSIS `vdz_<versão>.exe` (um clique, por usuário, atalho "vdz", idioma pt-BR). O executável nativo entra em `resources/win-audio.exe`.

O compilador é o `csc.exe` do .NET Framework 4.x que já vem no Windows (`Framework64\v4.0.30319`). Não há SDK à parte. `electron/win-audio.exe` não vai para o git.

`streamUrl` fica antes de `open()`. O app de desenvolvimento e o empacotado usam a mesma URL de produção.

## Peças

| Peça | Arquivo | Papel |
| --- | --- | --- |
| Sinalização | `server.js` | HTTP estático + WebSocket na mesma porta |
| Quem assiste | `public/index.html`, `list.html`, `video.html` | Mosaico, lista de lives e player |
| Quem transmite | `public/stream.html` | Captura, prévia e ofertas WebRTC |
| Compartilhado no browser | `public/common.js` | Servidores STUN e `showError` |
| App de captura | `electron/main.js`, `preload.js` | Janela Electron, escolha da fonte, PCM |
| Áudio da janela | `electron/win-audio.cs` | Loopback WASAPI do processo da janela |
| Visual | `public/styles.css` | Único CSS em uso |

## Páginas

O Express entrega cada HTML numa rota fixa. `express.static` serve o resto de `public/` com `index: false`, para um `index.html` solto não tomar o lugar de `/`.

- `GET /` — `index.html`. Mosaico de 1 a 4 quadros. O primeiro já abre `/list?unique=1`; os outros recebem `/list` quando aparecem. A barra (menos, mais, tela cheia) aparece com o mouse e some após 3 s parado. O mouse dentro do iframe não borbulha: cada quadro registra `mousemove` no próprio documento. `mouseleave` espera 200 ms, porque cruzar para a barra também dispara esse evento.
- `GET /list` — lista de quem está no ar. Cada nome abre `/video?id=<nome>`. No Electron, redireciona para `/update`. O botão de download só aparece com `?unique=1` e baixa `https://github.com/brandaorodrigo/vdz/releases/download/<versão>/vdz_<versão>.exe`.
- `GET /video` — player de uma live. No Electron, também vai para `/update`.
- `GET /stream` — tela de transmissão. No Electron, continua só se `?version=` for exatamente `2.2.0`; qualquer outra versão vai para `/update`.
- `GET /update` — pede para baixar o mesmo instalador no GitHub Releases.
- `GET /ping` — `204` vazio. `/video` chama ao abrir e de novo a cada 1 minuto. `/stream` chama no mesmo intervalo só enquanto a live está no ar (`stayAwake`). Serve para o host não dormir.
- `GET /webcam` — `public/webcam/webcam.html`. Extra solto, fora da sinalização e do CSS do vdz: só mostra a câmera ocupando a janela, para quem quiser capturar essa página e transmitir a webcam. Duplo clique pede tela cheia. `deviceId`, `deviceLabel` e `audioDeviceId` na query escolhem o aparelho; sem `audioDeviceId` não há áudio.

A versão está em `package.json` (o Electron manda `app.getVersion()` na query), na checagem de `public/stream.html` e nas URLs de `public/list.html` e `public/update.html`. Ao mudar a versão, os quatro lugares precisam acompanhar. O instalador gerado se chama `vdz_<versão>.exe` e o link aponta para o asset dessa tag no GitHub Releases.

## Papéis no WebSocket

Cada socket assume um papel uma vez. Mensagem que não é JSON é ignorada. O socket só envia se `readyState === 1`.

Estado no servidor:

- `broadcasters`: nome → socket de quem transmite. O id da live **é** o nome.
- `watchers`: id numérico crescente → socket de quem assiste. Cada um guarda `broadcasterId`.
- `lobbies`: sockets da lista, que não assistem nem transmitem.
- `nextId`: próximo id de espectador, a partir de 1.

Nome válido: `readName` deixa só `[a-z0-9]`, no máximo 40 caracteres. Vazio responde `need-name`. Nome já em `broadcasters` responde `name-taken`. A página aplica a mesma limpeza no input.

### Mensagens

Cliente → servidor:

| `type` | Quem | Efeito |
| --- | --- | --- |
| `broadcaster` | página `/stream`, com `name` | entra no ar e publica a lista |
| `stop` | broadcaster | sai do ar, avisa os watchers e publica a lista |
| `lobby` | `/list` | passa a receber `{ type: 'online', list }` na hora e a cada mudança |
| `watcher` | `/video`, com `id` | se a live existe, pede ao transmissor `{ type: 'watcher', id }` |
| `offer` | broadcaster, com `id` do watcher e `sdp` | encaminha ao watcher, com `id` do broadcaster |
| `answer` | watcher, com `id` do broadcaster e `sdp` | só se `id` for a live que ele escolheu |
| `candidate` | os dois, com `id` do outro lado | mesmo filtro de papel e de id |

Servidor → cliente, além do encaminhamento: `online` (`{ id, name }[]`), `need-name`, `name-taken`, `gone` (watcher pediu uma live que não existe), `stop` (a live acabou), `watcher-gone` (o espectador caiu; o transmissor fecha só aquele `RTCPeerConnection`).

Ao cair a conexão: broadcaster encerra a live; lobby sai do conjunto; watcher é removido e o transmissor recebe `watcher-gone`.

`list` de `online` é `{ id, name }`. Na prática os dois são o nome. A lista ainda filtra ids com `/^[a-z0-9]+$/`.

## WebRTC

`common.js` define `window.iceServers`: cinco STUN do Google e um da Cloudflare. Não há TURN. Quem estiver atrás de NAT simétrico pode não conectar.

Fluxo de uma live:

1. `/stream` captura a mídia, mostra a prévia muda e envia `broadcaster`.
2. `/list` já está como `lobby` e redesenha quando chega `online`.
3. `/video?id=` envia `watcher`. O servidor manda `watcher` ao transmissor com um id numérico.
4. O transmissor cria um `RTCPeerConnection` só para esse id, adiciona a faixa de vídeo e, se houver, a de áudio, gera a offer e manda `offer`.
5. O espectador responde com `answer`. Candidatos ICE que chegaram cedo ficam numa fila até existir `remoteDescription`.
6. `ontrack` no espectador joga o `MediaStream` no `<video>`. O vídeo começa mudo para o autoplay passar. A barra de volume (0–100%) escreve direto em `video.volume`. O botão de sair, os tipos `gone` / `stop`, o fim da faixa de vídeo e a queda da conexão voltam para `/list`. O `<video>` é esvaziado antes da troca, para o último quadro não ficar por cima da lista. `gone` e `stop` são tratados na hora, fora da fila.

No transmissor, as mensagens WebSocket são aplicadas em série (`chain`). No espectador também, menos `gone` e `stop`.

Qualidade (selects em `/stream`, padrão 720p, 60 fps, 4 Mb):

- `readQuality` lê resolução, fps e bitrate.
- `applyConstraints` pede isso à faixa de vídeo.
- `setParameters` em cada sender de vídeo fixa `minBitrate` e `maxBitrate` no valor escolhido (2, 4, 8 ou 16 Mb), `maxFramerate` e `scaleResolutionDownBy` se a captura vier maior que o pedido.
- Mudanças entram numa fila (`qualityChain`) para não se atropelarem. O mesmo botão começa e para. Parar manda `stop` antes de fechar os peer connections. O reload da página espera esse envio sair; no mesmo instante o socket fecha e quem assiste não recebe o `stop`. Parar o compartilhamento no navegador também chama `stop`.

## Captura no Electron

A janela é 400×700, sem menu, sem redimensionar, fundo preto, oculta até `ready-to-show`. `backgroundThrottling: false` para o stream não pausar sem foco. `contextIsolation` e `sandbox` ligados, sem Node na página. A página só vê `window.vdz`, exposto por `preload.js`. O ícone é `public/android-chrome-512x512.png`.

Em `/stream`, `desktop()` trata `window.vdz` como API nativa só se existirem `choose` e `windows`. No navegador, `<img id="vdz">` ocupa `window.vdz`; nesse caso a captura é `getDisplayMedia({ audio: true, video })`, com o seletor do próprio browser.

No app:

1. `windows` lista janelas via `desktopCapturer` (sem miniatura). O id tem a forma `window:<hwnd>:<outro>`. `win-audio.exe --pid <hwnd...>` devolve `hwnd pid` e a janela do próprio processo é omitida. Janela de `ApplicationFrameHost` (apps da Microsoft Store) usa o PID do filho.
2. `choose(id)` guarda a fonte em `pendingVideo` e `activeSource`. O próximo `getDisplayMedia` não abre o seletor do sistema: `setDisplayMediaRequestHandler` devolve `pendingVideo` e zera essa variável. Sem vídeo pedido ou sem fonte, o pedido é recusado.
3. O vídeo da janela vem desse `getDisplayMedia({ audio: false, video: true })`. O áudio não vem do Chromium.
4. `start-audio` mata qualquer captura anterior e sobe `win-audio.exe <hwnd>`. Os primeiros 8 bytes do stdout são o cabeçalho little-endian: `sampleRate` u32, `channels` u16, `bitsPerSample` u16. O resto é PCM contínuo. Se o cabeçalho não chegar em 2,5 s, a promise resolve `null` e a página mostra "Sem áudio da janela".
5. O processo principal converte o PCM para `Float32Array` em [-1, 1] (Float32 copiado, Int16 dividido por 32768) e envia `{ channels, samples }` no canal `audio-chunk`. `generation` sobe a cada `stopAudio`; pedaços do processo antigo são descartados.
6. A página enfileira as amostras (no máximo cerca de 1 s, senão descarta o mais antigo), toca com `ScriptProcessor` (4096, estéreo; mono é duplicado) num `MediaStreamDestination` e mistura essa faixa ao vídeo. O ganho até os alto-falantes locais é 0. `offAudio` só tira o listener; `stopAudio` mata o processo.

`win-audio.exe` ativa `VAD\Process_Loopback` (WASAPI) no PID da janela, modo árvore de processos, formato pedido 48 kHz, estéreo, 16-bit, com `AUDCLNT_STREAMFLAGS_LOOPBACK`, `EVENTCALLBACK` e `AUTOCONVERTPCM`. Flags de silêncio viram zeros. `--self` captura o próprio processo. Erros vão para stderr como `passo 0xHHHHHHHH`. Se o stdout fechar, o processo termina com 0.

`before-quit` mata o capturador. Fechar a única janela encerra o app.

## Convenções ao editar

- CommonJS (`require`). Aspas simples, indentação de 4 espaços, linha até 160. O Biome formata e organiza imports/chaves ao salvar (`.vscode/settings.json`, `biome.json`).
- Comentários em português, no mesmo tom dos arquivos: o que a função faz e a restrição que não é óbvia.
- Não colocar segredo ou TURN. A URL do stream do Electron é `streamUrl` em `electron/main.js` (`https://vdz.onrender.com/stream?version=` mais a versão do `package.json`).
- `server.js` exporta `{ listen, close }`. Rodar o arquivo direto escuta a porta 3000; quem importa chama `listen()`.
- Não editar `public/vdz_*.exe` como código. Instalador e `win-audio.exe` são gerados.
- O protocolo não tem autenticação nem sala além do nome. Dois transmissores não compartilham o mesmo nome. Um nome é público para quem alcança o servidor.
