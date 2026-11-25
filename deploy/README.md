# WhatsIA multiusuário

## Instalação e atualização pelo Mac

O portal atende em `https://whatsia.psxt.io`. Configure o registro DNS de `whatsia.psxt.io` e um registro curinga de `*.whatsia.psxt.io` para o mesmo servidor. Cada espaço usa um subdomínio próprio para isolar cookies, armazenamento do navegador e notificações. O SSH usa o domínio principal.

Use um servidor Debian ou Ubuntu com systemd, acesso administrativo e suporte a ext4 com quotas e dispositivos de loop. Reserve espaço físico para o crescimento dos discos. A soma das cotas pode exceder a capacidade física, portanto monitore também o disco do servidor. O instalador usa Nginx na porta 443 e um serviço interno em 127.0.0.1:3040. O servidor atual do Mac pode continuar sendo controlado pelo terminal.

Na pasta do projeto, com Docker Desktop em execução, rode:

```sh
bash deploy/mac.sh
```

O script abre uma conexão SSH com `root@whatsia.psxt.io`, detecta a arquitetura do Linux, constrói as imagens no Mac, transfere e instala a versão. Digite a senha no prompt do OpenSSH. Na primeira conexão, confira a impressão digital pelo console do provedor. Para outro destino, ajuste `WHATSIA_SSH`, `WHATSIA_DOMAIN` e `WHATSIA_ADMIN_EMAIL`. A conta inicial configurada para esta instalação é `reinaldofs95@gmail.com`. O primeiro link de ativação aparece no terminal e vale por 30 minutos.

O HTTPS usa certificados públicos do Let’s Encrypt. Mantenha as portas TCP 80 e 443 acessíveis e os registros A e, se usados, AAAA do portal e dos espaços apontando para a VPS. O servidor usa a porta 80 para validar o domínio e redireciona a navegação para HTTPS. O navegador usa suas autoridades de confiança habituais.

O serviço `whatsia-cert.timer` verifica novos espaços a cada cinco minutos e solicita um certificado individual quando o DNS estiver disponível. O registro DNS curinga atende aos próximos cadastros. `certbot.timer` cuida da renovação e o Nginx recarrega o certificado após a emissão. Confira com `certbot certificates`, `journalctl -u whatsia-cert.service` e `certbot renew --dry-run`. Faça backup protegido de `/etc/letsencrypt`.

Rode o mesmo script para atualizar. O banco do portal em `/var/lib/whatsia/control` mantém contas, permissões, credenciais de IA e sessões de login. Os perfis do WhatsApp e os dados de cada pessoa ficam em um disco individual em `/var/lib/whatsia/disks`. As imagens Docker contêm o aplicativo. O reconciliador encerra o Chromium antes de substituir cada contêiner, monta o mesmo disco e verifica a resposta da nova versão. Uma falha de inicialização aciona o retorno ao contêiner anterior quando disponível. Leia o resultado da atualização e consulte `journalctl -u whatsia-users.service` para falhas. Uma sessão revogada no telefone pode exigir novo QR. Os contadores de conexão, sincronização e atenção são verificados separadamente da disponibilidade do processo.

## Permissões e acesso

Em **Contas → Minha conta e administração**, o usuário abre o portal. Cada permissão libera uma função. Cadastro, consulta de consumo, mudança de cotas, configuração compartilhada de IA e delegação são independentes. A administração mostra o consumo agregado. As rotas de conversa encaminham requisições somente ao espaço do usuário autenticado. Sair do portal também revoga os acessos ao espaço vinculados àquela sessão.

Para ativação e recuperação por e-mail, preencha `/etc/whatsia/mail.env` no servidor com `SMTP_HOST`, `SMTP_PORT` (padrão 587), `SMTP_FROM` e, quando necessário, `SMTP_USER` e `SMTP_PASSWORD`. O envio usa STARTTLS. Execute novamente o instalador para aplicar. Crie o cadastro pelo painel e peça à pessoa que use **Primeiro acesso ou recuperação de senha**. O e-mail cadastrado não pode ser trocado pelo painel. O operador SSH também pode emitir um link individual no terminal confiável:

```sh
docker exec whatsia-control node control/bootstrap.js recover usuario@exemplo.com
```

## Skills administrativas

No portal, marque **Gerenciar skills administrativas** no cadastro de quem poderá criar, editar, pausar e excluir as regras. Na atualização, os cadastros que já possuíam todas as permissões administrativas anteriores recebem essa permissão uma vez. Um usuário com apenas essa permissão pode administrar as regras. Se a instalação anterior não tiver um gestor com todas as permissões, o operador SSH pode fazer a primeira concessão com `docker exec whatsia-control node control/bootstrap.js grant-admin-skills usuario@exemplo.com`.

Em **Skills administrativas → Nova skill**, informe o nome e a ação. Para gerar uma tarefa por pedido atrasado em um grupo, use **Grupo** igual a `Expedição`, **Condição e informações a destacar** igual a “Quando houver um atraso, destaque o pedido afetado e o novo prazo” e **Ação** igual a **Criar tarefa**. Com a condição vazia, o grupo por si só dispara a ação. Sem um grupo fixo, escreva a condição na descrição. O filtro de grupo compara o título da conversa inteira, ignorando maiúsculas e espaços repetidos.

As regras ativas valem para novas mensagens recebidas após sua criação ou última edição, com análise e interceptação habilitadas. Cada espaço tem um avaliador privado ligado apenas à sua rede. Ele lê o catálogo em volume separado e usa o contexto recente da conversa de origem. O administrador vê as definições. O usuário vê o resultado no próprio espaço: tarefa no Hoje, resumo em Conversas IA ou rascunho vinculado à conversa para revisar antes de enviar.

