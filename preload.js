const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    obterConfig: () => ipcRenderer.invoke('obter-config'),
    salvarConfig: (config) => ipcRenderer.invoke('salvar-config', config),
    obterVersaoApp: () => ipcRenderer.invoke('obter-versao-app'),
    obterEstadoConexao: () => ipcRenderer.invoke('obter-estado-conexao'),
    reiniciarBot: () => ipcRenderer.invoke('reiniciar-bot'),
    forcarVarreduraNaoLidas: () => ipcRenderer.invoke('forcar-varredura-nao-lidas'),
    verificarAtualizacaoManual: () => ipcRenderer.invoke('verificar-atualizacao-manual'),
    instalarAtualizacaoAgora: () => ipcRenderer.invoke('instalar-atualizacao-agora'),
    obterPausados: () => ipcRenderer.invoke('obter-pausados'),
    removerPausa: (numero) => ipcRenderer.invoke('remover-pausa', numero),

    // Eventos vindos do main.js
    aoReceberQR: (callback) => ipcRenderer.on('bot-qr', (event, qr) => callback(qr)),
    aoMudarStatus: (callback) => ipcRenderer.on('bot-status', (event, status) => callback(status)),
    aoReceberLog: (callback) => ipcRenderer.on('bot-log', (event, log) => callback(log)),
    aoAtualizarPausados: (callback) => ipcRenderer.on('bot-pausados', (event, pausados) => callback(pausados)),
    aoAtualizarProcessos: (callback) => ipcRenderer.on('bot-processos-sync', (event, config) => callback(config)),
    aoReceberEventoUpdate: (callback) => ipcRenderer.on('bot-update-status', (event, dados) => callback(dados))
});