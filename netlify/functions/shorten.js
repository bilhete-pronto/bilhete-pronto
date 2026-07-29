// Netlify Function: gera um código CURTO de verdade (ex.: "a3f9k2") e guarda a
// correspondência [código -> link real] no Netlify Blobs (um banquinho de dados
// key-value oferecido pela própria Netlify). Assim o link final fica bem curto,
// porque ele só carrega um índice, não o link inteiro comprimido.
//
// Isso só funciona quando o site é publicado a partir de um repositório Git (Netlify
// instala o pacote "@netlify/blobs" automaticamente antes do deploy). Não funciona
// em deploys manuais (arrastar pasta/zip), porque não há instalação de dependências.

const { getStore, setEnvironmentContext } = require('@netlify/blobs');

// Em vez de usar connectLambda() (que configura um caminho de leitura via "borda"/CDN
// e sofre com atraso de propagação — foi exatamente isso que causava o link "não
// encontrado" logo após ser criado), montamos o contexto nós mesmos, sem a URL de
// borda. Isso força todas as leituras/escritas a irem direto pro servidor central da
// Netlify, que é consistente na hora.
function connectDireto(event) {
  const raw = Buffer.from(event.blobs, 'base64').toString('utf8');
  const data = JSON.parse(raw);
  setEnvironmentContext({
    deployID: event.headers['x-nf-deploy-id'],
    siteID: event.headers['x-nf-site-id'],
    token: data.token
    // Propositalmente NÃO incluímos "edgeURL" aqui.
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Método não permitido' }) };
  }

  let url;
  try {
    const body = JSON.parse(event.body || '{}');
    url = body.url;
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'URL ausente' }) };
  }

  try {
    connectDireto(event);
    const store = getStore('links');

    // Gera um código e garante que ele ainda não está em uso (tenta algumas vezes).
    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomCode();
      const existing = await store.get(candidate, { type: 'text' });
      if (existing === null) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      // Caso extremamente improvável de colisão repetida: usa um código maior.
      code = randomCode() + randomCode().slice(0, 2);
    }

    await store.set(code, url.trim());

    const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
    const brandedUrl = host ? ('https://' + host + '/' + code) : url;

    // Confere na hora se o que acabamos de gravar já está lendo certo (debug temporário)
    let verify = null;
    try {
      verify = await store.get(code, { type: 'text' });
    } catch (e) {
      verify = 'ERRO ao verificar: ' + String(e);
    }

    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
      body: JSON.stringify({ result_url: brandedUrl, debug_code: code, debug_verify: verify })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Erro ao gerar o link camuflado', details: String(err) })
    };
  }
};
