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

## Hipóteses e próxima comparação

A negociação sem estéreo e o perfil padrão do Opus são os primeiros candidatos para perda de fidelidade de jogos e
música. Misturar canais pode remover detalhes espaciais ou conteúdo em oposição de fase. Isso não comprova a causa
do som descrito como "caixa de som molhada". Perda de pacotes e filtros na origem também podem produzir artefatos.

Para fechar a causa, comparar no dev uma fonte estéreo conhecida em dois perfis: o atual e outro com estéreo explícito,
um teto de bitrate apropriado para música e processamento de voz desligado apenas na captura da tela. Medir o bitrate
efetivo, a separação de canais e os deltas de perda/concealment. O teto configurado não força o bitrate efetivo.
Se o relato ocorrer em celular, testar também o caminho de volume com `playbackRate` fixo em 1. Uma amostra da fonte
e da recepção durante a falha permite distinguir degradação de captura, codificação, rede e reprodução.

`tests/e2e/stream-audio-defaults.mjs` usa uma tela sintética pequena no dev, verifica o comportamento de mudo e registra
o SDP Opus negociado, as configurações efetivas da faixa, o bitrate de envio e os contadores de recepção de áudio.
