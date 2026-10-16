const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

process.on('uncaughtException', (err) => {
    console.error('[Proteção Anti-Crash] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Proteção Anti-Crash] unhandledRejection:', reason);
});

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
let tentativasReconexao = 0;
let timerReconexao = null;
let varrendoNaoLidas = false;
let instalandoUpdate = false;
let baixandoUpdate = false;
let caminhoInstaladorBaixado = null;
let statusAtualBot = 'initializing';
let subStatusDetalhado = 'Preparando ambiente seguro...';
let ultimoQrDataUrl = '';
let timerGravacaoDisco = null;
let timerHeartbeatShutdown = null;

// Estado em memória da Triagem Offline e controle de IDs já decididos pelo advogado
let offlineTriageList = [];
const handledOfflineMsgIds = new Set();
let timersVarreduraPosReady = [];
let intervaloVarreduraContinua = null;

function sincronizarHandledIdsComConfig(cfg) {
    try {
        const c = cfg || carregarConfig();
        if (Array.isArray(c.idsMensagensVarreduraRespondidas)) {
            for (const id of c.idsMensagensVarreduraRespondidas) {
                if (id) handledOfflineMsgIds.add(String(id));
            }
        }
    } catch (e) {}
}

function registrarMsgIdOfflineProcessado(msgId, chatId = null, msgTimestampSec = null) {
    try {
        const cfg = carregarConfig();
        if (!Array.isArray(cfg.idsMensagensVarreduraRespondidas)) {
            cfg.idsMensagensVarreduraRespondidas = [];
        }
        if (msgId) {
            const idStr = String(msgId);
            handledOfflineMsgIds.add(idStr);
            mensagensJaProcessadas.add(idStr);
            if (!cfg.idsMensagensVarreduraRespondidas.includes(idStr)) {
                cfg.idsMensagensVarreduraRespondidas.push(idStr);
            }
        }
        if (chatId && msgTimestampSec) {
            if (!cfg.ultimoTimestampTriadoPorChat) cfg.ultimoTimestampTriadoPorChat = {};
            const atual = cfg.ultimoTimestampTriadoPorChat[chatId] || 0;
            if (msgTimestampSec > atual) {
                cfg.ultimoTimestampTriadoPorChat[chatId] = msgTimestampSec;
            }
        }
        if (cfg.idsMensagensVarreduraRespondidas.length > 800) {
            cfg.idsMensagensVarreduraRespondidas = cfg.idsMensagensVarreduraRespondidas.slice(-800);
        }
        salvarConfigDisco(cfg, false);
    } catch (e) {}
}

const GITHUB_OWNER = 'danireid123';
const GITHUB_REPO = 'advocacia-studio-pro';

