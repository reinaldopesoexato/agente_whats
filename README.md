# WhatsIA

[Instalação multiusuário em Docker, certificados, cotas e atualização por SSH](deploy/README.md)

Cliente web local para vários números de WhatsApp, com análise de conversas, pendências e fechamento diário de grupos de feedback. Cada número usa uma instância do Chromium com perfil persistente em `data/session-<id-da-conta>/`. O diretório é exclusivo por conta. Ao parar o servidor com Ctrl+C, o navegador fecha de forma controlada e o perfil é reutilizado no próximo início.

## Instalação no macOS, Windows e Linux

1. Instale [Node.js 22.13 ou superior](https://nodejs.org/). No Windows, use PowerShell. No Linux, instale também as bibliotecas de sistema exigidas pelo [Chromium do Puppeteer](https://pptr.dev/troubleshooting).
2. Execute `npm install` dentro do projeto. A instalação baixa as dependências e o navegador do Puppeteer quando necessário.
3. Copie `.env.example` para `.env`. Use `cp .env.example .env` no macOS/Linux ou `Copy-Item .env.example .env` no PowerShell.
4. Execute `npm run chromium:install` para baixar o Chromium. Se já tiver o Chromium instalado, pode apontar `WHATSAPP_CHROMIUM_PATH` para seu executável.
5. Execute `npm start` e abra [http://127.0.0.1:3030](http://127.0.0.1:3030).

Vincule cada conta pelo QR no menu **Aparelhos conectados** do WhatsApp. Aguarde o estado **Conectado** para abrir as conversas. O envio é manual, pelo campo de mensagem da conversa. Abrir conversas, baixar anexos e analisar mensagens pela I.A. não solicita ao WhatsApp que marque as mensagens como lidas. O envio manual também desativa essa solicitação.

## Configurações de IA

Em **Contas → Configurações de IA**, configure os modelos de Conversas IA e da análise automática, limites de tokens por chamada, chave da OpenAI, modelos de visão e geração de imagens, modelo local Whisper e idiomas de OCR. As alterações valem para novas solicitações. Os valores iniciais vêm do ambiente. As escolhas feitas no painel ficam em `data/ai-settings.json`, com acesso restrito ao usuário do processo. O painel informa se há uma chave cadastrada e permite substituí-la ou removê-la.

Em **Conversas IA**, o modo Automático começa pelo Ollama. Se o modelo escolhido faltar, tenta modelos locais instalados. Se o serviço ou os modelos locais estiverem indisponíveis, usa o modelo da OpenAI configurado. Nesse caso, a OpenAI recebe o prompt e as evidências do escopo selecionado, inclusive no escopo **Todas as contas**. Selecione **Somente Ollama** para manter essas consultas locais. O modo da análise automática é definido separadamente por conta.

## Análise automática por conta

| Modo | Como funciona |
|---|---|
| Desativada | A conta funciona como cliente de mensagens. |
| Somente local | Usa o Ollama local para texto e imagens. Instale o [Ollama](https://ollama.com/download), execute `ollama pull qwen3-vl:8b` e mantenha o serviço em execução. |
| Híbrida | Processa áudio e extrai texto dos arquivos no computador. Usa a API da OpenAI para interpretar texto e imagens e para PDFs sem camada de texto quando aplicável. Configure `OPENAI_API_KEY` no arquivo `.env`. A API é faturada separadamente. |

Nos dois modos de análise, para transcrever áudio instale [FFmpeg](https://ffmpeg.org/download.html) e [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Aponte `FFMPEG` e `WHISPER_BIN` para os executáveis se eles estiverem fora do PATH. Em `WHISPER_MODEL`, informe o caminho do modelo multilíngue, como `ggml-small.bin`. O reconhecimento está configurado para português.

Na sincronização, o painel mostra o aviso do WhatsApp quando disponível e o maior percentual recebido. Por padrão, o aplicativo espera até 3 minutos para autenticar e até 10 minutos sem progresso durante a sincronização. Ao chegar a 99% ou concluir a sincronização, há até 90 segundos para a sessão ficar pronta. Se o prazo vencer, o aplicativo reconecta com o perfil salvo. Os tempos de autenticação e sincronização podem ser ajustados em `WHATSAPP_AUTH_TIMEOUT_SECONDS` e `WHATSAPP_SYNC_TIMEOUT_SECONDS`.

A aba I.A. mostra ações identificadas, fontes, status e falhas de análise. O modelo recebe dados e devolve JSON para atualizar os registros internos. A rota de envio é usada pelo formulário do cliente e não é oferecida como ferramenta ao modelo.

Abra um grupo e clique em **Incluir nos resumos**. O fechamento padrão é às 17h30 de Brasília. Mensagens a partir do horário de fechamento entram no próximo período. A análise considera mensagens novas enquanto a conta estiver conectada e o modo habilitado. Mensagens sincronizadas de períodos anteriores à conexão e itens da fila de execuções anteriores são ignorados. A tela de conversas exibe até 60 mensagens já carregadas, sem buscar páginas antigas.

A primeira versão extrai texto de PDF, DOCX, XLSX, CSV e TXT. Páginas digitalizadas passam por OCR local quando as dependências estão configuradas. Arquivos grandes, ilegíveis e formatos fora dessa lista podem ter análise parcial. A pasta `data/` guarda sessões, mensagens analisadas, pendências e resumos. Mantenha essa pasta no computador e use um único processo por instalação.

### Contexto por conversa

Abra uma conversa ou grupo e clique em **Contexto da I.A.** para cadastrar sua finalidade, participantes e funções, vocabulário e prioridades. O perfil vale apenas para aquela conversa e conta. A análise usa o perfil, até 15 mensagens recentes da execução atual, pendências abertas e até 12 fatos aprendidos nos últimos 14 dias. A memória mostra a mensagem de origem e não exige buscar o histórico. O perfil também ajuda a interpretar os resumos de feedback. Em modo híbrido, o perfil e a memória relevantes são enviados junto com os dados da análise à OpenAI.

Em **Contexto da I.A. → Gerar contexto pelo histórico**, escolha todo o histórico disponível ou informe quantos dias deseja analisar. A geração acontece em segundo plano e usa textos, legendas e transcrições já salvas. Cada nova geração concluída substitui o contexto histórico anterior da conversa. O modelo cria um resumo reutilizável.

Em **I.A. → Consultar contextos**, selecione a conta e use todos os contextos da conta ou apenas o da conversa aberta. O prompt consulta os contextos salvos no escopo escolhido e usa as preferências de Conversas IA.

### Chromium em segundo plano

O WhatsIA inicia o Chromium em modo headless em todas as plataformas. O painel mostra o QR e o código de vinculação. Abrir a janela manualmente ou selecionar **Rodar em segundo plano** reinicia somente a conta escolhida usando o mesmo perfil. A recuperação automática inicia em segundo plano.

O Agente verifica cada conexão a cada 15 segundos. Se o navegador ou a aba fechar, ou se duas verificações consecutivas falharem, o Agente tenta reabrir o Chromium com o mesmo perfil. Falhas repetidas aumentam o intervalo entre tentativas até dois minutos. Se o WhatsApp exigir uma nova vinculação, o QR fica disponível no painel enquanto o Agente aguarda.

Em **I.A. → Skills**, crie ou edite skills com **Nome** e **Descrição**. Use **Salvar como skill** para copiar o texto de uma consulta para a descrição.

### Pessoas

A página **Pessoas** reúne os contatos de todas as contas e autores identificados em conversas e grupos. O perfil global permite registrar vínculo, organização, responsabilidades, assuntos pessoais e de empresa, e instruções para a I.A. O telefone é usado para unificar identidades confirmadas. Se o WhatsApp só fornecer um identificador interno, é possível associá-lo a um telefone no perfil. Observações da I.A. são provisórias e têm link para a mensagem de origem. Em **Consultar na I.A.**, use perguntas sobre a pessoa. No modo híbrido, o perfil cadastrado e observações da conta selecionada podem ser enviados à OpenAI.

### Contexto pessoal e Obsidian

Abra a pasta `context/` como um vault separado no Obsidian pessoal. Comece pela nota `Inicio.md` e use o gráfico do Obsidian para navegar entre pessoas, conversas, mensagens, resumos, pendências, skills e memórias. O vault é local e ignorado pelo Git. Os perfis do Chromium permanecem em `data/`. No primeiro início após a mudança, o servidor importa o estado anterior para `context/state.json`. Edite os dados pelo WhatsIA. As notas Markdown são visualizações geradas pelo aplicativo.

Em **I.A.**, marque **Guardar este prompt na memória** ou escreva, por exemplo, «Lembre que a Larissa pediu para validar a entrega». As consultas e respostas ficam em **Consultas**. Os prompts marcados ficam disponíveis como fatos anotados para consultas futuras. Para consultar todas as contas juntas, escolha o escopo **Todas as contas**. Mensagens registradas e histórico de texto importado ficam vinculados às fontes. O provedor das consultas manuais é escolhido em Configurações de IA.

Em **I.A. → Processar histórico de todas as conversas**, informe quantos dias deseja importar. O lote percorre as contas conectadas com I.A. ativa, arquiva o texto disponível e complementa os resumos existentes. As mensagens já processadas por esse fluxo são ignoradas nas próximas rodadas. Contextos anteriores sem registro dos IDs podem ser reavaliados na primeira rodada incremental.

Em **Grupos**, o mesmo grupo do WhatsApp é reunido pelo identificador entre as contas. Você pode cadastrar um perfil comum, comparar históricos por conta, processar aquele grupo nas contas disponíveis e consultá-lo na I.A. A consulta local pode combinar evidências de todas as contas. A híbrida usa as evidências da conta selecionada. O Obsidian pessoal também ganha um índice de grupos com links para as conversas por conta.

A aba **I.A.** mantém conversas independentes no painel lateral. Cada conversa guarda prompts, respostas e fontes. Use **Enviar** ou Enter para consultar o contexto selecionado e Shift+Enter para inserir uma quebra de linha. As respostas renderizam Markdown. Você pode escolher uma skill na consulta ou mencioná-la pelo nome com a seleção automática.

### Fila automática de novas mensagens

A barra inferior mostra o volume de mensagens aguardando, a análise em andamento e as falhas. Use **Pausar análise** para manter novas mensagens na fila local sem iniciar outra análise e **Retomar análise** para continuar. A fila em `context/state.json` é reaberta ao iniciar o servidor. O modo de I.A. de cada conta continua valendo. Para cada mensagem elegível recebida pelo Agente, a análise cruza o contexto da conversa e evidências gerais relevantes e cria uma pendência quando identifica uma responsabilidade do usuário. No modo híbrido, as evidências gerais ficam no escopo da mesma conta.

Em **I.A. → Skills → Nova skill**, informe o nome e descreva em português quando agir, quais ações executar e quem deve receber a resposta. Ao salvar, a regra passa a ser avaliada a cada nova mensagem elegível. Por exemplo, “Quando o grupo Suporte informar uma falha de produção, crie uma pendência e responda no próprio grupo com um resumo do problema”.

A descrição pode pedir uma pendência, um rascunho para revisão, uma resposta no WhatsApp ou o envio de um resumo ao webhook configurado. Para enviar para outra conversa, cite seu nome ou telefone na descrição. Quando houver dúvida sobre o destino ou sobre a ação, consulte **Execuções de skills**.

As skills padrão **Interceptar mensagens do WhatsApp** e **Enviar ou responder no WhatsApp** têm controles **Skill ativa** independentes. Desativar a interceptação suspende a captura de novos eventos e a execução da fila de automações. Desativar o envio bloqueia inclusive o envio manual pelo aplicativo. A fila de mensagens aguardando envio continua guardada.

Para usar uma skill a partir de outra, escreva na descrição `Use a skill "Nome da skill".` Uma dependência desativada, inexistente ou circular impede a execução da regra que a chama. Respostas e envios passam pela skill padrão de WhatsApp mesmo quando a descrição não cita seu nome.

### Canal privado entre as contas

Depois de conectar as duas contas, escreva na conversa direta entre elas pelo WhatsApp. A conta que recebeu a mensagem envia a resposta de volta. O histórico é compartilhado pelos dois lados da conversa e separado dos outros chats da I.A. Os controles de interceptação e envio também se aplicam ao canal.

O canal privado e os comandos `/ia` enviados pela própria conta consultam o contexto de todas as contas. Se o Ollama ou o modelo local estiver indisponível, o Agente usa a OpenAI configurada no aplicativo. Nesse caso, o prompt e as evidências selecionadas das contas são enviados à OpenAI.

- `Liste as skills`
- `Crie a skill Nome: descrição`
- `Edite a skill Nome: nova descrição`
- `Use a skill Nome: seu pedido`
- `Envie para Nome: texto` prepara o envio e retorna uma prévia com o código de autorização.

Revisões de automações e envios sem confirmação também podem gerar avisos no canal. Responda à mensagem de autorização com “sim”, “ok”, “claro” ou “1” para aprovar, ou com “não”, “0” ou “pare” para recusar. A autorização vale por 24 horas.

Na aba I.A., a skill **Reprocessar histórico de conversa** aceita pedidos como “Reprocesse o grupo Suporte dos últimos 7 dias” ou “Reprocesse esta conversa de 01/11/2026 a 10/11/2026”. O painel mostra o progresso. Use **Parar** ou escreva “parar reprocessamento” no mesmo chat da I.A. para interromper e preservar os lotes já concluídos.

Para frases exatas, escreva “Quando eu receber exatamente "ping" responda com "pong"”. O Agente compara o texto recebido com o texto entre aspas e executa a regra mesmo com o modelo de I.A. desligado na conta. A pausa geral continua valendo. Para previsão, use “Quando eu receber exatamente "tempo?" responda com a previsão do tempo de Cidade - Estado”. A consulta usa o Open-Meteo e aparece em revisão se o serviço estiver indisponível.

As ações ficam na fila local até serem concluídas. Se houver interrupção durante um envio, a execução fica como **Envio sem confirmação**. Confira o destino antes de repetir. Para conectar um serviço externo, configure `SKILL_WEBHOOK_URL` com um endpoint HTTPS que aceite POST JSON e, se necessário, `SKILL_WEBHOOK_TOKEN` para autenticação Bearer. Cada chamada inclui `Idempotency-Key` e um resumo com a referência à mensagem.

A skill padrão **Enviar ou responder no WhatsApp** prepara mensagens como «Envie para Larissa: Chego às 15h» ou «Envie para Larissa pela conta Trabalho: Chego às 15h». Sem uma conta explícita, usa a conversa aberta quando ela corresponde ao destino, ou a conversa mais recente do destinatário. Para citar uma mensagem exata, clique em **Responder com a I.A.** nela. «Responda para Larissa: …» busca a mensagem recebida mais recente da conversa resolvida. Revise o rascunho e clique em **Enviar no WhatsApp** para efetivar.

### Comandos do app pela I.A.

- **Reprocesse tudo da última semana** reprocessa os últimos sete dias em todas as conversas das contas conectadas com I.A. ativa, incluindo mensagens já processadas. Para outro período, escreva, por exemplo, **Reprocesse todas as conversas dos últimos 14 dias**.
- **Status do reprocessamento** mostra o andamento, as mensagens processadas, a contagem de erros e as contas ignoradas. Veja os detalhes na janela de processamento de histórico.
- **Reiniciar sessões** reinicia as sessões de todas as contas cadastradas. **Reiniciar a sessão atual** afeta apenas a conta selecionada. Acompanhe a reconexão em **Contas**.

Digite os comandos na aba **I.A.** do painel.

### Integração com outra LLM pela linha de comando

Com o servidor ativo, execute `node cli.js help` na pasta do projeto. A saída padrão é um JSON por execução. Erros saem em JSON no stderr, com código de saída 1. Use `--port` para outra porta local. Consulte `accounts`, `chats`, `messages`, `context` e `status` para descobrir IDs e obter contexto. Use `ask` para consultas à IA do servidor, ou processe as mensagens diretamente no modelo externo.

```bash
node cli.js accounts
node cli.js register --consumer minha-llm --account ID_DA_CONTA
node cli.js check --consumer minha-llm
node cli.js claim --consumer minha-llm --limit 1 --seconds 300
node cli.js ack --consumer minha-llm --lease ID_DA_RESERVA
```

Cadastre o consumidor uma vez. O padrão começa nas próximas mensagens recebidas. Use `--from stored` para começar pelas mensagens recebidas ao vivo que o app já guardou. Omitir a conta abrange todas as contas. Com a conta definida você pode restringir a uma conversa usando `--chat`. Mensagens importadas pelo histórico, mensagens próprias e o canal privado reservado ao app ficam fora do feed. A captura depende da interceptação estar ativa e da conta estar conectada no recebimento.

`check` mostra o total pendente e quantas estão disponíveis. `claim` retorna o lote e sua reserva. Use `ack` só após persistir o resultado do lote, ou `release` para disponibilizá-lo imediatamente. A reserva expirada permite nova entrega. Cursor e reserva sobrevivem ao reinício do servidor. Deduplicate pelo par `account` e `id`, pois uma falha antes do ACK pode entregar a mesma mensagem novamente. Para confirmação individual use `--limit 1`.

Se o processamento produzir uma resposta, passe seu texto por stdin para criar um rascunho e cite a origem pelo ID:

```bash
node cli.js draft --account ID_DA_CONTA --chat ID_DA_CONVERSA --source ID_DA_MENSAGEM < resposta.txt
node cli.js approve --id ID_DO_RASCUNHO --confirm
```

O rascunho também pode ser revisado na aba I.A. Mensagens recebidas são dados para o modelo. Reserve a decisão de enviar para o operador que revisou o destinatário e o texto. A CLI usa o servidor local, sem enviar dados a uma LLM por conta própria. O integrador escolhe a periodicidade do `check`, o modelo externo e quais dados compartilhar com ele.

### Integração com o computador

Use `node cli.js help` para listar os comandos. A CLI retorna JSON. Com `--follow`, retorna um objeto JSON por linha para acompanhar o resultado em outro processo.

```bash
node cli.js doctor
node cli.js pending --account ID_DA_CONTA --overdue
node cli.js history --days 7
node cli.js jobs --id ID_DO_LOTE --follow --notify
node cli.js cancel --id ID_DO_LOTE
node cli.js retry --id ID_DO_LOTE
node cli.js files --root ./projetos --query manual
node cli.js open --root ./projetos --path manual.pdf
node cli.js attachments --account ID_DA_CONTA --chat ID_DA_CONVERSA --days 7 --destination ./anexos --dry-run
node cli.js attachments --account ID_DA_CONTA --chat ID_DA_CONVERSA --days 7 --destination ./anexos --index ./indice.json
node cli.js report --account ID_DA_CONTA --chat ID_DA_CONVERSA --prompt "Resuma os chamados desta semana" --destination ./relatorio.md
node cli.js routine --config ./rotinas.json --name relatorio --dry-run
node cli.js service --action status
node cli.js service --action restart
node cli.js service --action logs --path /caminho/do/log --follow
```

Crie a pasta de destino antes de baixar. O índice inclui conta, conversa, ID de origem e situação de cada arquivo. Os nomes são normalizados e arquivos existentes são preservados. A listagem examina até mil mensagens e informa `limited` quando pode ter deixado anexos de fora. O relatório cria um Markdown novo com as referências que a consulta retornou.

O painel e a CLI compartilham o último lote de histórico. O progresso fica registrado após cada conversa e um encerramento marca o lote como interrompido. `retry` abre um novo lote para as falhas identificadas por conversa. Para refazer um lote interrompido, inicie outro processamento incremental com o mesmo período. Notificações ficam disponíveis em macOS e Linux enquanto `jobs --follow --notify` estiver rodando. O diagnóstico informa presença do Chromium, estado das contas, fila e último erro de provedor registrado.

As rotinas vêm de um arquivo criado pelo operador. Cada registro tem executável e pasta absolutos, argumentos fixos e, opcionalmente, uma lista de argumentos adicionais aceitos. Use somente configurações confiáveis.

```json
{
  "relatorio": {
    "program": "/caminho/do/executavel",
    "cwd": "/caminho/do/projeto",
    "args": ["relatorio-semanal"],
    "allowedArguments": ["--sexta"]
  }
}
```

No macOS, `service` opera sobre um serviço launchd do usuário já registrado. Por padrão, usa `local.agente-whats.codex`. Use `--label` quando sua instalação usar outro identificador. Scripts e agendadores do sistema podem chamar os mesmos comandos com caminhos absolutos.

Para preparar uma rotina semanal no macOS, gere um arquivo de agendamento com
`node cli.js schedule --config ./rotinas.json --name relatorio --weekday 5 --time 16:00 --destination ./relatorio.plist --log ./relatorio.log`.
O valor 0 representa domingo. Use `--dry-run` para conferir o plano. O arquivo precisa ser ativado pelo operador com `launchctl bootstrap gui/$(id -u) /caminho/absoluto/relatorio.plist`.
Escolha uma rotina que possa rodar sem interação. Esta integração não registra nem recupera execuções perdidas enquanto o sistema está indisponível.

No macOS, abra o menu de estado com `swift menubar.swift`. Informe a porta como primeiro argumento se ela for diferente de 3030.
O menu mostra contas conectadas, fila e lote ativo e oferece um atalho para o painel.

Para vincular um arquivo de até 5 MiB, arraste-o do Finder para o cartão da pendência ou use o seletor de arquivo do cartão.
Pela CLI, use `node cli.js link-file --id ID_DA_PENDENCIA --path ./arquivo.pdf`.
O Agente guarda uma cópia em `data/action-files` e exibe o link no cartão.

### Executar um comando local pela aba I.A.

Teste com **Execute o comando uptime**. O cadastro padrão inclui também **espaco-disco**.
Para adicionar rotinas próprias, cadastre o executável, a pasta e os argumentos permitidos. Defina `AGENTE_WHATS_ROUTINES` no `.env` e reinicie o servidor. Na aba **I.A.**, digite
**Execute a rotina relatorio**. Para passar argumentos permitidos pelo cadastro, use
`Execute a rotina relatorio com argumentos ["--sexta"]`.

O painel mostra o executável, a pasta e os argumentos. Clique em **Executar no computador**
para executar e ver a saída na própria conversa. O aplicativo chama o executável diretamente
com a conta do sistema que roda o servidor. A execução usa um ambiente reduzido, tempo limite
de dois minutos e saída exibida de até 12 mil caracteres por canal. Configure caminhos absolutos.

### Áudios no histórico

O Agente transcreve mensagens de voz e anexos de áudio novos com FFmpeg e whisper.cpp quando
a captura e a análise estão habilitadas e o modelo local está configurado. A transcrição fica
ligada à mensagem de origem, aparece em **Transcrição do áudio** no chat e pode ser recuperada
nas consultas de contexto e no Obsidian. O arquivo do áudio é processado localmente. Se o modo
híbrido estiver ativo, o texto pode entrar nas análises enviadas ao provedor configurado.

Para áudios antigos, abra **Contexto da I.A. → Gerar contexto pelo histórico** e selecione o
período. O Agente tenta transcrever os áudios ainda disponíveis no WhatsApp e reaproveita o texto
já salvo. O lote pode demorar mais em conversas com muitos áudios. Falhas de transcrição não
impedem o processamento do restante do histórico.

### Imagens e PDFs no contexto

Imagens JPEG, PNG e WebP recebem uma descrição detalhada em português, vinculada à mensagem.
A análise visual usa o provedor da conta. No modo híbrido, a imagem é enviada uma vez para análise visual.
As consultas e as demais análises reaproveitam a descrição salva. No chat, abra **Descrição da imagem**.

PDFs são processados localmente com PDF.js. Instale Poppler e Tesseract com idiomas português e
inglês para habilitar OCR nas páginas com pouco ou nenhum texto. Configure `PDFTOPPM`,
`TESSERACT`, `TESSDATA_DIR` e `TESSERACT_LANG` conforme a instalação.
O Agente guarda o texto por página e usa excertos limitados nas consultas, priorizados pela pergunta.
A análise híbrida pode enviar esses excertos ao provedor. O arquivo PDF e as imagens do OCR ficam locais.
Uma leitura processa até 60 páginas, com até 20 tentativas de OCR. Leituras parciais aparecem no chat.
Para mídias antigas ainda disponíveis, use **Gerar contexto pelo histórico**.

### Busca automática e diretórios pela I.A.

Digite **Liste todos os grupos**, **Liste meus contatos** ou **Quantos contatos tenho?**.
O diretório usa a conta selecionada. Acrescente **de todas as contas** para consultar as duas.
Quando uma conta estiver desconectada, a resposta avisa e usa os registros locais disponíveis.

Em perguntas sobre mensagens, o Agente combina o contexto salvo com a busca ao vivo quando
a pergunta pede informações recentes ou quando encontra conversas relevantes com pouca evidência.
A busca consulta até três conversas, com até 60 mensagens por conversa. O escopo selecionado
continua valendo, e mensagens consultadas entram como evidência sem acionar a fila de análise
ou automações. No modo híbrido, os trechos selecionados podem ser enviados ao provedor configurado.
O chat mostra o progresso durante a consulta. Exemplo: **O que o grupo Suporte disse hoje sobre a instalação?**

### Consultas, caixa Hoje e retomada

A aba **Hoje** reúne pendências, acompanhamentos, rascunhos em revisão, mensagens que parecem
aguardar resposta e anexos com falha. A indicação de mensagem sem resposta compara o último
evento capturado de cada conversa nos sete dias anteriores. Em grupos, considera menções e
respostas a mensagens. Abra a fonte para conferir, prepare uma resposta ou crie um acompanhamento
com data. Pendências adiadas voltam a aparecer na data selecionada.

Nas consultas, o agente busca primeiro nas conversas mais relevantes. Quando a evidência é
insuficiente ou a pergunta pede um período, pode ampliar o limite inicial de 40 para até 120
mensagens e consultar outras conversas, com limite total de cinco. A resposta mostra as datas
encontradas, o limite quando aplicável e as falhas. Exemplos: **O que ficou combinado sobre a
instalação no grupo Suporte desde sexta?**, **Em quais grupos a Ana aparece?** e
**Quais grupos de suporte tiveram atividade esta semana?**. Participação e atividade refletem
os registros disponíveis.

No processamento de histórico, **Pausar**, **Retomar** e **Cancelar** controlam a fila persistente.
O servidor registra a posição por conta e conversa e os blocos já salvos. Após um reinício,
lotes em execução retomam automaticamente. Contas com I.A. ativa que estiverem desconectadas
aguardam conexão dentro do lote. Erros por conversa podem ser repetidos pelo botão **Tentar
conversas com erro**. Em **Hoje → Anexos com falha**, a nova tentativa atua apenas no anexo.
A próxima geração de histórico incorpora resultados recuperados.

```bash
node cli.js watch --consumer minha-llm --limit 1 --once
node cli.js renew --consumer minha-llm --lease ID_DA_RESERVA --seconds 900
node cli.js ack --consumer minha-llm --lease ID_DA_RESERVA
node cli.js pause --id ID_DO_LOTE
node cli.js resume --id ID_DO_LOTE
node cli.js today
node cli.js attachment-issues
node cli.js attachment-retry --account ID_DA_CONTA --source ID_DA_MENSAGEM
```

`watch` mantém uma consulta pendente e emite uma linha JSON por reserva. Com `--once`, sai após
a primeira reserva. Use `renew` antes de a reserva expirar. Uma repetição imediata do último ACK
é aceita. Para evitar repetir efeitos externos após uma interrupção, persista o resultado usando
o par conta e ID da mensagem antes de confirmar o consumo.

### Decisões, correções e acompanhamentos por assunto

As análises de mensagens novas e os lotes de histórico registram decisões e compromissos com
situação, responsável, prazo e trecho original. Para alimentar a memória com mensagens já resumidas,
use a opção de reprocessamento. A aba **Hoje** mostra decisões, agrupamentos e os motivos da
prioridade. Corrija uma decisão no próprio cartão ou marque uma pendência como **É de outra pessoa**.
Estas correções entram no contexto das próximas análises.

Para registrar um apelido, escreva **Aprenda que Projeto Azul é o mesmo que Instalação Norte**.
A associação fica na conta selecionada e ajuda a orientar as buscas. Perguntas ambíguas podem
receber opções antes da busca. A busca mantém o escopo selecionado.

Na aba **I.A.**, digite **Me avise se Ana não responder sobre o orçamento da instalação até sexta**.
Selecione a conversa ou indique o nome exato. Em grupo, informe quem deve responder ou diga
**o grupo**. O acompanhamento verifica as mensagens capturadas, mostra avisos de prazo na aba
**Hoje** e vincula respostas que reconheceu sobre o mesmo assunto. Confira a origem quando houver dúvida.

Execute `node cli.js evaluate` para os casos sintéticos locais. Para avaliar perguntas já conferidas,
use `node cli.js evaluate --account ID --cases casos.json`. O arquivo contém objetos com
`name`, `prompt`, `chat` opcional e um ou mais resultados esperados em `contains` (lista de trechos),
`sources` (lista de IDs de mensagens) ou `clarification` (booleano).
A CLI retorna aprovação, tempo e tokens quando o provedor os informa. A execução com casos reais
usa a conta e o provedor configurados. Informe as tarifas por milhão de tokens com
`--input-rate` e `--output-rate` para estimar o custo na moeda das tarifas informadas.

### Gerar e enviar imagens

Na aba **I.A.**, clique em **Gerar imagem**, escolha uma conversa na conta selecionada e descreva
a imagem. A legenda é opcional. O rascunho mostra a imagem e o destino. Use **Enviar no WhatsApp**
para confirmar o envio ou **Baixar imagem** para guardar uma cópia.
A geração usa a API de imagens da OpenAI e envia somente o texto da descrição. Configure
`OPENAI_IMAGE_MODEL` no `.env` para escolher o modelo de imagem. O padrão é
`gpt-image-2.5-flare`; as conversas continuam usando o modelo de texto configurado.
O PNG fica armazenado em `data/generated-images` junto ao rascunho.

### Skill de arquivo de mensagens apagadas

A skill **Salvar mensagens e mídias apagadas** vem ativa e pode ser desligada em **I.A. → Skills**.
Com a interceptação ativa, o Agente copia mensagens novas e mídias disponíveis enquanto a conta
está conectada. Os arquivos ficam no Mac em `data/message-archive`, com até 18 MiB por mídia.
Quando o WhatsApp comunica uma exclusão, abra **Mostrar conteúdo apagado** na conversa para
revelar o texto e baixar a mídia arquivada. Mensagens que o app não capturou e mídias já
indisponíveis podem aparecer sem conteúdo. Desativar a skill interrompe novas capturas.

#### Pesquisa e retenção do arquivo

Abra **Arquivo** na barra superior para consultar exclusões por conta, nome da conversa e datas.
O painel oferece prévia dos formatos de imagem, áudio e vídeo compatíveis com o navegador, além
do download. **Atividade** mostra registros recentes de arquivo, exclusão, transcrição, correção e
envios confirmados pelo app. O uso do arquivo inclui bytes de texto e mídia, além da quantidade
de mensagens com cópia local.

Em **Arquivo da conversa**, ajuste a captura e os prazos de retenção. Texto e mídia têm prazos
independentes. Zero mantém a cópia sem prazo. Um prazo positivo é aplicado às cópias existentes
e à captura futura. A limpeza atua no arquivo dedicado e roda também periodicamente.
A fila tenta baixar mídias temporariamente indisponíveis até três vezes enquanto o servidor
estiver ativo. O painel oferece uma nova tentativa quando o WhatsApp ainda dispõe da mídia.

Na aba **I.A.**, marque **Incluir cópias de mensagens apagadas** para acrescentar o texto
arquivado ao pedido. Fontes identificam cópia arquivada, mensagem, decisão ou resumo.
Resumos e contexto criados antes de uma exclusão podem conter fatos extraídos anteriormente.

## Ações do WhatsApp e skills

Em **Conversas**, abra a seta no canto da mensagem para reagir, responder citando, votar ou apagar. Clique nos emojis abaixo da mensagem para consultar os participantes. Para retirar sua reação, escolha **Reagir → Retirar → Executar**. Em grupos, digite `@` e parte do nome no campo de mensagem para escolher um participante.

**Apagar para mim** remove a mensagem da sua conta. **Apagar para todos** solicita a revogação ao WhatsApp e informa quando o prazo ou as permissões impedem a operação. Na seleção em massa, o resultado é individual por mensagem. A skill de arquivo local continua seguindo a configuração da conta.

Em **Contas → Ações do WhatsApp**, escolha a conta, a operação e o destino. O catálogo inclui contatos, grupos e participantes, convites, permissões, mensagens, enquetes, canais, recado e publicações de status. O envio de vídeo depende de codecs compatíveis. O projeto da biblioteca indica o Google Chrome para essa função. O caminho do executável pode ser configurado em `WHATSAPP_CHROMIUM_PATH`.

Em **Skills → Skill do WhatsApp**, configure a operação, os parâmetros e a conta. Também é possível escolher **Salvar como skill** no painel de uma ação. A execução manual fica disponível na lista de skills. Para automatizar, indique a conversa de origem e o texto exato recebido. Em grupos é possível restringir o remetente pelo ID. Por exemplo, configure **Reagir ou retirar reação**, escolha 👍 e use o gatilho `Recebido`. A reação é aplicada à mensagem que contém o gatilho. A execução automática requer a interceptação e a análise de mensagens ativas. Envios dependem também da skill de envio.

Para integração local, `GET /api/whatsapp/actions` lista os identificadores das operações, os campos e os escopos da versão instalada. Envie `POST /api/accounts/{conta}/whatsapp/action` com a ação e os IDs da própria conta, por exemplo:

```json
{"operation":"message.react","chat":"ID_DA_CONVERSA","message":"ID_DA_MENSAGEM","params":{"emoji":"👍"}}
```

Para executar a configuração de uma skill, envie `{"skillId":"ID_DA_SKILL"}` ao mesmo endpoint. Para ações sobre uma mensagem sem ID fixado na skill, acrescente o campo `message`.

Na linha de comando, use `node cli.js wa-actions` para listar o catálogo. Exemplo de consulta: `node cli.js wa-action --account CONTA --chat GRUPO --name group.participants`. Para executar uma skill salva, use `node cli.js wa-skill --account CONTA --id SKILL`.

## Contas no painel Hoje

O seletor **Conta** filtra cartões, contagens, anexos com falha e o histórico de cada categoria. **Todas as contas** abre a visão conjunta. O navegador lembra a última escolha. Com uma conta selecionada, comandos como “Ignore as mensagens sem resposta” e as ações em massa se aplicam somente a ela. A organização das categorias é compartilhada. No terminal, use `node cli.js today --account ID` para consultar uma conta ou `node cli.js today` para consultar todas.

## Aprendizado ao mover cartões em Hoje

Ao mover um cartão, o WhatsIA usa o assunto da mensagem como exemplo para as próximas mensagens da mesma conta. Se você corrigir o destino novamente, passa a valer a última escolha. A mensagem de confirmação indica quando o cartão forneceu conteúdo suficiente para aprender. O destino pode ser uma categoria oculta ou sem prompt.

Com a análise de IA ativa, o agrupamento usa uma consulta própria ao modelo automático da conta quando existe um critério ou uma correção aplicável. A consulta reúne nome e critério das listas, mensagem atual, transcrição ou conteúdo extraído, origem da conversa e até oito mensagens anteriores das últimas duas horas. A mensagem citada pode ser mais antiga. Os exemplos de correção compartilham palavras do assunto e indicam se a correção veio da mesma conversa. Uma resposta ambígua pode ficar sem lista. Com a análise por modelo desativada, a comparação local por palavras continua disponível para mensagens arquivadas.

Nos cartões de mensagens agrupadas, abra **Classificação da lista** para consultar o motivo e o trecho usado. **Reavaliar listas** aplica os critérios atuais somente àquela mensagem e preserva movimentos manuais. A atualização do aplicativo passa a classificar os próximos itens dessa forma. As listas operacionais de pendências, aprovações e mensagens sem resposta mantêm seus critérios próprios.

### Complementos de conversa

Ao analisar uma nova mensagem, o WhatsIA também verifica se ela traz uma mudança concreta para um cartão da mesma conta e conversa. Uma resposta citada pode retomar um item antigo ou um complemento anterior. Em grupos, outra pessoa pode completar o item. Quando há dois assuntos plausíveis e falta evidência para escolher, a mensagem segue a classificação normal.

O cartão mostra o resumo atualizado e os trechos que sustentam a alteração em **Ver complementos**, com acesso às mensagens originais. O agrupamento considera texto, transcrições e conteúdo extraído de anexos. Uma mudança de horário ou quantidade pode atualizar o mesmo cartão; um pedido independente pode abrir outro. O vínculo e o resumo ficam salvos no WhatsIA. Mover ou apagar um cartão continua sendo uma decisão do usuário. O processamento usa o modelo automático da conta quando há listas ou cartões candidatos.

## Notificações do navegador

Em **Contas → Notificações do navegador**, marque **Mensagens recebidas** e/ou **Novos itens visíveis** e permita os avisos quando o navegador solicitar. Mantenha o WhatsIA rodando no terminal e uma aba do painel aberta, mesmo em segundo plano. A preferência é salva neste navegador.

As mensagens recebidas mostram a conta e a conversa. Os cartões geram um aviso separado, com ícones próprios para tarefas, acompanhamentos, aprovações, decisões, mensagens sem resposta, falhas de anexo e mensagens agrupadas. Os avisos do painel respeitam a conta selecionada em **Hoje** e as categorias ocultas. Clicar no aviso abre a conversa ou a categoria correspondente. Só os itens novos geram aviso ao ativar.

Em **Contas → Notificações do navegador**, escolha se deseja receber mensagens de pessoas, de grupos ou de ambos. Você também pode silenciar o som e ocultar os detalhes dos avisos. Em **Hoje → Organizar categorias**, edite uma lista e ajuste **Mostrar notificações**. Essa opção é compartilhada por quem usa a lista e vale para os próximos itens. Os controles gerais de cada navegador continuam valendo.

## Fotos e recados

As listas **Pessoas** e **Grupos** exibem a foto e, quando o WhatsApp disponibiliza, o recado do contato ou a descrição do grupo. Abra a linha para ler o texto completo. O WhatsIA consulta os perfis à medida que aparecem na tela. Ele guarda os dados por conta em `data/contact-profiles/` para reutilizá-los em Conversas e nos diretórios, inclusive quando a conta estiver desconectada. Ao voltar a consultar um perfil conectado, o servidor pode atualizar uma cópia com mais de um dia.
