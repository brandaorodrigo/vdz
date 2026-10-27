# vdz

Guia para quem for alterar este repositório. O produto se chama vdz. A pasta do git pode continuar se chamando `kino`.

A interface é em português. O servidor só apresenta as pessoas. O vídeo e o áudio vão direto de quem transmite para quem assiste, por WebRTC. Nada é gravado e nada disso passa pelo Node.

## O que não fazer

- Não colocar o vídeo no servidor, nem banco, conta, chat, senha ou TURN.
- Não criar uma rota com o nome `host` nem `watch`. `host` é a página do transmissor. `watch` é a lista de quem está no ar.
- Não tratar `/1`, `/2`, `/3` e `/4` como sala. São páginas de vários quadros.
- Sala é só letras minúsculas, de 1 a 32. O campo da tela limita a 10.
- Cada assistindo recebe a própria conexão com o transmissor. Não reenviar de um assistindo para outro.
- Mudança só em `public/` não pede recompilar o Electron. O aplicativo abre o site ao vivo. Recompilar quando mudar `desktop/main.js`, `desktop/preload.js` ou o executável do loopback.
- O instalador Windows servido no site é `public/vdz_1.2.0.exe`. O do Linux é `public/vdz_1.2.0.AppImage`. O build novo fica em `desktop/dist/` até alguém copiar para `public/`.

## Pastas

```
server.js                 sinalização e arquivos estáticos
public/                   páginas, CSS e o instalador publicado
desktop/main.js           janela Electron, abre /
desktop/preload.js        window.vdzDesktop
desktop/loopback/         captura de áudio WASAPI em C#
```

Um processo Node. Dependência de produção: `ws`. Porto local `3000`, no Render `process.env.PORT`.

Estado só na memória. Reiniciar o processo apaga as salas.

## Rotas

| Caminho | O que entrega |
|---|---|
| `/` | `index.html`, Assistir, Transmitir, e os ícones Windows, Linux e GitHub |
| `/watch` | `stream.html`, lista ao vivo |
| `/host` | `live.html`, transmissor, no navegador e no Electron |
| `/1` `/2` `/3` `/4` | `mosaic.html`, um a quatro iframes de `/watch` |
| `/nome` | `watch.html`, se o nome for `^[a-z]{1,32}$` e não for `host` nem `watch` |
| `/api/rooms` | JSON `{ "rooms": ["nome"] }`, salas em uso, sem cache |
| `/health` | texto `ok` |
| `/vdz_1.2.0.exe` | o instalador Windows de `public/`, como anexo |
| `/vdz_1.2.0.AppImage` | o instalador Linux de `public/`, como anexo |
| `/ws` | WebSocket |

Arquivos de `public/` saem de uma lista branca em `server.js`. Página nova ou script novo precisa entrar nessa lista. `/host` e `/watch` têm de ser resolvidos antes do padrão da sala.

## Sinalização

JSON texto, no máximo 64 KB. Tipo desconhecido ou JSON inválido é ignorado.

Cliente para servidor: `create`, `join`, `signal`, `ping`, `leave`.

Servidor para cliente: `created`, `joined`, `waiting`, `viewer-joined`, `viewer-left`, `viewers`, `signal`, `error`, `pong`.

`viewers` leva `{ count }` a cada assistindo. A contagem é quem está na sala, inclusive quem recebe. Sai de novo quando alguém entra ou sai. Quem só espera a sala existir fica de fora.

`signal.data` só pode ser oferta, resposta ou ICE. Oferta só sai do transmissor. Resposta só sai de um assistindo e só para o transmissor. O servidor não lê o SDP.

`ping` a cada 4 minutos, resposta `pong`, para o plano grátis do Render não dormir com uma sala aberta.

A sala existe desde o `create`, antes de escolher a janela. Some quando o transmissor manda `leave`, e também quando o socket dele fecha. Quem assistia volta a esperar o mesmo nome. Quem entra num nome que ainda não existe também espera, e entra sozinho quando a sala for criada de novo.

O transmissor manda `leave` ao encerrar e ao sair da página. O nome fica livre nesse instante, com o socket antigo ainda aberto. Sem essa mensagem, o nome só sai quando o servidor vê o socket fechar, e até lá a resposta é "Essa sala já está em uso".

## WebRTC

STUN `stun:stun.l.google.com:19302`. Sem TURN.

O transmissor cria um `RTCPeerConnection` por assistindo. Se a captura ainda não começou, a oferta sai quando a janela for escolhida. Trocar de janela substitui os trilhos sem derrubar a sala.

