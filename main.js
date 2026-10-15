const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const https = require('https');

let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {}

let mainWindow;
let client = null;
let configEmMemoria = null;
let contatosPausados = {};
let estadosUsuarios = {};
let avisoForaHorarioRecente = {};
let mensagensJaProcessadas = new Set();
let momentoConexao = 0;
let iniciandoBot = false;
let reconectando = false;
let varrendoNaoLidas = false;
let statusAtualBot = 'initializing';
let ultimoQrDataUrl = '';
let timerGravacaoDisco = null;

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const AUTH_DIR = path.join(app.getPath('userData'), 'wwebjs_auth_session');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function obterCaminhoNavegador() {
    const caminhosWindows = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const caminho of caminhosWindows) {
        if (caminho && fs.existsSync(caminho)) {
            return caminho;
        }
    }
    return undefined;
}

function limparLocksTravados() {
    try {
        const possiveisLocks = [
            path.join(AUTH_DIR, 'session-adv_studio_client', 'SingletonLock'),
            path.join(AUTH_DIR, 'session-adv_studio_client', 'lockfile'),
            path.join(__dirname, '.wwebjs_auth', 'session-adv_studio_client', 'SingletonLock'),
            path.join(__dirname, '.wwebjs_auth', 'session-adv_studio_client', 'lockfile')
        ];
        for (const arq of possiveisLocks) {
            if (fs.existsSync(arq)) {
                try { fs.unlinkSync(arq); } catch (e) {}
            }
        }
    } catch (e) {}
}

function criarConfigPadrao() {
    return {
        // Varredura Automática desligada por padrão como solicitado
        varredura_automatica_inicio: false,
        agenda: {
            "0": { nome: "Domingo", ativo: false, abertura: "08:00", fechamento: "18:00" },
            "1": { nome: "Segunda-feira", ativo: true, abertura: "08:00", fechamento: "18:00" },
            "2": { nome: "Terça-feira", ativo: true, abertura: "08:00", fechamento: "18:00" },
            "3": { nome: "Quarta-feira", ativo: true, abertura: "08:00", fechamento: "18:00" },
            "4": { nome: "Quinta-feira", ativo: true, abertura: "08:00", fechamento: "18:00" },
            "5": { nome: "Sexta-feira", ativo: true, abertura: "08:00", fechamento: "18:00" },
            "6": { nome: "Sábado", ativo: false, abertura: "08:00", fechamento: "12:00" },
            almoco_ativo: true,
            almoco_inicio: "12:00",
            almoco_fim: "13:30",
            msg_almoco: "⏳ *Horário de Almoço:* No momento nossa equipe está em intervalo de almoço (retornamos às 13:30), mas nosso atendimento automático segue abaixo para ajudar você:",
            msg_fora_expediente: "🌙 *Fora do Horário de Expediente:* Nosso escritório está fechado neste momento, mas nosso atendimento automático segue disponível abaixo para adiantar sua solicitação:"
        },
        fluxo: {
            raiz: {
                titulo: "Menu Principal (Boas-Vindas)",
                mensagem: "⚖️ *Escritório de Advocacia*\n\nOlá! Seja muito bem-vindo(a) ao nosso atendimento digital.\n\nComo podemos auxiliar você hoje?",
                opcoes: [
                    { gatilho: "1", rotulo: "Consultar Andamento de Processo", tipo: "processo", destino: "", resposta: "Perfeito! Por gentileza, digite apenas o seu *CPF* ou o *Número do Processo* para localizarmos sua pasta:" },
                    { gatilho: "2", rotulo: "Iniciar Nova Consulta Jurídica", tipo: "submenu", destino: "areas", resposta: "" },
                    { gatilho: "3", rotulo: "Falar diretamente com Advogado", tipo: "humano", destino: "", resposta: "Perfeito! Sua solicitação foi encaminhada e um advogado da nossa equipe assumirá seu atendimento." }
                ]
            },
            etapas: {
                "areas": {
                    titulo: "Submenu: Especialidades",
                    mensagem: "*Nova Consulta Jurídica*\n\nSelecione a área correspondente ao seu caso:",
                    opcoes: [
                        { gatilho: "1", rotulo: "Direito Cível, Família ou Contratos", tipo: "texto", destino: "", resposta: "Compreendido. Envie um breve relato do ocorrido para análise prévia do advogado." },
                        { gatilho: "0", rotulo: "Voltar ao Menu Principal", tipo: "submenu", destino: "raiz", resposta: "" }
                    ]
                }
            }
        },
        processos: {
            mensagens: {
                msg_com_atualizacao: "⚖️ *Andamento Processual Localizado*\n\nOlá, *{nome}*!\nReferente ao processo nº *{processo}* (CPF: *{cpf}*):\n\n📋 *Resumo da Atualização ({data}):*\n{resumo}\n\n_(Digite *0* para voltar ao Menu Principal ou *3* para falar com um advogado)_",
                msg_ja_visto: "⚖️ *Consulta Processual*\n\nOlá, *{nome}*! Verificamos a pasta do seu processo nº *{processo}* e informamos que *não houve novas movimentações* desde a sua última consulta em *{ultima_consulta}*.\n\n📌 *Último resumo registrado ({data}):*\n{resumo}\n\nFique tranquilo(a), assim que houver novidades atualizaremos por aqui!",
                msg_sem_atualizacao: "⚖️ *Consulta Processual*\n\nOlá, *{nome}*! Seu processo nº *{processo}* está devidamente cadastrado em nosso sistema, porém ainda não possui movimentações ou resumos lançados até o momento.\n\nNossa equipe segue acompanhando!",
                msg_nao_encontrado: "⚠️ Não conseguimos localizar nenhum processo com o *CPF* ou *Número de Processo* informado.\n\nPor favor, envie novamente apenas os números do seu CPF ou do Processo, ou digite *0* para voltar ao Menu Inicial."
            },
            lista: []
        },
        mapaNomes: {},
        metricasReais: {
            totalMensagens: 0,
            contatosAtendidos: []
        }
    };
}

