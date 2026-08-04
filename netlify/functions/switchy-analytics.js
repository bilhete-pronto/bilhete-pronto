/**
 * Netlify Function: switchy-analytics
 * ------------------------------------------------------------------
 * Busca as estatísticas de um link da Switchy usando o endpoint REST real que o
 * PRÓPRIO painel deles usa (descoberto inspecionando a aba Network do navegador):
 *
 *   GET https://api.switchy.io/v1/links/getLinkStat?domain=<domain>&id=<slug>&page=<n>
 *
 * Esse endpoint devolve o LOG BRUTO de cada clique (ip, país, cidade, referrer,
 * user-agent, data) — não um resumo pronto. Por isso, essa function calcula ela
 * mesma todos os agrupamentos (países, cidades, referrers, dispositivos, cliques
 * por dia) a partir desses eventos brutos.
 *
 * ⚠️ RISCO CONHECIDO: no navegador, esse endpoint foi chamado com um token de
 * SESSÃO (login no site, formato JWT), não com a nossa API Key de integração
 * ("Api-Authorization"). Tentamos usar nossa própria API Key aqui, já que o
 * endpoint fica no mesmo host/versão (api.switchy.io/v1) que já usamos pra criar
 * e atualizar links. Se a Switchy rejeitar (401/403), a function cai automaticamente
 * para um resumo básico (só "clicks", via GraphQL) e avisa isso na resposta.
 *
 * COMO INSTALAR:
 *   Salve este arquivo em netlify/functions/switchy-analytics.js (mesmo projeto das
 *   outras functions), suba (git push / trigger deploy). Responde em:
 *     https://bilhete-pronto.netlify.app/.netlify/functions/switchy-analytics
 *
 * CONTRATO:
 *   Requisição (POST, JSON): { "domain": "hi.switchy.io", "slug": "RMComunidadeIG" }
 *   Resposta de sucesso (200):
 *     {
 *       "clicks": 131, "users": 115,
 *       "dailyClicks": [{ "date": "2026-07-22", "clicks": 3 }, ...],
 *       "countries": [{ "country": "Brasil", "visits": 121, "unique": 105, "percentVisits": 92 }, ...],
 *       "cities":    [{ "city": "São Paulo", "visits": 15, "unique": 1, "percentVisits": 11 }, ...],
 *       "referrers": [{ "referrer": "instagram.com", "visits": 118, "unique": 106, "percentVisits": 90 }, ...],
 *       "devices":   [{ "device": "Phone", "visits": 126, "unique": 111, "percentVisits": 96 }, ...],
 *       "warning": "..." (presente só se caiu no resumo básico)
 *     }
 *   Resposta de erro: { "error": "mensagem", "status", "detail" }
 */

const SWITCHY_API_KEY_FALLBACK = 'f23a7edb-0a63-4390-95e8-900ccedfeab6';
const GRAPHQL_ENDPOINT = 'https://graphql.switchy.io/v1/graphql';
const REST_STAT_ENDPOINT = 'https://api.switchy.io/v1/links/getLinkStat';

/* Fallback básico (só clicks) via GraphQL, usado apenas se o REST getLinkStat falhar. */
const QUERY_CLICKS_ONLY = `
  query LinkClicks($domain: String!, $slug: String!) {
    links(where: { domain: { _eq: $domain }, id: { _eq: $slug } }) {
      clicks
    }
  }
`;

/* Mapa de código de país (ISO-3166 alpha-2) → nome em português. Cobre os países mais
   comuns; qualquer código fora da lista aparece com o próprio código (ex.: "XX"). */
const COUNTRY_NAMES = {
  BR: 'Brasil', US: 'Estados Unidos', PT: 'Portugal', ES: 'Espanha', FR: 'França',
  DE: 'Alemanha', IT: 'Itália', GB: 'Reino Unido', UK: 'Reino Unido', NL: 'Holanda',
  EG: 'Egito', NI: 'Nicarágua', AR: 'Argentina', MX: 'México', CL: 'Chile', CO: 'Colômbia',
  PE: 'Peru', UY: 'Uruguai', PY: 'Paraguai', BO: 'Bolívia', VE: 'Venezuela', EC: 'Equador',
  CA: 'Canadá', CN: 'China', JP: 'Japão', IN: 'Índia', RU: 'Rússia', AU: 'Austrália',
  ZA: 'África do Sul', AO: 'Angola', MZ: 'Moçambique', IE: 'Irlanda', CH: 'Suíça',
  BE: 'Bélgica', SE: 'Suécia', NO: 'Noruega', DK: 'Dinamarca', PL: 'Polônia', TR: 'Turquia',
  SA: 'Arábia Saudita', AE: 'Emirados Árabes', IL: 'Israel', KR: 'Coreia do Sul'
};

function countryName(code) {
  if (!code) return 'Desconhecido';
  return COUNTRY_NAMES[code.toUpperCase()] || code;
}

/* Agrupa o referer numa "marca" reconhecível (instagram.com, facebook.com, etc.),
   ignorando subdomínios e parâmetros de rastreamento. */
function extractReferrerDomain(ref) {
  if (!ref) return 'Direto / Desconhecido';
  try {
    var host = new URL(ref).hostname.replace(/^www\./, '');
    return host;
  } catch (e) {
    return 'Direto / Desconhecido';
  }
}

/* Classifica o tipo de dispositivo a partir do user-agent (heurística simples,
   igual ao que qualquer ferramenta de analytics costuma fazer). */