Captura com `cursor: always` e `contentHint: detail`. Tamanhos: 480p é 854×480, 720p é 1280×720, 1080p é 1920×1080. Quadros: 30 ou 60.

A taxa não tem seletor. Ela segue resolução e quadros:

| | 30 fps | 60 fps |
|---|---|---|
| 480p | 1 Mbps | 2 Mbps |
| 720p | 3 Mbps | 4 Mbps |
| 1080p | 5 Mbps | 6 Mbps |

O padrão da sala é 1080p a 60 fps, portanto 6 Mbps. Mudar resolução ou quadros com a captura no ar reaplica o limite no trilho e o teto em cada conexão. A taxa vale por assistindo: três pessoas são três cópias saindo de quem transmite.

No navegador, `getDisplayMedia` pede vídeo e áudio. Se o áudio falhar, a imagem segue e a faixa diz "transmissão sem som".

No Electron, o vídeo é a janela escolhida no seletor próprio. O áudio é o processo dessa janela, PCM 48 kHz estéreo, injetado num AudioWorklet. No Windows isso sai do `vdz-loopback.exe`. No Linux o aplicativo abre em X11, no Wayland via XWayland, o PID da janela vem do `xprop`, e o som do processo vem do PipeWire (`pw-dump`, `pw-record`, `pw-link`). Sem esses programas, a imagem segue e a faixa diz "transmissão sem som".

## Páginas

Fonte Google Sans e ícones Material Icons, ambos do Google Fonts. Fundo `#1a1917`.

`/` tem o botão Assistir, que abre `/1`, e embaixo o botão Transmitir, que abre `/host`. No navegador, o aviso de que o áudio não sai de forma adequada fica visível o tempo todo, e abaixo ficam os ícones Windows (`/vdz_1.2.0.exe`), Linux (`/vdz_1.2.0.AppImage`) e GitHub (https://github.com/brandaorodrigo/vdz). No Electron, a frase e esses ícones não aparecem.

`/watch` lista os nomes em uso, atualiza a cada 5 segundos, e cada nome aponta para `/nome`.

`/host` começa só com o nome e o botão de criar. Enter cria a sala. Depois aparecem resolução, quadros, escolher janela e encerrar. O Voltar fica na parte de baixo e abre `/`. O nome `watch` também não pode ser usado.

`/nome` é o vídeo em tela cheia da página. Sem imagem, o centro mostra o ícone de espera. Volume, som e o X ficam num menu no centro da borda de baixo e só aparecem com o ponteiro perto dessa borda. O número de quem está assistindo fica numa bolinha antes do volume, nesse menu, e some enquanto a sala não existe. No toque, um toque nessa borda abre e fecha. Volume começa em 50%, desmutado. O X volta para `/watch`.

`/1` é um iframe em tela toda. `/2` são dois iframes lado a lado. `/3` são três lado a lado. `/4` são dois em cima e dois embaixo. Cada iframe abre `/watch`. O menu com menos quadros, mais quadros e a tela inteira fica no centro do topo e só aparece com o ponteiro na borda de cima. No toque, um toque nessa borda abre e fecha. Mais quadros abre o mosaico seguinte, do zero, com `/watch` de novo em cada quadro. Menos quadros volta um. No `/1` o menos fica desligado. No `/4` o mais fica desligado.

## Electron

Windows x64 e Linux x64, Electron 35.7.5, produto `vdz` 1.2.0, id `app.vdz.desktop`. Abre `origem + /`. A origem padrão é `https://vdz.onrender.com`. `--url=` ou `VDZ_URL` trocam isso.

O preload expõe `vdzDesktop.listWindows`, `arm`, `beginAudio`, `stopAudio` e `onPcm`.

Build, dentro de `desktop/`:

```
npm install
npm run build
```

Isso publica o loopback em `desktop/loopback/publish/` e gera o instalador NSIS em `desktop/dist/`. O AppImage sai de `npm run build:linux` numa máquina Linux, em `desktop/dist/vdz_1.2.0.AppImage`, e não usa o loopback. Idiomas do Chromium: `pt-BR` e `en-US`. Compressão máxima. O ícone da janela e do instalador é `public/android-chrome-512x512.png`.

Para testar contra o servidor local: `VDZ_URL=http://127.0.0.1:3000` antes de `npm start` em `desktop/`.

## Render

Serviço web, Node, raiz do repositório, start `node server.js`, health check `/health`. Site público `https://vdz.onrender.com`. WebSocket `wss://` no mesmo host, caminho `/ws`. Não usar `ws://` na internet.
