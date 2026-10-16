const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

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
let instalandoUpdate = false;
let baixandoUpdate = false;
let caminhoInstaladorBaixado = null;
let statusAtualBot = 'initializing';
let ultimoQrDataUrl = '';
let timerGravacaoDisco = null;

const GITHUB_OWNER = 'danireid123';
const GITHUB_REPO = 'advocacia-studio-pro';

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const AUTH_DIR = path.join(app.getPath('userData'), 'wwebjs_auth_session');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function obterCaminhoIcone() {
    const icoPath = path.join(__dirname, 'icon.ico');
    const pngPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(icoPath)) return icoPath;
    if (fs.existsSync(pngPath)) return pngPath;
    return undefined;
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
        if (caminho && fs.existsSync(caminho)) return caminho;
    }
    return undefined;
}

function limparLocksTravados() {
    try {
        const possiveisLocks = [
            path.join(AUTH_DIR, 'session-adv_studio_client', 'SingletonLock'),
            path.join(AUTH_DIR, 'session-adv_studio_client', 'lockfile')
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
        metricasReais: { totalMensagens: 0, contatosAtendidos: [] }
    };
}

function carregarConfig(forcarDisco = false) {
    if (configEmMemoria && !forcarDisco) return configEmMemoria;
    try {
        const padrao = criarConfigPadrao();
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(padrao, null, 2), 'utf-8');
            configEmMemoria = padrao;
            return configEmMemoria;
        }
        configEmMemoria = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
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

    return {
        idChat: chatId,
        chaveCliente: chaveUnica,
        nomeCliente: nomeInstantaneo || '',
        telefoneFormatado: formatarTelefoneBrasil(numeroLimpo || parteId),
        exibicao: nomeInstantaneo ? `${nomeInstantaneo} (${formatarTelefoneBrasil(numeroLimpo || parteId)})` : formatarTelefoneBrasil(numeroLimpo || parteId)
    };
}

function extrairGatilhoLimpo(texto) {
    const t = String(texto || '').trim().toLowerCase();
    const matchNumero = t.match(/^(\d+)\s*[\.\-\)]?$/);
    if (matchNumero) return matchNumero[1];
    return t;
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

// =========================================================================
// PROCESSAMENTO E RESPOSTA SEGURA DE MENSAGENS DO ROBÔ
// =========================================================================
async function enviarMensagemSegura(msgObj, chatId, texto) {
    if (!client) return;
    try {
        await client.sendMessage(chatId, texto, { sendSeen: true });
    } catch (err1) {
        try {
            if (msgObj && typeof msgObj.reply === 'function') {
                await msgObj.reply(texto, chatId, { sendSeen: true });
            }
        } catch (e) {}
    }
}

function montarTextoEtapa(etapa) {
    let txt = (etapa.mensagem || '') + "\n\n";
    (etapa.opcoes || []).forEach(op => {
        txt += `*${op.gatilho}* - ${op.rotulo}\n`;
    });
    return txt.trim();
}

async function processarMensagemEntrada(msg) {
    try {
        if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return;
        if (!msg.from || msg.from.includes('@g.us') || msg.from.includes('@newsletter') || msg.from.includes('@broadcast')) return;

        const textoOriginal = String(msg.body || '').trim();
        if (!textoOriginal) return;

        const config = carregarConfig();
        const identidade = resolverIdentidadeRapida(msg, config);
        const remetenteChave = identidade.chaveCliente;
        const gatilhoDigitado = extrairGatilhoLimpo(textoOriginal);

        // Verifica se o contato está pausado (atendimento humano)
        const tempoPausa = contatosPausados[remetenteChave] || contatosPausados[msg.from];
        if (tempoPausa && (Date.now() - tempoPausa < 24 * 60 * 60 * 1000)) {
            return; // Robô silenciado para este cliente
        }

        // Atualiza métricas reais
        if (!config.metricasReais) config.metricasReais = { totalMensagens: 0, contatosAtendidos: [] };
        config.metricasReais.totalMensagens += 1;
        if (!config.metricasReais.contatosAtendidos.includes(remetenteChave)) {
            config.metricasReais.contatosAtendidos.push(remetenteChave);
        }
        salvarConfigDisco(config, false);

        // Envia log para a UI em tempo real
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

        const responderCliente = async (txt) => {
            await enviarMensagemSegura(msg, msg.from, txt);
        };

        // Tratamento de saudações e menu raiz
        const saudacoes = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "menu", "inicio", "início", "ajuda"];
        if (saudacoes.some(s => gatilhoDigitado === s || gatilhoDigitado.startsWith(s + " "))) {
            estadosUsuarios[remetenteChave] = 'raiz';
            await responderCliente(montarTextoEtapa(config.fluxo.raiz));
            return;
        }

        const etapaAtualKey = estadosUsuarios[remetenteChave] || 'raiz';
        const etapaAtual = etapaAtualKey === 'raiz' ? config.fluxo.raiz : (config.fluxo.etapas[etapaAtualKey] || config.fluxo.raiz);
        const opcaoEscolhida = (etapaAtual.opcoes || []).find(op => String(op.gatilho).trim().toLowerCase() === gatilhoDigitado);

        if (opcaoEscolhida) {
            if (opcaoEscolhida.tipo === 'humano') {
                contatosPausados[remetenteChave] = Date.now();
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
                await responderCliente(opcaoEscolhida.resposta);
                return;
            }
        }

        // Padrão caso não digite opção válida
        await responderCliente(montarTextoEtapa(config.fluxo.raiz));
    } catch (e) {
        console.error("[ERRO PROCESSAR MSG]:", e.message);
    }
}

