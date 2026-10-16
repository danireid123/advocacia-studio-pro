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
    return list.some(item => {
        const itemNum = typeof item === 'object' && item !== null ? (item.numero || item.telefone || '') : item;
        const cleanItem = String(itemNum || '').replace(/\D/g, '');
        if (!cleanItem || cleanItem.length < 4) return false;
        return cleanNumber.includes(cleanItem) || cleanItem.includes(cleanNumber);
    });
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
        primeiraConexaoTimestamp: 0,
        ultimoDesligamentoTimestamp: 0,
        ultimoInicioTimestamp: 0,
        historicoVarreduras: [],
        idsMensagensVarreduraRespondidas: [],
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
    if (!cfg.mapaNomes) cfg.mapaNomes = {};
    if (!cfg.mapaTelefones) cfg.mapaTelefones = {};
    if (!cfg.pausadosPersistidos) cfg.pausadosPersistidos = {};
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
                salvarConfigDisco(configEmMemoria, true);
                return configEmMemoria;
            }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(padrao, null, 2), 'utf-8');
            configEmMemoria = padrao;
            return configEmMemoria;
        }
        const lido = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        configEmMemoria = migrarTemplatesAntigosProcessos({ ...padrao, ...lido });
        if (configEmMemoria.pausadosPersistidos) {
            contatosPausados = { ...configEmMemoria.pausadosPersistidos, ...contatosPausados };
        }
        return configEmMemoria;
    } catch (e) {
        try {
            if (fs.existsSync(CONFIG_BACKUP_PATH)) {
                configEmMemoria = migrarTemplatesAntigosProcessos(JSON.parse(fs.readFileSync(CONFIG_BACKUP_PATH, 'utf-8')));
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

async function processarMensagemEntrada(msg, origemVarreduraOffline = false) {
    try {
        if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return false;
        if (!msg.from || msg.from.includes('@g.us') || msg.from.includes('@newsletter') || msg.from.includes('@broadcast')) return false;

        // SUB-AGENTE 2: Interceptador de Contatos Ignorados (Descarte imediato antes de qualquer resposta)
        const senderId = msg.from || '';
        if (isContactIgnored(senderId) || (msg.author && isContactIgnored(msg.author))) {
            return false;
        }

        const msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : `${msg.from}_${msg.timestamp}_${msg.body}`;
        if (mensagensJaProcessadas.has(msgId)) return false;

        const config = carregarConfig();
        if (Array.isArray(config.idsMensagensVarreduraRespondidas) && config.idsMensagensVarreduraRespondidas.includes(msgId)) {
            return false;
        }

        if (!origemVarreduraOffline && msg.timestamp && momentoConexao > 0 && msg.timestamp < (momentoConexao - 15)) {
            return false;
        }

        const textoOriginal = String(msg.body || '').trim();
        if (!textoOriginal) return false;

        mensagensJaProcessadas.add(msgId);
        if (mensagensJaProcessadas.size > 2000) {
            const primeiroItem = mensagensJaProcessadas.values().next().value;
            mensagensJaProcessadas.delete(primeiroItem);
        }
        if (origemVarreduraOffline) {
            config.idsMensagensVarreduraRespondidas.push(msgId);
            if (config.idsMensagensVarreduraRespondidas.length > 500) {
                config.idsMensagensVarreduraRespondidas = config.idsMensagensVarreduraRespondidas.slice(-500);
            }
        }

        const identidade = await resolverIdentidadeCompleta(msg, config);
        const remetenteChave = identidade.chaveCliente;

        // Verificação redundante com número real limpo da identidade
        if (isContactIgnored(remetenteChave) || isContactIgnored(identidade.telefoneFormatado)) {
            return false;
        }

        const gatilhoDigitado = extrairGatilhoLimpo(textoOriginal);

        const registroPausa = contatosPausados[remetenteChave] || contatosPausados[msg.from];
        const tsPausa = typeof registroPausa === 'object' ? registroPausa.timestamp : registroPausa;
        if (tsPausa && (Date.now() - tsPausa < 24 * 60 * 60 * 1000)) {
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

async function syncOfflineMessages(cli) {
    return await varrerMensagensNaoLidas(cli);
}

async function varrerMensagensNaoLidas(clienteEspecifico = null) {
    const alvoClient = clienteEspecifico || client;
    if (!alvoClient || statusAtualBot !== 'ready' || varrendoNaoLidas) {
        emitirProgressoVarredura({
            emAndamento: false,
            fase: statusAtualBot !== 'ready' ? 'WhatsApp ainda não está conectado.' : 'Varredura já em andamento.',
            analisadas: 0,
            respondidas: 0,
            itens: []
        });
        return { respondidas: 0, analisadas: 0, itens: [] };
    }

    varrendoNaoLidas = true;
    const config = carregarConfig();
    const listaIgnorados = carregarContatosIgnorados();
    const agoraMs = Date.now();
    const corte24h = Math.floor((agoraMs - MAX_AGE_MS) / 1000);
    const janelaCorteMinima = corte24h;

    let analisadas = 0;
    let respondidas = 0;
    const itensProcessados = [];

    emitirProgressoVarredura({
        emAndamento: true,
        fase: 'Buscando conversas com mensagens não lidas...',
        analisadas: 0,
        respondidas: 0,
        itens: []
    });

    try {
        const chats = await alvoClient.getChats();
        const candidatos = chats.filter(c => !c.isGroup && c.unreadCount > 0);

        emitirProgressoVarredura({
            emAndamento: true,
            fase: `Analisando ${candidatos.length} conversa(s) não lida(s)...`,
            analisadas: 0,
            respondidas: 0,
            itens: []
        });

        for (const chat of candidatos) {
            analisadas++;
            try {
                const senderId = (chat.id && (chat.id._serialized || chat.id.user)) || String(chat.id || '');
                if (isContactIgnored(senderId, listaIgnorados)) {
                    continue;
                }

                const qtdParaBuscar = Math.min(Math.max(chat.unreadCount || 1, 1), 10);
                const msgs = await chat.fetchMessages({ limit: qtdParaBuscar });
                if (!msgs || msgs.length === 0) continue;

                const ultimaMsg = msgs[msgs.length - 1];
                if (!ultimaMsg || ultimaMsg.fromMe) continue;

                // Corte temporal estrito de 24 horas
                const msgTimestampMs = (ultimaMsg.timestamp || 0) * 1000;
                const idadeMs = agoraMs - msgTimestampMs;
                if (idadeMs > MAX_AGE_MS || (ultimaMsg.timestamp && ultimaMsg.timestamp < janelaCorteMinima)) {
                    continue;
                }

                const msgId = (ultimaMsg.id && ultimaMsg.id._serialized) ? ultimaMsg.id._serialized : `${ultimaMsg.from}_${ultimaMsg.timestamp}`;
                if (mensagensJaProcessadas.has(msgId) || (config.idsMensagensVarreduraRespondidas || []).includes(msgId)) {
                    continue;
                }

                const identidade = await resolverIdentidadeCompleta(ultimaMsg, config);
                if (isContactIgnored(identidade.chaveCliente, listaIgnorados) || isContactIgnored(identidade.telefoneFormatado, listaIgnorados)) {
                    continue;
                }

                const ok = await processarMensagemEntrada(ultimaMsg, true);
                if (ok) {
                    respondidas++;
                    const itemInfo = {
                        exibicao: identidade.exibicao,
                        msg: String(ultimaMsg.body || '').substring(0, 80),
                        horaMsg: new Date((ultimaMsg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
                        status: 'Respondida com sucesso'
                    };
                    itensProcessados.push(itemInfo);
                }

                try {
                    await chat.sendSeen();
                } catch (errSeen) {}

                emitirProgressoVarredura({
                    emAndamento: true,
                    fase: `Verificando (${analisadas}/${candidatos.length})...`,
                    analisadas,
                    respondidas,
                    itens: itensProcessados
                });
            } catch (errChat) {}
        }

        const regHistorico = {
            data: new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
            analisadas,
            respondidas,
            itens: itensProcessados
        };
        config.historicoVarreduras = [regHistorico, ...(config.historicoVarreduras || [])].slice(0, 15);
        salvarConfigDisco(config, true);

    } catch (e) {}

    varrendoNaoLidas = false;
    emitirProgressoVarredura({
        emAndamento: false,
        fase: respondidas > 0
            ? `Concluído! ${respondidas} conversa(s) pendente(s) respondida(s).`
            : 'Varredura concluída. Nenhuma conversa pendente sem resposta.',
        analisadas,
        respondidas,
        itens: itensProcessados
    });

    return { respondidas, analisadas, itens: itensProcessados };
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
        title: 'Advocacia Studio Pro • Beta 0.8 (v1.8.2)',
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

async function iniciarWhatsApp(forcarReinicio = false) {
    if (iniciandoBot && !forcarReinicio) return;
    iniciandoBot = true;
    clearTimeout(timerReconexao);

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

    client.on('loading_screen', (percent, message) => {
        atualizarStatusUI('authenticated', `Carregando conversas (${percent || 0}%): ${message || 'Sincronizando WhatsApp...'}`);

        // WATCHDOG ANTI-TRAVAMENTO 99%:
        // Evita o congelamento no estágio final de carregamento avaliando se a tela principal já renderizou
        if (percent >= 90) {
            clearTimeout(watchdog99Timer);
            watchdog99Timer = setTimeout(async () => {
                if (statusAtualBot !== 'ready' && client && client.pupPage) {
                    try {
                        const synced = await client.pupPage.evaluate(() => {
                            try {
                                const pane = document.querySelector('#pane-side') || document.querySelector('[data-testid="chat-list"]');
                                const socket = window.require && window.require('WAWebSocketModel')?.Socket;
                                if (pane || (socket && socket.state === 'CONNECTED')) {
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
            }, 3500);
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
        iniciandoBot = false;
        reconectando = false;
        tentativasReconexao = 0;
        ultimoQrDataUrl = '';
        clearTimeout(watchdog99Timer);
        momentoConexao = Math.floor(Date.now() / 1000);

        const cfg = carregarConfig();
        if (!cfg.primeiraConexaoTimestamp || cfg.primeiraConexaoTimestamp === 0) {
            cfg.primeiraConexaoTimestamp = momentoConexao;
            salvarConfigDisco(cfg, true);
        }

        atualizarStatusUI('ready', 'Conectado e Operante ( Monitoramento em Tempo Real )');

        if (cfg.varredura_automatica_inicio !== false) {
            setTimeout(() => { varrerMensagensNaoLidas(); }, 2500);
        }
    });

    client.on('disconnected', () => {
        iniciandoBot = false;
        ultimoQrDataUrl = '';
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