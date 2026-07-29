// Netlify Function: recebe o clique em bilhete-pronto.netlify.app/XXXX, busca o
// código no Netlify Blobs, e redireciona de verdade para o link original.

const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async function (event) {
  const parts = (event.path || '').split('/').filter(Boolean);
  let code = parts[parts.length - 1] || '';
  // Se o último pedaço for "redirect" (nome da própria function), não veio nenhum código.
  if (code === 'redirect') code = '';
  code = decodeURIComponent(code).trim();

  if (!code) {
    return { statusCode: 400, body: 'Link inválido: código ausente.' };
  }

  try {
    connectLambda(event);
    const store = getStore('links');
    const destino = await store.get(code, { type: 'text' });

    if (destino && /^https?:\/\//i.test(destino)) {
      return {
        statusCode: 302,
        headers: { Location: destino },
        body: ''
      };
    }
  } catch (err) {
    // cai no 404 abaixo
  }

  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0c0c0c;color:#fff">'
        + '<h2>Link não encontrado ou inválido</h2>'
        + '<p style="color:#999">Peça um novo link para quem te enviou.</p>'
        + '</body></html>'
  };
};
