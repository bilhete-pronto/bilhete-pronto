/**
 * Netlify Function: switchy-shorten
 * ------------------------------------------------------------------
 * Cria um link camuflado usando a API OFICIAL da Switchy:
 *   POST https://api.switchy.io/v1/links/create
 *
 * Por que essa function existe:
 *   A API da Switchy exige uma API Key (header "Api-Authorization"). Essa chave
 *   NUNCA pode ficar exposta no código do navegador (qualquer pessoa poderia
 *   ver e usar sua conta). Por isso essa chamada precisa passar por um servidor —
 *   exatamente como já funciona a function "shorten" que vocês já usam hoje.
 *
 * COMO INSTALAR:
 *   1) Salve este arquivo dentro do MESMO projeto Netlify que já hospeda a
 *      function "shorten" (o site "bilhete-pronto"), no caminho:
 *          netlify/functions/switchy-shorten.js
 *   2) A API Key já está preenchida no código (constante SWITCHY_API_KEY_FALLBACK
 *      logo abaixo) — não precisa configurar nada no painel do Netlify pra funcionar.
 *      (Opcional, mais seguro): se preferir não deixar a chave escrita no código,
 *      crie a variável de ambiente SWITCHY_API_KEY no painel (Site configuration →
 *      Environment variables) — ela tem prioridade sobre o valor fixo.
 *   3) Faça o deploy (git push, ou "Trigger deploy" manual no painel).
 *   4) A function passa a responder em:
 *          https://bilhete-pronto.netlify.app/.netlify/functions/switchy-shorten
 *
 * CONTRATO (para casar com o front-end já existente):
 *   Requisição (POST, JSON):
 *     { "url": "https://wa.me/...", "slug": "RMComunidadeTR" (opcional), "domain": "hi.switchy.io" (opcional) }
 *   Resposta de sucesso (200):
 *     { "result_url": "https://hi.switchy.io/RMComunidadeTR", "raw": {...resposta original da Switchy...} }
 *   Resposta de erro:
 *     { "error": "mensagem", "detail"/"raw": {...} }
 *
 * ATENÇÃO: a documentação pública da Switchy mostra o formato da REQUISIÇÃO,
 * mas não publica um exemplo completo do formato da RESPOSTA de criação.
 * Por isso, abaixo eu tento vários nomes de campo possíveis para achar a URL final,
 * e devolvo sempre o "raw" (resposta crua da Switchy) junto — se a Switchy usar um
 * nome de campo diferente do esperado, é só olhar o "raw" no console do navegador
 * e ajustar a linha do "resultUrl" logo abaixo.
 */

/*
 * ⚠️ CHAVE DA API — recomendo fortemente regenerar essa chave no painel da Switchy
 * depois que tudo estiver funcionando (Settings → API), já que ela foi compartilhada
 * em uma conversa de chat. Depois de gerar a nova, é só substituir o valor abaixo.
 * Se você preferir não deixar a chave escrita no código, pode em vez disso criar a
 * variável de ambiente SWITCHY_API_KEY no painel do Netlify — se ela existir, tem
 * prioridade sobre o valor fixo abaixo.
 */
const SWITCHY_API_KEY_FALLBACK = 'f23a7edb-0a63-4390-95e8-900ccedfeab6';

exports.handler = async function (event) {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'JSON inválido no corpo da requisição' }) };
  }

  const longUrl = body.url;
  const slug    = (body.slug || '').trim();
  const domain  = (body.domain || process.env.SWITCHY_DEFAULT_DOMAIN || '').trim();

  if (!longUrl) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Campo "url" é obrigatório' }) };
  }

  const apiKey = process.env.SWITCHY_API_KEY || SWITCHY_API_KEY_FALLBACK;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Nenhuma API Key da Switchy configurada (nem variável de ambiente, nem fallback no código)' })
    };
  }

  /* Monta o payload conforme a documentação da Switchy (POST /v1/links/create).
     "id" é o apelido/padrão customizado do link (ex.: RMComunidadeTR). */
  const linkPayload = { url: longUrl };
  if (domain) linkPayload.domain = domain;
  if (slug)   linkPayload.id = slug;

  try {
    const switchyRes = await fetch('https://api.switchy.io/v1/links/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Authorization': apiKey
      },
      body: JSON.stringify({ link: linkPayload })
    });

    const data = await switchyRes.json().catch(() => null);

    if (!switchyRes.ok || !data) {
      return {
        statusCode: switchyRes.status || 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'A Switchy retornou um erro ao criar o link', detail: data })
      };
    }

    const link = data.link || data;
    const resultUrl =
      link.shortUrl || link.short_url || link.fullUrl || link.full_url || link.url_short ||
      (link.domain && (link.id || link.uniqId) ? ('https://' + link.domain + '/' + (link.id || link.uniqId)) : null) ||
      (domain && slug ? ('https://' + domain + '/' + slug) : null);

    if (!resultUrl) {
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'Link criado na Switchy, mas não encontrei a URL final no formato de resposta. Veja "raw" e ajuste o parsing na function.',
          raw: data
        })
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result_url: resultUrl, raw: data })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