const USER_DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA_DIR, 'config.json');
const CONFIG_BACKUP_PATH = path.join(USER_DATA_DIR, 'config.backup.json');
const IGNORED_CONTACTS_PATH = path.join(USER_DATA_DIR, 'ignored_contacts.json');
const AUTH_DIR = path.join(USER_DATA_DIR, 'wwebjs_auth_session_v2');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function carregarContatosIgnorados() {
    try {
        if (fs.existsSync(IGNORED_CONTACTS_PATH)) {
            const raw = fs.readFileSync(IGNORED_CONTACTS_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (e) {}
    try {
        const cfg = carregarConfig();
        if (Array.isArray(cfg.contatosIgnorados)) return cfg.contatosIgnorados;
    } catch (e) {}
    return [];
}

function salvarContatosIgnorados(lista) {
    try {
        const limpa = Array.isArray(lista) ? lista : [];
        fs.writeFileSync(IGNORED_CONTACTS_PATH, JSON.stringify(limpa, null, 2), 'utf-8');
        const cfg = carregarConfig();
        cfg.contatosIgnorados = limpa;
        salvarConfigDisco(cfg, false);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-ignorados-sync', limpa);
        }
        return true;
    } catch (e) {
        return false;
    }
}

function isContactIgnored(fromNumber, ignoredList) {
    const cleanNumber = String(fromNumber || '').replace(/\D/g, '');
    if (!cleanNumber) return false;
    const list = Array.isArray(ignoredList) ? ignoredList : carregarContatosIgnorados();
    if (!Array.isArray(list) || list.length === 0) return false;
    return list
        .map(item => {
            const itemNum = typeof item === 'object' && item !== null ? (item.numero || item.telefone || '') : item;
            return String(itemNum || '').replace(/\D/g, '');
        })
        .filter(item => item.length >= 4) // ignora entradas vazias ou curtas
        .some(item => cleanNumber.includes(item));
}

function obterIconeNativo() {
    try {
        const pngPath = path.join(__dirname, 'icon.png');
        const icoPath = path.join(__dirname, 'icon.ico');
        const alvo = fs.existsSync(pngPath) ? pngPath : (fs.existsSync(icoPath) ? icoPath : null);
        if (!alvo) return undefined;
        let img = nativeImage.createFromPath(alvo);
        if (!img.isEmpty()) {
            return img.resize({ width: 256, height: 256, quality: 'best' });
        }
        return alvo;
    } catch (e) {
        return undefined;
    }
}

function configurarAutoStartWindows(ativar) {
    try {
        if (process.platform === 'win32' && app.isPackaged) {
            app.setLoginItemSettings({
                openAtLogin: Boolean(ativar),
                path: process.execPath
            });
        }
    } catch (e) {}
}

function obterCaminhoNavegador() {
    const progFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';

    const caminhosWindows = [
        path.join(progFiles, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(progFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(progFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(progFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe')
    ];
    for (const caminho of caminhosWindows) {
        if (caminho && fs.existsSync(caminho)) return caminho;
    }
    return undefined;
}

function limparLocksTravados() {
    try {
        const pastaSessao = path.join(AUTH_DIR, 'session-adv_studio_client');
        const possiveisLocks = [
            path.join(pastaSessao, 'SingletonLock'),
            path.join(pastaSessao, 'lockfile'),
            path.join(pastaSessao, 'Default', 'SingletonLock'),
            path.join(pastaSessao, 'Default', 'lockfile')
        ];
        for (const arq of possiveisLocks) {
            if (fs.existsSync(arq)) {
                try { fs.unlinkSync(arq); } catch (e) {}
            }
        }
    } catch (e) {}
}

function criarConfigPadrao() {
    const msgPadraoAtualizacao = "⚖️ *Andamento Processual Localizado*\n\nOlá, *{nome}*!\nReferente ao processo nº *{processo}* (CPF: *{cpf}*):\n\n📋 *Resumo da Atualização ({data}):*\n{resumo}\n\n━━━━━━━━━━━━━━━━━━━━\nDigite *1* para encerrar a conversa\nDigite *2* para falar com um advogado";
    const msgPadraoJaVisto = "⚖️ *Consulta Processual*\n\nOlá, *{nome}*! Verificamos a pasta do seu processo nº *{processo}* e informamos que *não houve novas movimentações* desde a sua última consulta em *{ultima_consulta}*.\n\n📌 *Último resumo registrado ({data}):*\n{resumo}\n\n━━━━━━━━━━━━━━━━━━━━\nDigite *1* para encerrar a conversa\nDigite *2* para falar com um advogado";
    const msgPadraoSemAtualizacao = "⚖️ *Consulta Processual*\n\nOlá, *{nome}*! Seu processo nº *{processo}* está devidamente cadastrado em nosso sistema, porém ainda não possui movimentações ou resumos lançados até o momento.\n\n━━━━━━━━━━━━━━━━━━━━\nDigite *1* para encerrar a conversa\nDigite *2* para falar com um advogado";

    return {
        versao_config: "Beta 0.8",
        iniciar_com_windows: true,
        varredura_automatica_inicio: true,
        responder_offline_automaticamente: false,
        primeiraConexaoTimestamp: 0,
        ultimoDesligamentoTimestamp: 0,
        ultimoInicioTimestamp: 0,
        historicoVarreduras: [],
        idsMensagensVarreduraRespondidas: [],
        ultimoTimestampTriadoPorChat: {},
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
                    { gatilho: "3", rotulo: "Falar diretamente com Advogado", tipo: "humano", destino: "", resposta: "Perfeito! Sua solicitação foi encaminhada e um advogado da nossa equipe já está chegando para assumir seu atendimento." }
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
                msg_com_atualizacao: msgPadraoAtualizacao,
                msg_ja_visto: msgPadraoJaVisto,
                msg_sem_atualizacao: msgPadraoSemAtualizacao,
                msg_nao_encontrado: "⚠️ Não conseguimos localizar nenhum processo com o *CPF* ou *Número de Processo* informado.\n\nPor favor, envie novamente apenas os números do seu CPF ou do Processo, ou digite *0* para voltar ao Menu Inicial.",
                msg_encerrar_conversa: "✅ *Atendimento Finalizado!*\n\nAgradecemos o seu contato. Sempre que precisar consultar seu processo ou falar conosco, basta enviar uma mensagem por aqui. Tenha um excelente dia!",
                msg_chamar_advogado_pos_proc: "👨‍⚖️ *Solicitação Recebida!*\n\nUm advogado da nossa equipe já foi notificado e *já está chegando* para assumir o seu atendimento pessoalmente. Por gentileza, aguarde alguns instantes."
            },
            lista: []
        },
        mapaNomes: {},
        mapaTelefones: {},
        pausadosPersistidos: {},
        contatosIgnorados: [],
        metricasReais: { totalMensagens: 0, contatosAtendidos: [] }
    };
}

function migrarTemplatesAntigosProcessos(cfg) {
    const padrao = criarConfigPadrao();
    if (!cfg.processos) cfg.processos = padrao.processos;
    if (!cfg.processos.mensagens) cfg.processos.mensagens = padrao.processos.mensagens;

    const m = cfg.processos.mensagens;
    const substituirRodapeAntigo = (txt) => {
        if (!txt) return txt;
        return txt.replace(/_\(Digite \*0\* para voltar ao Menu Principal ou \*3\* para falar com um advogado\)_/gi,
            "━━━━━━━━━━━━━━━━━━━━\nDigite *1* para encerrar a conversa\nDigite *2* para falar com um advogado");
    };

    m.msg_com_atualizacao = substituirRodapeAntigo(m.msg_com_atualizacao || padrao.processos.mensagens.msg_com_atualizacao);
    m.msg_ja_visto = substituirRodapeAntigo(m.msg_ja_visto || padrao.processos.mensagens.msg_ja_visto);
    m.msg_sem_atualizacao = substituirRodapeAntigo(m.msg_sem_atualizacao || padrao.processos.mensagens.msg_sem_atualizacao);

    if (!m.msg_encerrar_conversa) m.msg_encerrar_conversa = padrao.processos.mensagens.msg_encerrar_conversa;
    if (!m.msg_chamar_advogado_pos_proc) m.msg_chamar_advogado_pos_proc = padrao.processos.mensagens.msg_chamar_advogado_pos_proc;

    if (typeof cfg.iniciar_com_windows === 'undefined') cfg.iniciar_com_windows = true;
    if (typeof cfg.varredura_automatica_inicio === 'undefined') cfg.varredura_automatica_inicio = true;
    if (typeof cfg.responder_offline_automaticamente === 'undefined') cfg.responder_offline_automaticamente = false;
    if (!cfg.mapaNomes) cfg.mapaNomes = {};
    if (!cfg.mapaTelefones) cfg.mapaTelefones = {};
    if (!cfg.pausadosPersistidos) cfg.pausadosPersistidos = {};
    if (!cfg.ultimoTimestampTriadoPorChat || typeof cfg.ultimoTimestampTriadoPorChat !== 'object') cfg.ultimoTimestampTriadoPorChat = {};
    if (!Array.isArray(cfg.contatosIgnorados)) cfg.contatosIgnorados = [];
    if (!Array.isArray(cfg.historicoVarreduras)) cfg.historicoVarreduras = [];
    if (!Array.isArray(cfg.idsMensagensVarreduraRespondidas)) cfg.idsMensagensVarreduraRespondidas = [];
    return cfg;
}

function carregarConfig(forcarDisco = false) {
    if (configEmMemoria && !forcarDisco) return configEmMemoria;
    try {
        const padrao = criarConfigPadrao();
        if (!fs.existsSync(CONFIG_PATH)) {
            if (fs.existsSync(CONFIG_BACKUP_PATH)) {
                const recuperado = JSON.parse(fs.readFileSync(CONFIG_BACKUP_PATH, 'utf-8'));
                configEmMemoria = migrarTemplatesAntigosProcessos({ ...padrao, ...recuperado });
                sincronizarHandledIdsComConfig(configEmMemoria);
                salvarConfigDisco(configEmMemoria, true);
                return configEmMemoria;
            }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(padrao, null, 2), 'utf-8');
            configEmMemoria = padrao;
            sincronizarHandledIdsComConfig(configEmMemoria);
            return configEmMemoria;
        }
        const lido = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        configEmMemoria = migrarTemplatesAntigosProcessos({ ...padrao, ...lido });
        sincronizarHandledIdsComConfig(configEmMemoria);
        if (configEmMemoria.pausadosPersistidos) {
            contatosPausados = { ...configEmMemoria.pausadosPersistidos, ...contatosPausados };
        }
        return configEmMemoria;
    } catch (e) {
        try {
            if (fs.existsSync(CONFIG_BACKUP_PATH)) {
                configEmMemoria = migrarTemplatesAntigosProcessos(JSON.parse(fs.readFileSync(CONFIG_BACKUP_PATH, 'utf-8')));
                sincronizarHandledIdsComConfig(configEmMemoria);
                return configEmMemoria;
            }
        } catch (err2) {}
        configEmMemoria = criarConfigPadrao();
        return configEmMemoria;
    }
}

function salvarConfigDisco(cfg, imediato = false) {
    configEmMemoria = cfg;
    configEmMemoria.pausadosPersistidos = contatosPausados;
    const gravar = () => {
        try {
            const payload = JSON.stringify(configEmMemoria, null, 2);
            fs.writeFileSync(CONFIG_PATH, payload, 'utf-8');
            fs.writeFileSync(CONFIG_BACKUP_PATH, payload, 'utf-8');
        } catch (e) {}
    };
    if (imediato) {
        gravar();
        return;
    }
    clearTimeout(timerGravacaoDisco);
    timerGravacaoDisco = setTimeout(gravar, 350);
}

function apenasNumeros(str) {
    return String(str || '').replace(/\D/g, '');
}

function formatarTelefoneBrasil(num) {
    const limpo = apenasNumeros(num);
    if (!limpo) return 'Contato';
    if (limpo.length === 13 && limpo.startsWith('55')) {
        return `+55 (${limpo.substring(2, 4)}) ${limpo.substring(4, 9)}-${limpo.substring(9)}`;
    }
    if (limpo.length === 12 && limpo.startsWith('55')) {
        return `+55 (${limpo.substring(2, 4)}) ${limpo.substring(4, 8)}-${limpo.substring(8)}`;
    }
    if (limpo.length === 11) {
        return `(${limpo.substring(0, 2)}) ${limpo.substring(2, 7)}-${limpo.substring(7)}`;
    }
    if (limpo.length === 10) {
        return `(${limpo.substring(0, 2)}) ${limpo.substring(2, 6)}-${limpo.substring(6)}`;
    }
    if (limpo.length > 13) {
        return `ID #${limpo.slice(-6)}`;
    }
    return `+${limpo}`;
}

async function resolverIdentidadeCompleta(msg, config) {
    const chatId = msg.from || '';
    const parteId = chatId.split('@')[0];
    let numeroReal = apenasNumeros(parteId);

    let nomeAgenda = '';
    let nomePush = (msg._data && (msg._data.notifyName || msg._data.pushname)) || '';

    try {
        const contato = await msg.getContact();
        if (contato) {
            if (contato.number) {
                numeroReal = apenasNumeros(contato.number);
            }
            if (contato.name) {
                nomeAgenda = String(contato.name).trim();
            }
            if (!nomePush && contato.pushname) {
                nomePush = String(contato.pushname).trim();
            }
        }
    } catch (e) {}

    const chaveUnica = numeroReal || parteId;
    const nomeEscolhido = nomeAgenda || nomePush || (config.mapaNomes && config.mapaNomes[chaveUnica]) || '';

    if (nomeEscolhido) {
        config.mapaNomes[chaveUnica] = nomeEscolhido;
        config.mapaNomes[chatId] = nomeEscolhido;
    }
    if (numeroReal) {
        config.mapaTelefones[chaveUnica] = formatarTelefoneBrasil(numeroReal);
        config.mapaTelefones[chatId] = formatarTelefoneBrasil(numeroReal);
    }

    const telFormatado = formatarTelefoneBrasil(numeroReal || parteId);
    const exibicaoPrincipal = nomeEscolhido
        ? `${nomeEscolhido} (${telFormatado})`
        : telFormatado;

    return {
        idChat: chatId,
        chaveCliente: chaveUnica,
        nomeCliente: nomeEscolhido,
        temContatoSalvo: Boolean(nomeAgenda),
        telefoneFormatado: telFormatado,
        exibicao: exibicaoPrincipal
    };
}

function extrairGatilhoLimpo(texto) {
    const t = String(texto || '').trim().toLowerCase();
    const matchNumero = t.match(/^(\d+)\s*[\.\-\)]?$/);
    if (matchNumero) return matchNumero[1];
    return t;
}

function emitirPausados() {
    const cfg = carregarConfig();
    salvarConfigDisco(cfg, false);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-pausados', contatosPausados);
    }
}

function atualizarStatusUI(novoStatus, detalheSubStatus = null) {
    statusAtualBot = novoStatus;
    if (detalheSubStatus) subStatusDetalhado = detalheSubStatus;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-status', novoStatus);
        mainWindow.webContents.send('bot-substatus', {
            status: novoStatus,
            detalhe: subStatusDetalhado,
            tentativa: tentativasReconexao
        });
    }
}

