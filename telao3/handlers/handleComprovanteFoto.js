const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Buffer } = require('buffer');
const Tesseract = require('tesseract.js');

const grupoPermitido = [
    "120363401150279870@g.us",
    "120363252308434038@g.us",
    "120363417514741662@g.us"
];

function extrairNumeroLocal(text) {
    const textoSemEspacos = text.replace(/[\s\-\.]/g, '');
    const match = textoSemEspacos.match(/(?:\+?258)?(8\d{8})/);
    return match ? match[1] : null;
}

function pareceComprovativo(normalizedText) {
    const operadoras = ['mpesa', 'emola', 'transferência'];
    const temOperadora = operadoras.some(op => normalizedText.includes(op));

    const valorMatch = normalizedText.match(/transferiste[\s\S]*?([\d.,]+)\s*mt/i);
    const idMatch = normalizedText.match(/\b([A-Z]{2,3}[0-9A-Z.\-]{6,15})\b/);

    const numeroTransferidoOCR = extrairNumeroLocal(normalizedText);
    const numerosValidos = ['872960710', '848619531'];

    const temDadosValidos = temOperadora || valorMatch || idMatch || numeroTransferidoOCR;
    if (!temDadosValidos) return false;

    if (numeroTransferidoOCR && !numerosValidos.includes(numeroTransferidoOCR)) return false;

    return true;
}

exports.handleComprovanteFoto = async (sock, msg) => {
    try {
        const from = msg.key.remoteJid;

        if (!grupoPermitido.includes(from)) {
            console.log(`📷 Mensagem ignorada - grupo não autorizado: ${from}`);
            return false;
        }

        if (!msg.message?.imageMessage) return false;

        const legenda = msg.message.imageMessage.caption || '';
        const cleanLegenda = legenda.replace(/[\u200e\u200f\u2068\u2069]/g, '').trim();

        const numeroCompleto = extrairNumeroLocal(cleanLegenda);
        const prefixo = numeroCompleto ? numeroCompleto.substring(0, 2) : null;

        if (numeroCompleto && prefixo !== "84" && prefixo !== "85") {
            await sock.sendMessage(from, {
                react: { text: "❌", key: msg.key }
            });

            await sock.sendMessage(from, {
                text: `🤖 Número *${numeroCompleto}* inválido.\n\n🚫 Apenas números da *Vodacom (84/85)* são aceitos no comprovante.`,
            });

            return true;
        }

        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
        let buffer = Buffer.alloc(0);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const { data: { text } } = await Tesseract.recognize(buffer, 'por', {
            logger: m => console.log(m)
        });

        const normalizedText = text
            .replace(/-\s*\n\s*/g, '')
            .replace(/[\u200e\u200f\u2068\u2069]/g, '')
            .toLowerCase()
            .trim();

        console.log('📄 Texto extraído via OCR (normalizado):', normalizedText);

        if (!pareceComprovativo(normalizedText)) {
            console.log("📷 Foto ignorada - não parece ser um comprovativo válido.");
            return false;
        }

        const valorMatch = normalizedText.match(/transferiste[\s\S]*?([\d.,]+)\s*mt/i);
        const idMatch = normalizedText.match(/\b([A-Z]{2,3}[0-9A-Z.\-]{6,15})\b/);

        let numeroTransferido = extrairNumeroLocal(normalizedText);
        const numerosValidos = ['872960710', '848619531'];

        if (!numeroTransferido) {
            const trechoNumeroTransferidoMatch = normalizedText.match(/(?:transferido para|para o número)\s*([\d\s\+\-\.]+)/i);
            if (trechoNumeroTransferidoMatch) {
                numeroTransferido = extrairNumeroLocal(trechoNumeroTransferidoMatch[1]);
            }
        }

        if (!numeroTransferido) {
            await sock.sendMessage(from, {
                react: { text: "❌", key: msg.key }
            });

            await new Promise(resolve => setTimeout(resolve, 20000));

            await sock.sendMessage(from, {
                text: '🚫 Não foi possível detectar o número de destino válido no comprovante. Por favor, envie um comprovante válido.',
                contextInfo: {
                    quotedMessage: { imageMessage: msg.message.imageMessage },
                    participant: msg.key.participant || msg.key.remoteJid
                }
            });

            return true;
        }

        if (!numerosValidos.includes(numeroTransferido)) {
            await sock.sendMessage(from, {
                react: { text: "❌", key: msg.key }
            });

            await new Promise(resolve => setTimeout(resolve, 20000));

            await sock.sendMessage(from, {
                text: `🚫 *Comprovante rejeitado!*\n\nO número para qual foi transferido o valor é *inválido*.\n\n📱 *Números aceitos para transferência:*\n\n1. 📲 *872960710* - *Manuel Zoca*\n2. 📲 *848619531* - *Dinis Marta*\n\n🔒 *Aviso:* Qualquer tentativa de envio de comprovativos falsos pode resultar em *banimento imediato!*`,
                contextInfo: {
                    quotedMessage: { imageMessage: msg.message.imageMessage },
                    participant: msg.key.participant || msg.key.remoteJid
                }
            });

            return true;
        }

        await sock.sendMessage(from, {
            react: { text: "✅", key: msg.key }
        });

        await new Promise(resolve => setTimeout(resolve, 20000));

        let mensagem = `✅ Comprovante recebido`;
        if (numeroCompleto) {
            mensagem += `\n\npara o número: *${numeroCompleto}*.`;
        } else {
            mensagem += `.\n\nPor favor, envie o número para qual deseja receber os megas.`;
        }

        if (valorMatch) mensagem += `\n💰 Valor transferido: *${valorMatch[1]} MT*`;
        if (idMatch) mensagem += `\n🆔 ID da transação: *${idMatch[1]}*`;

        mensagem += `\n🔄 Enviaremos os megas em 1min... Por favor, aguarde a confirmação.`;

        await sock.sendMessage(from, {
            text: mensagem,
            contextInfo: {
                quotedMessage: { imageMessage: msg.message.imageMessage },
                participant: msg.key.participant || msg.key.remoteJid
            }
        });

        if (!numeroCompleto) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            await sock.sendMessage(from, {
                text: '📲 Por favor, envie o número para qual deseja receber os megas.',
                contextInfo: {
                    quotedMessage: { imageMessage: msg.message.imageMessage },
                    participant: msg.key.participant || msg.key.remoteJid
                }
            });
        }

        console.log(`📷 Comprovante detectado para ${numeroCompleto || 'número não informado'} - Valor: ${valorMatch ? valorMatch[1] : 'não detectado'} - ID: ${idMatch ? idMatch[1] : 'não detectado'}`);
        return true;

    } catch (error) {
        console.error('❌ Erro em handleComprovanteFoto:', error);
        return false;
    }
};
