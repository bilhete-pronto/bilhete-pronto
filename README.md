# Bilhete Pronto — encurtador com códigos curtos

Este projeto gera links camuflados com códigos curtos de verdade (ex.:
`bilhete-pronto.netlify.app/a3f9k2`), guardando a correspondência
[código → link real] no **Netlify Blobs** (banco de dados key-value da própria
Netlify).

Isso só funciona publicando via **GitHub** (não com "arrastar pasta/zip"),
porque a Netlify precisa instalar o pacote `@netlify/blobs` automaticamente
antes do deploy — e isso só acontece quando o site está conectado a um
repositório Git.

## Como publicar

1. Crie um repositório novo no GitHub (github.com → botão "New").
2. No repositório vazio, clique em **"uploading an existing file"** e arraste
   TODOS os arquivos e pastas deste projeto (mantendo a estrutura de pastas:
   `netlify/functions/...`, `package.json`, `netlify.toml`, `index.html`).
3. Clique em **"Commit changes"**.
4. No painel da Netlify, entre no site **bilhete-pronto** (o mesmo que já
   existe) → **Site configuration** → **Build & deploy** → procure a opção de
   **"Link repository"** (ou "Link site to Git") e escolha o repositório que
   você acabou de criar.
5. A Netlify vai rodar um novo deploy automaticamente — dessa vez instalando o
   `@netlify/blobs` sozinha, e a função vai funcionar com códigos curtos de
   verdade.

## Estrutura

```
index.html
package.json                    ← lista a dependência @netlify/blobs
netlify.toml                    ← configura a pasta de functions e o redirecionamento
netlify/functions/shorten.js    ← gera o código curto e guarda no Blobs
netlify/functions/redirect.js   ← busca o código no Blobs e redireciona
```