function converterHoraParaMinutos(horaStr) {
    const partes = String(horaStr || '00:00').split(':');
    return (parseInt(partes[0], 10) || 0) * 60 + (parseInt(partes[1], 10) || 0);
}

function obterPrefixoHorario(config, remetenteChave) {
    try {
        const agenda = config.agenda;
        if (!agenda) return '';

        const ultimoAviso = avisoForaHorarioRecente[remetenteChave] || 0;
        if (Date.now() - ultimoAviso < 30 * 60 * 1000) return '';

        const agora = new Date();
        const diaSemana = String(agora.getDay());
        const minutosAgora = agora.getHours() * 60 + agora.getMinutes();

        const registrarAviso = () => {
            avisoForaHorarioRecente[remetenteChave] = Date.now();
            if (Object.keys(avisoForaHorarioRecente).length > 500) {
                const limite = Date.now() - 60 * 60 * 1000;
                for (const k in avisoForaHorarioRecente) {
                    if (avisoForaHorarioRecente[k] < limite) delete avisoForaHorarioRecente[k];
                }
            }
        };

        const confDia = agenda[diaSemana];
        if (!confDia || !confDia.ativo) {
            registrarAviso();
            return (agenda.msg_fora_expediente || '').trim() + '\n\n';
        }

        const minAbertura = converterHoraParaMinutos(confDia.abertura || '08:00');
        const minFechamento = converterHoraParaMinutos(confDia.fechamento || '18:00');

        if (minutosAgora < minAbertura || minutosAgora >= minFechamento) {
            registrarAviso();
            return (agenda.msg_fora_expediente || '').trim() + '\n\n';
        }

        if (agenda.almoco_ativo) {
            const minAlmocoIni = converterHoraParaMinutos(agenda.almoco_inicio || '12:00');
            const minAlmocoFim = converterHoraParaMinutos(agenda.almoco_fim || '13:30');
            if (minutosAgora >= minAlmocoIni && minutosAgora < minAlmocoFim) {
                registrarAviso();
                return (agenda.msg_almoco || '').trim() + '\n\n';
            }
        }
    } catch (e) {}
    return '';
}

async function enviarMensagemSegura(msgObj, chatId, texto) {
    if (!client || !texto) return;
    try {
        await client.sendMessage(chatId, texto, { sendSeen: false });
    } catch (err1) {
        try {
            if (msgObj && typeof msgObj.reply === 'function') {
                await msgObj.reply(texto, chatId, { sendSeen: false });
            }
        } catch (err2) {}
    }
}

function montarTextoEtapa(etapa) {
    let txt = (etapa.mensagem || '') + "\n\n";
    (etapa.opcoes || []).forEach(op => {
        txt += `*${op.gatilho}* - ${op.rotulo}\n`;
    });
    return txt.trim();
}

function buscarProcessoPorNumero(config, digitosBusca) {
    if (!config.processos || !Array.isArray(config.processos.lista)) return null;
    if (!digitosBusca || digitosBusca.length < 5) return null;

    return config.processos.lista.find(p => {
        const cpfLimpo = apenasNumeros(p.cpf);
        const numLimpo = apenasNumeros(p.numero);
        return (cpfLimpo && cpfLimpo === digitosBusca) ||
               (numLimpo && numLimpo === digitosBusca) ||
               (cpfLimpo && cpfLimpo.length >= 5 && digitosBusca.includes(cpfLimpo)) ||
               (numLimpo && numLimpo.length >= 5 && digitosBusca.includes(numLimpo));
    });
}

function formatarMensagemProcesso(config, proc, remetenteChave) {
    const tpls = (config.processos && config.processos.mensagens) || criarConfigPadrao().processos.mensagens;
    const temResumo = Boolean(proc.temAtualizacao && proc.resumo && proc.resumo.trim());

    if (!proc.consultasPorContato) proc.consultasPorContato = {};
    const ultimaConsulta = proc.consultasPorContato[remetenteChave];
    const agoraTexto = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

    let modelo = tpls.msg_sem_atualizacao;
    if (temResumo) {
        if (ultimaConsulta && !proc._resetarVistos) {
            modelo = tpls.msg_ja_visto;
        } else {
            modelo = tpls.msg_com_atualizacao;
        }
    }

    proc.consultasPorContato[remetenteChave] = agoraTexto;
    proc._resetarVistos = false;
    salvarConfigDisco(config, true);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-processos-sync', config);
    }

    return String(modelo || '')
        .replace(/\{nome\}/g, proc.nome || 'Cliente')
        .replace(/\{cpf\}/g, proc.cpf || '-')
        .replace(/\{processo\}/g, proc.numero || '-')
        .replace(/\{resumo\}/g, proc.resumo || 'Sem detalhes adicionais.')
        .replace(/\{data\}/g, proc.dataAtualizacaoTexto || agoraTexto)
        .replace(/\{ultima_consulta\}/g, ultimaConsulta || agoraTexto);
}