function carregarConfig(forcarDisco = false) {
    if (configEmMemoria && !forcarDisco) {
        return configEmMemoria;
    }
    try {
        const padrao = criarConfigPadrao();
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(padrao, null, 2), 'utf-8');
            configEmMemoria = padrao;
            return configEmMemoria;
        }
        const lido = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

        if (typeof lido.varredura_automatica_inicio === 'undefined') {
            lido.varredura_automatica_inicio = false;
        }

        if (!lido.agenda || typeof lido.agenda !== 'object') lido.agenda = padrao.agenda;
        ["0", "1", "2", "3", "4", "5", "6"].forEach(d => {
            if (!lido.agenda[d] || typeof lido.agenda[d] !== 'object') {
                lido.agenda[d] = padrao.agenda[d];
            }
        });
        if (typeof lido.agenda.almoco_ativo === 'undefined') lido.agenda.almoco_ativo = padrao.agenda.almoco_ativo;
        if (!lido.agenda.almoco_inicio) lido.agenda.almoco_inicio = padrao.agenda.almoco_inicio;
        if (!lido.agenda.almoco_fim) lido.agenda.almoco_fim = padrao.agenda.almoco_fim;
        if (!lido.agenda.msg_almoco) lido.agenda.msg_almoco = padrao.agenda.msg_almoco;
        if (!lido.agenda.msg_fora_expediente) lido.agenda.msg_fora_expediente = padrao.agenda.msg_fora_expediente;

        if (!lido.fluxo) lido.fluxo = padrao.fluxo;
        if (!lido.processos) lido.processos = padrao.processos;
        if (!lido.processos.mensagens) lido.processos.mensagens = padrao.processos.mensagens;
        if (!Array.isArray(lido.processos.lista)) lido.processos.lista = [];
        if (!lido.mapaNomes) lido.mapaNomes = {};
        if (!lido.metricasReais) lido.metricasReais = { totalMensagens: 0, contatosAtendidos: [] };

        configEmMemoria = lido;
        return configEmMemoria;
    } catch (e) {
        configEmMemoria = criarConfigPadrao();
        return configEmMemoria;
    }
}

function salvarConfigDisco(cfg, imediato = false) {
    configEmMemoria = cfg;
    if (imediato) {
        try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8'); } catch (e) {}
        return;
    }
    clearTimeout(timerGravacaoDisco);
    timerGravacaoDisco = setTimeout(() => {
        try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(configEmMemoria, null, 2), 'utf-8'); } catch (e) {}
    }, 400);
}

function apenasNumeros(str) {
    return String(str || '').replace(/\D/g, '');
}

function formatarTelefoneBrasil(num) {
    const limpo = apenasNumeros(num);
    if (!limpo) return num || 'Contato';
    if (limpo.length === 13 && limpo.startsWith('55')) {
        return `+55 (${limpo.substring(2, 4)}) ${limpo.substring(4, 9)}-${limpo.substring(9)}`;
    }
    if (limpo.length === 12 && limpo.startsWith('55')) {
        return `+55 (${limpo.substring(2, 4)}) ${limpo.substring(4, 8)}-${limpo.substring(8)}`;
    }
    if (limpo.length === 11) {
        return `(${limpo.substring(0, 2)}) ${limpo.substring(2, 7)}-${limpo.substring(7)}`;
    }
    return `+${limpo}`;
}

function resolverIdentidadeRapida(msg, config) {
    const chatId = msg.from || '';
    const parteId = chatId.split('@')[0];
    const numeroLimpo = apenasNumeros(parteId);

    let nomeInstantaneo = (msg._data && (msg._data.notifyName || msg._data.pushname)) || '';

    const chaveUnica = numeroLimpo || parteId;

    if (config.mapaNomes && config.mapaNomes[chaveUnica]) {
        nomeInstantaneo = config.mapaNomes[chaveUnica];
    } else if (nomeInstantaneo && config.mapaNomes) {
        config.mapaNomes[chaveUnica] = nomeInstantaneo;
    }

    const formatado = formatarTelefoneBrasil(numeroLimpo || parteId);
    const identificadorExibicao = nomeInstantaneo ? `${nomeInstantaneo} (${formatado})` : formatado;

    return {
        idChat: chatId,
        chaveCliente: chaveUnica,
        nomeCliente: nomeInstantaneo || '',
        telefoneFormatado: formatado,
        exibicao: identificadorExibicao
    };
}

