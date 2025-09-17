const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Buffer } = require('buffer');
const Tesseract = require('tesseract.js');

const pagamentosConfirmados = new Map();
const mensagensProcessadas = new Set();

function marcarPagamentoConfirmadoTemporariamente(remetente, tempoEmMs = 5 * 60 * 1000) {
  pagamentosConfirmados.set(remetente, true);
  setTimeout(() => {
    pagamentosConfirmados.delete(remetente);
    console.log(`⌛ Tempo expirado para ${remetente}`);
  }, tempoEmMs);
}

function detectarTipoPagamento(texto, numero) {
  const textoLower = texto.toLowerCase();
  if (
    (textoLower.includes("confirmado") && textoLower.includes("transferiste") && textoLower.includes("m-pesa")) ||
    textoLower.includes("dinis") || 
    textoLower.includes("continua a transferir") || 
    textoLower.includes("m-pesa")
  ) {
    return "M-Pesa";
  }
  if (
    (textoLower.includes("id da transacao") && textoLower.includes("transferiste") && textoLower.includes("e-mola")) ||
    textoLower.includes("manuel zoca") || 
    textoLower.includes("obrigado!") || 
    textoLower.includes("e-mola")
  ) {
    return "E-Mola";
  }

  const prefixo = numero.slice(0, 2);
  if (["84", "85"].includes(prefixo)) return "M-Pesa";
  if (["86", "87"].includes(prefixo)) return "E-Mola";
  return "Desconhecido";
}

function extrairNumeroLocal(text) {
  const textoSemEspacos = text.replace(/[\s\-\.]/g, '');
  const match = textoSemEspacos.match(/(?:\+?258)?(8\d{8})/);
  return match ? match[1] : null;
}

exports.handleMensagemPix = async (sock, msg) => {
  try {
    const from = msg.key.remoteJid;
    const messageId = msg.key.id;
    const remetente = msg.participant || msg.key.participant || msg.key.remoteJid;
    const numeroFormatado = remetente.replace(/[@:\s].*/g, "");
    const chaveUnica = `${from}:${remetente}:${messageId}`;

    // Ignora mensagens já processadas
    if (mensagensProcessadas.has(chaveUnica)) return;
    mensagensProcessadas.add(chaveUnica);

    // Se for o próprio bot, ignora
    const botJid = sock.user?.id || sock.authState.creds?.me?.id;
    if (remetente === botJid) {
      mensagensProcessadas.delete(chaveUnica);
      return;
    }

    // Grupos permitidos
    const gruposPermitidos = [
      "120363401150279870@g.us",
      "120363252308434038@g.us",
      "120363417514741662@g.us"
    ];

    if (!gruposPermitidos.includes(from)) {
      mensagensProcessadas.delete(chaveUnica);
      return;
    }

    let messageText = '';
    let isImageMessage = false;
    let quotedMessage = {};

    if (msg.message?.imageMessage) {
      isImageMessage = true;

      // Baixa imagem e faz OCR
      const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
      let buffer = Buffer.alloc(0);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      const { data: { text } } = await Tesseract.recognize(buffer, 'por', {
        logger: m => console.log(m)
      });

      messageText = text.replace(/[\u200e\u200f\u2068\u2069]/g, '').trim();
      quotedMessage = { imageMessage: msg.message.imageMessage };

    } else {
      messageText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      quotedMessage = {
        conversation: messageText
      };
    }

    const textoLower = messageText.toLowerCase().replace(/\s+/g, ' ').trim();

    // Palavras-chave para identificar comprovativo
    const operadoras = ['mpesa', 'emola', 'transferência'];
    const temOperadora = operadoras.some(op => textoLower.includes(op));

    const regexValor = /transferiste\s+([\d.,]+)\s*mt/i.test(textoLower);
    const regexID = /\b([A-Z]{2,3}[0-9A-Z.\-]{6,15})\b/.test(textoLower);

    const regexNumeroDestino = /(8\d{8})/;
    const numeroEncontrado = textoLower.match(regexNumeroDestino);
    const numeroOCR = numeroEncontrado ? numeroEncontrado[0] : null;

    const numerosValidos = ['872960710', '848619531'];

    // Verifica se é realmente um comprovativo válido
    if (!(temOperadora || regexValor || regexID || numerosValidos.includes(numeroOCR))) {
      console.log("📷 Mensagem ignorada - não parece ser um comprovativo válido.");
      mensagensProcessadas.delete(chaveUnica);
      return;
    }

    // Valida número no texto
    const todosNumeros = [...textoLower.matchAll(/(?:\+?258)?(8\d{8})/g)].map(match => match[1]);
    const contemNumeroValido = todosNumeros.some(n => numerosValidos.includes(n));

    if (!contemNumeroValido) {
      await sock.sendMessage(from, {
        react: { text: "❌", key: msg.key }
      });

      await new Promise(resolve => setTimeout(resolve, 20000));

      await sock.sendMessage(from, {
        text: `🚫 *Comprovante rejeitado!*\n\nO número para qual foi feita a transferência *é inválido*.\n\n📱 Apenas aceitamos transferências para:\n- *848619531* 📱 (Dinis Marta)\n- *872960710* 💸 (Manuel Zoca)\n\n❗️Tentativas de fraude resultarão em *banimento imediato*!`,
        contextInfo: {
          quotedMessage,
          participant: remetente
        }
      });

      console.log(`🚫 Rejeitado: comprovativo enviado para número inválido:`, todosNumeros);
      return;
    }

    // ✅ Reage com check
    await sock.sendMessage(from, {
      react: {
        text: "✅",
        key: { remoteJid: from, participant: remetente, id: messageId }
      }
    });
    console.log(`✅ Reagiu à mensagem ${isImageMessage ? 'de imagem' : 'de texto'} de ${numeroFormatado}`);

    const tipoPagamento = detectarTipoPagamento(messageText, numeroFormatado);

    await new Promise(resolve => setTimeout(resolve, 20000));

    // Monta resposta final
    let mensagem = `✅ *Comprovante recebido!*`;

    const valorMatch = textoLower.match(/transferiste\s+([\d.,]+)\s*mt/i);
    const valorTransferido = valorMatch ? valorMatch[1].replace(',', '.') : null;

    const idMatch = textoLower.match(/\b([A-Z]{2,3}[0-9A-Z.\-]{6,15})\b/);
    const idTransacao = idMatch ? idMatch[1] : null;

    if (valorTransferido) mensagem += `\n\n💰 Valor transferido: *${valorTransferido} MT*`;
    if (idTransacao) mensagem += `\n>ID da transação: *${idTransacao}*`;

    mensagem += `\n🔄 Enviaremos os megas em *1 minuto*... Por favor, aguarde a confirmação.`;

    await sock.sendMessage(from, {
      text: mensagem,
      mentions: [remetente],
      contextInfo: {
        quotedMessage,
        participant: remetente
      }
    });

    console.log(`📨 Confirmação enviada para ${numeroFormatado}`);
    marcarPagamentoConfirmadoTemporariamente(remetente);

  } catch (error) {
    console.error("❌ Erro ao processar mensagem PIX:", error);
    const chaveUnica = `${msg.key.remoteJid}:${msg.key.participant || msg.key.remoteJid}:${msg.key.id}`;
    mensagensProcessadas.delete(chaveUnica);
  }
};