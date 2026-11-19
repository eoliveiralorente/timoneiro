# ☸ Timoneiro — Lab Kubernetes da mentoria

Jogo para aprender Kubernetes, com contas de aluno, progresso salvo no servidor, consentimento de marketing conforme a LGPD e painel do mentor.

- **Sem dependências:** Node 22 puro, com SQLite embutido. Não precisa de `npm install`.
- **Uma imagem, um volume:** roda no seu k3s com 1 réplica e um PVC de 1 Gi.

## O que tem

| Rota | Para quê |
|---|---|
| `/` | O jogo (cadastro, login, modo convidado) |
| `/privacidade` | Termos e Política de Privacidade (**modelo: preencha e revise com um advogado**) |
| `/admin` | Painel do mentor (pede o `ADMIN_TOKEN`) |
| `/api/unsubscribe?k=…` | Link de descadastro de cada aluno (vai no CSV de leads) |
| `/healthz` | Health check |

**Aluno:** cria conta com o aceite obrigatório dos termos e um aceite **opcional e desmarcado** de ofertas. Pode mudar o aceite, baixar seus dados, trocar a senha e excluir a conta em *Carreira → Sua conta*. Quem joga como convidado não envia nada ao servidor; o progresso fica só no aparelho e é levado junto quando ele cria a conta.

**Mentor:** vê alunos ativos, em risco (5+ dias parados), engajados e quem completou a rota. Exporta um CSV **só com quem aceitou ofertas**, já com o link de descadastro de cada um, e gera senha temporária para quem esqueceu a dele.

**Ofertas no jogo:** a oferta da mentoria aparece ao vencer a tempestade da Ilha 04. A oferta de camiseta aparece a cada nova patente e ao completar a rota. Elas só aparecem se `MENTORIA_URL` e `LOJA_URL` estiverem definidas.

Cada aceite fica registrado com o texto exato, a versão, a data, o IP e o navegador, em `consent_log`.

## Rodar local

```bash
APP_SECRET="$(openssl rand -base64 48)" ADMIN_TOKEN="$(openssl rand -base64 32)" node server.js
# abra http://localhost:8080
```

## Subir no k3s

1. **Gerar a imagem.** Pelo GitHub (o workflow já está pronto), crie uma tag:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0   # publica ghcr.io/eoliveiralorente/timoneiro:1.0.0
   ```
   Depois deixe o pacote público no GHCR ou crie um `imagePullSecret`. Outra opção é rodar `docker build -t ghcr.io/eoliveiralorente/timoneiro:1.0.0 . && docker push ...`.
2. **Ajustar** `k8s/10-config.yaml` (domínio, links da mentoria e da loja, e-mail) e o host em `k8s/50-ingress.yaml`.
3. **Criar o namespace e o Secret** (fora do Git):
   ```bash
   kubectl apply -f k8s/00-namespace.yaml
   kubectl -n timoneiro create secret generic timoneiro-secrets \
     --from-literal=APP_SECRET="$(openssl rand -base64 48)" \
     --from-literal=ADMIN_TOKEN="$(openssl rand -base64 32)"
   ```
   Guarde o `ADMIN_TOKEN`: é a senha do painel do mentor.
4. **Aplicar:** `kubectl apply -k k8s/`. Se preferir GitOps, aplique `k8s/argocd-application.yaml`.
5. *(Opcional)* Backup diário: `kubectl apply -f k8s/backup-cronjob.yaml`. Copie `/data/backups` para fora do cluster.

> Use HTTPS. Com cert-manager, descomente a anotação e o bloco `tls` do Ingress.

## Antes de abrir para o público

- [ ] Preencher os campos `[entre colchetes]` de `public/privacidade.html` e revisar com um advogado.
- [ ] Remover o aviso amarelo de "modelo" da página de privacidade.
- [ ] Testar o cadastro, o descadastro e a exclusão de conta no domínio final.
- [ ] Ao importar o CSV na sua ferramenta de e-mail, colocar o `link_descadastro` no rodapé de todo e-mail promocional. Sincronize quem se descadastrar na ferramenta.

## Limites conhecidos

- Não há "esqueci minha senha" por e-mail. Por enquanto, o mentor gera uma senha temporária no painel.
- SQLite pede **1 réplica**. Para escalar horizontalmente, troque por Postgres.
- O conteúdo das lições está no front (`public/index.html`, constante `U`). Cada item tem link para a documentação oficial.
