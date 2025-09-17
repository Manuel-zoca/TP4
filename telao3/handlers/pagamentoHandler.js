exports.handlePagamento = async (sock, msg) => {
    try {
        const from = msg.key.remoteJid;

        // Verifica se é grupo
        if (!from.endsWith('@g.us')) {
            return sock.sendMessage(from, { text: '❌ Este comando só funciona em grupos!' });
        }

        // Mensagem padrão de pagamento
        const mensagem = `
📱Formas de Pagamento Atualizadas📱 💳

1. M-PESA 📱  
   - Número: 848619531  
   - DINIS MARTA  

2. E-MOLA 💸  
   - Número: 872960710  
   - MANUEL ZOCA  

3. BIM 🏦  
   - Conta nº: 1059773792  
   - CHONGO MANUEL  

Após efetuar o pagamento, por favor, envie o comprovante da transferência juntamente com seu contato.
        `.trim();

        // Envia a mensagem de pagamento
        await sock.sendMessage(from, { text: mensagem });

        // Aguarda 2 segundos antes de finalizar
        await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
        console.error('🚨 Erro ao processar @Pagamentos:', error);
        await sock.sendMessage(from, { text: '❌ Ocorreu um erro ao processar sua solicitação. Tente novamente mais tarde.' });
    }
};
