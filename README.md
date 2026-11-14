# LinkBox

Aplicação em Cloudflare Workers com interface em português.

## Recursos

- Extrator de endereços públicos: procura URLs de mídia expostas no HTML e identifica URLs que já apontam para arquivos.
- Links curtos de download: envia arquivos para Cloudflare R2 e cria links públicos em /d/ID.
- Interface responsiva azul/roxa.

## Deploy

1. Conecte este repositório em Workers & Pages.
2. Deixe o Build command vazio e use `npx wrangler deploy` como Deploy command.
3. O primeiro deploy publica a interface e o extrator. O envio de arquivos permanece bloqueado até configurar R2 e a chave secreta.

## Ativar uploads

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
- Não compartilhe a chave UPLOAD_KEY. Arquivos enviados geram links públicos.
- O R2 pode exigir habilitação de cobrança e tem franquias/limites próprios. Confira a tela de cobrança e peça autorização do responsável antes de ativar qualquer serviço que solicite forma de pagamento.

## Teste

- `GET /api/health`
- `POST /api/extract` com JSON: `{"url":"https://example.com"}`
