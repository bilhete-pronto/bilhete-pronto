/**
 * Netlify Function: switchy-analytics
 * ------------------------------------------------------------------
 * Busca as estatísticas (clicks, usuários, referrers, dispositivos, países/cidades)
 * de um link já criado na Switchy, usando a API GraphQL deles:
 *   POST https://graphql.switchy.io/v1/graphql
 *
 * COMO INSTALAR:
 *   1) Salve este arquivo dentro do MESMO projeto Netlify que já hospeda as outras
 *      functions (shorten, switchy-shorten), no caminho:
 *          netlify/functions/switchy-analytics.js
 *   2) Faça o deploy (git push, ou "Trigger deploy" manual no painel).
 *   3) A function passa a responder em:
 *          https://bilhete-pronto.netlify.app/.netlify/functions/switchy-analytics
 *
 * CONTRATO (para casar com o front-end já existente):
 *   Requisição (POST, JSON): { "domain": "hi.switchy.io", "slug": "RMComunidadeTR" }
 *   Resposta de sucesso (200):
 *     {
 *       "clicks": 131, "users": 115,
 *       "dailyClicks": [{ "date": "2026-07-22", "clicks": 3 }, ...],
 *       "countries": [{ "country": "Brazil", "visits": 121, "unique": 105, "percentVisits": 92 }, ...],
 *       "cities":    [{ "city": "São Paulo", "visits": 15, "unique": 1, "percentVisits": 11 }, ...],
 *       "referrers": [{ "referrer": "instagram.com", "visits": 118, "unique": 106, "percentVisits": 90 }, ...],
 *       "devices":   [{ "device": "Phone", "visits": 126, "unique": 111, "percentVisits": 96 }, ...]
 *     }
 *   Resposta de erro: { "error": "mensagem", "raw"/"graphqlErrors": {...} }
 *
 * ⚠️ MUITO IMPORTANTE — ISSO É UM PALPITE, PRECISA SER VALIDADO:
 * A Switchy documenta publicamente o formato da API de CRIAR/ATUALIZAR link (REST),
 * mas NÃO publica um exemplo completo do schema de consulta (GraphQL) para analytics.
 * O que sabemos com certeza:
 *   - o endpoint é https://graphql.switchy.io/v1/graphql
 *   - autenticação via header "Api-Authorization"
 *   - o schema é introspectável (query { __schema { types { name fields { name } } } })
 * A query abaixo (QUERY_STATS) é uma tentativa razoável baseada no que o painel deles
 * mostra (clicks, users, referrers, devices, countries, cities). Se a Switchy usar
 * nomes de campo diferentes, essa function vai falhar — e quando isso acontecer, ela
 * automaticamente faz uma introspecção do tipo "Link" e devolve os nomes de campos
 * REAIS no campo "schemaHint" da resposta de erro, pra eu conseguir corrigir a query
 * certeira na próxima tentativa, sem precisar de tentativa-e-erro manual no GraphiQL.
 */

const SWITCHY_API_KEY_FALLBACK = 'f23a7edb-0a63-4390-95e8-900ccedfeab6';
const GRAPHQL_ENDPOINT = 'https://graphql.switchy.io/v1/graphql';

const QUERY_STATS = `
  query LinkStats($domain: String!, $slug: String!) {
    link(domain: $domain, id: $slug) {
      id
      url
      stats {
        clicks
        uniqueVisitors
        dailyClicks { date clicks }
        countries { country visits unique percentVisits }
        cities { city visits unique percentVisits }
        referers { referer visits unique percentVisits }
        devices { device visits unique percentVisits }
      }
    }
  }
`;

const INTROSPECT_QUERY = `
  query IntrospectRoot {
    __schema {
      queryType {
        name
        fields {
          name
          args { name type { name kind ofType { name kind } } }
          type { name kind ofType { name kind ofType { name kind } } }
        }
      }
    }
  }
`;

async function callGraphQL(apiKey, query, variables) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Authorization': apiKey },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data: data };
}

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

  const domain = (body.domain || '').trim();
  const slug   = (body.slug || '').trim();
  if (!domain || !slug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Campos "domain" e "slug" são obrigatórios' }) };
  }

  const apiKey = process.env.SWITCHY_API_KEY || SWITCHY_API_KEY_FALLBACK;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Nenhuma API Key da Switchy configurada' }) };
  }

  try {
    const result = await callGraphQL(apiKey, QUERY_STATS, { domain: domain, slug: slug });

    if (!result.ok || !result.data || result.data.errors) {
      /* Query principal falhou — faz introspecção automática pra descobrir os nomes
         de campo corretos e devolve isso junto do erro, pra facilitar o ajuste. */
      let schemaHint = null;
      try {
        const introspect = await callGraphQL(apiKey, INTROSPECT_QUERY, {});
        schemaHint = introspect.data;
      } catch (e) { /* noop */ }
      return {
        statusCode: result.status || 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'A consulta de estatísticas falhou (schema pode ter nomes de campo diferentes)',
          graphqlErrors: result.data && result.data.errors,
          schemaHint: schemaHint
        })
      };
    }

    const link = result.data.data && result.data.data.link;
    if (!link || !link.stats) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Link não encontrado ou sem estatísticas ainda', raw: result.data }) };
    }

    const stats = link.stats;
    const out = {
      clicks: stats.clicks || 0,
      users: stats.uniqueVisitors || 0,
      dailyClicks: (stats.dailyClicks || []).map(function (d) { return { date: d.date, clicks: d.clicks }; }),
      countries: (stats.countries || []).map(function (c) { return { country: c.country, visits: c.visits, unique: c.unique, percentVisits: c.percentVisits }; }),
      cities: (stats.cities || []).map(function (c) { return { city: c.city, visits: c.visits, unique: c.unique, percentVisits: c.percentVisits }; }),
      referrers: (stats.referers || []).map(function (r) { return { referrer: r.referer, visits: r.visits, unique: r.unique, percentVisits: r.percentVisits }; }),
      devices: (stats.devices || []).map(function (d) { return { device: d.device, visits: d.visits, unique: d.unique, percentVisits: d.percentVisits }; })
    };

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
