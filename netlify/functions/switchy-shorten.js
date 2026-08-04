/**
 * Netlify Function: switchy-shorten
 * ------------------------------------------------------------------
 * Cria OU atualiza um link camuflado usando a API OFICIAL da Switchy:
 *   Criar:    POST https://api.switchy.io/v1/links/create
 *   Atualizar: PUT https://api.switchy.io/v1/links/by-domain/:domain/:id
 *
 * Por que "criar OU atualizar":
 *   A ideia do Gerador de Link é poder trocar o número de destino mantendo o
 *   MESMO link/padrão (ex.: hi.switchy.io/RMComunidadeTR) — assim não precisa
 *   reconfigurar o Rotator da Switchy toda vez. Só que a Switchy não deixa criar
 *   dois links com o mesmo padrão no mesmo domínio (dá erro de conflito).
 *   Por isso, quando um padrão é informado, essa function primeiro TENTA
 *   ATUALIZAR o link que já existe com esse padrão; só cria um novo se ainda
 *   não existir nenhum link com esse padrão.
 *
 * Por que essa function existe (chamada via servidor, não direto do navegador):
 *   A API da Switchy exige uma API Key (header "Api-Authorization"). Essa chave
 *   NUNCA pode ficar exposta no código do navegador. Por isso essa chamada
 *   precisa passar por um servidor — como já funciona a function "shorten".
 *
 * COMO INSTALAR:
 *   1) Salve este arquivo dentro do MESMO projeto Netlify que já hospeda a
 *      function "shorten" (o site "bilhete-pronto"), no caminho:
 *          netlify/functions/switchy-shorten.js
 *   2) A API Key já está preenchida no código (constante SWITCHY_API_KEY_FALLBACK
 *      logo abaixo) — não precisa configurar nada no painel do Netlify pra funcionar.
 *   3) Faça o deploy (git push, ou "Trigger deploy" manual no painel).
 *   4) A function passa a responder em:
 *          https://bilhete-pronto.netlify.app/.netlify/functions/switchy-shorten
 *
 * CONTRATO (para casar com o front-end já existente):
 *   Requisição (POST, JSON):
 *     { "url": "https://wa.me/...", "slug": "RMComunidadeTR" (opcional), "domain": "hi.switchy.io" (opcional) }
 *   Resposta de sucesso (200):
 *     { "result_url": "https://hi.switchy.io/RMComunidadeTR", "raw": {...} }
 *   Resposta de erro:
 *     { "error": "mensagem", "detail"/"raw": {...} }
 */

/*
 * ⚠️ CHAVE DA API — recomendo fortemente regenerar essa chave no painel da Switchy
 * depois que tudo estiver funcionando (Settings → API), já que ela foi compartilhada
 * em uma conversa de chat. Depois de gerar a nova, é só substituir o valor abaixo.
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
  /* rotator (opcional): [{ url, percentage }, ...] — distribui esse ÚNICO link entre
     vários destinos por porcentagem, usando o Rotator/A-B Testing da própria Switchy. */
  const rotator = Array.isArray(body.rotator) ? body.rotator : null;

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

  const AUTH_HEADERS = { 'Content-Type': 'application/json', 'Api-Authorization': apiKey };

  /* Monta o campo de rotator no formato que a Switchy espera (extraOptionsLinkRotator).
     ATENÇÃO: a documentação pública não mostra um exemplo completo desse formato — segui
     o mesmo padrão usado no exemplo de geolocalização deles ({ url, value }), onde "value"
     aqui é a porcentagem. Se a Switchy usar outro nome de campo, é só me avisar com o "raw"
     do erro que eu ajusto essa função (buildRotatorPayload) rapidinho. */
  function buildRotatorPayload(items) {
    return items.map(function (r) {
      return { url: r.url, value: Number(r.percentage) || 0 };
    });
  }

  function extractResultUrl(data) {
    const link = (data && (data.link || data)) || {};
    return (
      link.shortUrl || link.short_url || link.fullUrl || link.full_url || link.url_short ||
      (link.domain && (link.id || link.uniqId) ? ('https://' + link.domain + '/' + (link.id || link.uniqId)) : null) ||
      (domain && slug ? ('https://' + domain + '/' + slug) : null)
    );
  }

  try {
    let switchyRes;
    let attemptedUpdate = false;

    /* Se um padrão (slug) foi informado, tenta ATUALIZAR primeiro um link que já
       exista com esse padrão nesse domínio — assim, trocar o número não gera conflito,
       só troca o destino do mesmo link. */
    if (slug && domain) {
      attemptedUpdate = true;
      const updatePayload = { url: longUrl };
      if (rotator && rotator.length) updatePayload.extraOptionsLinkRotator = buildRotatorPayload(rotator);
      switchyRes = await fetch(
        'https://api.switchy.io/v1/links/by-domain/' + encodeURIComponent(domain) + '/' + encodeURIComponent(slug),
        {
          method: 'PUT',
          headers: AUTH_HEADERS,
          body: JSON.stringify({ link: updatePayload })
        }
      );

      /* 404 = ainda não existe nenhum link com esse padrão → cai pra criação normal abaixo. */
      if (switchyRes.status !== 404) {
        const data = await switchyRes.json().catch(() => null);
        if (!switchyRes.ok || !data) {
          return {
            statusCode: switchyRes.status || 502,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'A Switchy retornou um erro ao ATUALIZAR o link existente', detail: data })
          };
        }
        const resultUrl = extractResultUrl(data);
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ result_url: resultUrl, raw: data, action: 'updated' })
        };
      }
      /* status 404 → segue para criar um link novo */
    }

    /* Cria um link novo (primeira vez com esse padrão, ou sem padrão nenhum). */
    const linkPayload = { url: longUrl };
    if (domain) linkPayload.domain = domain;
    if (slug)   linkPayload.id = slug;
    if (rotator && rotator.length) linkPayload.extraOptionsLinkRotator = buildRotatorPayload(rotator);

    switchyRes = await fetch('https://api.switchy.io/v1/links/create', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ link: linkPayload })
    });

    const data = await switchyRes.json().catch(() => null);

    if (!switchyRes.ok || !data) {
      return {
        statusCode: switchyRes.status || 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: attemptedUpdate
            ? 'A Switchy retornou um erro ao criar o link (a atualização não encontrou um link existente, e a criação também falhou)'
            : 'A Switchy retornou um erro ao criar o link',
          detail: data
        })
      };
    }

    const resultUrl = extractResultUrl(data);
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
      body: JSON.stringify({ result_url: resultUrl, raw: data, action: 'created' })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
