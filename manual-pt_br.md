# Manual — Contreex (`ctx`)

Guia direto para instalar e configurar o Contreex em qualquer máquina. Para entender a arquitetura por trás, veja `docs/ARCHITECTURE.md` (em inglês); este arquivo é só o "como usar".

## O que é

Um orquestrador de linha de comando: um agente (**implementer**) analisa, planeja e — só quando você mandar explicitamente — implementa. Outros agentes atuam só como **reviewers**: dão opinião, nunca escrevem código. Hoje suporta Claude Code, Codex CLI, Antigravity CLI (`agy`) e MimoCode CLI (`mimo`) — basta ter pelo menos um instalado.

## 1. Pré-requisitos

- Node.js ≥ 20
- `git`
- Pelo menos um destes, instalado e autenticado:
  - [`claude`](https://claude.com/claude-code) — Claude Code
  - [`codex`](https://github.com/openai/codex) — Codex CLI
  - [`agy`](https://antigravity.google) — Antigravity CLI
  - [`mimo`](https://mimo.xiaomi.com) — MimoCode CLI
- (Opcional, só para `--from-clipboard`) WSL2 no Windows — usa `powershell.exe` para ler a área de transferência do Windows.

## 2. Instalação

```sh
git clone <url-do-repositorio> ~/Contreex
cd ~/Contreex
npm install
```

Exponha o comando `ctx` globalmente. Duas opções — use a que funcionar no seu ambiente:

```sh
# Opção A — se o prefixo global do npm for gravável pelo seu usuário:
npm link

# Opção B — sempre funciona, sem precisar de permissão especial:
mkdir -p ~/.local/bin
ln -s "$(pwd)/bin/contreex.mjs" ~/.local/bin/ctx
# garanta que ~/.local/bin está no PATH (adicione ao ~/.bashrc ou ~/.zshrc se precisar):
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Teste:

```sh
ctx --help
```

## 3. Configuração — as três camadas

O Contreex nunca assume um workspace padrão. A configuração é resolvida em cascata, cada camada podendo sobrescrever a anterior:

| Camada | Arquivo | Serve para |
|---|---|---|
| Global | `~/.contreex/config.yaml` | Padrão pra todo projeto: quais agentes fazem qual papel, pipeline padrão |
| Workspace | `~/.contreex/workspaces/<nome>.yaml` | Quais servidores MCP são permitidos, ajustes por ambiente (ex: casa vs. empresa) |
| Projeto | `<seu-projeto>/.contreex-profile` | Escolhe qual workspace usar; pode sobrescrever tudo acima só pra esse projeto |

### 3.1. Configuração global

Crie `~/.contreex/config.yaml`:

```yaml
roles:
  implementer: claude   # quem analisa, planeja e implementa
  reviewer1: codex       # só dá opinião, nunca escreve
  reviewer2: agy          # idem — remova esta linha se só tiver 2 agentes instalados

pipeline:
  - role: implementer
    action: analyze
  - parallel:
      - role: reviewer1
        action: review
      - role: reviewer2
        action: review
  - role: implementer
    action: refine
```

Ajuste `roles` para os agentes que você realmente tem instalados. Só precisa de `implementer` no mínimo — reviewers são opcionais, mas sem eles as revisões ficam vazias.

### 3.2. Workspace

Crie pelo menos um workspace. Para uso pessoal:

```yaml
# ~/.contreex/workspaces/home.yaml
name: home
mcp: []
```

Se você usa Contreex tanto em projetos pessoais quanto da empresa, crie um segundo workspace separado (ex: `~/.contreex/workspaces/corporate.yaml`) — isso garante que credenciais/servidores MCP da empresa nunca vazam pra um projeto pessoal por engano. Veja `docs/examples/workspace-corporate.yaml` para um exemplo completo com MCP e `capabilities`.

### 3.3. Projeto

Em cada projeto onde for usar o Contreex, crie um arquivo `.contreex-profile` na raiz (o Contreex procura esse arquivo subindo os diretórios, igual o `git` procura `.git`):

```yaml
# <seu-projeto>/.contreex-profile
profile: home
```

Sem esse arquivo, o Contreex recusa rodar — nunca assume um workspace por padrão.

Opcionalmente, dentro desse mesmo arquivo você pode:

```yaml
profile: home

# Escrever objetivos em português — os agentes trabalham internamente em
# inglês (onde rendem melhor), a resposta final volta em português:
language:
  input: pt-BR
  internal: en-US
  output: pt-BR

# Forçar um perfil de pipeline específico (ver seção 5) em vez do automático:
# pipelineProfile: critical
```

## 4. Primeiro uso

```sh
cd <seu-projeto>
ctx "Adicione uma função isPalindrome em utils.js"
```

Por padrão isso só **analisa e revisa** — nenhum arquivo é escrito. O relatório final mostra: análise, plano, veredito de cada reviewer, e o que o implementer aceitou/rejeitou do feedback.

## 5. Perfis de pipeline

Sem configurar nada, o Contreex escolhe automaticamente o quão minucioso ser, com base no que você pediu (um pedido de análise nunca vira implementação sem querer). Pra forçar um perfil específico, use `pipelineProfile: <nome>` no `.contreex-profile` — veja `docs/examples/pipelines/` para o YAML de cada um:

| Perfil | O que roda |
|---|---|
| `fast` | Só análise, sem revisão |
| `standard` | Análise + 1 revisor |
| `review` | Análise + 2 revisores + refinamento (padrão) |
| `critical` | Loop dinâmico de revisão (até 3 rodadas) até consenso — ver seção 7 |
| `enterprise` | Igual `critical`, com 3 revisores |
| `analysis-only` | Só análise + revisão, sem refinamento |
| `implement` | Usado automaticamente com `--implement` (ver seção 6) |

## 6. Implementando de verdade

Por padrão, **nada é escrito em disco**. Pra implementar de verdade, use a flag `--implement` explicitamente — nunca é inferido do texto do pedido:

```sh
ctx --implement "Adicione uma função isPalindrome em utils.js"
```

O que acontece:
- Roda `analyze → review → refine → implement`.
- O implementer escreve os arquivos numa **worktree isolada do git** (`.worktrees/<agente>-implementer/` dentro do seu projeto) — o diretório real do seu projeto nunca é tocado.
- O relatório final mostra o diff real, os arquivos alterados, e os comandos exatos pra você revisar e mesclar manualmente quando estiver satisfeito:

```sh
git -C .worktrees/claude-implementer log -p     # ver o que mudou
git merge contreex/claude-implementer            # rodar no diretório real do projeto, quando aprovar
```

O merge **nunca é automático** — é sempre um passo seu.

## 7. Loop de consenso (perfis `critical`/`enterprise`)

Nesses perfis, em vez de um número fixo de rodadas, o Contreex repete revisão → refinamento até:
1. Todos os revisores aprovarem por unanimidade (para ali, nem roda refinamento de novo), ou
2. O implementer decidir explicitamente encerrar mesmo sem unanimidade — só quando julgar que a divergência não é um problema real, sempre com justificativa registrada no relatório, ou
3. Bater o limite de rodadas (3, por padrão) — nesse caso o relatório avisa claramente que **não houve consenso** e a decisão final é sua, não do agente.

## 8. Anexando uma imagem (screenshot)

Se você quer mostrar exatamente o que está na tela (um erro, um layout quebrado):

```sh
# Windows/WSL2: tire o print (vai pra área de transferência normalmente),
# depois rode com a flag — sem precisar salvar arquivo:
ctx --from-clipboard "O que está errado nessa tela?"

# ou aponte pra um arquivo de imagem já salvo:
ctx --image ./screenshot.png "O que está errado nessa tela?"
```

Funciona de verdade com Claude Code e Codex CLI (verificado com uma imagem real). Antigravity e MimoCode ainda não têm suporte a imagem confirmado.

## 9. Onde o Contreex guarda coisas

Tudo fica em `~/.contreex/`, nunca dentro do seu projeto (exceto a worktree temporária do `--implement`):

```
~/.contreex/config.yaml           configuração global
~/.contreex/workspaces/*.yaml     workspaces (home, corporate, ...)
~/.contreex/pipelines/*.yaml      perfis de pipeline
~/.contreex/cache/                respostas em cache (15 min de validade)
~/.contreex/memory/runs.jsonl     histórico de execuções passadas
~/.contreex/knowledge-base.jsonl  lições permanentes, adicionadas manualmente
~/.contreex/attachments/          imagens anexadas via --from-clipboard
```

## 10. Problemas comuns

- **"contreex: no .contreex-profile found"** — crie o arquivo `.contreex-profile` na raiz do projeto (seção 3.3). O Contreex nunca assume um padrão.
- **`npm link` falha com erro de permissão** — use a Opção B da seção 2 (symlink em `~/.local/bin`), não precisa de `sudo`.
- **`--from-clipboard` diz que não encontrou imagem** — confirme que está numa sessão WSL2 (o comando usa `powershell.exe` pra ler a área de transferência do Windows) e que você realmente tirou um print antes de rodar o comando.
- **Um revisor nunca aparece no relatório final** — normal e por design: se um agente falhar (timeout, resposta inválida), o Contreex segue sem ele em vez de travar o pipeline inteiro. Rode de novo se quiser tentar incluí-lo.
- **Quero trocar qual agente faz qual papel** — edite `roles:` em `~/.contreex/config.yaml` (ou sobrescreva só num workspace/projeto específico) — nunca precisa mexer em código.