function extrairGatilhoLimpo(texto) {
    const t = String(texto || '').trim().toLowerCase();
    const matchNumero = t.match(/^(\d+)\s*[\.\-\)]?$/);
    if (matchNumero) return matchNumero[1];
    return t;
}

function buscarProcessosPorTextoCliente(textoCliente, listaProcessos) {
    if (!Array.isArray(listaProcessos) || listaProcessos.length === 0) return [];

    const digitosCliente = apenasNumeros(textoCliente);
    if (!digitosCliente || digitosCliente.length < 5) return [];

    const sequenciasNumericas = (String(textoCliente).match(/[\d.\-\/\s]+/g) || [])
        .map(s => apenasNumeros(s))
        .filter(s => s.length >= 5);

    const encontrados = [];

    for (const proc of listaProcessos) {
        const cpfCad = apenasNumeros(proc.cpf);
        const numProcCad = apenasNumeros(proc.numero);

        let bateuProcesso = false;
        let bateuCpf = false;

        if (numProcCad && numProcCad.length >= 5) {
            if (
                digitosCliente === numProcCad ||
                sequenciasNumericas.includes(numProcCad) ||
                digitosCliente.includes(numProcCad)
            ) {
                bateuProcesso = true;
            }
        }

        if (!bateuProcesso && cpfCad && cpfCad.length >= 5) {
            const cpfSemZero = cpfCad.replace(/^0+/, '');
            const clienteSemZero = digitosCliente.replace(/^0+/, '');

            if (
                digitosCliente === cpfCad ||
                sequenciasNumericas.includes(cpfCad) ||
                digitosCliente.includes(cpfCad) ||
                (cpfSemZero.length >= 5 && clienteSemZero === cpfSemZero)
            ) {
                bateuCpf = true;
            }
        }

        if (bateuProcesso || bateuCpf) {
            encontrados.push(proc);
        }
    }

    return encontrados;
}

function formatarTemplateProcesso(template, proc, dataUltimaConsultaStr) {
    return String(template || '')
        .replace(/\{nome\}/gi, proc.nome || 'Cliente')
        .replace(/\{cpf\}/gi, proc.cpf || 'Não informado')
        .replace(/\{processo\}/gi, proc.numero || 'S/N')
        .replace(/\{resumo\}/gi, proc.resumo || 'Sem detalhes adicionais.')
        .replace(/\{data\}/gi, proc.dataAtualizacaoTexto || 'Recente')
        .replace(/\{ultima_consulta\}/gi, dataUltimaConsultaStr || '');
}

function checarStatusAgenda(config) {
    const agora = new Date();
    const diaSemana = String(agora.getDay());
    const minutosAgora = agora.getHours() * 60 + agora.getMinutes();

    const confDia = config.agenda && config.agenda[diaSemana];
    if (!confDia || !confDia.ativo) {
        return { aberto: false, motivo: 'fora_expediente' };
    }

    const [hIni, mIni] = (confDia.abertura || "08:00").split(':').map(Number);
    const [hFim, mFim] = (confDia.fechamento || "18:00").split(':').map(Number);
    if (minutosAgora < (hIni * 60 + mIni) || minutosAgora > (hFim * 60 + mFim)) {
        return { aberto: false, motivo: 'fora_expediente' };
    }

    if (config.agenda.almoco_ativo) {
        const [hAlmIni, mAlmIni] = (config.agenda.almoco_inicio || "12:00").split(':').map(Number);
        const [hAlmFim, mAlmFim] = (config.agenda.almoco_fim || "13:30").split(':').map(Number);
        if (minutosAgora >= (hAlmIni * 60 + mAlmIni) && minutosAgora <= (hAlmFim * 60 + mAlmFim)) {
            return { aberto: false, motivo: 'almoco' };
        }
    }

    return { aberto: true };
}

function montarTextoEtapa(etapa) {
    let txt = (etapa.mensagem || '') + "\n\n";
    (etapa.opcoes || []).forEach(op => {
        txt += `*${op.gatilho}* - ${op.rotulo}\n`;
    });
    return txt.trim();
}

function emitirPausados() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-pausados', contatosPausados);
    }
}

function atualizarStatusUI(novoStatus) {
    statusAtualBot = novoStatus;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-status', novoStatus);
    }
}

async function enviarMensagemSegura(msgObj, chatId, texto) {
    if (!client) return;
    try {
        await client.sendMessage(chatId, texto, { sendSeen: true });
    } catch (err1) {
        try {
            if (msgObj && typeof msgObj.reply === 'function') {
                await msgObj.reply(texto, chatId, { sendSeen: true });
            }
        } catch (err2) {
            console.error("[ERRO ENVIO TEXTO]:", err2.message);
        }
    }
}

