const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    obterConfig: () => ipcRenderer.invoke('obter-config'),
    salvarConfig: (config) => ipcRenderer.invoke('salvar-config', config),
    reiniciarBot: () => ipcRenderer.invoke('reiniciar-bot'),
    obterEstadoConexao: () => ipcRenderer.invoke('obter-estado-conexao'),
    obterPausados: () => ipcRenderer.invoke('obter-pausados'),
    removerPausa: (numero) => ipcRenderer.invoke('remover-pausa', numero),
    forcarVarreduraNaoLidas: () => ipcRenderer.invoke('forcar-varredura-nao-lidas'),
    instalarAtualizacaoAgora: () => ipcRenderer.invoke('instalar-atualizacao-agora'),
    verificarAtualizacao: () => ipcRenderer.invoke('verificar-atualizacao'),
    aoReceberQR: (callback) => ipcRenderer.on('bot-qr', (e, url) => callback(url)),
    aoMudarStatus: (callback) => ipcRenderer.on('bot-status', (e, status) => callback(status)),
    aoReceberLog: (callback) => ipcRenderer.on('bot-log', (e, log) => callback(log)),
    aoAtualizarPausados: (callback) => ipcRenderer.on('bot-pausados', (e, lista) => callback(lista)),
    aoAtualizarProcessos: (callback) => ipcRenderer.on('bot-processos-sync', (e, cfg) => callback(cfg)),
    aoReceberEventoUpdate: (callback) => ipcRenderer.on('bot-update-status', (e, dados) => callback(dados))
});