// Adiciona ou atualiza um item na lista de triagem offline a partir de um evento de mensagem tardia (ex: client.on('message') com timestamp anterior a momentoConexao)
async function adicionarOuAtualizarItemTriagemDeMsg(msg, config) {
    try {
        if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return false;
        const chatId = msg.from || '';
        if (!chatId || chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast')) return false;

        const listaIgnorados = carregarContatosIgnorados();
        if (isContactIgnored(chatId, listaIgnorados) || (msg.author && isContactIgnored(msg.author, listaIgnorados))) {
            return false;
        }

        const msgId = (msg.id && (msg.id._serialized || msg.id.id)) ? (msg.id._serialized || msg.id.id) : `${chatId}_${msg.timestamp || Math.floor(Date.now() / 1000)}`;
        const msgTimestampSec = msg.timestamp || Math.floor(Date.now() / 1000);
        const msgTimestampMs = msgTimestampSec * 1000;

        // Se o advogado ativou a resposta automática imediata de mensagens offline:
        if (config.responder_offline_automaticamente === true) {
            return await processarMensagemEntrada(msg, true);
        }

        const identidade = await resolverIdentidadeCompleta(msg, config);
        if (isContactIgnored(identidade.chaveCliente, listaIgnorados) || isContactIgnored(identidade.telefoneFormatado, listaIgnorados)) {
            return false;
        }

        const rawUser = chatId.split('@')[0];
        const contactName = identidade.nomeCliente || rawUser;
        const phoneNumber = identidade.telefoneFormatado || rawUser;
        const bodyPreview = String(msg.body || '').trim() || '[Mídia/Áudio/Documento]';

        const idxExistente = offlineTriageList.findIndex(item => item.chatId === chatId);
        const novoItem = {
            chatId,
            msgId,
            contactName,
            phoneNumber,
            unreadCount: idxExistente >= 0 ? Math.max(1, (offlineTriageList[idxExistente].unreadCount || 1)) : 1,
            messagePreview: bodyPreview,
            rawBody: String(msg.body || '').trim() || 'Olá',
            timestamp: msgTimestampMs,
            timestampSec: msgTimestampSec,
            timeFormatted: new Date(msgTimestampMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
            relativeTime: formatRelativeTime(msgTimestampMs)
        };

        if (idxExistente >= 0) {
            if (msgTimestampMs >= offlineTriageList[idxExistente].timestamp) {
                offlineTriageList[idxExistente] = novoItem;
            }
        } else {
            offlineTriageList.push(novoItem);
        }

        offlineTriageList.sort((a, b) => b.timestamp - a.timestamp);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('offline-triage-updated', offlineTriageList); mainWindow.webContents.send('triage:updated', offlineTriageList);
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function processarMensagemEntrada(msg, origemVarreduraOffline = false) {
    try {
        if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return false;
        if (!msg.from || msg.from.includes('@g.us') || msg.from.includes('@newsletter') || msg.from.includes('@broadcast')) return false;

        // SUB-AGENTE 2: Interceptador de Contatos Ignorados (Descarte imediato antes de qualquer resposta)
        const senderId = msg.from || '';
        if (isContactIgnored(senderId) || (msg.author && isContactIgnored(msg.author))) {
            return false;
        }

        const msgId = (msg.id && (msg.id._serialized || msg.id.id)) ? (msg.id._serialized || msg.id.id) : `${msg.from}_${msg.timestamp}_${msg.body}`;
        if (!origemVarreduraOffline && mensagensJaProcessadas.has(msgId)) return false;

        const config = carregarConfig();
        sincronizarHandledIdsComConfig(config);

        if (!origemVarreduraOffline && (handledOfflineMsgIds.has(msgId) || (Array.isArray(config.idsMensagensVarreduraRespondidas) && config.idsMensagensVarreduraRespondidas.includes(msgId)))) {
            return false;
        }

        // CORREÇÃO CRÍTICA (CAUSA RAIZ 2):
        // Se uma mensagem chega pelo evento client.on('message') após abrir o app, mas o timestamp dela é anterior
        // ao momentoConexao (significa que foi enviada enquanto o bot estava fechado!), NÃO descartamos mais!
        // Roteamos imediatamente para a Central de Triagem Offline (ou auto-respondemos se responder_offline_automaticamente estiver ativo).
        if (!origemVarreduraOffline && msg.timestamp && momentoConexao > 0 && msg.timestamp < (momentoConexao - 10)) {
            await adicionarOuAtualizarItemTriagemDeMsg(msg, config);
            return false;
        }

        let textoOriginal = String(msg.body || '').trim();
        if (!textoOriginal) {
            if (origemVarreduraOffline) {
                textoOriginal = 'Olá';
            } else {
                return false;
            }
        }

        mensagensJaProcessadas.add(msgId);
        if (mensagensJaProcessadas.size > 2000) {
            const primeiroItem = mensagensJaProcessadas.values().next().value;
            mensagensJaProcessadas.delete(primeiroItem);
        }

        // Registra como processada tanto para mensagens ao vivo quanto de varredura offline,
        // garantindo que não reapareça como pendente em futuras varreduras
        registrarMsgIdOfflineProcessado(msgId, msg.from, msg.timestamp || Math.floor(Date.now() / 1000));

        const identidade = await resolverIdentidadeCompleta(msg, config);
        const remetenteChave = identidade.chaveCliente;

        // Verificação redundante com número real limpo da identidade
        if (isContactIgnored(remetenteChave) || isContactIgnored(identidade.telefoneFormatado)) {
            return false;
        }

        const gatilhoDigitado = extrairGatilhoLimpo(textoOriginal);

        const registroPausa = contatosPausados[remetenteChave] || contatosPausados[msg.from];
        const tsPausa = typeof registroPausa === 'object' ? registroPausa.timestamp : registroPausa;
        if (!origemVarreduraOffline && tsPausa && (Date.now() - tsPausa < 24 * 60 * 60 * 1000)) {
            return false;
        }

        if (!config.metricasReais) config.metricasReais = { totalMensagens: 0, contatosAtendidos: [] };
        config.metricasReais.totalMensagens += 1;
        if (!config.metricasReais.contatosAtendidos.includes(remetenteChave)) {
            config.metricasReais.contatosAtendidos.push(remetenteChave);
        }
        salvarConfigDisco(config, false);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-log', {
                numero: identidade.telefoneFormatado,
                nome: identidade.nomeCliente || '',
                exibicao: identidade.exibicao,
                msg: textoOriginal,
                origemOffline: origemVarreduraOffline,
                hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                metricasReais: {
                    totalMensagens: config.metricasReais.totalMensagens,
                    totalContatos: config.metricasReais.contatosAtendidos.length
                }
            });
        }

        const prefixoHorario = obterPrefixoHorario(config, remetenteChave);
        const responderCliente = async (txt) => {
            await enviarMensagemSegura(msg, msg.from, prefixoHorario + txt);
        };

        const colocarNaFilaHumana = async (mensagemConfirmacao) => {
            contatosPausados[remetenteChave] = {
                timestamp: Date.now(),
                nome: identidade.nomeCliente || '',
                telefone: identidade.telefoneFormatado,
                exibicao: identidade.exibicao,
                idChat: msg.from
            };
            delete estadosUsuarios[remetenteChave];
            emitirPausados();
            await responderCliente(mensagemConfirmacao);
        };

        const estadoAtual = estadosUsuarios[remetenteChave] || 'raiz';
        const tplsProc = (config.processos && config.processos.mensagens) || criarConfigPadrao().processos.mensagens;

        if (estadoAtual === 'pos_consulta_processo') {
            if (gatilhoDigitado === '1') {
                delete estadosUsuarios[remetenteChave];
                await responderCliente(tplsProc.msg_encerrar_conversa || "✅ Atendimento finalizado! Agradecemos o seu contato.");
                return true;
            }
            if (gatilhoDigitado === '2') {
                await colocarNaFilaHumana(tplsProc.msg_chamar_advogado_pos_proc || "👨‍⚖️ Perfeito! Um advogado da nossa equipe já foi acionado e já está chegando para atender você.");
                return true;
            }
        }

        const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "menu", "inicio", "início", "ajuda"];
        if (gatilhoDigitado === "0" || saudacoes.some(s => gatilhoDigitado === s || gatilhoDigitado.startsWith(s + " "))) {
            estadosUsuarios[remetenteChave] = 'raiz';
            await responderCliente(montarTextoEtapa(config.fluxo.raiz));
            return true;
        }

        if (estadoAtual === 'aguardando_processo') {
            const digitos = apenasNumeros(textoOriginal);
            const procAchado = buscarProcessoPorNumero(config, digitos);
            if (procAchado) {
                if (procAchado.nome && !config.mapaNomes[remetenteChave]) {
                    config.mapaNomes[remetenteChave] = procAchado.nome;
                }
                estadosUsuarios[remetenteChave] = 'pos_consulta_processo';
                const textoProc = formatarMensagemProcesso(config, procAchado, remetenteChave);
                await responderCliente(textoProc);
                return true;
            } else {
                const msgNaoEncontrado = tplsProc.msg_nao_encontrado || criarConfigPadrao().processos.mensagens.msg_nao_encontrado;
                await responderCliente(msgNaoEncontrado);
                return true;
            }
        }

        const etapaAtual = (estadoAtual === 'raiz' || estadoAtual === 'pos_consulta_processo')
            ? config.fluxo.raiz
            : (config.fluxo.etapas[estadoAtual] || config.fluxo.raiz);

        const opcaoEscolhida = (etapaAtual.opcoes || []).find(op => String(op.gatilho).trim().toLowerCase() === gatilhoDigitado);

        if (opcaoEscolhida) {
            if (opcaoEscolhida.tipo === 'humano') {
                await colocarNaFilaHumana(opcaoEscolhida.resposta || "Perfeito! Um advogado da nossa equipe já está chegando para atender você.");
                return true;
            }
            if (opcaoEscolhida.tipo === 'processo') {
                estadosUsuarios[remetenteChave] = 'aguardando_processo';
                await responderCliente(opcaoEscolhida.resposta || "Por favor, digite apenas o seu *CPF* ou o *Número do Processo*:");
                return true;
            }
            if (opcaoEscolhida.tipo === 'submenu') {
                const dest = opcaoEscolhida.destino || 'raiz';
                estadosUsuarios[remetenteChave] = dest;
                const proxEtapa = dest === 'raiz' ? config.fluxo.raiz : config.fluxo.etapas[dest];
                await responderCliente(montarTextoEtapa(proxEtapa || config.fluxo.raiz));
                return true;
            }
            if (opcaoEscolhida.resposta) {
                await responderCliente(opcaoEscolhida.resposta);
                return true;
            }
        }

        const digitosDiretos = apenasNumeros(textoOriginal);
        if (digitosDiretos.length >= 9) {
            const procDireto = buscarProcessoPorNumero(config, digitosDiretos);
            if (procDireto) {
                if (procDireto.nome && !config.mapaNomes[remetenteChave]) {
                    config.mapaNomes[remetenteChave] = procDireto.nome;
                }
                estadosUsuarios[remetenteChave] = 'pos_consulta_processo';
                const textoProc = formatarMensagemProcesso(config, procDireto, remetenteChave);
                await responderCliente(textoProc);
                return true;
            }
        }

        estadosUsuarios[remetenteChave] = 'raiz';
        await responderCliente(montarTextoEtapa(config.fluxo.raiz));
        return true;
    } catch (e) {
        return false;
    }
}

function emitirProgressoVarredura(dados) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-varredura-progresso', dados);
    }
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // Limite rigoroso de 24 horas

// Função auxiliar para formatar o tempo relativo na UI da triagem
function formatRelativeTime(timestampMs) {
    const diffMin = Math.max(1, Math.floor((Date.now() - timestampMs) / 60000));
    if (diffMin < 60) return `há ${diffMin} min`;
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return `há ${hours}h${mins > 0 ? ` ${mins}min` : ''}`;
}

