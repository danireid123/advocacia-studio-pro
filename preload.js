const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  obterConfig: () => ipcRenderer.invoke('obter-config'),
  salvarConfig: (cfg) => ipcRenderer.invoke('salvar-config', cfg),
  reiniciarBot: () => ipcRenderer.invoke('reiniciar-bot'),
  obterEstadoConexao: () => ipcRenderer.invoke('obter-estado-conexao'),
  obterPausados: () => ipcRenderer.invoke('obter-pausados'),
  removerPausa: (numero) => ipcRenderer.invoke('remover-pausa', numero),
  forcarVarreduraNaoLidas: () => ipcRenderer.invoke('forcar-varredura-nao-lidas'),
  instalarAtualizacaoAgora: () => ipcRenderer.invoke('instalar-atualizacao-agora'),
  verificarAtualizacaoManual: () => ipcRenderer.invoke('verificar-atualizacao-manual'),
  obterVersaoApp: () => ipcRenderer.invoke('obter-versao-app'),

  aoReceberQR: (cb) => ipcRenderer.on('bot-qr', (_, url) => cb(url)),
  aoMudarStatus: (cb) => ipcRenderer.on('bot-status', (_, status) => cb(status)),
  aoReceberLog: (cb) => ipcRenderer.on('bot-log', (_, log) => cb(log)),
  aoAtualizarPausados: (cb) => ipcRenderer.on('bot-pausados', (_, mapa) => cb(mapa)),
  aoAtualizarProcessos: (cb) => ipcRenderer.on('bot-processos-sync', (_, cfg) => cb(cfg)),
  aoReceberEventoUpdate: (cb) => ipcRenderer.on('bot-update-status', (_, dados) => cb(dados))
});