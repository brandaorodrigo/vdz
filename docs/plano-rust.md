# Plano: vdz em Rust

O vdz de hoje cabe em Rust. O site de quem assiste continua. O processo público de sinalização continua, escrito em Rust. O `.exe` passa a ser o transmissor, também em Rust.

Um aplicativo que só existe dentro do `.exe`, sem página nenhuma, muda o produto: quem assiste deixa de abrir um link. Esse caminho está no final, como alternativa, e não é o plano.

## O que o vdz faz

Uma pessoa transmite uma janela. Quem abre `/nome` assiste direto. O vídeo e o áudio vão de quem transmite para quem assiste, por WebRTC. O servidor só apresenta as pessoas: sala na memória, oferta, resposta e ICE. Nada é gravado. Não há conta, chat, senha nem TURN.

Hoje isso está em quatro peças:

| Peça | Onde | Tamanho aproximado | Papel |
|---|---|---|---|
| Sinalização e páginas | `server.js` | 400 linhas | Salas, WebSocket `/ws`, arquivos de `public/` |
| Quem assiste e quem transmite no navegador | `public/*.html`, `public/*.js`, `public/style.css` | ~2 500 linhas | Interface e `RTCPeerConnection` |
| Janela do aplicativo | `desktop/main.js`, `desktop/preload.js` | 330 linhas | Electron abre o site. Escolhe a janela e entrega o PCM ao AudioWorklet |
| Som da janela | `desktop/loopback/Program.cs`, `desktop/linux-audio.js` | ~900 linhas | Windows: WASAPI do processo. Linux: PipeWire |

O aplicativo abre `https://vdz.onrender.com`. Mudança só em `public/` não pede recompilar o Electron. O instalador publicado é `public/vdz_1.12.exe` e `public/vdz_1.12.AppImage`.

STUN: `stun:stun.l.google.com:19302`. Taxa por assistindo, sem seletor próprio:

| | 30 fps | 60 fps |
|---|---|---|
| 480p | 1 Mbps | 2 Mbps |
| 720p | 3 Mbps | 4 Mbps |
| 1080p | 5 Mbps | 6 Mbps |

O padrão é 1080p a 60 fps. Trocar de janela substitui os trilhos e a sala continua. Sem o som do processo, a imagem segue e a faixa diz "transmissão sem som".

## O que muda de linguagem, e o que fica

Três fatos definem a ordem.

O navegador de quem assiste já é o runtime certo. A página usa `RTCPeerConnection`. Rust no `.exe` não executa dentro do Chrome de outra pessoa. Enquanto o produto for "abre o link", `/`, `/watch`, `/nome` e `/1`–`/4` continuam páginas.

O Electron não é um detalhe da janela. `setDisplayMediaRequestHandler` entrega a janela já escolhida ao `getDisplayMedia`, sem o seletor do Chrome. WebView2 e Tauri não têm esse gancho. Trocar o Electron por uma casca que ainda carrega `host.js` perde o seletor próprio, ou reimplementa a captura fora do navegador. Por isso o transmissor novo fala WebRTC em Rust, e a página `/host` do navegador pode continuar como está, com o áudio que o Chrome oferecer.

Duas máquinas em redes diferentes ainda precisam de um processo público para trocar oferta, resposta e ICE. Esse processo não carrega vídeo. Colocar o vdz inteiro dentro do `.exe` não elimina esse encontro. Sem ele, o par só se acha na mesma rede, ou com porta aberta na máquina de quem transmite.

O contrato que não muda durante a migração:

- JSON texto, no máximo 64 KB. Tipo desconhecido é ignorado.
- Cliente para servidor: `create`, `join`, `signal`, `ping`, `leave`.
- Servidor para cliente: `created`, `joined`, `waiting`, `viewer-joined`, `viewer-left`, `viewers`, `signal`, `error`, `pong`.
- `signal.data` é oferta, resposta ou ICE. Oferta só sai de quem transmite. Resposta só sai de quem assiste e só para quem transmite.
- Sala: letras minúsculas, 1 a 32 no servidor, 10 no campo. `host`, `watch` e `webcam` recusados.
- `GET /api/rooms` devolve `{ "rooms": ["nome"] }` sem cache. `GET /health` devolve `ok`.
- Estado só na memória. Reiniciar apaga as salas.
- Sem TURN. Cada assistindo tem a própria conexão com quem transmite.