Uma condição escrita em linguagem natural usa o modelo local do espaço no modo local. No modo nuvem, usa o modelo e a chave compartilhada configurados pela administração ou, na ausência dessa chave, o modelo local do espaço. A etapa que redige o resultado usa as preferências de processamento do usuário e recebe somente os trechos selecionados. Se o modelo necessário estiver indisponível, a mensagem aguarda nova tentativa. O catálogo persiste em `/var/lib/whatsia/control/skill-catalog` e faz parte do backup do portal.

## Dados, cotas e IA

Cada usuário começa com 10 GiB. O painel sinaliza 80% de uso. A gravação de novas cópias no arquivo de mídias pausa a partir de 90% para deixar espaço para mensagens. O kernel aplica a cota aos arquivos persistentes do usuário, inclusive aos arquivos criados pelas rotinas. Ao atingir o limite, novas gravações podem falhar. O usuário pode liberar espaço manualmente em **Arquivo → Limpar mídias antigas**, ou pedir aumento de cota. A prévia discrimina quantidade e tamanho antes da confirmação. A limpeza atua nas cópias locais de anexos das mensagens e conserva o histórico, as legendas e as transcrições. Não há exclusão automática de mídia ao atingir a cota.

O administrador define os modelos e a chave compartilhada em **IA compartilhada**. O intermediário aceita apenas novas solicitações de análise ou geração. As consultas compartilhadas desativam o armazenamento de respostas e não aceitam IDs de arquivos, conversas e respostas anteriores. A chave do provedor fica no portal. Cada usuário pode definir modelos e uma chave pessoal em **Contas → Configurações de IA**.

Para oferecer o Ollama compartilhado, execute como root `bash /opt/whatsia/current/ollama-shared.sh qwen3-vl:8b`. Os pesos ficam em um volume Docker persistente do servidor. A instalação de `qwen3-vl:8b` inclui a variante `qwen3-vl:8b-instruct` para descrever fotos na CPU. O modelo visual escolhido nas preferências tem prioridade. Cada espaço acessa a lista de modelos e envia sua própria consulta pela rede privada. Em **Contas → Configurações de IA**, o usuário escolhe **Somente Ollama** para conversas de IA e pode também escolher esse modo por conta WhatsApp para a análise automática.

Em instalações com modelos individuais, o operador pode habilitar uma instância separada por usuário, com seus modelos contabilizados na cota. Coloque a referência oficial imutável `ollama/ollama@sha256:…` em `/etc/whatsia/ollama-image` e ajuste a memória e o disco disponíveis. O reconciliador disponibiliza a instância na rede daquele usuário. Use `docker exec whatsia-model-ID ollama pull MODELO` para instalar o modelo escolhido. A imagem do aplicativo inclui Chromium, FFmpeg, Poppler, Tesseract e whisper-cli. A imagem fornece também o Whisper Base multilíngue em `/opt/whatsia/models/ggml-base.bin`. Todos os espaços usam os mesmos pesos em modo somente leitura. Cada espaço converte e transcreve seus próprios áudios em português. Um caminho individual válido permite usar outro modelo.

Novas contas WhatsApp na VPS começam no modo híbrido, com análise automática em nuvem. A descrição de fotos utiliza o modelo de visão efetivo da conta ou, quando o campo está vazio, o modelo de análise automática. Configure a chave em **Administração → IA compartilhada** para habilitar o provedor para todos os espaços. As descrições e transcrições são salvas na mensagem dentro do próprio espaço. O usuário pode mudar o modo por conta e pausar a análise.

Os volumes persistentes montam em `/persist`. O código é somente leitura, o trabalhador roda sem privilégios de root e cada usuário tem uma rede Docker própria. As rotinas disponíveis são as já cadastradas pelo aplicativo. Administração SSH continua tendo acesso aos arquivos do servidor.

## Migração da instalação atual

Escolha uma janela para parar o WhatsIA do Mac. Conclua o primeiro login no servidor e aguarde o provisionamento. Para copiar os diretórios locais de dados, histórico e perfis ao usuário inicial, execute no Mac:

```sh
bash deploy/migrate-mac.sh
```

O script solicita confirmação e transfere os dados por SSH. O importador valida o estado recebido, recusa um destino que já contenha mensagens ou contas e preserva os diretórios anteriores em `before-import-*`. O espaço permanece pausado se a troca dos diretórios for interrompida. O operador deve conferir esses diretórios antes de liberá-lo. Valide as conexões depois de uma migração entre macOS e Linux. Mantenha o WhatsIA do Mac encerrado enquanto os mesmos perfis estiverem ativos no servidor.

## Operação

- Verifique serviços e renovação com `systemctl list-timers 'whatsia-*'`. Consulte os resultados de cada espaço em `/var/lib/whatsia/runtime/ID.json` por SSH.
- Para pausar um espaço entre atualizações, crie o arquivo vazio `/var/lib/whatsia/paused/ID` e rode `systemctl start whatsia-users.service`. Para retomá-lo, retire esse arquivo e rode o serviço novamente.
- Faça backup do banco, dos discos individuais e das configurações com a aplicação em repouso ou use um snapshot consistente dos volumes. A chave compartilhada e os perfis de autenticação fazem parte do backup confidencial.
- Para validar uma imagem com perfis de teste desconectados da internet, rode `bash deploy/smoke.sh NOME_DA_IMAGEM`. A verificação abre o Chromium em dois espaços independentes e recria um deles.
