# Poker Patio socket protocol (as observed, October 2026)

Poker Patio's private lobbies (`https://pokerpatio.com/mp?game=<id>`) run on **socket.io v4**. The page exposes
`window.GameManager`, and the live socket is `GameManager.socket`. Every table event arrives as a named socket.io
event. Both builds attach with `socket.onAny(...)`. That listener fires **before** the game's own handlers, so a
snapshot of `GameManager.state` taken inside it reflects the state *before* the event is applied.

Everything below was recorded from real hands in a test lobby.

## Useful globals

| Path | Meaning |
|---|---|
| `GameManager.data.tableType` | `"private"` for friends' lobbies. The overlay refuses to run on anything else. |
| `GameManager.playerData.id` | Hero's auth user id (matches `players[].authUserId`). |
| `GameManager.state.players[]` | `{ id, authUserId, name, stack, posType: "s1".."s10", playState, totalBetsMade, totalStageBetsMade, ... }`. `stack` and `totalBetsMade` are updated live as bets happen. **`totalStageBetsMade` was 0 preflop even with blinds posted, so don't rely on it.** |
| `GameManager.state.settings.blind_sizes` | `[{ sb, bb, requirements }]` (last entry = current). |

`playState` values seen: `playing`, `folded`, `away`, `waiting_to_play`.

## Hand lifecycle (in order)

```
game:stage_began        { stageType: "set_blinds", stageId: 0 }     <- new hand starts here
game:dealer_updated     { dealerSeatPos: "s1", dealerPlayerID, smallBlindSeatPos, smallBlindPlayerID, bigBlindSeatPos, bigBlindPlayerID, underTheGunSeatPos, underTheGunPlayerID }
game:small_blind_paid   { amount: 5, playerId: 1 }
game:big_blind_paid     { amount: 10, playerId: 2 }
game:stage_ended        { stageType: "set_blinds" }
game:stage_began        { stageType: "deal_hands" }
game:cards_dealt_to_player [ { playerPos: "s7", cardData: { uniqueID }, delay }, ... ]   // face-down, ids only
game:update_card_data   { cardData: { uniqueID, cardID, suite: "spades", value: "6", name }, flipCard: true }  // hero's own cards revealed
game:stage_began        { stageType: "pre_flop" }
game:player_turn_started { playerID, playerPos, timestamp, turnTimeDurationMS, turnTimeElapsedMS }
player:game:action_taken { playerID, playerPos, actionType: "check"|"call"|"raise"|"fold", makeBetValue, wasServerAutoAction }
game:player_turn_ended  { playerID, playerPos, timestamp }
game:stage_began        { stageType: "flop" | "turn" | "river" }
game:cards_deal_to_stack [ { delay, emitData: { stackID: "community_stack", cardData: { uniqueID, suite, value, ... } } } ]
...
game:stage_began        { stageType: "showdown" }      // also sent when the pot is won uncontested
game:update_card_data   ...                            // opponents' cards revealed at showdown (arrives after the
                                                       // showdown stage; the tracker matches uniqueID to the seat
                                                       // from cards_dealt_to_player and logs the shown hand)
game:game_ended         { endPopupData: { gameResults: { winnersInfo, sidePotsWithWinners, ... } } }
```

Card `value` is `"2".."10","J","Q","K","A"` and `suite` is `clubs|diamonds|hearts|spades`. Dealer-stack deals
(`stackID: "dealer_stack"`) carry no card values and can be ignored.

## Bet accounting (verified)

* **`makeBetValue` = chips the player added with this action**, not the total they've now bet. Examples from real
  hands: SB completes → `call 5`; facing 240 with 140 in → `call 100`; a $20 bet raised to $40 by a player with 0 in → `raise 40`.
* There is no separate "bet" action. A first bet on a street comes through as `"raise"`. The tracker turns it into
  `bet` when nobody has bet yet this street.
* Outgoing `player:game:perform_action` uses `raiseAmount` = **raise-by on top of the call** (sending
  `raiseAmount: 100` while facing 20 produced `makeBetValue: 120`). The overlay never sends actions. This is only
  noted so nobody misreads it.
* Sending `check` when there is a bet to call was treated by the server as a **fold**.
* Uncalled bets are refunded and announced in chat logs (`chat_message` with `log.e === "ur"`).

## Chat game log (not used, but handy)

`chat_message` events with `msgType: "game_log"` carry compact logs: `df`/`dt`/`dr` = flop/turn/river cards
(`cds: ["Jh","5h","6h"]`, tens as `"10s"`), `w` = winner (`amt`, `hnd`), `hei` = hand end (`tp` total pot),
`ur` = uncalled bet refund, `psa` = player set away.

## Other events seen

`room:get`, `room:lobby_stats_updated` (includes `playerStates` with per-hand stats), `player:game:player_play_state_changed`,
`admin:game:game_started`, `admin:game:game_stopped`, `admin:game:new_hand_started` (includes full settings),
`admin:room:settings_updated`, `game:next_hand_cancelled`.