## Caminho

Quatro fases. Cada uma sobe sozinha. A anterior continua no ar até a nova passar no critério de pronto.

### Fase 1. Servidor em Rust

Substituir `server.js` por um binário Rust. As páginas em `public/` saem do mesmo processo, com a mesma lista branca.

Caixas: `tokio`, HTTP com `axum`, WebSocket no mesmo listener em `/ws`. Uma struct de sala no lugar do `Map` do Node. A lógica de `create`, `join`, espera, admissão, `leave` e fechamento do socket é a de `server.js`, na mesma ordem.

Porto: `PORT` ou 3000, escuta em `0.0.0.0`. No Render o serviço deixa de ser Node e passa a ser imagem Docker com o binário. Health check continua `/health`. O site público continua `https://vdz.onrender.com`, WebSocket `wss://` no mesmo host, caminho `/ws`.

Pronto quando: criar, entrar, esperar uma sala que ainda não existe, entrar sozinho quando ela for criada, sinalizar, sair, ver a contagem, listar `/api/rooms` e responder `/health` com o mesmo JSON de hoje. Quem assiste no navegador e quem transmite no Electron atual falam com esse processo sem mudança em `public/` nem em `desktop/`.

### Fase 2. Som do processo no Windows, em Rust

Reescrever `desktop/loopback/Program.cs` como `vdz-loopback.exe` em Rust. O Electron desta fase não muda.

O contrato do executável fica:

- `lookup` lê HWND em decimal, um por linha na entrada padrão, e escreve o PID, um por linha.
- `capture <pid>` escreve `ready` na saída de erro e, na saída padrão, PCM 48 kHz, estéreo, float 32, em blocos de 960 quadros (15360 bytes).
- A captura é a do processo (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, dispositivo `VAD\Process_Loopback`), com a árvore de processos, como o C# faz hoje. Um loopback da mixagem inteira captura o som do sistema e quebra o produto.

A API é Win32. O crate `windows` expõe `ActivateAudioInterfaceAsync`. Um crate genérico de áudio, que só abre o dispositivo padrão, não serve.

O `npm run build` em `desktop/` deixa de chamar `dotnet publish`. O instalador copia o `vdz-loopback.exe` produzido por `cargo build --release`.

Pronto quando: o Electron atual lista janelas, transmite o som da janela escolhida, a faixa cai para "transmissão sem som" se a captura falhar, e trocar de janela troca o processo sem derrubar a sala.

### Fase 3. Transmissor em Rust

Novo aplicativo Windows x64, produto `vdz`, id `app.vdz.desktop`. Ele deixa de ser Electron. Quem assiste continua no site.

O processo Rust:

1. Abre a interface de transmitir: nome, criar, resolução, quadros, lista de janelas, encerrar, voltar. Pode ser uma janela nativa (`egui` ou `iced`) ou uma página local mínima. Não carrega `/host` remoto e não depende de `getDisplayMedia`.
2. Cria a sala no WebSocket já existente.
3. Captura a janela com Windows Graphics Capture, cursor sempre visível, nos tamanhos 854×480, 1280×720 e 1920×1080, a 30 ou 60 quadros.
4. Codifica e envia com `webrtc-rs`, um `RTCPeerConnection` por assistindo. STUN igual. Teto de taxa da tabela acima, reaplicado quando resolução ou quadros mudam no ar.
5. O áudio da fase 2 entra no mesmo processo, no trilho de áudio. Sem som, o vídeo segue.
6. Trocar de janela substitui os trilhos. `leave` sai ao encerrar e ao fechar, com o socket ainda aberto, para o nome ficar livre na hora.