// =========================================================================
// MOTOR DE AUTO-UPDATE DIRETO VIA GITHUB API
// =========================================================================
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
            mainWindow.webContents.send('bot-update-status', { status: 'downloading', versao: versaoRemota, progresso: 1 });
        }

        await baixarArquivoComProgresso(assetExe.browser_download_url, destinoExe, (pct) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bot-update-status', { status: 'downloading', versao: versaoRemota, progresso: pct });
            }
        });

        caminhoInstaladorBaixado = destinoExe;
        baixandoUpdate = false;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bot-update-status', { status: 'ready', versao: versaoRemota, progresso: 100 });
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
    instalandoUpdate = true;

    try {
        if (client) { await client.destroy(); client = null; }
        limparLocksTravados();
    } catch (e) {}

    setTimeout(() => {
        try {
            const batPath = path.join(app.getPath('temp'), 'aplicar_update.bat');
            const conteudoBat = [
                '@echo off',
                'timeout /t 2 /nobreak > NUL',
                `start /wait "" "${caminhoInstaladorBaixado}" /S`,
                `start "" "${process.execPath}"`,
                `del "${batPath}"`
            ].join('\r\n');

            fs.writeFileSync(batPath, conteudoBat, 'utf-8');
            const child = spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
        } catch (e) {}
        app.quit();
    }, 400);
    return true;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1100,
        minHeight: 720,
        title: 'Advocacia Studio Pro',
        icon: obterCaminhoIcone(),
        backgroundColor: '#0b0f17',
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
        try { await client.destroy(); } catch (e) {}
        client = null;
    }
    limparLocksTravados();

    const puppeteerConfig = {
        headless: true,
        takeoverOnConflict: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
        ]
    };

    const browserPath = obterCaminhoNavegador();
    if (browserPath) {
        puppeteerConfig.executablePath = browserPath;
    }

    client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: "adv_studio_client", 
            dataPath: AUTH_DIR 
        }),
        puppeteer: puppeteerConfig
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

    client.on('ready', () => {
        iniciandoBot = false;
        reconectando = false;
        ultimoQrDataUrl = '';
        momentoConexao = Math.floor(Date.now() / 1000);
        atualizarStatusUI('ready');
    });

    client.on('disconnected', () => {
        iniciandoBot = false;
        ultimoQrDataUrl = '';
        atualizarStatusUI('disconnected');
        if (!reconectando && !instalandoUpdate) {
            reconectando = true;
            setTimeout(() => { reconectando = false; iniciarWhatsApp(true); }, 3000);
        }
    });

    client.on('message', async (msg) => {
        await processarMensagemEntrada(msg);
    });

    try {
        await client.initialize();
    } catch (e) {
        iniciandoBot = false;
        atualizarStatusUI('disconnected');
    }
}

ipcMain.handle('obter-config', () => carregarConfig());
ipcMain.handle('obter-versao-app', () => app.getVersion());
ipcMain.handle('obter-estado-conexao', () => ({ status: statusAtualBot, qr: ultimoQrDataUrl }));
ipcMain.handle('salvar-config', (e, nc) => { salvarConfigDisco(nc, true); return true; });
ipcMain.handle('reiniciar-bot', () => { iniciarWhatsApp(true); return true; });
ipcMain.handle('verificar-atualizacao-manual', async () => await verificarEBaixarAtualizacaoGitHub());
ipcMain.handle('instalar-atualizacao-agora', async () => await executarInstalacaoSilenciosaUpdate());
ipcMain.handle('obter-pausados', () => contatosPausados);
ipcMain.handle('remover-pausa', (e, num) => { delete contatosPausados[num]; emitirPausados(); return contatosPausados; });