// VARREDURA SEGURA (SEM EXCEÇÕES DO WHATSAPP WEB)
async function varrerMensagensNaoLidas() {
    if (!client || statusAtualBot !== 'ready' || varrendoNaoLidas) return 0;
    varrendoNaoLidas = true;
    let respondidas = 0;

    try {
        // Proteção contra chamadas prematuras
        if (typeof client.getChats !== 'function') {
            varrendoNaoLidas = false;
            return 0;
        }

        const chats = await client.getChats();
        if (!Array.isArray(chats)) {
            varrendoNaoLidas = false;
            return 0;
        }

        const agoraSegundos = Math.floor(Date.now() / 1000);
        const limiteIdadeSegundos = 24 * 60 * 60;

        for (const chat of chats) {
            try {
                if (!chat || chat.isGroup) continue;
                const qtdNaoLidas = Number(chat.unreadCount || 0);
                if (qtdNaoLidas <= 0) continue;

                const remetenteId = (chat.id && chat.id._serialized) || '';
                if (!remetenteId || remetenteId.includes('@g.us') || remetenteId.includes('@broadcast') || remetenteId.includes('@newsletter')) continue;

                const chaveSimples = apenasNumeros(remetenteId.split('@')[0]) || remetenteId.split('@')[0];

                const tempoPausa = contatosPausados[chaveSimples] || contatosPausados[remetenteId];
                if (tempoPausa && (Date.now() - tempoPausa < 24 * 60 * 60 * 1000)) {
                    continue;
                }

                if (typeof chat.fetchMessages !== 'function') continue;
                const msgs = await chat.fetchMessages({ limit: Math.max(qtdNaoLidas + 4, 8) });
                if (!Array.isArray(msgs) || msgs.length === 0) continue;

                const ultimaMsgGeral = msgs[msgs.length - 1];

                // Se nós já respondemos nessa conversa pelo celular ou PC, pula!
                if (ultimaMsgGeral.fromMe) {
                    continue;
                }

                const textoBody = String(ultimaMsgGeral.body || '').trim();
                if (!textoBody) continue;

                if (ultimaMsgGeral.timestamp && (agoraSegundos - ultimaMsgGeral.timestamp > limiteIdadeSegundos)) {
                    continue;
                }

                const idMsg = ultimaMsgGeral.id ? ultimaMsgGeral.id._serialized : null;
                if (idMsg && mensagensJaProcessadas.has(idMsg)) continue;

                await processarMensagemEntrada(ultimaMsgGeral, true);
                respondidas++;

                try { if (typeof chat.sendSeen === 'function') await chat.sendSeen(); } catch (e) {}
            } catch (errChat) {}
        }
    } catch (errVarredura) {
        console.error("[AVISO VARREDURA]: Sincronização de conversas ainda em andamento no WhatsApp.");
    } finally {
        varrendoNaoLidas = false;
    }
    return respondidas;
}