// Extrai diretamente do Store.Chat do WhatsApp Web (ou de cli.getChats() em ambiente de teste)
// todas as conversas individuais com suas mensagens já carregadas em memória, SEM chamar WAWebChatLoadMessages.loadEarlierMsgs
async function extrairCandidatosStoreDireto(cli) {
    if (cli && cli.pupPage && typeof cli.pupPage.evaluate === 'function' && !cli._isMockClient) {
        try {
            const rawChats = await cli.pupPage.evaluate(() => {
                try {
                    const Store = window.Store;
                    if (!Store || !Store.Chat) return null;
                    const models = Store.Chat.getModelsArray ? Store.Chat.getModelsArray() : (Store.Chat.models || []);
                    const result = [];

                    for (const c of models) {
                        try {
                            const idObj = c.id || {};
                            const chatId = idObj._serialized || (idObj.user ? `${idObj.user}@${idObj.server || 'c.us'}` : String(c.id || ''));
                            if (!chatId || chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast') || chatId === 'status@broadcast') {
                                continue;
                            }
                            const isGroup = Boolean(c.isGroup || chatId.includes('@g.us'));
                            if (isGroup) continue;

                            const unreadCount = typeof c.unreadCount === 'number' ? c.unreadCount : 0;
                            const rawMsgs = (c.msgs && typeof c.msgs.getModelsArray === 'function')
                                ? c.msgs.getModelsArray()
                                : (c.msgs && Array.isArray(c.msgs.models) ? c.msgs.models : []);

                            const serializedMsgs = [];
                            const sliceStart = Math.max(0, rawMsgs.length - 15);
                            for (let i = sliceStart; i < rawMsgs.length; i++) {
                                const m = rawMsgs[i];
                                if (!m) continue;
                                const mId = (m.id && (m.id._serialized || m.id.id)) || '';
                                const fromMe = Boolean(m.id?.fromMe ?? m.fromMe);
                                const type = String(m.type || 'chat');
                                // Se for ciphertext ainda aguardando descriptografia E2EE, sinalizamos
                                const isCiphertext = (type === 'ciphertext');
                                const body = isCiphertext
                                    ? '[Sincronizando criptografia...]'
                                    : String(m.body || m.caption || m.content || '');
                                const timestamp = Number(m.t || m.timestamp || 0);
                                serializedMsgs.push({
                                    id: mId,
                                    fromMe,
                                    type,
                                    isCiphertext,
                                    body,
                                    timestamp,
                                    from: chatId
                                });
                            }

                            // Fallback: se c.msgs estiver vazio mas existir c.lastReceivedKey ou c.t
                            if (serializedMsgs.length === 0 && c.lastReceivedKey) {
                                const lk = c.lastReceivedKey;
                                const lkFromMe = Boolean(lk.fromMe);
                                const lkId = lk._serialized || lk.id || `${chatId}_${c.t || 0}`;
                                serializedMsgs.push({
                                    id: lkId,
                                    fromMe: lkFromMe,
                                    type: 'chat',
                                    isCiphertext: false,
                                    body: '',
                                    timestamp: Number(c.t || 0),
                                    from: chatId
                                });
                            }

                            const contactObj = c.contact || {};
                            const contactName = c.formattedTitle || c.name || contactObj.name || contactObj.pushname || contactObj.shortName || '';
                            const phoneNumber = (contactObj.id && contactObj.id.user) || (idObj && idObj.user) || chatId.split('@')[0];

                            result.push({
                                chatId,
                                unreadCount,
                                markedUnread: Boolean(c.markedUnread),
                                hasUnread: Boolean(c.hasUnread),
                                chatTimestamp: Number(c.t || 0),
                                contactName,
                                phoneNumber,
                                messages: serializedMsgs
                            });
                        } catch (innerErr) {}
                    }
                    return result;
                } catch (e) {
                    return null;
                }
            });

            if (Array.isArray(rawChats)) {
                return rawChats;
            }
        } catch (errEval) {
            console.error('[Triagem Offline] Fallback para getChats após erro em evaluate:', errEval.message);
        }
    }

    // Fallback seguro (ou para ambiente de testes): usa cli.getChats() e chat.lastMessage sem travar em loadEarlierMsgs
    const chats = await cli.getChats();
    const fallbackList = [];
    for (const chat of chats) {
        if (!chat || chat.isGroup) continue;
        const chatId = (chat.id && (chat.id._serialized || chat.id.user)) || String(chat.id || '');
        if (!chatId || chatId.includes('@g.us') || chatId.includes('@newsletter') || chatId.includes('@broadcast')) continue;
        const rawUser = (chat.id && chat.id.user) || chatId.split('@')[0];

        let msgs = [];
        if (Array.isArray(chat._mockMessages)) {
            msgs = chat._mockMessages;
        } else if (chat.lastMessage) {
            const lm = chat.lastMessage;
            msgs = [{
                id: (lm.id && (lm.id._serialized || lm.id.id)) || `${chatId}_${lm.timestamp || chat.timestamp || 0}`,
                fromMe: Boolean(lm.fromMe),
                type: lm.type || 'chat',
                isCiphertext: lm.type === 'ciphertext',
                body: lm.body || '',
                timestamp: Number(lm.timestamp || chat.timestamp || 0),
                from: chatId
            }];
        }

        fallbackList.push({
            chatId,
            unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
            markedUnread: Boolean(chat.markedUnread),
            hasUnread: Boolean(chat.hasUnread),
            chatTimestamp: Number(chat.timestamp || 0),
            contactName: chat.name || rawUser,
            phoneNumber: rawUser,
            messages: msgs
        });
    }
    return fallbackList;
}

