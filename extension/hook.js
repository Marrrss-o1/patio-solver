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

  let hooked = null;
  function attach() {
    const gm = window.GameManager;
    const sock = gm && gm.socket;
    if (!sock || sock === hooked || typeof sock.onAny !== 'function') return;
    hooked = sock;
    sock.onAny((ev, data) => {
      if (WANTED.has(ev)) post(ev, data);
    });
    post('hook:attached', null);
  }

  setInterval(attach, 250);
  // Lets the overlay ask for fresh table state at any time.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.source === 'patio-solver-overlay' && e.data.type === 'snapshot') {
      post('hook:snapshot', null);
    }
  });
})();