// NÚCLEO DE ATENDIMENTO DO BOT
async function processarMensagemEntrada(msg, veioDaVarredura = false) {
    try {
        if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return;
        if (!msg.from || msg.from.includes('@g.us') || msg.from.includes('@newsletter') || msg.from.includes('@broadcast')) return;
        if (msg.author) return;

        const idUnicoMsg = msg.id ? msg.id._serialized : `${msg.from}_${msg.timestamp}_${msg.body}`;
        if (mensagensJaProcessadas.has(idUnicoMsg)) return;

        if (!veioDaVarredura && msg.timestamp && momentoConexao > 0 && msg.timestamp < (momentoConexao - 180)) {
            return;
        }

        const textoOriginal = String(msg.body || '').trim();
        if (!textoOriginal) return;

        mensagensJaProcessadas.add(idUnicoMsg);
        if (mensagensJaProcessadas.size > 800) {
            const primeiro = mensagensJaProcessadas.values().next().value;
            mensagensJaProcessadas.delete(primeiro);
        }

        const config = carregarConfig();
        const identidade = resolverIdentidadeRapida(msg, config);
        const remetenteChave = identidade.chaveCliente;
        const gatilhoDigitado = extrairGatilhoLimpo(textoOriginal);

        // 1. Pausa Humana
        const tempoPausa = contatosPausados[remetenteChave] || contatosPausados[msg.from];
        if (tempoPausa) {
            if (Date.now() - tempoPausa < 24 * 60 * 60 * 1000) {
                return;
            } else {
                delete contatosPausados[remetenteChave];
                delete contatosPausados[msg.from];
                emitirPausados();
            }
        }

        // 2. Captura Nome
        const matchNome = textoOriginal.match(/(?:meu nome é|meu nome e|me chamo|sou o|sou a|aqui é o|aqui é a)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+){0,2})/i);
        if (matchNome && matchNome[1]) {
            identidade.nomeCliente = matchNome[1].trim();
            config.mapaNomes[remetenteChave] = identidade.nomeCliente;
        }

        // 3. Métricas
        if (!config.metricasReais) config.metricasReais = { totalMensagens: 0, contatosAtendidos: [] };
        config.metricasReais.totalMensagens += 1;
        if (!config.metricasReais.contatosAtendidos.includes(remetenteChave)) {
            config.metricasReais.contatosAtendidos.push(remetenteChave);
        }
        salvarConfigDisco(config, false);

        // 4. Log
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-log', {
                numero: identidade.telefoneFormatado,
                nome: identidade.nomeCliente || '',
                exibicao: identidade.exibicao,
                msg: textoOriginal,
                hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                metricasReais: {
                    totalMensagens: config.metricasReais.totalMensagens,
                    totalContatos: config.metricasReais.contatosAtendidos.length
                }
            });
        }

        // 5. Horário / Almoço: Não salva separado. Apenas adiciona aviso no início e responde normal!
        let prefixoForaDeHorario = "";
        const statusAgenda = checarStatusAgenda(config);
        if (!statusAgenda.aberto) {
            const ultimoAvisoCliente = avisoForaHorarioRecente[remetenteChave] || 0;
            if (Date.now() - ultimoAvisoCliente > 30 * 60 * 1000) {
                const avisoConfigurado = statusAgenda.motivo === 'almoco'
                    ? config.agenda.msg_almoco
                    : config.agenda.msg_fora_expediente;

                if (avisoConfigurado && avisoConfigurado.trim()) {
                    prefixoForaDeHorario = avisoConfigurado.trim() + "\n\n───────────────────\n\n";
                    avisoForaHorarioRecente[remetenteChave] = Date.now();
                }
            }
        } else {
            delete avisoForaHorarioRecente[remetenteChave];
        }

        const responderCliente = async (textoResposta) => {
            await enviarMensagemSegura(msg, msg.from, prefixoForaDeHorario + textoResposta);
        };

        // 6. Saudações ou "0"
        const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "menu", "inicio", "início", "ajuda"];
        if (saudacoes.some(s => gatilhoDigitado === s || gatilhoDigitado.startsWith(s + " ")) || (estadosUsuarios[remetenteChave] === '__aguardando_processo__' && gatilhoDigitado === '0')) {
            estadosUsuarios[remetenteChave] = 'raiz';
            await responderCliente(montarTextoEtapa(config.fluxo.raiz));
            return;
        }

        // 7. Opções Numéricas do Menu Atual (1, 2, 3...)
        const etapaAtualKey = (estadosUsuarios[remetenteChave] && estadosUsuarios[remetenteChave] !== '__aguardando_processo__')
            ? estadosUsuarios[remetenteChave]
            : 'raiz';
        const etapaAtual = etapaAtualKey === 'raiz'
            ? config.fluxo.raiz
            : (config.fluxo.etapas[etapaAtualKey] || config.fluxo.raiz);

        const opcaoEscolhida = (etapaAtual.opcoes || []).find(op => String(op.gatilho).trim().toLowerCase() === gatilhoDigitado);

        if (opcaoEscolhida) {
            if (opcaoEscolhida.tipo === 'processo') {
                estadosUsuarios[remetenteChave] = '__aguardando_processo__';
                const msgPedirDados = opcaoEscolhida.resposta || "Por favor, digite apenas o seu *CPF* ou o *Número do Processo* para localizarmos sua pasta:";
                await responderCliente(msgPedirDados);
                return;
            }

            if (opcaoEscolhida.tipo === 'humano') {
                contatosPausados[remetenteChave] = Date.now();
                contatosPausados[msg.from] = Date.now();
                delete estadosUsuarios[remetenteChave];
                emitirPausados();
                await responderCliente(opcaoEscolhida.resposta || "Um advogado atenderá você em instantes.");
                return;
            }

            if (opcaoEscolhida.tipo === 'submenu') {
                const dest = opcaoEscolhida.destino || 'raiz';
                estadosUsuarios[remetenteChave] = dest;
                const proxEtapa = dest === 'raiz' ? config.fluxo.raiz : config.fluxo.etapas[dest];
                await responderCliente(montarTextoEtapa(proxEtapa || config.fluxo.raiz));
                return;
            }

            if (opcaoEscolhida.resposta) {
                contatosPausados[remetenteChave] = Date.now();
                contatosPausados[msg.from] = Date.now();
                delete estadosUsuarios[remetenteChave];
                emitirPausados();
                await responderCliente(opcaoEscolhida.resposta);
                return;
            }
        }

        // 8. Consulta de Processo por CPF ou Número CNJ
        const digitosRecebidos = apenasNumeros(textoOriginal);
        const pareceCpfOuProcesso = digitosRecebidos.length >= 5;

        if (estadosUsuarios[remetenteChave] === '__aguardando_processo__' || pareceCpfOuProcesso) {
            const processosEncontrados = buscarProcessosPorTextoCliente(textoOriginal, config.processos.lista);

            if (!processosEncontrados || processosEncontrados.length === 0) {
                if (estadosUsuarios[remetenteChave] === '__aguardando_processo__' || digitosRecebidos.length >= 8) {
                    await responderCliente(config.processos.mensagens.msg_nao_encontrado);
                    return;
                }
            } else {
                let houveMudancaNoDisco = false;

                for (const procEncontrado of processosEncontrados) {
                    if (!procEncontrado.consultasPorContato) {
                        procEncontrado.consultasPorContato = {};
                    }

                    if (procEncontrado.nome && procEncontrado.nome !== 'Cliente') {
                        config.mapaNomes[remetenteChave] = procEncontrado.nome;
                        houveMudancaNoDisco = true;
                    }

                    const temResumo = Boolean(procEncontrado.resumo && procEncontrado.resumo.trim().length > 0);
                    const timestampProc = procEncontrado.updatedAt || 0;
                    const registroAnterior = procEncontrado.consultasPorContato[remetenteChave] || procEncontrado.consultasPorContato[msg.from];

                    if (!temResumo || !procEncontrado.temAtualizacao) {
                        const txtSem = formatarTemplateProcesso(config.processos.mensagens.msg_sem_atualizacao, procEncontrado, '');
                        await responderCliente(txtSem);
                        continue;
                    }

                    if (registroAnterior && registroAnterior.timestamp >= timestampProc) {
                        const txtJaVisto = formatarTemplateProcesso(
                            config.processos.mensagens.msg_ja_visto,
                            procEncontrado,
                            registroAnterior.dataFormatada
                        );
                        await responderCliente(txtJaVisto);
                        continue;
                    }

                    const agoraStr = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
                    const txtNovo = formatarTemplateProcesso(config.processos.mensagens.msg_com_atualizacao, procEncontrado, agoraStr);

                    await responderCliente(txtNovo);

                    procEncontrado.consultasPorContato[remetenteChave] = {
                        timestamp: Date.now(),
                        dataFormatada: agoraStr
                    };
                    houveMudancaNoDisco = true;
                }

                if (houveMudancaNoDisco) {
                    salvarConfigDisco(config, true);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('bot-processos-sync', config);
                    }
                }

                estadosUsuarios[remetenteChave] = 'raiz';
                return;
            }
        }

        // 9. Menu Inicial
        estadosUsuarios[remetenteChave] = 'raiz';
        await responderCliente(montarTextoEtapa(config.fluxo.raiz));
    } catch (errProcesso) {
        console.error("[ERRO PROCESSAMENTO MSG]:", errProcesso.message);
    }
}

