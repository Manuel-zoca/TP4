const fs = require("fs");
const path = require("path");

// Caminho para o arquivo de persistência
const INFRACTIONS_FILE = path.join(__dirname, "..", "data", "infracoes.json");

// Garante que a pasta 'data' exista
const dataDir = path.dirname(INFRACTIONS_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Carrega as infrações do arquivo (ou cria uma nova se não existir)
let infracoes = {};
if (fs.existsSync(INFRACTIONS_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(INFRACTIONS_FILE, "utf-8"));
        infracoes = data || {};
    } catch (e) {
        console.error("❌ Erro ao ler arquivo de infrações. Reiniciando...");
        infracoes = {};
    }
}

// Salva as infrações no arquivo
function saveInfractions() {
    try {
        fs.writeFileSync(INFRACTIONS_FILE, JSON.stringify(infracoes, null, 2), "utf-8");
    } catch (err) {
        console.error("❌ Falha ao salvar infrações:", err.message);
    }
}

// Expressão regular para detectar links (com ou sem http(s))
const linkRegex = /(?:www\.)?\w+\.\w{2,}(?:\/[^\s]*)?/gi;

async function handleMessage(sock, msg) {
    if (!msg.message || !msg.key.remoteJid) return;

    const chatId = msg.key.remoteJid;
    const remetente = msg.key.participant || msg.key.remoteJid;
    const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
    const isGroup = chatId.endsWith("@g.us");

    // Ignora mensagens fora de grupos
    if (!isGroup) return;

    // Obtém metadados do grupo
    let groupMetadata;
    try {
        groupMetadata = await sock.groupMetadata(chatId);
    } catch (err) {
        console.error(`❌ Erro ao obter metadados do grupo ${chatId}:`, err.message);
        return;
    }

    // Verifica se é admin ou bot
    const isAdmin = groupMetadata.participants.some(p => p.id === remetente && p.admin !== null);
    const isBotMessage = msg.key.fromMe;

    if (isAdmin || isBotMessage) return;

    // Verifica se tem link
    if (!linkRegex.test(texto)) return;

    // Processa infração
    if (!infracoes[remetente]) {
        infracoes[remetente] = 1;
    } else {
        infracoes[remetente]++;
    }

    saveInfractions();

    setTimeout(async () => {
        try {
            // Verifica novamente se o usuário ainda está no grupo
            const currentMeta = await sock.groupMetadata(chatId);
            const userStillInGroup = currentMeta.participants.some(p => p.id === remetente);

            if (!userStillInGroup) {
                delete infracoes[remetente];
                saveInfractions();
                return;
            }

            // Envia aviso
            await sock.sendMessage(chatId, {
                text: `🚫 @${remetente.split("@")[0]}, links não são permitidos! (${infracoes[remetente]}/2)\nSe continuar, será removido.`,
                mentions: [remetente],
            });

            // Apaga a mensagem proibida
            if (!isBotMessage) {
                await sock.sendMessage(chatId, { delete: msg.key });
            }

            // Remove se atingir limite
            if (infracoes[remetente] >= 2) {
                await sock.groupParticipantsUpdate(chatId, [remetente], "remove");
                delete infracoes[remetente];
                saveInfractions();
            }

        } catch (error) {
            console.error("❌ Erro no timeout do anti-link:", error.message);
        }
    }, 5000);
}

module.exports = { handleMessage };