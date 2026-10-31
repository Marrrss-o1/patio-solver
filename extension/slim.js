// Shrinks a solver result to what the overlay shows (shared by background.js and the workers).
// eslint-disable-next-line no-unused-vars
function slim(r) {
  const sc = (s) => s && {
    kind: s.kind, label: s.label, sizeLabel: s.sizeLabel || '', amount: s.amount,
    ev: s.ev, se: s.se, foldPct: s.foldPct || 0, reraisedPct: s.reraisedPct || 0,
    equityWhenCalled: s.equityWhenCalled, freq: s.freq, bpFreq: s.bpFreq,
  };
  return {
    street: r.street, pot: r.pot, toCall: r.toCall, stack: isFinite(r.stack) ? r.stack : null,
    bigBlind: r.bigBlind, inPosition: r.inPosition, lookahead: !!r.lookahead,
    best: sc(r.best), runnerUp: sc(r.runnerUp), ranked: r.ranked.map(sc),
    margin: isFinite(r.margin) ? r.margin : null, close: r.close, mix: r.mix, solver: r.solver, blueprint: r.blueprint,
    equity: r.equity, potOdds: r.potOdds, hero: r.hero, impliedOddsNeeded: r.impliedOddsNeeded,
    opponents: r.opponents.map((o) => ({
      name: o.name, pending: o.pending, aggressor: o.aggressor,
      type: { key: o.type.key, label: o.type.label, tip: o.type.tip },
      stats: {
        hands: o.stats.hands, vpip: o.stats.vpip, pfr: o.stats.pfr, af: o.stats.af,
        foldToBet: o.stats.foldToBet, confidence: o.stats.confidence,
        exploitWeight: o.stats.exploitWeight, accuracy: o.stats.accuracy, strengthBias: o.stats.strengthBias,
        callBig: o.stats.callBig, tiltAgg: o.stats.tiltAgg, tiltPas: o.stats.tiltPas,
      },
      topClasses: o.grid.topClasses.slice(0, 8).map((c) => c.name),
      heroVs: o.heroVs, foldToBest: o.foldToBest, summary: o.summary || '', bluffChance: o.bluffChance,
    })),
  };
}
