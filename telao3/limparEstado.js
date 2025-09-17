// limparEstado.js
const { MongoClient } = require("mongodb");

const MONGO_URI = "mongodb+srv://manuelzocachongochongo:edna@topai.o8uvgg8.mongodb.net/?retryWrites=true&w=majority&appName=Topai";
const DB_NAME = "baileys_auth";     // Ajuste para o nome do seu banco
const COLLECTION = "auth_state";    // Ajuste para o nome da sua coleção

async function limparEstado() {
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        const db = client.db(DB_NAME);
        const col = db.collection(COLLECTION);
        const result = await col.deleteMany({});
        console.log(`🧹 Estado limpo: ${result.deletedCount} registros removidos.`);
    } catch (err) {
        console.error("❌ Erro ao limpar estado:", err);
    } finally {
        await client.close();
    }
}

limparEstado();
