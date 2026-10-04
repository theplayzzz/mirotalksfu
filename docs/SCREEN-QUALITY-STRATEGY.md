# Estratégia de qualidade de tela: 60 fps para todo mundo

Escrito em 03/10/2026, depois da primeira noite com o replay em produção e de uma rodada de pesquisa (três relatórios) e de
medições neste PC. **Nada daqui está em produção**: o que existe está no dev (`develop`), atrás de chaves.

## 1. O pedido

Qualquer pessoa, com monitor de 1080p, 2K ou 4K, compartilhando a tela do jogo, deve ser vista a **60 fps por todo mundo**.
Quando não der (internet fraca, PC no limite), a gente quer saber **por quê**, com registros que separem internet, nosso
servidor, nosso software e os "motores" (versão do Chrome, codificador). E o pedido incluía olhar se o VP8 serve e como
outros sistemas parecidos resolvem.

## 2. O que a primeira noite mostrou

Uma imagem de tela passa por quatro elos, e cada um tem o seu limite:

```
tela do jogo -> CAPTURA -> CODIFICAÇÃO -> internet/servidor -> DECODIFICAÇÃO -> tela de quem assiste
                (Chrome)   (VP8 no CPU)    (uplink, SFU)       (VP8 no CPU)
```

Quem vê pouco fps vê o que o **remetente** mandou. O servidor não cria nem perde quadros por conta própria (ele só repassa), e
os espectadores só pioram a imagem quando pedem camada menor ou quando o PC deles não aguenta.

Dados de produção (03/10, 21:15 a 23:30 UTC, build antigo, sem número de captura). `ms/quadro da captura` é 500 dividido pelos
fps: é o que a regra do Chrome (abaixo) diz que a captura gasta por quadro.

| Quem | fps enviados | Codificador ocupado | Perda/RTT | Leitura |
|---|---|---|---|---|
| lirou (tela 1366) | 58,4 | 0,3 a 0,4 | 0 / 190 ms | sem problema |
| theplayzzz (2K) | 32 e depois 15,8 | 0,3 a 0,5 | 0 / 200 ms | **captura** (≈15 e ≈31 ms por quadro) |
| CoreanoRJ | 36 e depois 18 | 0,1 a 0,3 | 0 / 190 ms | **captura** (ou conteúdo parado) |
| sem nome (1080p) | 32 a 52 | 0,2 a 0,8 | 0 / 170 a 230 ms | captura a 32 fps em 1080p; 52 fps quando a imagem encolhe para 720p |
| Gustta | 42 a 46 | 0,25 | **12 a 20% / 1 s** | **internet de saída** (7 Mbps numa linha que carrega ~5) |

Nenhum caso de "o VP8 não dá conta". Os fps de quem tem problema de captura caem em degraus (32, 16...), e isso tem explicação.

### A regra do Chrome que explica os degraus

O Chrome limita a captura de tela a **no máximo metade do tempo** (`kDefaultMaximumCpuConsumptionPercentage = 50` em
`desktop_capture_device.cc`): o próximo quadro só é pedido depois de o dobro do tempo que o último levou. Então
`fps = 500 / T`, com T em milissegundos por quadro capturado: T = 15,6 ms dá 32 fps; T = 31,6 ms dá 15,8 fps; para 60 fps o
quadro precisa levar menos de 8,3 ms. A captura converte o quadro (BGRA para I420) **no tamanho original da tela** e depois
reduz, tudo no processador e em uma thread; num monitor 2K isso é ~3,7 milhões de pontos por quadro, e se o jogo está
usando a placa de vídeo a leitura do quadro ainda espera atrás do trabalho do jogo. No Windows 10 a captura de tela usa DXGI
(WGC para tela só no Windows 11 24H2 ou mais novo).

Isso é **previsão da pesquisa que bate com os números**; a prova é medir a captura sozinha no PC de quem tem o problema
(`/capture-test`, abaixo).

### O que o VP8 faz e não faz

- Num PC folgado o VP8 em 1080p60 gasta ~7 ms por quadro. Não é ele o limite de quem anda em 32 ou 16 fps.
- Por baixo, o libvpx do Chrome usa **3 threads** em 1080p quando o PC tem 8 ou menos processadores lógicos (8 threads só com
  mais de 8). Com a competição de um jogo, o tempo por quadro sobe (28 a 32 ms medidos antes).
