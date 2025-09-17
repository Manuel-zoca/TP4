// handlers/compra2Handler.js
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'compras.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({}), 'utf8');
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getDataHoje() {
  const hoje = new Date();
  return hoje.toISOString().slice(0, 10);
}

async function handleCompra2(sock, msg) {
  const from = msg.key.remoteJid;
  const messageText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();

  if (!messageText.startsWith('.compra')) return;

  try {
    const partes = messageText.split(' ');
    if (partes.length < 2) {
      return await sock.sendMessage(from, { text: '❌ Use: .compra quantidade\nExemplo: .compra 2048' });
    }
    const quantidadeMB = parseInt(partes[1], 10);
    if (isNaN(quantidadeMB) || quantidadeMB <= 0) {
      return await sock.sendMessage(from, { text: '❌ Quantidade inválida.' });
    }

    // ✅ Pega o número da pessoa da mensagem respondida (OBRIGATÓRIO responder à mensagem!)
    const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.participant;

    if (!quotedMessage || !mentionedJid) {
      return await sock.sendMessage(from, { text: '❌ Você precisa *responder* à mensagem do comprador para registrar a compra!' });
    }

    let db = loadDB();
    const dataHoje = getDataHoje();

    if (!db[dataHoje]) db[dataHoje] = {};
    if (!db[dataHoje][mentionedJid]) db[dataHoje][mentionedJid] = { total: 0, compras: 0 };

    db[dataHoje][mentionedJid].total += quantidadeMB;
    db[dataHoje][mentionedJid].compras += 1;

    saveDB(db);

    const ranking = Object.entries(db[dataHoje])
      .sort((a, b) => b[1].total - a[1].total)
      .map(([numero, data]) => ({ numero, total: data.total }));

    const posicao = ranking.findIndex(item => item.numero === mentionedJid) + 1;
    const maiorComprador = ranking[0];

    const numeroFormatado = mentionedJid.replace('@s.whatsapp.net', '');

    let mensagem = `🎉 Parabéns @${numeroFormatado}!\n\n`;
    mensagem += `📅 Esta é sua compra nº *${db[dataHoje][mentionedJid].compras}* hoje.\n`;
    mensagem += `💾 Você comprou *${quantidadeMB}MB* agora.\n`;
    mensagem += `📊 Total acumulado hoje: *${db[dataHoje][mentionedJid].total}MB*.\n`;
    mensagem += `🏅 Você está no *#${posicao}º lugar* entre os compradores hoje.\n\n`;

    if (posicao === 1) {
      mensagem += `👑 Você é o maior comprador do dia! Continue para ganhar bônus!`;
    } else {
      mensagem += `🥇 O maior comprador tem *${maiorComprador.total}MB*. Lute para ultrapassá-lo e ganhar bônus!`;
    }

    await sock.sendMessage(from, {
      text: mensagem,
      mentions: [mentionedJid],
    });

  } catch (error) {
    console.error('❌ Erro no handleCompra2:', error);
    await sock.sendMessage(from, { text: '❌ Erro ao processar sua compra.' });
  }
}

module.exports = { handleCompra2 };
