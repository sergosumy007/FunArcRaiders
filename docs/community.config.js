// Public settings of the player-reports layer. An empty api keeps the whole feature switched off.
window.FAR_CM = { api: 'https://funarcraiders-community.funarcraiders-community.workers.dev', turnstile: '0x4AAAAAAF8Z6oDjdxoSt_K9' };
if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
  window.FAR_CM = { api: 'http://127.0.0.1:8787', turnstile: '1x00000000000000000000AA' };
}
