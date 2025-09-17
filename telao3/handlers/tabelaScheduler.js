const TABELA_TEXTO = `
ⓘ *❗🛑MEGABYTE* *VODACOM*

*💡ESTAMOS DISPONÍVEIS DAS 6H ÀS 23:00*

*TABELA ATUALIZADA* 04/05/2025

🕓Validade: 1 dia
20MT    📶  1.100MB
30MT    📶  1.650MB
40MT    📶  2.200MB
50MT    📶  2.750MB 
60MT    📶  3.300MB
80MT    📶  4.400MB
100MT   📶  5.500MB
180MT   📶  10.000MB
280MT   📶  15.000MB
360MT   📶  20.000MB

*🗓️SEMANAIS 7DIAS*
105MT   📶  4.000MB 
130MT   📶  5.000MB 
150MT   📶  6.000MB 
250MT   📶  10.000MB 

*🗓️MENSAL 30DIAS*
150MT    📶    5.000MB
170MT    📶    7.200MB
210MT    📶    9.400MB
260MT    📶   10.500MB
520MT    📶   20.000MB
1150MT   📶   50.250MB

> 🚀 _Conectando pessoas,_
> 🚀 _compartilhando megabytes!_

📞 TUDO TOP VODACOM 

📍chamadas e SMS ilimitadas para todas redes

📆30 dias Tudo top

450MT 🔥 Chamadas + SMS ilimitadas + 9.5GB +10min Int+30MB Roam  
550MT 🔥 Chamadas + SMS ilimitadas + 12.5GB +10min Int+30MB Roam  
650MT 🔥 Chamadas + SMS ilimitadas + 15.5GB +10min Int+30MB Roam  
850MT 🔥 Chamadas + SMS ilimitadas + 27.5GB +10min Int+30MB Roam  
1050MT 🔥 Chamadas + SMS ilimitadas + 25.5GB +10min Int+30MB Roam
`.trim();

const FORMAS_PAGAMENTO = `
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

const grupos = [
  {
    id: "120363252308434038@g.us", // Grupo 1
    intervaloMinutos: 30,
    ultimoEnvio: 0,
  },
  {
    id: "120363417514741662@g.us", // Grupo 2
    intervaloMinutos: 35,
    ultimoEnvio: 0,
  },
];

function horaDentroDoIntervalo(hora) {
  const [h, m] = hora.split(":").map(Number);
  const minutosTotais = h * 60 + m;
  const inicio = 6 * 60 + 20; // 06:20
  const fim = 22 * 60;        // 22:00
  return minutosTotais >= inicio && minutosTotais <= fim;
}

function getHoraAtualMaputo() {
  const agora = new Date();
  const formatter = new Intl.DateTimeFormat("pt-MZ", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Maputo",
  });
  return formatter.format(agora);
}

async function iniciarAgendamentoTabela(sock) {
  console.log("⏰ Agendador de envio de tabela iniciado.");

  setInterval(async () => {
    const hora = getHoraAtualMaputo();
    if (!horaDentroDoIntervalo(hora)) return;

    const agora = Date.now();

    for (const grupo of grupos) {
      const diferencaMin = (agora - grupo.ultimoEnvio) / 60000;

      if (diferencaMin >= grupo.intervaloMinutos) {
        console.log(`📤 Enviando tabela para ${grupo.id} às ${hora}`);
        await sock.sendMessage(grupo.id, { text: TABELA_TEXTO });
        await new Promise((res) => setTimeout(res, 5000));
        await sock.sendMessage(grupo.id, { text: FORMAS_PAGAMENTO });
        grupo.ultimoEnvio = agora;
      }
    }
  }, 60 * 1000);
}

module.exports = { iniciarAgendamentoTabela };