// Varredura que popula a Lista de Triagem sem disparar mensagens sem permissão do advogado (a menos que auto-resposta offline esteja ativa)
async function scanOfflineMessagesToTriage(targetClient, win) {
    const cli = targetClient || client;
    const targetWin = win || mainWindow;
    if (!cli || (!cli.pupPage && statusAtualBot !== 'ready')) {
        console.log('[Triagem Offline] WhatsApp ainda não está pronto para varredura.');
        return offlineTriageList;
    }
    if (varrendoNaoLidas) return offlineTriageList;
    varrendoNaoLidas = true;

    try {
        const config = carregarConfig();
        sincronizarHandledIdsComConfig(config);

        // 1. Pressiona Escape na página do Puppeteer para fechar qualquer chat focado por engano
        if (cli.pupPage && typeof cli.pupPage.keyboard?.press === 'function') {
            await cli.pupPage.keyboard.press('Escape').catch(() => {});
        }

        const rawChats = await extrairCandidatosStoreDireto(cli);
        const now = Date.now();
        const nowSec = Math.floor(now / 1000);
        const listaIgnorados = carregarContatosIgnorados();
        const newTriageItems = [];

        // Janela de desligamento: mensagens recebidas após o último desligamento (ou nas últimas 6h antes da conexão caso ultimoDesligamentoTimestamp seja 0)
        // usada como Critério B quando unreadCount foi zerado pelo celular aberto mas o escritório ainda não respondeu!
        const cutoffOfflineWindowSec = (config.ultimoDesligamentoTimestamp && config.ultimoDesligamentoTimestamp > 0)
            ? (config.ultimoDesligamentoTimestamp - 180)
            : ((momentoConexao > 0 ? momentoConexao : nowSec) - 6 * 3600);

        for (const chatData of rawChats) {
            try {
                const { chatId, unreadCount } = chatData;
                const rawUser = chatId.split('@')[0];

                // Verifica Lista de Contatos Ignorados
                if (isContactIgnored(chatId, listaIgnorados) || isContactIgnored(rawUser, listaIgnorados) || isContactIgnored(chatData.phoneNumber, listaIgnorados)) {
                    continue;
                }

                const cleanNum = apenasNumeros(chatId);
                const messages = Array.isArray(chatData.messages) ? chatData.messages : [];

                // REGRA DE NEGÓCIO: bolinha verde / marcado como não lido => SEMPRE entra na triagem (sem travas temporais)
                const isUnreadFlagged = (
                    (typeof unreadCount === 'number' && (unreadCount > 0 || unreadCount === -1)) ||
                    Boolean(chatData.markedUnread) ||
                    Boolean(chatData.hasUnread)
                );
                if (!isUnreadFlagged) continue;

                // Mensagens recebidas do cliente (mais recentes por último)
                const incomingMsgs = messages.filter(m => m && !m.fromMe);
                const qtdNaoLidas = (typeof unreadCount === 'number' && unreadCount > 0) ? unreadCount : 1;
                const unreadIncoming = incomingMsgs.slice(-Math.max(qtdNaoLidas, 1));
                const latestUnread = unreadIncoming.length > 0
                    ? unreadIncoming[unreadIncoming.length - 1]
                    : { id: `${chatId}_${chatData.chatTimestamp || nowSec}`, body: '', timestamp: chatData.chatTimestamp || nowSec, isCiphertext: false };
                const latestMsgId = latestUnread.id || `${chatId}_${latestUnread.timestamp}`;
                const msgTimestampSec = Number(latestUnread.timestamp || chatData.chatTimestamp || nowSec);
                const msgTimestampMs = msgTimestampSec * 1000;

                // Resolve o nome do contato salvo na agenda (com cache em config.mapaNomes)
                let contactName = chatData.contactName || (config.mapaNomes && (config.mapaNomes[cleanNum] || config.mapaNomes[chatId])) || '';
                let phoneNumber = chatData.phoneNumber || rawUser;

                if (!contactName || contactName === rawUser) {
                    try {
                        const contact = await cli.getContactById(chatId);
                        if (contact) {
                            contactName = contact.name || contact.pushname || contactName;
                            phoneNumber = contact.number || phoneNumber;
                        }
                    } catch (e) {}
                }

                if (contactName && cleanNum) {
                    config.mapaNomes[cleanNum] = contactName;
                    config.mapaNomes[chatId] = contactName;
                }
                const formattedPhone = formatarTelefoneBrasil(phoneNumber || rawUser);
                if (!contactName) contactName = formattedPhone;

                if (isContactIgnored(phoneNumber, listaIgnorados) || isContactIgnored(formattedPhone, listaIgnorados)) {
                    continue;
                }

                const combinedText = unreadIncoming
                    .map(m => m.body || '[Mídia/Áudio/Documento]')
                    .join(' | ');

                const rawBodyForBot = String(latestUnread.body || '').trim() || 'Olá';

                // Se o modo de resposta automática offline estiver ativo, responde imediatamente!
                if (config.responder_offline_automaticamente === true && !latestUnread.isCiphertext) {
                    const syntheticMsg = {
                        id: { _serialized: latestMsgId },
                        from: chatId,
                        fromMe: false,
                        body: rawBodyForBot,
                        timestamp: msgTimestampSec,
                        getContact: async () => ({
                            number: apenasNumeros(phoneNumber || rawUser),
                            name: contactName,
                            pushname: contactName
                        })
                    };
                    await processarMensagemEntrada(syntheticMsg, true);
                    continue;
                }

                newTriageItems.push({
                    chatId,
                    msgId: latestMsgId,
                    contactName,
                    phoneNumber: formattedPhone,
                    unreadCount: Math.max(unreadCount > 0 ? unreadCount : 1, unreadIncoming.length),
                    messagePreview: combinedText,
                    rawBody: rawBodyForBot,
                    timestamp: msgTimestampMs,
                    timestampSec: msgTimestampSec,
                    timeFormatted: new Date(msgTimestampMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
                    relativeTime: formatRelativeTime(msgTimestampMs)
                });
            } catch (errItem) {
                console.error('[Triagem Offline] Erro ao analisar chat:', errItem);
            }
        }

        // Ordena das mais recentes para as mais antigas
        offlineTriageList = newTriageItems.sort((a, b) => b.timestamp - a.timestamp);

        if (targetWin && !targetWin.isDestroyed()) {
            targetWin.webContents.send('offline-triage-updated', offlineTriageList);
            targetWin.webContents.send('triage:updated', offlineTriageList);
        }

        console.log(`[Triagem Offline] ${offlineTriageList.length} conversa(s) aguardando decisão do advogado.`);
        return offlineTriageList;
    } catch (err) {
        console.error('[Triagem Offline Erro]', err);
        return offlineTriageList;
    } finally {
        varrendoNaoLidas = false;
    }
}

async function syncOfflineMessages(cli) {
    return await scanOfflineMessagesToTriage(cli, mainWindow);
}

async function varrerMensagensNaoLidas(clienteEspecifico = null) {
    const list = await scanOfflineMessagesToTriage(clienteEspecifico || client, mainWindow);
    return { respondidas: 0, analisadas: list.length, itens: list };
}

function compararVersoes(vNova, vAtual) {
    const limpar = (v) => String(v || '').replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
    const p1 = limpar(vNova);
    const p2 = limpar(vAtual);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const n1 = p1[i] || 0;
        const n2 = p2[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

function requisitarJsonGitHub(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Advocacia-Studio-Pro-Updater', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return requisitarJsonGitHub(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`Status HTTP ${res.statusCode}`));
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function baixarArquivoComProgresso(url, destinoPath, onProgress) {
    return new Promise((resolve, reject) => {
        const fazerDownload = (linkAtual) => {
            https.get(linkAtual, { headers: { 'User-Agent': 'Advocacia-Studio-Pro-Updater' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return fazerDownload(res.headers.location);
                }
                if (res.statusCode !== 200) return reject(new Error(`Falha no download: HTTP ${res.statusCode}`));

                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let baixadosBytes = 0;
                let ultimoPct = -1;
                const fileStream = fs.createWriteStream(destinoPath);

                res.on('data', (chunk) => {
                    baixadosBytes += chunk.length;
                    if (totalBytes > 0) {
                        const pct = Math.min(99, Math.round((baixadosBytes / totalBytes) * 100));
                        if (pct !== ultimoPct) { ultimoPct = pct; onProgress(pct); }
                    }
                });

                res.pipe(fileStream);
                fileStream.on('finish', () => fileStream.close(() => resolve(destinoPath)));
                fileStream.on('error', (err) => { try { fs.unlinkSync(destinoPath); } catch (e) {} reject(err); });
            }).on('error', reject);
        };
        fazerDownload(url);
    });
}

async function verificarEBaixarAtualizacaoGitHub() {
    if (baixandoUpdate || instalandoUpdate || caminhoInstaladorBaixado) return { disponivel: false };
    try {
        const versaoAtual = app.getVersion();
        const release = await requisitarJsonGitHub(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
        if (!release || !release.tag_name) return { disponivel: false };

        const versaoRemota = String(release.tag_name).replace(/^v/i, '').trim();
        if (compararVersoes(versaoRemota, versaoAtual) <= 0) return { disponivel: false };

        const assetExe = (release.assets || []).find(a => a.name && a.name.toLowerCase().endsWith('.exe') && !a.name.toLowerCase().includes('blockmap'));
        if (!assetExe || !assetExe.browser_download_url) return { disponivel: false };

        baixandoUpdate = true;
        const destinoExe = path.join(app.getPath('temp'), `AdvocaciaStudioPro-Update-${versaoRemota}.exe`);
        if (fs.existsSync(destinoExe)) try { fs.unlinkSync(destinoExe); } catch (e) {}

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-update-status', { status: 'downloading', versao: versaoRemota, nomeRelease: release.name || `v${versaoRemota}`, progresso: 1 });
        }

        await baixarArquivoComProgresso(assetExe.browser_download_url, destinoExe, (pct) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-update-status', { status: 'downloading', versao: versaoRemota, nomeRelease: release.name || `v${versaoRemota}`, progresso: pct });
            }
        });

        caminhoInstaladorBaixado = destinoExe;
        baixandoUpdate = false;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-update-status', { status: 'ready', versao: versaoRemota, nomeRelease: release.name || `v${versaoRemota}`, progresso: 100 });
        }
        return { disponivel: true, versao: versaoRemota };
    } catch (err) {
        baixandoUpdate = false;
        return { disponivel: false };
    }
}

function configurarAutoUpdater() {
    setTimeout(() => { verificarEBaixarAtualizacaoGitHub(); }, 4000);
    setInterval(() => { verificarEBaixarAtualizacaoGitHub(); }, 15 * 60 * 1000);
}

async function executarInstalacaoSilenciosaUpdate() {
    if (instalandoUpdate || !caminhoInstaladorBaixado || !fs.existsSync(caminhoInstaladorBaixado)) return false;

    try {
        const stat = fs.statSync(caminhoInstaladorBaixado);
        if (stat.size < 20 * 1024 * 1024) {
            console.error('[Update] Arquivo baixado muito pequeno/corrompido:', stat.size);
            caminhoInstaladorBaixado = '';
            return false;
        }
    } catch (e) {
        return false;
    }

    instalandoUpdate = true;

    try {
        const cfg = carregarConfig();
        cfg.ultimoDesligamentoTimestamp = Math.floor(Date.now() / 1000);
        salvarConfigDisco(cfg, true);
    } catch (e) {}

    try {
        if (client) { await client.destroy(); client = null; }
        limparLocksTravados();
    } catch (e) {}

    setTimeout(() => {
        try {
            const batPath = path.join(app.getPath('temp'), 'aplicar_update.bat');
            const conteudoBat = [
                '@echo off',
                'timeout /t 1 /nobreak > NUL',
                'taskkill /F /IM "Advocacia Studio Pro.exe" > NUL 2>&1',
                'taskkill /F /IM "chrome.exe" > NUL 2>&1',
                `start /wait "" "${caminhoInstaladorBaixado}" /S`,
                'if errorlevel 1 (',
                `    start /wait "" "${caminhoInstaladorBaixado}"`,
                ')',
                `start "" "${process.execPath}"`,
                `del "${batPath}"`
            ].join('\r\n');

            fs.writeFileSync(batPath, conteudoBat, 'utf-8');
            const child = spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
        } catch (e) {}
        app.quit();
    }, 200);
    return true;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1100,
        minHeight: 720,
        title: 'Advocacia Studio Pro • Beta 0.8 (v1.8.5)',
        icon: obterIconeNativo(),
        backgroundColor: '#0b0f17',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: true
        },
        autoHideMenuBar: true
    });

    mainWindow.loadFile('index.html');
}