let ultimaInfoUpdate = null;
let arquivoInstaladorBaixado = null;
let baixandoUpdate = false;

function baixarEInstalarAtualizacaoNativa(exeUrl, versao) {
    if (!exeUrl || baixandoUpdate) return;
    baixandoUpdate = true;

    const os = require('os');
    const tempDir = app.getPath ? app.getPath('temp') : os.tmpdir();
    const destPath = path.join(tempDir, `Advocacia-Studio-Pro-Setup-${versao}.exe`);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-update-status', {
            status: 'downloading',
            versao: versao,
            progresso: 0
        });
    }

    function realizarDownload(urlAtual) {
        https.get(urlAtual, { headers: { 'User-Agent': 'AdvocaciaStudioPro-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return realizarDownload(res.headers.location);
            }

            if (res.statusCode !== 200) {
                console.error('[UPDATER NATIVO] Erro ao baixar executável, status:', res.statusCode);
                baixandoUpdate = false;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('bot-update-status', {
                        status: 'error',
                        erro: `Erro no download do executável (HTTP ${res.statusCode})`
                    });
                }
                return;
            }

            const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
            let downloadedBytes = 0;
            const fileStream = fs.createWriteStream(destPath);

            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0) {
                    const pct = Math.round((downloadedBytes / totalBytes) * 100);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('bot-update-status', {
                            status: 'downloading',
                            versao: versao,
                            progresso: pct
                        });
                    }
                }
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                baixandoUpdate = false;
                arquivoInstaladorBaixado = destPath;
                console.log('[UPDATER NATIVO] Download concluído com sucesso em:', destPath);

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('bot-update-status', {
                        status: 'ready',
                        versao: versao
                    });
                }
            });

            fileStream.on('error', (errStream) => {
                baixandoUpdate = false;
                console.error('[UPDATER NATIVO FILE ERROR]:', errStream.message);
            });
        }).on('error', (errReq) => {
            baixandoUpdate = false;
            console.error('[UPDATER NATIVO REQ ERROR]:', errReq.message);
        });
    }

    realizarDownload(exeUrl);
}

