require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");
const express = require("express");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Handlers
const { handleMessage } = require("./handlers/messageHandler");
const { handleConcorrer } = require("./handlers/concorrerHandler");
const { handleListar } = require("./handlers/listarHandler");
const { handleRemove } = require("./handlers/removeHandler");
const { handlePagamento } = require("./handlers/pagamentoHandler");
const { handleGrupo } = require("./handlers/grupoHandler");
const { handleBan } = require("./handlers/banHandler");
const { handleCompra } = require("./handlers/compraHandler");
const { handleTabela } = require("./handlers/tabelaHandler");
const { handleTodos } = require("./handlers/todosHandler");
const { handleMensagemPix } = require("./handlers/pixHandler");
const { handleComprovanteFoto } = require("./handlers/handleComprovanteFoto");
const { handleReaction } = require("./handlers/reactionHandler");
const { handleAntiLinkMessage } = require("./handlers/antiLink");
const { handleCompra2 } = require("./handlers/compra2Handler");

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = process.env.BUCKET_NAME || "whatsapp-auth";
const AUTH_FOLDER = "./auth_info_baileys";

let pendingMessages = [];
let authReady = false;
let qrSent = false;

// ===================== Funções de sincronização com Supabase =====================

async function syncAuthFromSupabase() {
  console.log("🔄 Verificando sessão salva no Supabase...");

  if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  }

  try {
    const { data, error } = await supabase.storage.from(BUCKET).list("", { limit: 100 });
    if (error) throw error;

    if (!data || data.length === 0) {
      console.log("ℹ️ Nenhuma sessão encontrada no Supabase. Será necessário escanear o QR.");
      return false;
    }

    console.log(`📥 Baixando ${data.length} arquivos de sessão...`);
    for (const file of data) {
      const { data: fileData, error: downloadErr } = await supabase.storage.from(BUCKET).download(file.name);
      if (downloadErr) throw downloadErr;
      const buffer = Buffer.from(await fileData.arrayBuffer());
      fs.writeFileSync(path.join(AUTH_FOLDER, file.name), buffer);
    }

    console.log("✅ Sessão carregada do Supabase. Não será necessário QR.");
    return true;
  } catch (err) {
    console.log("ℹ️ Nenhuma sessão válida encontrada. Será necessário escanear o QR.");
    // Limpa pasta local se corrompida
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    return false;
  }
}

async function syncAuthToSupabase() {
  if (!fs.existsSync(AUTH_FOLDER)) return;

  const files = fs.readdirSync(AUTH_FOLDER);
  console.log(`☁️ Enviando ${files.length} arquivos de sessão para o Supabase...`);

  for (const file of files) {
    try {
      const filePath = path.join(AUTH_FOLDER, file);
      const content = fs.readFileSync(filePath);
      await supabase.storage.from(BUCKET).upload(file, content, { upsert: true });
    } catch (err) {
      console.error(`❌ Erro ao enviar ${file}:`, err.message);
    }
  }
  console.log("✅ Sessão salva com sucesso no Supabase.");
}