- Se o Chrome tratar a tela como "captura de tela" (sem `contentHint: motion`), ele **mantém a resolução e derruba fps** quando
  falta processador (60, 40, 26, 17). Com `motion` ele reduz a imagem e mantém os fps. A sala usa `motion`; o guarda do
  remetente (abaixo) garante isso mesmo se alguém tiver `detail` salvo nas configurações.

## 3. O que medimos neste PC (AMD RX 9060 XT, 12 processadores lógicos, Chrome 154, Windows 10)

**O H.264 por hardware existe.** O teste de 03/10 de manhã só olhou o perfil *Constrained Baseline* (42e0xx), que o Chrome no
Windows codifica **por software** (OpenH264); e concluiu errado que "não há hardware". Os perfis Baseline (42001f), Main
(4d001f e 4d0028) e High (64001f, 640028, 64002a) usam o codificador da placa (AMF), até 2160p60. VP8, VP9 e AV1 são software
(decodificar: VP9, H.264 e AV1 por hardware; VP8 por software).

Codificar 1080p60 (animação com muito movimento, o navegador manda para si mesmo; `renderer` é o processo que roda os
codificadores de software):

| Codec | Parado: fps / ms por quadro / renderer | Com 8 processos disputando o CPU |
|---|---|---|
| VP8 (software) | 60 / 6,6 / 0,95 núcleo | 57,5 fps / 12,4 ms / 1,39 núcleo |
| H.264 Constrained Baseline (software) | 59,9 / 6,1 / 0,60 | 53,4 fps / 17,9 ms / 1,02 |
| **H.264 Main (placa de vídeo)** | 60,1 / 7,8 / **0,22** | **59,6 fps** / 9,4 ms / **0,25** |
| VP9 (software) | 59,4 / 10,1 (2K: 12,7) | não medido |
| AV1 (software) | 59,6 / 13,5 | não medido (usa ~4,7 núcleos) |

Decodificar 1080p60 (quem assiste, arquivo de 8 Mbps tocado no Chrome):

| Codec | CPU por tela |
|---|---|
| VP8 | **0,27 a 0,29 núcleo por tela** (3 telas: 0,82) |
| VP9, H.264, AV1 | ≈ 0 (placa de vídeo) |

Num notebook fraco, 0,27 núcleo vira 0,6 a 0,8; com três telas ele satura. Aqui o H.264 também ajuda quem assiste.

## 4. Pesquisa: como outros resolvem (resumo)

- **LiveKit e Jitsi** são afinados para slides: 5 a 15 fps (LiveKit padrão 1080p15; nenhum preset passa de 30 fps; Jitsi
  padrão 5 fps com `contentHint: detail`). Quando se pede mais fps, os dois trocam para `motion` e `maintain-framerate`. Ninguém
  escolhe camada temporal pelo tamanho do tile: o espectador diz o que *consegue usar* (tamanho, escondido) e o servidor escolhe
  abaixo disso pela banda. O Jitsi só considera camadas de 30 fps ou mais quando a tela está em destaque.
- **Discord** (o único parecido com a gente, navegador à parte): codificador por hardware, VP8/H.264, um único formato para
  todos, e ainda assim 18% das sessões de 60 fps ficam abaixo de 50 fps. A meta realista é "quase sempre perto de 60", não
  "sempre 60".
- **Moonlight/Sunshine**: 1080p60 a 20 Mbps, bitrate fixo, FEC; Sunshine mantém no mínimo metade do fps alvo repetindo
  quadro. **OBS**: adapta bitrate pela fila de envio (cai para o que foi medido e sobe 10% a cada 4 s).
- **Preferência humana** (pesquisa): em jogo, 60 fps em resolução menor é preferido a 30 em maior; o pior 5% dos fps pesa mais
  que a média.
- **Chrome**: o estimador de banda reage devagar com RTT alto (um corte por RTT + 300 ms), a velocidade enviada passa da
  estimada (a retransmissão não é descontada), e perdas viram mais retransmissões (o Gustta mandava 7 Mbps contra uma
  linha de ~5, com 12 a 20% de perda e quase 1 s de RTT).
- **mediasoup 3.26**: a camada temporal preferida é um teto (não existe "mínimo"); VP8 L1T3 só tira quadros (T0 = 25% dos
  quadros e ~40% dos bits: pouca economia para muita perda de fluidez); H.264 não tem camadas.
