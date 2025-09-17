const { Boom } = require("@hapi/boom");

// Palavras-chave para identificar concorrentes na biografia
const keywords = ["megas", "internet", "net", "gigas", "mb", "mbs", "fornecedor"];

// Palavras-chave para identificar no NOME (remoção instantânea)
const nameKeywords = ["net", "internet"];

// Cache para armazenar tentativas recentes de leitura de biografia
const bioCheckCache = new Map(); // { jid => { timeoutId, attempt, groupId, sock } }

/**
 * Função para lidar com o evento de entrada de membros no grupo
 * @param {Object} sock - Instância do socket WA
 * @param {Object} update - Atualização do grupo (evento)
 */
async function handleGroupParticipantsUpdate(sock, update) {
    try {
        if (update.action === 'add' && update.participants?.length > 0) {
            const groupId = update.id;
            const addedParticipants = update.participants;

            console.log(`👥 Novo(s) participante(s) adicionado(s) ao grupo ${groupId}`);
            console.log(`📌 Participantes envolvidos: ${addedParticipants.join(', ')}`);

            for (const participantJid of addedParticipants) {
                // Pula se for o próprio bot
                const botJid = sock.authState.creds.me.jid;
                if (participantJid === botJid) continue;

                // Obter nome do participante
                let participantName = '';
                try {
                    const groupMeta = await sock.groupMetadata(groupId);
                    const participantInfo = groupMeta.participants.find(p => p.id === participantJid);
                    participantName = participantInfo?.pushName || '';
                } catch (metaError) {
                    console.error(`❌ Erro ao obter metadados do grupo para ${participantJid}:`, metaError.message);
                }

                console.log(`🔍 Nome do participante ${participantJid}: "${participantName}"`);

                if (containsKeywords(participantName, nameKeywords)) {
                    console.log(`🚨 Nome suspeito detectado: "${participantName}" para ${participantJid}. Removendo...`);
                    await sock.groupParticipantsUpdate(groupId, [participantJid], "remove");
                    await sock.sendMessage(groupId, {
                        text: `🚫 *Removido Instantaneamente!* 👤 +${participantJid.split('@')[0]}\n\n🤖`,
                    });
                    continue;
                }

                // Iniciar verificação contínua da biografia
                startBackgroundBioCheck(sock, groupId, participantJid);
            }
        }

    } catch (error) {
        console.error("❌ Erro ao processar entrada de participantes:", error.message || error.stack || error);
    }
}

/**
 * Inicia verificação contínua da biografia em background
 */
function startBackgroundBioCheck(sock, groupId, participantJid) {
    const checkInterval = 10_000; // A cada 10 segundos
    const maxAttempts = 30; // ~5 minutos (30 * 10s)

    let attempt = 1;

    // Cancelar verificações anteriores, se houver
    if (bioCheckCache.has(participantJid)) {
        clearTimeout(bioCheckCache.get(participantJid).timeoutId);
    }

    const intervalId = setInterval(async () => {
        console.log(`🔄 Tentando ler biografia do ${participantJid} (tentativa ${attempt})`);

        const userStatus = await getUserStatusWithRetry(sock, participantJid, 1);

        if (userStatus) {
            console.log(`📄 Biografia real do usuário ${participantJid}: "${userStatus}"`);

            if (containsKeywords(userStatus, keywords)) {
                console.log(`🚨 Concorrente detectado pela biografia: ${participantJid}. Removendo...`);
                await sock.groupParticipantsUpdate(groupId, [participantJid], "remove");
                await sock.sendMessage(groupId, {
                    text: `🚫 *Concorrente Removido!* 👤 +${participantJid.split('@')[0]}\n\n🤖`,
                });
            }

            clearInterval(intervalId);
            bioCheckCache.delete(participantJid);
            return;
        }

        if (attempt >= maxAttempts) {
            console.log(`🔚 Limite de tentativas alcançado para ${participantJid}. Parando verificação.`);
            clearInterval(intervalId);
            bioCheckCache.delete(participantJid);
        }

        attempt++;
    }, checkInterval);

    bioCheckCache.set(participantJid, { intervalId });
}

/**
 * Função para obter a biografia/status de um usuário com retry
 */
async function getUserStatusWithRetry(sock, userJid, retries = 2, delayMs = 2000) {
    let attempt = 0;
    while (attempt < retries) {
        try {
            const status = await sock.fetchStatus(userJid);
            if (status?.status) {
                return status.status.trim();
            } else {
                console.log(`🟡 Status vazio na tentativa ${attempt + 1} para ${userJid}`);
            }
        } catch (err) {
            if (err instanceof Boom && err.output.statusCode === 404) {
                console.warn(`⚠️ Biografia não encontrada (404) para ${userJid}. Privacidade?`);
            } else {
                console.error(`❌ Erro inesperado ao buscar status de ${userJid}:`, err.message);
            }
        }

        attempt++;
        if (attempt < retries) {
            await new Promise(res => setTimeout(res, delayMs));
        }
    }

    return null;
}

/**
 * Verifica se uma string contém alguma palavra-chave
 */
function containsKeywords(text, keywords) {
    if (!text) return false;
    const lowerText = text.toLowerCase().trim();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

module.exports = { handleGroupParticipantsUpdate };