function checarAtualizacaoGitHubDireta(disparoManual = false) {
    try {
        const versaoAtual = app.getVersion ? app.getVersion() : require('./package.json').version;
        if (disparoManual && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-update-status', { status: 'checking' });
        }

        const options = {
            hostname: 'api.github.com',
            path: '/repos/danireid123/advocacia-studio-pro/releases/latest',
            headers: {
                'User-Agent': 'AdvocaciaStudioPro-App'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        if (disparoManual && mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('bot-update-status', {
                                status: 'error',
                                erro: `GitHub retornou status ${res.statusCode}`
                            });
                        }
                        return;
                    }
                    const json = JSON.parse(data);
                    const tag = json.tag_name ? json.tag_name.replace(/^v/, '') : '';
                    if (!tag) return;

                    const vAtualNums = String(versaoAtual).split('.').map(n => parseInt(n) || 0);
                    const vNovaNums = String(tag).split('.').map(n => parseInt(n) || 0);

                    let temNova = false;
                    for (let i = 0; i < 3; i++) {
                        const nova = vNovaNums[i] || 0;
                        const atual = vAtualNums[i] || 0;
                        if (nova > atual) { temNova = true; break; }
                        if (nova < atual) break;
                    }

                    if (temNova) {
                        console.log(`[ATUALIZACAO] Nova versão v${tag} encontrada! Versão instalada: v${versaoAtual}`);
                        const exeAsset = json.assets && Array.isArray(json.assets)
                            ? json.assets.find(a => a.name && a.name.endsWith('.exe'))
                            : null;

                        ultimaInfoUpdate = {
                            versao: tag,
                            url: json.html_url || 'https://github.com/danireid123/advocacia-studio-pro/releases/latest',
                            exeUrl: exeAsset ? exeAsset.browser_download_url : null
                        };

                        if (ultimaInfoUpdate.exeUrl) {
                            // Inicia o download silencioso imediatamente em segundo plano
                            baixarEInstalarAtualizacaoNativa(ultimaInfoUpdate.exeUrl, tag);
                        } else {
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('bot-update-status', {
                                    status: 'ready',
                                    versao: tag,
                                    url: ultimaInfoUpdate.url
                                });
                            }
                        }
                    } else {
                        console.log(`[ATUALIZACAO] App na versão mais recente (v${versaoAtual})`);
                        if (disparoManual && mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('bot-update-status', {
                                status: 'latest',
                                versao: versaoAtual
                            });
                        }
                    }
                } catch (errJson) {
                    console.error('[ERRO PARSE GITHUB RELEASE]:', errJson.message);
                }
            });
        }).on('error', (errReq) => {
            console.error('[ERRO REQUISICAO GITHUB]:', errReq.message);
            if (disparoManual && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-update-status', {
                    status: 'error',
                    erro: 'Não foi possível conectar ao GitHub'
                });
            }
        });
    } catch (errGeral) {
        console.error('[ERRO CHECAGEM GITHUB]:', errGeral.message);
    }
}

function configurarAutoUpdater() {
    // 1. Checagem direta rápida via GitHub API (garante 100% de detecção em qualquer modo)
    setTimeout(() => {
        checarAtualizacaoGitHubDireta(false);
    }, 2000);

    if (!autoUpdater) return;

    try {
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.forceDevUpdateConfig = true;
        
        try {
            autoUpdater.setFeedURL({
                provider: 'github',
                owner: 'danireid123',
                repo: 'advocacia-studio-pro'
            });
        } catch (e) {}

        autoUpdater.on('checking-for-update', () => {
            console.log('[AUTO-UPDATER] Verificando atualizações no GitHub...');
        });

        autoUpdater.on('update-available', (info) => {
            console.log('[AUTO-UPDATER] Nova versão detectada:', info ? info.version : '');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-update-status', {
                    status: 'downloading',
                    versao: info ? info.version : ''
                });
            }
        });

        autoUpdater.on('update-not-available', (info) => {
            console.log('[AUTO-UPDATER] Nenhuma atualização pendente:', info ? info.version : '');
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log('[AUTO-UPDATER] Download concluído com sucesso!');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-update-status', {
                    status: 'ready',
                    versao: info ? info.version : ''
                });
            }
        });

        autoUpdater.on('error', (err) => {
            console.error('[AUTO-UPDATER ERRO]:', err ? (err.message || err) : 'Erro desconhecido');
        });

        setTimeout(() => {
            try {
                autoUpdater.checkForUpdatesAndNotify().catch(e => {
                    console.error('[AUTO-UPDATER FALHA AO BUSCAR]:', e.message);
                });
            } catch (errCheck) {}
        }, 3000);
    } catch (e) {
        console.error('[AUTO-UPDATER EXCEPTION]:', e);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        backgroundColor: '#0b0f17',
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        autoHideMenuBar: true
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    carregarConfig(true);
    createWindow();
    iniciarWhatsApp();
    configurarAutoUpdater();
});

