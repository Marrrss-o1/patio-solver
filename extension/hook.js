// Runs inside the Poker Patio page. Listens to the game's own socket.io
// connection and forwards table events to the overlay (overlay.js).
// It only reads events; it never sends anything to the game server.
(function () {
  'use strict';
  if (window.__patioSolverHook) return;
  window.__patioSolverHook = true;

  const WANTED = new Set([
    'game:stage_began',
    'game:dealer_updated',
    'game:small_blind_paid',
    'game:big_blind_paid',
    'game:cards_dealt_to_player',
    'game:card_dealt_to_player',
    'game:update_card_data',
    'game:cards_deal_to_stack',
    'game:card_deal_to_stack',
    'player:game:action_taken',
    'game:player_turn_started',
    'game:player_turn_ended',
    'game:game_ended',
    'admin:game:game_stopped',
  ]);

  // Other table events are forwarded only so the hand log's raw recorder can keep them
  // (the tracker ignores them). Lobby-wide traffic is skipped.
  function recordOnly(ev, data) {
    if (ev === 'chat_message') return !!(data && data.msgType === 'game_log');
    return /^(game:|player:game:|admin:game:)/.test(ev);
  }

  function snapshot() {
    const gm = window.GameManager;
    const st = (gm && gm.state) || {};
    const bs = (st.settings && st.settings.blind_sizes) || [];
    return {
      tableType: gm && gm.data ? gm.data.tableType : null,
      heroAuthId: gm && gm.playerData ? gm.playerData.id : null,
      bigBlind: bs.length ? bs[bs.length - 1].bb : null,
      players: (st.players || []).map((p) => ({
        id: p.id,
        authUserId: p.authUserId,
        name: p.name,
        stack: p.stack,
        posType: p.posType,
        playState: p.playState,
        totalBetsMade: p.totalBetsMade,
      })),
    };
  }

  function post(ev, data) {
    let payload;
    try {
      payload = JSON.parse(JSON.stringify(data === undefined ? null : data));
    } catch (e) {
      payload = null;
    }
    window.postMessage({ source: 'patio-solver-hook', ev, data: payload, snap: snapshot() }, location.origin);
  }

  // The game's socket. Poker Patio's 3 Nov 2026 update moved it to GameManager.roomConnectionManager.socket
  // (a new socket on every reconnect); before that it was GameManager.socket.
  function gameSocket(gm) {
    const rcm = gm && gm.roomConnectionManager;
    return (rcm && rcm.socket) || (gm && gm.socket) || null;
  }

  let hooked = null;
  let lastEventAt = 0, sigMoves = 0, firstMoveAt = 0;
  const onAny = (ev, data) => {
    lastEventAt = Date.now(); sigMoves = 0;
    if (WANTED.has(ev) || recordOnly(ev, data)) post(ev, data);
  };
  function attach() {
    const sock = gameSocket(window.GameManager);
    if (!sock || sock === hooked || typeof sock.onAny !== 'function') return;
    if (hooked && typeof hooked.offAny === 'function') hooked.offAny(onAny);
    hooked = sock;
    sock.onAny(onAny);
    post('hook:attached', null);
  }

  setInterval(attach, 250);

  // Watchdog: when a game update moves the socket again, the panel says so instead of a quiet "Connected" with no
  // advice (3 Nov 2026: the hook never attached and nothing showed it). 'nosocket': a table is on screen but no
  // socket was found for noSocketMs. 'silent': the table's chips moved at least twice over silentMs with no socket
  // event at all in that time (the socket we hold went quiet). Test pages can shorten the waits with
  // window.__patioSolverWatch = { noSocketMs, silentMs }.
  const startedAt = Date.now();
  let lastSig = null, problem = null;
  function chipSig(gm) {
    const ps = (gm && gm.state && gm.state.players) || [];
    return ps.map((p) => [p.id, p.stack, p.totalBetsMade, p.playState].join(':')).join('|');
  }
  function watch() {
    const gm = window.GameManager, cfg = window.__patioSolverWatch || {};
    const noSocketMs = cfg.noSocketMs || 15000, silentMs = cfg.silentMs || 20000, now = Date.now();
    const table = !!(gm && gm.state && Array.isArray(gm.state.players) && gm.state.players.length);
    let p = null;
    if (table && !hooked && now - startedAt >= noSocketMs) p = 'nosocket';
    if (table && hooked) {
      const sig = chipSig(gm);
      if (lastSig != null && sig !== lastSig) { if (!sigMoves) firstMoveAt = now; sigMoves++; }
      lastSig = sig;
      if (sigMoves >= 2 && now - firstMoveAt >= silentMs && now - lastEventAt >= silentMs) p = 'silent';
    }
    if (p !== problem) { problem = p; post('hook:health', { problem: p }); }
  }
  setInterval(watch, 1000);

  // Lets the overlay ask for fresh table state at any time (and whether a socket is attached).
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.source === 'patio-solver-overlay' && e.data.type === 'snapshot') {
      post('hook:snapshot', { attached: !!hooked, problem });
    }
  });
})();
