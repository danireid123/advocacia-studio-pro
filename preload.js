const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    obterConfig: () => ipcRenderer.invoke('obter-config'),
    salvarConfig: (cfg) => ipcRenderer.invoke('salvar-config', cfg),
    obterVersaoApp: () => ipcRenderer.invoke('obter-versao-app'),
    obterEstadoConexao: () => ipcRenderer.invoke('obter-estado-conexao'),
    reiniciarBot: () => ipcRenderer.invoke('reiniciar-bot'),
    forcarVarreduraNaoLidas: () => ipcRenderer.invoke('forcar-varredura-nao-lidas'),
    obterStatusAutoStart: () => ipcRenderer.invoke('obter-status-autostart'),
    definirAutoStart: (ativo) => ipcRenderer.invoke('definir-autostart', ativo),
    verificarAtualizacaoManual: () => ipcRenderer.invoke('verificar-atualizacao-manual'),
    instalarAtualizacaoAgora: () => ipcRenderer.invoke('instalar-atualizacao-agora'),
    obterPausados: () => ipcRenderer.invoke('obter-pausados'),
    removerPausa: (num) => ipcRenderer.invoke('remover-pausa', num),
    obterIgnorados: () => ipcRenderer.invoke('obter-ignorados'),
    adicionarIgnorado: (item) => ipcRenderer.invoke('adicionar-ignorado', item),
    removerIgnorado: (num) => ipcRenderer.invoke('remover-ignorado', num),

    getOfflineTriageList: () => ipcRenderer.invoke('triage:get-list'),
    rescanOfflineTriage: () => ipcRenderer.invoke('triage:rescan'),
    sendTriageDecision: (payload) => ipcRenderer.invoke('triage:decision', payload),

    aoReceberQR: (callback) => ipcRenderer.on('bot-qr', (_e, qr) => callback(qr)),
    aoMudarStatus: (callback) => ipcRenderer.on('bot-status', (_e, st) => callback(st)),
    aoReceberSubStatus: (callback) => ipcRenderer.on('bot-substatus', (_e, info) => callback(info)),
    aoReceberLog: (callback) => ipcRenderer.on('bot-log', (_e, log) => callback(log)),
    aoAtualizarPausados: (callback) => ipcRenderer.on('bot-pausados', (_e, mapa) => callback(mapa)),
    aoAtualizarProcessos: (callback) => ipcRenderer.on('bot-processos-sync', (_e, cfg) => callback(cfg)),
    aoAtualizarIgnorados: (callback) => ipcRenderer.on('bot-ignorados-sync', (_e, lista) => callback(lista)),
    aoReceberProgressoVarredura: (callback) => ipcRenderer.on('bot-varredura-progresso', (_e, dados) => callback(dados)),
    aoReceberEventoUpdate: (callback) => ipcRenderer.on('bot-update-status', (_e, dados) => callback(dados)),
    onOfflineTriageUpdated: (callback) => ipcRenderer.on('offline-triage-updated', (_, list) => callback(list))
});