A página `/host` do navegador permanece para quem não instalou o aplicativo, com o aviso de áudio que já existe.

Linux nesta fase continua no Electron e no PipeWire atuais. O AppImage novo espera a fase 4.

Empacotar com `cargo-packager` ou NSIS chamado pelo CI, ícone `public/android-chrome-512x512.png`, artefato `vdz_<versão>.exe`. O arquivo publicado no site continua `public/vdz_1.12.exe` até a versão subir.

Pronto quando, contra o servidor da fase 1: o `.exe` cria a sala, o Chrome em `/nome` assiste imagem e som, três assistindo são três conexões saindo de quem transmite, mudar 480p/720p/1080p e 30/60 no ar reaplica o teto, trocar a janela não derruba a sala, encerrar libera o nome na hora, e a sala some se o processo morrer sem `leave`.

### Fase 4. Linux

Mesma interface e o mesmo WebRTC da fase 3.

Vídeo: captura da janela em X11. O aplicativo abre em X11, no Wayland via XWayland, como hoje. O PID continua vindo de `_NET_WM_PID`.

Áudio: primeiro o mesmo desenho de `linux-audio.js` (`pw-dump`, `pw-record`, `pw-link`, `xprop`), chamado pelo binário Rust. Sem esses programas, a imagem segue e a faixa diz "transmissão sem som". Ligar direto na biblioteca do PipeWire só depois desse caminho estar no ar.

Empacote AppImage x64, `vdz_<versão>.AppImage`. Idiomas da interface: português. Não há Chromium para cortar.

Pronto quando o mesmo roteiro da fase 3 passa no Linux, inclusive troca de janela e ausência do PipeWire.

## O que não entra nessas fases

- TURN, gravação, conta, banco, chat, senha.
- Vídeo passando pelo servidor.
- Reenviar de um assistindo para outro.
- Rota com nome `host`, `watch` ou `webcam`. Tratar `/1`–`/4` como sala.
- Mudar o JSON no meio da migração. Primeiro os dois servidores falam o protocolo atual. Um campo novo só depois dos clientes novos e velhos conviverem.
- Reescrever `watch.js`, o mosaico e o CSS em Rust ou WASM. Isso não tira o JavaScript do navegador de quem assiste e aumenta o que pode quebrar.
- Tauri no lugar do Electron mantendo `host.js`. Sem o gancho do `getDisplayMedia`, o seletor próprio de janelas se perde.

## Aplicativo sem site

Este caminho só vale se a decisão for que ninguém mais assiste no navegador.

Os dois lados instalam o `.exe`. A captura, o `webrtc-rs` e a interface nativa são as da fase 3, com uma janela a mais para assistir. O mosaico de um a quatro quadros vira layout nativo.

O encontro continua em aberto, e as três opções são piores do que o site:

| Encontro | O que a pessoa faz | Limite |
|---|---|---|
| Processo público Rust, o da fase 1, sem servir HTML | Abre o aplicativo e digita o nome da sala | Continua existindo um serviço na internet. Some só a página |
| Quem transmite escuta uma porta e quem assiste digita o endereço | Sem servidor | NAT de casa impede a conexão. Peça para abrir porta |
| Descoberta na rede local | Sem servidor e sem endereço | Só funciona na mesma rede |

A página some. O serviço público, se a sala ainda for um nome curto compartilhado entre duas casas, permanece.

## Ordem de trabalho

1. Fase 1 no ar, Electron e páginas atuais apontando para ela.
2. Fase 2 no instalador Electron, ainda útil enquanto a fase 3 não fecha.
3. Fase 3 substitui o `vdz.exe` publicado. O Electron Windows sai do build quando o critério de pronto passar.
4. Fase 4 substitui o AppImage. Aí `desktop/` em JavaScript pode sair do repositório.

Enquanto as duas gerações coexistirem, o protocolo deste documento é a fronteira. `public/` segue a lista branca do servidor que estiver no ar.
