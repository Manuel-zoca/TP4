const grupos = [
    {
        id: "120363252308434038@g.us",
        horaFechar: "22:30",
        horaAbrir: "06:24",
    },
    {
        id: "120363417514741662@g.us",
        horaFechar: "22:40",
        horaAbrir: "06:27",
    },
    // Adicione mais grupos conforme necessário
];

function getHoraAtual() {
    const agora = new Date();
    // Formata para horário de Moçambique (UTC+2)
    return agora.toLocaleTimeString('pt-PT', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Africa/Maputo'
    });
}

async function verificarHorarios(sock) {
    const horaAtual = getHoraAtual();

    for (const grupo of grupos) {
        try {
            if (horaAtual === grupo.horaFechar) {
                await sock.groupSettingUpdate(grupo.id, "announcement");
                console.log(`🔒 Grupo ${grupo.id} fechado às ${horaAtual}`);
                await sock.sendMessage(grupo.id, { text: "🔒 Grupo temporariamente fechado. \n\n *Urgente??* CAll- 848619531" });
            }

            if (horaAtual === grupo.horaAbrir) {
                await sock.groupSettingUpdate(grupo.id, "not_announcement");
                console.log(`🔓 Grupo ${grupo.id} aberto às ${horaAtual}`);

                setTimeout(async () => {
                    try {
                        await sock.sendMessage(grupo.id, { text: "🔓 Grupo aberto! \n\n podemos ativar para ficar online" });
                    } catch (err) {
                        console.error(`Erro ao enviar mensagem ao abrir grupo ${grupo.id}:`, err);
                    }
                }, 2000);
            }

        } catch (err) {
            console.error(`Erro ao alterar configurações do grupo ${grupo.id}:`, err);
        }
    }
}

function iniciarAgendamento(sock) {
    setInterval(() => verificarHorarios(sock), 60 * 1000); // Verifica a cada 1 minuto
}

module.exports = { iniciarAgendamento };
