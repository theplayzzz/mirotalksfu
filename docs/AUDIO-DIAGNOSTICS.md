# Áudio das transmissões — análise de 30/10/2026

Escopo: início silencioso e retenção dos clipes implementados em `develop`. A qualidade do áudio foi investigada;
nenhuma configuração de captura, codec ou velocidade de reprodução foi alterada por essa investigação.

## Início silencioso

Cada espectador começa com o áudio remoto silenciado antes de anexar a faixa ao elemento com autoplay. Quem entra
depois também começa no mudo. O botão existente, "Voltar a ouvir somente para mim", libera o som apenas para quem
clicou. Uma nova transmissão do mesmo participante volta ao mudo, inclusive quando não há faixa de áudio. Reconciliar
ou recriar o consumidor da mesma transmissão preserva a escolha do espectador. O áudio continua sendo transmitido e
permanece disponível ao gravador de replay.

O controle existente é por participante: se uma pessoa transmitir microfone e tela ao mesmo tempo, o botão controla
os dois. Essa característica foi preservada.

## O que foi confirmado

- A produção consultada usa o commit `3e98bac9`; o desenvolvimento, antes desta mudança, usava `0ab52ae4`.
- `produceScreenAudio()` envia a faixa capturada diretamente. O processamento RNNoise de microfone não passa por
  esse caminho. O SFU encaminha Opus; não há FFmpeg ou outra recodificação no caminho da transmissão ao vivo.
- O microfone configura `opusStereo`, FEC, DTX e NACK explicitamente; o áudio da tela não configura `codecOptions`.
  O router anunciar `audio/opus` com dois canais não garante áudio estéreo: a negociação de estéreo é separada.
  A [RFC 7587, seção 7](https://www.rfc-editor.org/rfc/rfc7587#section-7) define a preferência mono quando `stereo`
  está ausente. A API do [mediasoup-client](https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions)
  fornece `opusStereo` e `opusMaxAverageBitrate` para essa configuração.
- Existe um caminho em `applyOutputVolume()` que, em dispositivo móvel sem ganho Web Audio disponível, usa
  `playbackRate` como volume. Isso muda a velocidade e pode causar lentidão, perda de sincronismo e alteração de
  timbre. Só explica problemas em aparelhos que realmente entram nesse caminho; não explica automaticamente uma
  queixa em Chrome de desktop.
- A captura usa `audio: true`, sem pedir explicitamente `echoCancellation: false`, `noiseSuppression: false` e
  `autoGainControl: false` para o áudio da tela. Isso deixa a política ao navegador. É uma hipótese a verificar
  pelos valores efetivos de `track.getSettings()`, não prova de que algum filtro esteja ativo.
- O medidor de saúde persistido lê apenas estatísticas de vídeo. Não existem nele os contadores de áudio necessários
  para atribuir a queixa a jitter, perda ou reconstrução de amostras. A [especificação WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)
  define `concealedSamples`, `concealmentEvents`, `packetsLost` e os contadores do jitter buffer para essa investigação.
- Na consulta de produção, as quatro telas ativas estavam sem áudio capturado (`hasAudio: false`). Não havia clipe
  salvo disponível para comparar o som de origem com a recepção. A consulta não interrompeu nenhuma transmissão.

## Reprodução controlada no dev

O teste `tests/e2e/audio-stereo-probe.mjs` gerou uma faixa estéreo com seno de 440 Hz nos dois canais, com fases opostas
(L = sinal, R = -sinal). É um sinal artificial que evidencia o cancelamento ao misturar canais. A tela foi sintética,
640×360 a 10 fps; nenhum microfone, câmera ou tela real foi capturado. Na segunda execução, a única opção de codec
adicionada à chamada `produce()` foi `opusStereo: true`, apenas na memória desse navegador de teste.

| Perfil | Bitrate efetivo | RMS recebido por canal | Pacotes perdidos | Amostras reconstruídas |
|---|---:|---:|---:|---:|
| Atual, sem estéreo explícito | 32.319 bit/s | 0,0000041 | 0 | 0 |
| Com `opusStereo: true` | 64.332 bit/s | 0,107 | 0 | 0 |

O sinal original foi praticamente anulado no perfil atual e preservado com estéreo explícito. O SDP da segunda
execução confirmou `stereo=1`; o perfil atual não tinha esse parâmetro. Isso reproduz uma perda concreta de conteúdo
estéreo sem perda de pacotes ou reconstrução de amostras no teste. O `channels: 2` do codec, presente nos dois casos,
não bastava. O bitrate subiu automaticamente com estéreo, sem configurar teto nesse ensaio.

Um ensaio anterior com estéreo e teto de 128 kbit/s recebeu RMS de 0,1058 e enviou 127.464 bit/s. O ensaio acima,
com apenas a opção de estéreo, separa essa correção do aumento manual de bitrate. Essas medições demonstram o defeito
de mistura; não medem a fidelidade de uma trilha de jogo completa nem comprovam que toda queixa tenha a mesma causa.

## Interpretação e próximo ajuste

A negociação sem estéreo é o primeiro candidato para perda de detalhes espaciais ou conteúdo em oposição de fase em
jogos e música. O cancelamento foi reproduzido; a ligação com o som real descrito como "caixa de som molhada" ainda
precisa de uma amostra durante a falha. Perda de pacotes e filtros na origem também podem produzir artefatos.

O próximo ajuste recomendado é configurar estéreo explicitamente para o áudio da tela e comparar uma gravação real
de jogo antes/depois no dev. Depois, avaliar um teto de bitrate apropriado para música e processamento de voz desligado
apenas na captura da tela, medindo separação de canais e deltas de perda/concealment. O teto não força o bitrate efetivo.
Se o relato ocorrer em celular, testar também o caminho de volume com `playbackRate` fixo em 1. Uma amostra da fonte
e da recepção durante a falha permite distinguir degradação de captura, codificação, rede e reprodução.

`tests/e2e/stream-audio-defaults.mjs` usa uma tela sintética pequena no dev, verifica o comportamento de mudo e registra
o SDP Opus negociado, as configurações efetivas da faixa, o bitrate de envio e os contadores de recepção de áudio.

## Entrega e validação

- Dev atualizado para o commit de aplicação `a334a017`, imagem `sha256:c27980041fd87371374422cfeb586909fa2302dddf1b7ff6d037a7ea8f98b188`.
- Produção mantida em `3e98bac9`, sem reiniciar seus dois contêineres.
- 587 testes passaram localmente (3 testes dependentes do worker nativo ficaram pendentes no Windows); a CI passou.
- 48 testes focados passaram, incluindo reinício com metadado antigo expirado e limpeza em 80% antes de esgotar a cota.
- 182 verificações de galeria passaram no Chrome, em desktop e celular; a apresentação foi conferida por screenshot.
- O teste da sala no dev passou: mudo antes do autoplay, entrada tardia, escolha individual preservada na reconciliação,
  nova transmissão sem áudio voltando ao mudo e API da galeria informando retenção por cota sem expiração por idade.
- Os dois serviços de dev ficaram saudáveis. O rollback anterior foi guardado pelo `ops/deploy.sh`.