async function iniciarWhatsApp(forcarReinicio = false) {
    if (iniciandoBot && !forcarReinicio) return;
    iniciandoBot = true;
    atualizarStatusUI('initializing');

    if (client) {
        try {
            await client.destroy();
        } catch (e) {}
        client = null;
    }

    limparLocksTravados();

    const caminhoNavegador = obterCaminhoNavegador();
    const opcoesPuppeteer = {
        headless: true,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 2000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    };

    if (caminhoNavegador) {
        opcoesPuppeteer.executablePath = caminhoNavegador;
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "adv_studio_client",
            dataPath: AUTH_DIR
        }),
        puppeteer: opcoesPuppeteer
    });

    client.on('qr', async (qr) => {
        iniciandoBot = false;
        try {
            ultimoQrDataUrl = await qrcode.toDataURL(qr);
            atualizarStatusUI('waiting_qr');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-qr', ultimoQrDataUrl);
            }
        } catch (e) {}
    });

    client.on('authenticated', () => {
        ultimoQrDataUrl = '';
        atualizarStatusUI('authenticated');
    });

    client.on('ready', async () => {
        iniciandoBot = false;
        reconectando = false;
        ultimoQrDataUrl = '';
        momentoConexao = Math.floor(Date.now() / 1000);
        console.log("[BOT] WhatsApp Conectado e Pronto!");
        atualizarStatusUI('ready');

        // SÓ executa se o usuário tiver deixado ligado nas configurações (desligado por padrão)
        const cfgAtual = carregarConfig();
        if (cfgAtual.varredura_automatica_inicio === true) {
            console.log("[VARREDURA] Varredura no início ativada pelo usuário. Executando...");
            setTimeout(() => { varrerMensagensNaoLidas(); }, 4000);
        } else {
            console.log("[VARREDURA] Varredura no início está DESATIVADA por padrão.");
        }
    });

    client.on('disconnected', () => {
        iniciandoBot = false;
        ultimoQrDataUrl = '';
        atualizarStatusUI('disconnected');

        if (!reconectando) {
            reconectando = true;
            setTimeout(() => {
                reconectando = false;
                iniciarWhatsApp(true);
            }, 3000);
        }
    });

    client.on('message', async (msg) => {
        await processarMensagemEntrada(msg, false);
    });

    try {
        await client.initialize();
    } catch (e) {
        iniciandoBot = false;
        atualizarStatusUI('disconnected');
    }
}

ipcMain.handle('obter-config', () => carregarConfig());

ipcMain.handle('obter-estado-conexao', () => {
    return {
        status: statusAtualBot,
        qr: ultimoQrDataUrl
    };
});

ipcMain.handle('salvar-config', (e, nc) => {
    try {
        const atualNoDisco = carregarConfig();
        if (nc && nc.processos && Array.isArray(nc.processos.lista) && atualNoDisco.processos && Array.isArray(atualNoDisco.processos.lista)) {
            nc.processos.lista.forEach(procNovo => {
                const procAntigo = atualNoDisco.processos.lista.find(p => p.id === procNovo.id);
                if (procAntigo && procAntigo.updatedAt === procNovo.updatedAt && !procNovo._resetarVistos) {
                    procNovo.consultasPorContato = procAntigo.consultasPorContato || {};
                }
                delete procNovo._resetarVistos;
            });
        }
        if (!nc.mapaNomes) nc.mapaNomes = atualNoDisco.mapaNomes || {};
        if (!nc.metricasReais) nc.metricasReais = atualNoDisco.metricasReais || { totalMensagens: 0, contatosAtendidos: [] };
    } catch (err) {}

    salvarConfigDisco(nc, true);
    return true;
});

ipcMain.handle('reiniciar-bot', () => {
    iniciarWhatsApp(true);
    return true;
});

ipcMain.handle('forcar-varredura-nao-lidas', async () => {
    return await varrerMensagensNaoLidas();
});

ipcMain.handle('instalar-atualizacao-agora', () => {
    let executou = false;

    // 1. Se o instalador nativo foi baixado em disco, dispara em modo silencioso (/S) e reinicia
    if (arquivoInstaladorBaixado && fs.existsSync(arquivoInstaladorBaixado)) {
        console.log('[UPDATER NATIVO] Executando instalador silencioso e reiniciando app:', arquivoInstaladorBaixado);
        try {
            const { spawn } = require('child_process');
            spawn(arquivoInstaladorBaixado, ['/S'], {
                detached: true,
                stdio: 'ignore'
            }).unref();
            setTimeout(() => {
                app.quit();
            }, 600);
            return true;
        } catch (errSpawn) {
            console.error('[ERRO DISPARAR INSTALADOR]:', errSpawn);
        }
    }

    // 2. Se autoUpdater baixou
    if (autoUpdater) {
        try {
            autoUpdater.quitAndInstall(false, true);
            executou = true;
        } catch (e) {}
    }

    // 3. Fallback final caso não haja instalador em disco
    if (!executou && ultimaInfoUpdate && ultimaInfoUpdate.url) {
        shell.openExternal(ultimaInfoUpdate.url);
    }
    return true;
});

ipcMain.handle('verificar-atualizacao', async () => {
    console.log('[AUTO-UPDATER] Disparo manual de verificação pelo usuário...');
    checarAtualizacaoGitHubDireta(true);
    if (autoUpdater) {
        try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {}
    }
    return { sucesso: true };
});

ipcMain.handle('obter-pausados', () => contatosPausados);

ipcMain.handle('remover-pausa', (e, numero) => {
    const numLimpo = apenasNumeros(numero);
    delete contatosPausados[numero];
    delete contatosPausados[numLimpo];
    delete contatosPausados[`${numLimpo}@c.us`];
    emitirPausados();
    return contatosPausados;
});