// Otimização para PC fraco: limpeza periódica de referências em memória (< 300MB)
setInterval(() => {
    try {
        if (global.gc) global.gc();
        if (mensagensJaProcessadas && mensagensJaProcessadas.size > 800) {
            const arr = Array.from(mensagensJaProcessadas).slice(0, 400);
            for (const item of arr) mensagensJaProcessadas.delete(item);
        }
    } catch (e) {}
}, 5 * 60 * 1000);

app.whenReady().then(() => {
    const cfg = carregarConfig(true);
    cfg.ultimoInicioTimestamp = Math.floor(Date.now() / 1000);
    salvarConfigDisco(cfg, true);

    configurarAutoStartWindows(cfg.iniciar_com_windows !== false);
    createWindow();
    iniciarWhatsApp();
    configurarAutoUpdater();

    timerHeartbeatShutdown = setInterval(() => {
        try {
            const c = carregarConfig();
            c.ultimoDesligamentoTimestamp = Math.floor(Date.now() / 1000);
            salvarConfigDisco(c, false);
        } catch (e) {}
    }, 30000);
});

app.on('before-quit', async () => {
    clearInterval(timerHeartbeatShutdown);
    clearInterval(intervaloVarreduraContinua);
    for (const t of timersVarreduraPosReady) clearTimeout(t);
    try {
        const cfg = carregarConfig();
        cfg.ultimoDesligamentoTimestamp = Math.floor(Date.now() / 1000);
        salvarConfigDisco(cfg, true);
    } catch (e) {}
    if (client) {
        try { await client.destroy(); } catch (e) {}
    }
});

function agendarReconexaoBackoff() {
    if (reconectando || instalandoUpdate) return;
    reconectando = true;
    clearTimeout(timerReconexao);

    const delays = [5000, 15000, 30000, 60000];
    const delayAtual = delays[Math.min(tentativasReconexao, delays.length - 1)];
    tentativasReconexao++;

    const segs = Math.round(delayAtual / 1000);
    atualizarStatusUI('disconnected', `Oscilação detectada. Reconectando em ${segs}s (Tentativa #${tentativasReconexao})...`);

    timerReconexao = setTimeout(() => {
        reconectando = false;
        iniciarWhatsApp(true);
    }, delayAtual);
}

function limparTimersVarredura() {
    for (const t of timersVarreduraPosReady) clearTimeout(t);
    timersVarreduraPosReady = [];
    if (intervaloVarreduraContinua) {
        clearInterval(intervaloVarreduraContinua);
        intervaloVarreduraContinua = null;
    }
}

async function iniciarWhatsApp(forcarReinicio = false) {
    if (iniciandoBot && !forcarReinicio) return;
    iniciandoBot = true;
    clearTimeout(timerReconexao);
    limparTimersVarredura();

    atualizarStatusUI('initializing', 'Iniciando motor Chromium em segundo plano...');

    if (client) {
        try { await client.destroy(); } catch (e) {}
        client = null;
    }
    limparLocksTravados();

    const puppeteerConfig = {
        headless: true,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--mute-audio',
            '--no-default-browser-check',
            '--disable-sync',
            '--disable-translate',
            '--disable-default-apps',
            '--blink-settings=imagesEnabled=false',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    };

    const browserPath = obterCaminhoNavegador();
    if (browserPath) {
        puppeteerConfig.executablePath = browserPath;
    }

    atualizarStatusUI('initializing', 'Carregando sessão local criptografada...');

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "adv_studio_client",
            dataPath: AUTH_DIR
        }),
        webVersionCache: {
            type: 'none'
        },
        puppeteer: puppeteerConfig
    });

    let watchdog99Timer = null;
    let readyJaDisparado = false;

    client.on('loading_screen', (percent, message) => {
        atualizarStatusUI('authenticated', `Carregando conversas (${percent || 0}%): ${message || 'Sincronizando WhatsApp...'}`);

        // WATCHDOG ANTI-TRAVAMENTO 99% SEGURO:
        // Só atua se realmente ficar travado por mais de 10s no final E a lista de conversas (#pane-side) já estiver renderizada no DOM,
        // evitando interromper prematuramente o download de mensagens offline!
        if (percent >= 95) {
            clearTimeout(watchdog99Timer);
            watchdog99Timer = setTimeout(async () => {
                if (!readyJaDisparado && statusAtualBot !== 'ready' && client && client.pupPage) {
                    try {
                        const synced = await client.pupPage.evaluate(() => {
                            try {
                                const pane = document.querySelector('#pane-side') || document.querySelector('[data-testid="chat-list"]');
                                if (pane) {
                                    if (typeof window.onAppStateHasSyncedEvent === 'function') {
                                        window.onAppStateHasSyncedEvent();
                                        return true;
                                    }
                                }
                            } catch (e) {}
                            return false;
                        });
                        if (synced) {
                            atualizarStatusUI('authenticated', 'Finalizando sincronização rápida...');
                        }
                    } catch (e) {}
                }
            }, 10000);
        }
    });

    client.on('qr', async (qr) => {
        iniciandoBot = false;
        tentativasReconexao = 0;
        clearTimeout(watchdog99Timer);
        try {
            ultimoQrDataUrl = await qrcode.toDataURL(qr);
            atualizarStatusUI('waiting_qr', 'QR Code gerado! Aguardando leitura pelo celular...');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-qr', ultimoQrDataUrl);
            }
        } catch (e) {}
    });

    client.on('authenticated', () => {
        ultimoQrDataUrl = '';
        tentativasReconexao = 0;
        atualizarStatusUI('authenticated', 'Autenticado! Preparando listas de mensagens...');
    });

    client.on('auth_failure', () => {
        iniciandoBot = false;
        clearTimeout(watchdog99Timer);
        atualizarStatusUI('disconnected', 'Falha de autenticação. Reiniciando sessão...');
        agendarReconexaoBackoff();
    });

    client.on('ready', () => {
        clearTimeout(watchdog99Timer);
        if (readyJaDisparado) {
            // Se o evento ready disparar uma segunda vez após o watchdog, apenas executa uma nova varredura sem resetar momentoConexao!
            scanOfflineMessagesToTriage(client, mainWindow);
            return;
        }
        readyJaDisparado = true;
        iniciandoBot = false;
        reconectando = false;
        tentativasReconexao = 0;
        ultimoQrDataUrl = '';
        momentoConexao = Math.floor(Date.now() / 1000);

        const cfg = carregarConfig();
        if (!cfg.primeiraConexaoTimestamp || cfg.primeiraConexaoTimestamp === 0) {
            cfg.primeiraConexaoTimestamp = momentoConexao;
            salvarConfigDisco(cfg, true);
        }

        atualizarStatusUI('ready', 'Conectado e Operante ( Monitoramento em Tempo Real )');

        // VARREDURA MULTI-ESTÁGIO PÓS-CONEXÃO (CAUSA RAIZ 3):
        // O WhatsApp Web Multi-Device descriptografa mensagens offline (ciphertext -> chat) entre 1s e 25s após o 'ready'.
        // Executamos ondas automáticas em 1.5s, 5s, 10s, 18s e 30s + monitoramento periódico a cada 25s!
        limparTimersVarredura();
        const etapasMs = [1500, 5000, 10000, 18000, 30000];
        for (const delayMs of etapasMs) {
            const t = setTimeout(() => {
                if (statusAtualBot === 'ready') {
                    scanOfflineMessagesToTriage(client, mainWindow);
                }
            }, delayMs);
            timersVarreduraPosReady.push(t);
        }

        intervaloVarreduraContinua = setInterval(() => {
            if (statusAtualBot === 'ready') {
                scanOfflineMessagesToTriage(client, mainWindow);
            }
        }, 25000);
    });

    client.on('unread_count', () => {
        if (statusAtualBot === 'ready') {
            setTimeout(() => {
                scanOfflineMessagesToTriage(client, mainWindow);
            }, 1200);
        }
    });

    client.on('disconnected', () => {
        iniciandoBot = false;
        readyJaDisparado = false;
        ultimoQrDataUrl = '';
        limparTimersVarredura();
        agendarReconexaoBackoff();
    });

    client.on('message', async (msg) => {
        await processarMensagemEntrada(msg, false);
    });

    try {
        await client.initialize();
    } catch (e) {
        iniciandoBot = false;
        agendarReconexaoBackoff();
    }
}

