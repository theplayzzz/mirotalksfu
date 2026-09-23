# MiroTalk Desktop — teste de áudio por aplicação

Esta branch adiciona um cliente Electron para Windows que mantém o transporte
WebRTC do MiroTalk SFU e troca somente a etapa de captura. Ao selecionar uma
janela, o áudio é capturado pelo PID da janela e por seus processos filhos via
WASAPI. A captura de tela inteira usa o áudio completo do sistema.

O comportamento é intencionalmente *fail closed*: uma falha na captura por
processo interrompe o compartilhamento da janela e nunca ativa o loopback do
sistema como alternativa silenciosa.

## Artefato Windows

O workflow `Build Windows desktop test app` gera um ZIP portátil x64 contendo o
executável, o commit e o SHA-256. O Electron já está incluído; não é necessário
instalar Node.js, Electron, OBS ou driver de áudio virtual.

O executável de prova de conceito não possui assinatura comercial e pode exibir
o aviso padrão do Windows. Não desative o antivírus ou o SmartScreen: use a ação
de revisão oferecida pelo próprio Windows e confira o hash publicado no ZIP.

## Roteiro de validação

1. Abra `MiroTalk Desktop` como **Transmissor**.
2. Em Chrome/Brave, abra `https://mirotalk-dev.5-161-64-137.sslip.io/join/link`
   como **Receptor**.
3. Use fones e mantenha os dois microfones desligados.
4. No aplicativo, compartilhe a janela do jogo; o selo verde deve indicar
   `Áudio da aplicação`.
5. Reproduza áudio no jogo e em uma segunda aplicação.
6. Silencie o jogo: o receptor deve ficar em silêncio, mesmo com a segunda
   aplicação tocando.
7. Retome o jogo e confirme que somente ele volta a ser ouvido.
8. Encerre o jogo, pare e reinicie a captura; confirme que não há áudio residual.
9. Mantenha uma transmissão por 30 minutos e registre versão/build do Windows,
   sincronismo, interrupções e mensagens apresentadas pelo aplicativo.

A captura por processo é uma capacidade do Windows e não separa duas janelas
que compartilhem o mesmo processo. O suporte ao Windows 10 só será declarado
depois do teste na build real; compilar no GitHub Actions não comprova esse
comportamento.

## Desenvolvimento e atualização

- Aplicação web: `public/js/DesktopCapture.js` e
  `public/js/ProcessAudioWorklet.js`.
- Aplicação Windows: `desktop/`.
- Ambiente isolado: `compose.dev.yaml`, porta HTTP local 3013 e mídia
  TCP/UDP 40200–40300.
- Firewall persistente isolado: `ops/mirotalksfu-dev-firewall.service`.
- Produção não utiliza esses arquivos e permanece no checkout separado
  `/home/devuser/mirotalksfu`.

Ao atualizar a partir do upstream, faça merge/rebase em uma branch nova, revise
os dois adaptadores de captura e execute novamente o workflow Windows antes de
atualizar o ambiente de desenvolvimento.
