# LinkBox

Aplicação em JavaScript com interface em português, compatível com Cloudflare Workers e com execução Node.js no Render.

## Recursos atuais

- Extrator de endereços públicos: procura URLs de mídia expostas no HTML e identifica URLs que já apontam para arquivos.
- Links curtos de download: a rota de upload usa Cloudflare R2 quando o binding `FILES` estiver configurado.
- Interface responsiva azul/roxa.

## Deploy no Render

Este repositório inclui um adaptador Node.js (`server.mjs`) que executa o mesmo handler e serve os arquivos de `public/`.

- Runtime: Node.js
- Build command: `npm install --omit=dev`
- Start command: `npm start`
- Health check: `/api/health`

O serviço no Render pode usar as rotas `/api/health` e `/api/extract`. O armazenamento R2 não é criado automaticamente no Render; sem o binding `FILES`, uploads e links curtos retornam uma mensagem informando que o armazenamento não está configurado.

## Deploy no Cloudflare Workers

1. Conecte este repositório em Workers & Pages.
2. Deixe o Build command vazio e use `npx wrangler deploy` como Deploy command.
3. Configure o bucket R2 e o segredo `UPLOAD_KEY` separadamente se quiser habilitar uploads.

## Ativar uploads no Cloudflare

1. Crie um bucket R2 chamado `linkbox-files`.
2. Adicione ao `wrangler.jsonc`:

```json
"r2_buckets": [
  {
    "binding": "FILES",
    "bucket_name": "linkbox-files"
  }
]
```

3. Em Worker > Settings > Variables and Secrets, crie o segredo `UPLOAD_KEY` com uma senha forte. Não coloque essa senha no GitHub.
4. Faça um novo deploy.

O formulário de upload pede essa chave. Os links de download são públicos para qualquer pessoa que tenha o endereço.

## Limites e segurança

- Limite da aplicação: 95 MB por arquivo.
- O extrator só consulta URLs HTTP/HTTPS públicas e não tenta contornar login, CAPTCHA, bloqueio antibot ou conteúdo protegido.
- O extrator depende do que o site expõe no HTML; páginas com mídia carregada somente por JavaScript podem não funcionar.
- Não compartilhe a chave `UPLOAD_KEY`. Arquivos enviados geram links públicos.
- O R2 pode exigir habilitação de cobrança e tem franquias/limites próprios. Confira a tela de cobrança e peça autorização do responsável antes de ativar qualquer serviço que solicite forma de pagamento.

## Testes

- `GET /api/health`
- `POST /api/extract` com JSON: `{"url":"https://example.com"}`