ipcMain.handle('obter-config', () => carregarConfig());
ipcMain.handle('obter-versao-app', () => `Beta 0.8 (v${app.getVersion()})`);
ipcMain.handle('obter-estado-conexao', () => ({ status: statusAtualBot, qr: ultimoQrDataUrl, subStatus: subStatusDetalhado, tentativa: tentativasReconexao }));
ipcMain.handle('salvar-config', (e, nc) => {
    salvarConfigDisco(nc, true);
    if (typeof nc.iniciar_com_windows !== 'undefined') {
        configurarAutoStartWindows(nc.iniciar_com_windows);
    }
    return true;
});
ipcMain.handle('obter-status-autostart', () => {
    const cfg = carregarConfig();
    return Boolean(cfg.iniciar_com_windows !== false);
});
ipcMain.handle('definir-autostart', (e, ativo) => {
    const cfg = carregarConfig();
    cfg.iniciar_com_windows = Boolean(ativo);
    salvarConfigDisco(cfg, true);
    configurarAutoStartWindows(ativo);
    return true;
});
ipcMain.handle('reiniciar-bot', () => { tentativasReconexao = 0; iniciarWhatsApp(true); return true; });
ipcMain.handle('forcar-varredura-nao-lidas', async () => await varrerMensagensNaoLidas());
ipcMain.handle('verificar-atualizacao-manual', async () => await verificarEBaixarAtualizacaoGitHub());
ipcMain.handle('instalar-atualizacao-agora', async () => await executarInstalacaoSilenciosaUpdate());
ipcMain.handle('obter-pausados', () => contatosPausados);
ipcMain.handle('remover-pausa', (e, num) => { delete contatosPausados[num]; emitirPausados(); return contatosPausados; });
ipcMain.handle('obter-ignorados', () => carregarContatosIgnorados());
ipcMain.handle('adicionar-ignorado', (e, item) => {
    const lista = carregarContatosIgnorados();
    const numeroLimpo = apenasNumeros(typeof item === 'object' && item !== null ? item.numero : item);
    if (!numeroLimpo) return lista;
    const jaExiste = lista.some(x => apenasNumeros(typeof x === 'object' && x !== null ? x.numero : x) === numeroLimpo);
    if (!jaExiste) {
        const novoItem = {
            id: 'ign_' + Date.now(),
            numero: numeroLimpo,
            telefoneFormatado: formatarTelefoneBrasil(numeroLimpo),
            nome: (typeof item === 'object' && item !== null && item.nome) ? String(item.nome).trim() : '',
            adicionadoEm: new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
        };
        lista.push(novoItem);
        salvarContatosIgnorados(lista);
    }
    return lista;
});
ipcMain.handle('remover-ignorado', (e, identificador) => {
    let lista = carregarContatosIgnorados();
    const limpo = apenasNumeros(identificador);
    lista = lista.filter(x => {
        if (typeof x === 'object' && x !== null) {
            if (x.id && x.id === identificador) return false;
            if (apenasNumeros(x.numero) === limpo) return false;
            return true;
        }
        return apenasNumeros(x) !== limpo;
    });
    salvarContatosIgnorados(lista);
    return lista;
});

// Executa o atendimento do robô para um item da triagem de forma 100% segura (sem depender de loadEarlierMsgs)
async function atenderItemTriagemComBot(itemAlvo, chatIdFallback, msgIdFallback) {
    const cId = (itemAlvo && itemAlvo.chatId) || chatIdFallback;
    const mId = (itemAlvo && itemAlvo.msgId) || msgIdFallback || `${cId}_${Math.floor(Date.now() / 1000)}`;
    const tsSec = (itemAlvo && itemAlvo.timestampSec) || Math.floor(((itemAlvo && itemAlvo.timestamp) || Date.now()) / 1000);

    registrarMsgIdOfflineProcessado(mId, cId, tsSec);

    if (client) {
        const textoParaProcessar = (itemAlvo && itemAlvo.rawBody) || (itemAlvo && itemAlvo.messagePreview && itemAlvo.messagePreview !== '[Mídia/Áudio/Documento]' ? itemAlvo.messagePreview.split(' | ').pop() : 'Olá') || 'Olá';
        const syntheticMsg = {
            id: { _serialized: mId },
            from: cId,
            fromMe: false,
            body: textoParaProcessar,
            timestamp: tsSec,
            getContact: async () => {
                try {
                    const ct = await client.getContactById(cId);
                    if (ct) return ct;
                } catch (e) {}
                return {
                    number: apenasNumeros((itemAlvo && itemAlvo.phoneNumber) || cId),
                    name: (itemAlvo && itemAlvo.contactName) || '',
                    pushname: (itemAlvo && itemAlvo.contactName) || ''
                };
            }
        };

        await processarMensagemEntrada(syntheticMsg, true);

        try {
            const chat = await client.getChatById(cId);
            if (chat && typeof chat.sendSeen === 'function') {
                await chat.sendSeen();
            }
        } catch (eSeen) {}
    }
}

// ==========================================
// HANDLERS DA CENTRAL DE TRIAGEM OFFLINE (24H)
// ==========================================
ipcMain.handle('triage:get-list', async () => await scanOfflineMessagesToTriage(client, mainWindow));

ipcMain.handle('triage:rescan', async () => await scanOfflineMessagesToTriage(client, mainWindow));

async function executarAcaoTriagem(event, { chatId, msgId, action }) {
    try {
        if (action === 'bot-all') {
            const copiaItens = [...offlineTriageList];
            for (const item of copiaItens) {
                await atenderItemTriagemComBot(item, item.chatId, item.msgId);
            }
            offlineTriageList = [];
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('offline-triage-updated', offlineTriageList); mainWindow.webContents.send('triage:updated', offlineTriageList);
            }
            return { success: true, action: 'bot-all', list: offlineTriageList };
        }

        if (!chatId) return { success: false, erro: 'ChatId não informado' };

        const item = offlineTriageList.find(i => i.chatId === chatId);
        const tsSec = (item && item.timestampSec) || Math.floor(((item && item.timestamp) || Date.now()) / 1000);
        registrarMsgIdOfflineProcessado(msgId || (item && item.msgId), chatId, tsSec);

        if (action === 'bot') {
            await atenderItemTriagemComBot(item, chatId, msgId);
            offlineTriageList = offlineTriageList.filter(i => i.chatId !== chatId);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('offline-triage-updated', offlineTriageList); mainWindow.webContents.send('triage:updated', offlineTriageList);
            }
            return { success: true, action: 'bot', list: offlineTriageList };
        }

        if (action === 'waitlist') {
            const cleanNum = String(chatId).replace(/\D/g, '');
            const rawUser = String(chatId).split('@')[0];
            const nomeContato = item ? item.contactName : (cleanNum || rawUser);
            const telContato = item ? item.phoneNumber : (cleanNum || rawUser);

            const registroFila = {
                timestamp: Date.now(),
                nome: nomeContato,
                telefone: telContato,
                origem: 'triagem_offline',
                ultimaMensagem: item ? item.messagePreview : 'Transferido da Triagem Offline'
            };

            contatosPausados[chatId] = registroFila;
            if (cleanNum) contatosPausados[cleanNum] = registroFila;
            if (rawUser) contatosPausados[rawUser] = registroFila;

            delete estadosUsuarios[chatId];
            if (cleanNum) delete estadosUsuarios[cleanNum];
            if (rawUser) delete estadosUsuarios[rawUser];

            emitirPausados();

            if (client) {
                try {
                    const chat = await client.getChatById(chatId);
                    if (chat && typeof chat.sendSeen === 'function') await chat.sendSeen();
                } catch (e) {}
            }

            offlineTriageList = offlineTriageList.filter(i => i.chatId !== chatId);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('offline-triage-updated', offlineTriageList); mainWindow.webContents.send('triage:updated', offlineTriageList);
            }
            return { success: true, action: 'waitlist', list: offlineTriageList };
        }

        if (action === 'ignore') {
            if (client) {
                try {
                    const chat = await client.getChatById(chatId);
                    if (chat && typeof chat.sendSeen === 'function') await chat.sendSeen();
                } catch (e) {}
            }
            offlineTriageList = offlineTriageList.filter(i => i.chatId !== chatId);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('offline-triage-updated', offlineTriageList); mainWindow.webContents.send('triage:updated', offlineTriageList);
            }
            return { success: true, action: 'ignore', list: offlineTriageList };
        }

        return { success: false, erro: 'Ação não reconhecida' };
    } catch (err) {
        console.error('[Triagem Decision Erro]', err);
        return { success: false, erro: err.message };
    }
}
ipcMain.handle('triage:decision', executarAcaoTriagem);
ipcMain.handle('triage:execute-action', executarAcaoTriagem);