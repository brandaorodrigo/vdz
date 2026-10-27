# vdz

Uma pessoa transmite a janela. Quem abre o link assiste direto, sem conta e sem o vídeo passar pelo servidor.

O site público é https://vdz.onrender.com.

## O que dá para fazer

A página inicial tem o botão **Assistir**, que abre um quadro em tela toda, e o botão **Transmitir**, que abre a página de transmissão. No navegador, o aviso de que o áudio não sai de forma adequada fica sempre visível. No aplicativo, essa frase não aparece. Embaixo ficam os ícones de Windows, Linux e GitHub.

Dentro do quadro, a tabela **Ao vivo** lista as transmissões abertas. Cada nome é o link para assistir. A lista se atualiza sozinha. No topo, o menu com menos quadros, mais quadros e tela inteira aparece quando o ponteiro chega na borda de cima. Mais quadros passa para 2, 3 e no máximo 4, sempre reabrindo a lista em cada quadro. `/2` mostra dois quadros lado a lado, `/3` mostra três, e `/4` mostra dois em cima e dois embaixo.

Quem assiste em `/nome` vê a imagem em tela cheia. O volume começa em 50%. Volume, som e o X aparecem num menu no centro da borda de baixo quando o ponteiro chega perto dela, mesmo enquanto a transmissão não começou. O X volta para a lista. Quando ela abre, a página entra sozinha.

Quem transmite abre `/host`. O aplicativo do Windows e o do Linux abrem a página inicial do site. Em `/host`, a primeira tela só escolhe o nome. Depois escolhe 480p, 720p ou 1080p, e 30 ou 60 quadros. A taxa de bits acompanha essa escolha:

| | 30 fps | 60 fps |
|---|---|---|
| 480p | 1 Mbps | 2 Mbps |
| 720p | 3 Mbps | 4 Mbps |
| 1080p | 5 Mbps | 6 Mbps |

O padrão é 1080p a 60 fps. Dá para mudar resolução e quadros com a transmissão já no ar. Também dá para trocar a janela sem derrubar quem assiste, e encerrar.

No navegador, a captura usa o seletor do Chrome, com o áudio que ele oferecer. No aplicativo, a lista é de janelas e o som é o do processo da janela escolhida.

O nome da sala usa só letras, até 10 caracteres. Os nomes `host` e `watch` não podem ser usados.

## Local

Na raiz do repositório:

```
npm install
node server.js
```

Abra http://127.0.0.1:3000.

Para o aplicativo apontar para esse servidor, na pasta `desktop`:

```
npm install
VDZ_URL=http://127.0.0.1:3000 npm start
```

O instalador do Windows é gerado com `npm run build` dentro de `desktop/`. O AppImage do Linux sai de `npm run build:linux` numa máquina Linux. Os arquivos publicados no site são `public/vdz_1.2.0.exe` e `public/vdz_1.2.0.AppImage`.

## Render

- Serviço web
- Ambiente: Node
- Diretório raiz: a raiz do repositório
- Comando de start: `node server.js`
- Health check: `/health`

O WebSocket fica em `wss://` no mesmo endereço, no caminho `/ws`.