// ===================== Bot =====================
async function iniciarBot(deviceName) {
  console.log(`🟢 Iniciando o bot no modo MULTI-DEVICE para: ${deviceName}...`);

  // 1️⃣ Tenta carregar sessão do Supabase
  const hasSession = await syncAuthFromSupabase();
  qrSent = false;

  // 2️⃣ Configura autenticação
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, saveCreds) // ✅ ESSENCIAL para evitar "No sessions"
    },
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => {
      return { conversation: "placeholder" };
    }
  });

  const processPendingMessages = async () => {
    for (const { jid, msg } of pendingMessages) {
      try {
        await sock.sendMessage(jid, msg);
      } catch (e) {
        console.error("❌ Falha ao reenviar mensagem pendente:", e.message);
      }
    }
    pendingMessages = [];
  };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !qrSent) {
      qrSent = true;
      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        console.log(`\n\n📌 QR CODE PARA CONECTAR (escaneie nos próximos 30s):\n`);
        console.log(qrBase64.split(",")[1]);
        console.log("\n");
      } catch (err) {
        console.error("❌ Erro ao gerar QR Code:", err);
      }
    }

    if (connection === "close") {
      const motivo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.error(`⚠️ Conexão fechada: ${motivo}`);

      if (motivo === DisconnectReason.loggedOut) {
        console.log("❌ Sessão inválida. Limpando e pedindo novo QR...");
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(() => iniciarBot(deviceName), 3000);
      } else {
        console.log("🔄 Reconectando...");
        setTimeout(() => iniciarBot(deviceName), 5000);
      }
    } else if (connection === "open") {
      console.log(`✅✅✅ BOT CONECTADO COM SUCESSO!`);
      console.log(`✅ Grupos antigos DEVEM funcionar normalmente.`);
      authReady = true;
      await processPendingMessages();
      await syncAuthToSupabase(); // salva sessão logo após conectar
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await syncAuthToSupabase();
  });

  // ===================== SenderKey cache & throttle =====================
  // Guarda os grupos já inicializados para não tentar sempre (evita lentidão)
  const senderReadyGroups = new Set();
  // Guarda timestamp da última tentativa por grupo (evita flood de tentativas)
  const senderAttemptAt = new Map();
  const SENDER_COOLDOWN_MS = 60 * 1000; // 60 segundos

  // 🆕 Função melhorada: tenta garantir SenderKey UMA VEZ por grupo e usa cache
  const ensureGroupReady = async (groupId) => {
    if (!groupId || !groupId.endsWith("@g.us")) return true;

    // Se já está pronto, retorna true imediatamente
    if (senderReadyGroups.has(groupId)) return true;

    // Se tentou recentemente, não tenta de novo (apenas retorna false para indicar não pronto)
    const lastAttempt = senderAttemptAt.get(groupId) || 0;
    const now = Date.now();
    if (now - lastAttempt < SENDER_COOLDOWN_MS) {
      // Evita mensagens repetidas: não enviar aviso ao usuário, só faz fallback
      return false;
    }

    senderAttemptAt.set(groupId, now);

    try {
      // Envia mensagem mínima e imediata para forçar SenderKey. Evita conteúdo grande.
      await sock.sendMessage(groupId, { text: "🔐 Inicializando grupo..." });
      // Se chegou aqui, consideramos SenderKey pronto
      senderReadyGroups.add(groupId);
      // Limpa o aviso que mandamos (opcional): tenta deletar a mensagem se a API permitir
      // (comentado para não quebrar caso não tenha id retornado)
      return true;
    } catch (err) {
      console.warn(`⚠️ Falha na inicialização do grupo ${groupId}: ${err.message}`);
      return false;
    }
  };

  // ===================== Processamento de mensagens =====================
  const processMessage = async (msg) => {
    const senderJid = msg.key.remoteJid;
    let messageText = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.text ||
      ""
    ).replace(/[\u200e\u200f\u2068\u2069]/g, "").trim();
    const lowerText = messageText.toLowerCase();

    try { await handleAntiLinkMessage(sock, msg); } catch (err) { console.error("AntiLink:", err); }

    try {
      if (msg.message?.imageMessage && senderJid.endsWith("@g.us")) await handleComprovanteFoto(sock, msg);
      await handleMensagemPix(sock, msg);

      // Se for grupo, garante SenderKey ANTES de processar comandos pesados
      if (senderJid.endsWith("@g.us")) {
        const ready = await ensureGroupReady(senderJid);
        if (!ready) {
          // fallback: processa comandos leves (texto) mesmo sem SenderKey
          // para evitar bloquear completamente. Só evita enviar mídia grande.
          console.log(`ℹ️ SenderKey não pronta para ${senderJid}. Processando comandos leves.`);
          // Se o comando exige enviar mídia grande (ex: tabela com imagens), faça fallback para texto.
          if (lowerText === "@tabela" || ['.t', '.n', '.i', '.s'].includes(lowerText)) {
            // enviar versão em texto simples (mais leve)
            try {
              await handleTabela(sock, msg, { fallbackTextOnly: true }); // handler pode aceitar flag opcional
            } catch (e) {
              // se handler não aceitar flag, chamar normalmente (tentativa)
              try { await handleTabela(sock, msg); } catch (err) { console.error("Tabela fallback erro:", err.message); }
            }
            return;
          }
          // Para outros comandos de texto, continua normalmente
        }
      }

      // Comandos (mantidos)
      if (lowerText.startsWith(".compra")) await handleCompra2(sock, msg);
      else if (lowerText === "@concorrentes") await handleListar(sock, msg);
      else if (lowerText.startsWith("@remove") || lowerText.startsWith("/remove")) await handleRemove(sock, msg);
      else if (lowerText.startsWith("@ban") || lowerText.startsWith("/ban")) await handleBan(sock, msg);
      else if (lowerText === "@pagamentos") await handlePagamento(sock, msg);
      else if (["@grupo on", "@grupo off"].includes(lowerText)) await handleGrupo(sock, msg);
      else if (lowerText.startsWith("@compra") || lowerText.startsWith("@rentanas") || lowerText.startsWith("@remove rentanas")) await handleCompra(sock, msg);
      else if (senderJid.endsWith("@g.us") && lowerText === "@concorrencia") await handleConcorrer(sock, msg);
      else if (lowerText === "@tabela") await handleTabela(sock, msg);
      else if (lowerText === "@todos") await handleTodos(sock, msg);
      else if (lowerText.startsWith("@") || lowerText.startsWith("/")) await handleMessage(sock, msg);
      else if (['.n', '.t', '.i', '.s'].includes(lowerText)) await handleTabela(sock, msg);

    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
      pendingMessages.push({ jid: senderJid, msg: { text: "❌ Ocorreu um erro ao processar sua solicitação." } });
    }
  };

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;
    const msg = messages[0];
    if (msg.key.fromMe) return;

    if (!authReady) {
      // mantém comportamento inicial (fila), porém sem mensagens longas ao usuário
      pendingMessages.push({ jid: msg.key.remoteJid, msg: { text: "⏳ Bot iniciando, aguarde..." } });
      return;
    }

    // Processa a mensagem imediatamente (não bloqueante)
    // colocar em micro-tarefa para não travar o loop de eventos
    processMessage(msg).catch(err => console.error("processMessage catch:", err));
  });

  sock.ev.on("messages.reaction", async reactions => {
    for (const reactionMsg of reactions) {
      try {
        await handleReaction({ reactionMessage: reactionMsg, sock });
      } catch (err) {
        console.error("Erro reação:", err);
      }
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action === "add") {
      for (let participant of participants) {
        const nome = participant.split("@")[0];
        const mensagem = `@${nome}  *👋 Seja muito bem-vindo(a) ao grupo!*\n\n🎉 Ficamos felizes em ter você conosco.\n\nQualquer dúvida, estamos aqui para ajudar!`.trim();

        try {
          const ppUrl = await sock.profilePictureUrl(participant, "image").catch(() => null);
          if (ppUrl) await sock.sendMessage(id, { image: { url: ppUrl }, caption: mensagem, mentions: [participant] });
          else await sock.sendMessage(id, { text: mensagem, mentions: [participant] });
        } catch (err) { console.error(err); }
      }
    }
  });

  return sock;
}

// ===================== Inicialização =====================
iniciarBot("Dispositivo 1");

// ===================== Servidor HTTP =====================
const PORT = process.env.PORT || 10000; // Render usa 10000 por padrão
app.get("/", (_, res) => res.send("✅ TopBot MULTI-DEVICE rodando com sucesso!"));
app.listen(PORT, () => console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`));