- **Diagnóstico**: as ferramentas parecidas (ObserveRTC, LiveKit, Teams) separam causa assim: filtro (esperar, aba escondida) ->
  remetente (captura, codificador, internet) -> espectador (rede, decodificador, tela) -> servidor (vários ao mesmo tempo +
  CPU do worker). É o que o `health-diagnose.py` faz.

## 5. A estratégia

1. **Medir antes de mexer.** Cada elo tem número próprio nos registros e cada queda recebe uma causa.
2. **60 fps primeiro, tamanho depois** (jogo é movimento): `contentHint: motion` + `maintain-framerate`, e uma escada de
   tamanhos que desce quando falta CPU, internet ou captura.
3. **Cada elo com a sua alavanca:**
   - captura -> pedir captura menor (e, para quem tem monitor grande, dicas do que fazer na máquina);
   - codificação -> escada de tamanho; **H.264 por hardware** onde a placa tiver (não gasta o CPU do jogo);
   - internet de saída -> escada que **vai direto** ao tamanho que a linha comporta;
   - espectador -> sem camada por tamanho do tile: recebe tudo, e só desce quando **ele** sofre (e sobe com calma).
4. **Cada peça com chave** (`SCREEN_CODEC`, `SEND_GUARD`, `SELECTIVE_MODE`...) e testada no dev antes; a produção só com pedido.
5. **Meta honesta**: janelas de 10 s a 54 fps ou mais, por remetente, e o pior 5% de fps; não "sempre 60".

## 6. O que está pronto no dev

| Peça | Onde | Chave | Estado |
|---|---|---|---|
| Espectador: recebe tudo, desce só quando sofre, piso de fps | `public/js/ScreenQuality.js` | `SELECTIVE_MODE=adaptive` | testado (unitário e e2e) |
| Guarda do remetente: `motion` + `maintain-framerate`, escada 1080p -> 360p com bitrate coerente | `public/js/SendGuard.js` | `SEND_GUARD=apply` | testado; sob carga no e2e |
| Guarda: encolhe **de uma vez** para o tamanho que a linha comporta (80% do medido) | idem | idem | unitário |
| Guarda: não confunde o "tempo por quadro" do codificador por hardware com carga | idem | idem | unitário |
| Guarda: lembra o que a linha de cada um aguentou e não sobe para um tamanho que ela não carrega (30 min) | idem | idem | unitário |
| Guarda: avisa o remetente, uma vez, quando a captura continua lenta e não resta o que tentar (com dicas e o link do teste); não avisa para 24/25/30 fps (filme) nem tela parada | idem | idem | unitário + e2e |
| Guarda: **tenta captura menor** quando a captura é lenta e a imagem se mexe; volta se não ganhar 20% | idem | `apply` | unitário + e2e (`capture-trial.mjs`) |
| H.264 Main/High para quem tem codificador por hardware | `ScreenQuality.pickScreenCodec` | `SCREEN_CODEC=auto` | unitário + e2e na sala real com o gravador (encoder da placa AMD, clipe MP4 correto, áudio sincronizado) |
| Diagnóstico: build, chaves, captura x codificador x internet, pressão do processador, perfil H.264 | `HealthMeter`, `StreamMeter`, `StreamStats` | `HEALTH_METER_ENABLED` | em uso no dev |
| `health-diagnose.py`: causa por remetente/espectador (captura, tela parada, codificador por hardware, internet) | `ops/tools/` | - | rodado nos dados de produção |
| **Teste de captura** na máquina de quem compartilha | `/capture-test` | - | e2e com tela de mentira |

## 7. Como saber se funcionou

- Por remetente, janelas de 10 s: `% das janelas com >= 54 fps`, fps do pior 5%, e a causa dominante nas que ficaram abaixo.
- Por espectador: congelamentos e fps recebidos / fps enviados (se for 1, o problema não é dele).
- Servidor: CPU do worker (hoje 1 núcleo a 70% no pico), perda no UDP, pontuação dos produtores.
- Registro de cada mudança: `gWhy` (por que o guarda mexeu), `gRung` (degrau do codificador), `gCap` (degrau da captura), `bld` e `cb`
  (versões do servidor e da página), `enc`/`hw` (codificador) e `press` (pressão do processador do PC).

## 8. Plano

1. **Dev, sozinho:** testes e2e (feitos: unitários, página de teste, tentativas de captura); e2e do guarda e do H.264 por hardware
   com o gravador de replay.
2. **Teste de captura no PC de quem tem 2K (precisa de OK):** 3 minutos em `/capture-test`, parado e com o jogo. Mostra fps de captura por
   tamanho, se pedir captura menor resolve, e se o H.264 da placa segura 60 fps. Decide a regra de captura.