function classifyDevice(ua) {
  if (!ua) return 'Desconhecido';
  var s = ua.toLowerCase();
  if (s.indexOf('ipad') !== -1 || s.indexOf('tablet') !== -1) return 'Tablet';
  if (s.indexOf('mobile') !== -1 || s.indexOf('android') !== -1 || s.indexOf('iphone') !== -1) return 'Phone';
  if (s.indexOf('windows') !== -1 || s.indexOf('macintosh') !== -1 || s.indexOf('linux') !== -1) return 'Pc';
  return 'Desconhecido';
}

/* Monta uma lista ordenada [{ <labelKey>: label, visits, unique, percentVisits }]
   a partir de um mapa { chave: { visits, ips:{ip:true} } }. */
function buildBreakdown(map, labelKey, totalClicks) {
  var list = Object.keys(map).map(function (key) {
    var entry = map[key];
    var unique = Object.keys(entry.ips).length;
    var item = {};
    item[labelKey] = entry.label != null ? entry.label : key;
    item.visits = entry.visits;
    item.unique = unique;
    item.percentVisits = totalClicks ? Math.round((entry.visits / totalClicks) * 100) : 0;
    return item;
  });
  list.sort(function (a, b) { return b.visits - a.visits; });
  return list;
}

function aggregateVisits(visits) {
  var clicks = visits.length;
  var ipSet = {};
  var countryMap = {};
  var cityMap = {};
  var refMap = {};
  var deviceMap = {};
  var dayMap = {};

  visits.forEach(function (v) {
    if (v.ip) ipSet[v.ip] = true;
    var ip = v.ip || 'sem-ip';

    var code = (v.ipLookup && v.ipLookup.country) || v.country || 'XX';
    if (!countryMap[code]) countryMap[code] = { label: countryName(code), visits: 0, ips: {} };
    countryMap[code].visits++;
    countryMap[code].ips[ip] = true;

    var city = (v.ipLookup && v.ipLookup.city) || 'Desconhecida';
    var cityKey = city + '|' + code;
    if (!cityMap[cityKey]) cityMap[cityKey] = { label: city, visits: 0, ips: {} };
    cityMap[cityKey].visits++;
    cityMap[cityKey].ips[ip] = true;

    var refDomain = extractReferrerDomain(v.ref);
    if (!refMap[refDomain]) refMap[refDomain] = { label: refDomain, visits: 0, ips: {} };
    refMap[refDomain].visits++;
    refMap[refDomain].ips[ip] = true;

    var device = classifyDevice(v.userAgent);
    if (!deviceMap[device]) deviceMap[device] = { label: device, visits: 0, ips: {} };
    deviceMap[device].visits++;
    deviceMap[device].ips[ip] = true;

    var day = (v.date || '').slice(0, 10);
    if (day) dayMap[day] = (dayMap[day] || 0) + 1;
  });

  var dailyClicks = Object.keys(dayMap).sort().map(function (day) {
    return { date: day, clicks: dayMap[day] };
  });

  return {
    clicks: clicks,
    users: Object.keys(ipSet).length,
    dailyClicks: dailyClicks,
    countries: buildBreakdown(countryMap, 'country', clicks),
    cities: buildBreakdown(cityMap, 'city', clicks),
    referrers: buildBreakdown(refMap, 'referrer', clicks),
    devices: buildBreakdown(deviceMap, 'device', clicks)
  };
}

/* Busca todas as páginas de visitas do getLinkStat (a Switchy pagina o resultado). */
async function fetchAllVisits(apiKey, domain, slug) {
  var allVisits = [];
  var total = null;
  var page = 1;
  var maxPages = 20; /* segurança: nunca busca mais que 20 páginas numa única chamada */

  while (page <= maxPages) {
    var url = REST_STAT_ENDPOINT + '?domain=' + encodeURIComponent(domain) + '&id=' + encodeURIComponent(slug) + '&page=' + page;
    var res = await fetch(url, { headers: { 'Api-Authorization': apiKey, 'Accept': 'application/json' } });
    if (!res.ok) {
      var errBody = await res.text().catch(function () { return ''; });
      var e = new Error('REST_FAILED');
      e.status = res.status;
      e.body = errBody;
      throw e;
    }
    var data = await res.json();
    allVisits = allVisits.concat(data.visits || []);
    total = data.total != null ? data.total : total;
    var totalPages = data.totalPages || 1;
    if (page >= totalPages) break;
    page++;
  }

  return { visits: allVisits, total: total };
}

async function fetchClicksOnlyViaGraphQL(apiKey, domain, slug) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Authorization': apiKey },
    body: JSON.stringify({ query: QUERY_CLICKS_ONLY, variables: { domain: domain, slug: slug } })
  });
  const data = await res.json().catch(() => null);
  const links = data && data.data && data.data.links;
  if (links && links.length) return links[0].clicks || 0;
  return 0;
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
    const { visits, total } = await fetchAllVisits(apiKey, domain, slug);
    const out = aggregateVisits(visits);
    if (total != null) out.clicks = total; /* usa o total oficial da Switchy quando disponível */

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (err) {
    /* getLinkStat falhou (provavelmente auth, já que na inspeção do navegador ele usou
       um token de sessão diferente da nossa API Key) — tenta pelo menos o total de
       clicks via GraphQL, e avisa que o detalhamento não pôde ser calculado. */
    try {
      const clicks = await fetchClicksOnlyViaGraphQL(apiKey, domain, slug);
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clicks: clicks, users: 0, dailyClicks: [], countries: [], cities: [], referrers: [], devices: [],
          warning: 'O endpoint de detalhamento (getLinkStat) recusou nossa API Key (status ' + (err.status || '?') + '). Só foi possível obter o total de clicks.'
        })
      };
    } catch (e2) {
      return {
        statusCode: err.status || 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Falha ao buscar estatísticas detalhadas (getLinkStat)', status: err.status, detail: err.body })
      };
    }
  }
};
