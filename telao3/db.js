// db.js
const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://manuelzocachongochongo:edna@topai.o8uvgg8.mongodb.net/?retryWrites=true&w=majority&appName=Topai";
const client = new MongoClient(uri);

let collection;

async function connect() {
    if (!collection) {
        await client.connect();
        const db = client.db("topbot");
        collection = db.collection("authState");
    }
}

async function loadAuthState() {
    await connect();
    const data = await collection.findOne({ _id: 'auth1' });
    return data?.state || null;
}

async function saveAuthState(state) {
    await connect();
    await collection.updateOne(
        { _id: 'auth1' },
        { $set: { state } },
        { upsert: true }
    );
}

module.exports = {
    loadAuthState,
    saveAuthState
};