3. **Sessão com a galera no dev** (`SCREEN_CODEC=auto`, `SEND_GUARD=apply`, medidor ligado): cada um compartilha o jogo;
   `health-diagnose.py` diz a causa de cada queda.
4. **Produção, com pedido explícito:** `ops/deploy.sh prod` com as chaves que a sessão aprovou, uma por vez
   (`SELECTIVE_MODE=adaptive`, `SEND_GUARD=apply`, `SCREEN_CODEC=auto`). Reversão: `ops/rollback.sh prod` e as chaves em `off`.

### Roteiro da sessão de teste com a galera (dev)

1. Combinar um horário; ninguém mexe no dev nessa hora. Dev: `https://mirotalk-dev.40-160-143-32.sslip.io` (sala `link`, mesma senha).
2. Cada um abre a sala, **compartilha o jogo** (tela inteira) por uns 15 minutos. Quem tem monitor 2K/4K, ou internet fraca, é o
   caso mais útil.
3. Depois, `ssh ovh-mirotalk 'python3 - /home/debian/mirotalk-dev/data/health --from HH:MM --to HH:MM --window 5 --names' < ops/tools/health-diagnose.py`
   (horário UTC). A linha `SEND` de cada um diz a causa (`capture`, `still`, `encoder`, `uplink`, `ok`), o que o guarda fez
   (`guard rung`, `capture rung`, `gWhy`) e a pressão do processador; as linhas `VIEW` dizem o que cada um viu.
4. Quem ficou em `capture`: rodar `/capture-test` no PC dele (parado e com o jogo) e comparar.

## 9. Riscos e o que falta saber

- **Codificador por hardware**: pode falhar em alguns drivers (cores estranhas, limite de banda em placas Intel/AMD antigas, queda
  de quadros com a fila cheia); por isso é `auto` (só onde a placa diz que tem) e cada remetente reporta `enc`/`hw`.
- **Gravador (replay) com H.264 de hardware**: testado no dev com um Chrome de verdade (encoder `MediaFoundationVideoEncodeAccelerator`
  da placa AMD): clipe de 30 s pronto em 4,4 s, 34,5 s de arquivo (entrada de só 4,4 s: o encoder da placa emite quadros completos a
  cada poucos segundos), MP4 sem erro, áudio e imagem a 15 ms. Com a animação de teste (pesada: precisa de mais de 12 Mbps em 1080p)
  o encoder da placa entregou 46 a 52 fps em 720p, **abaixo do que o VP8 entrega com o mesmo conteúdo**: encoder de hardware
  derruba quadros quando falta bitrate em vez de piorar a qualidade. Com conteúdo de jogo de verdade pode ser diferente; é a
  principal coisa a olhar na sessão com a galera (`hw`, `fps`, `lim`).
- **Captura menor**: `applyConstraints` em tela funciona (dev, Chrome 154: aceitou 1920 -> 1280 -> 960 e refletiu no `getSettings`),
  mas não se sabe o ganho de fps por PC: por isso a **tentativa** com volta automática.
- **Flags do Chrome** (`WebRtcAllowWgcUsingTexture`, `ZeroCopyDesktopCapture`) relatadas por outro projeto como capazes de passar
  a captura de 28-33 para 53-58 fps; só dá para ligar na máquina de cada um (atalho do Chrome), e quebram em PC com duas
  placas de vídeo. Teste opcional se a captura continuar sendo o limite.
- **Windows 10**: captura de tela por DXGI (com a regra de metade do tempo). No Windows 11 24H2+ é WGC, que pode se comportar
  diferente.
- Se nada disso bastar para 2K/4K: **captura nativa** (OBS -> servidor) para quem precisa. Fora do escopo agora.

## 10. Dicas para quem compartilha (para colocar na galera)

- Limite os fps do jogo (60 a 90 em vez de ilimitado/180: a captura espera a placa de vídeo; no AMD, o *Frame Rate Target Control*).
- Jogar e compartilhar em **1920x1080** (ou janela 1080p) captura bem mais rápido do que em 2560x1440 ou 4K.
- PC de mesa na tomada, notebook na tomada e em modo de desempenho; aceleração por hardware ligada no navegador; no Opera GX,
  limitador de CPU desligado.
- Uma única placa de vídeo para jogo e navegador (nada de iGPU + placa dedicada trocando).
