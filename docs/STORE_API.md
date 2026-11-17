# Store API (Flutter / member app)

Virtual goods: coin packs, emoji packs, and gifts. Wallet + inventory live on the server.

**Do not** call `/api/v1/admin/store/*` from the member app.

---

## Base

| Item | Value |
| --- | --- |
| REST base | `{BASE_URL}/api/v1` |
| Auth header | `Authorization: Bearer <accessToken>` |
| Content-Type | `application/json` |

All `/store/*` routes require auth.

Success envelope:

```json
{
  "success": true,
  "data": {},
  "meta": { "requestId": "req_..." }
}
```

Error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "...",
    "details": [{ "field": "itemId", "reason": "REQUIRED" }]
  },
  "meta": { "requestId": "req_..." }
}
```

---

## Concepts

| Kind | How to buy | What it does |
| --- | --- | --- |
| `COIN_PACK` | `POST /store/checkout` → `POST /store/verify` | Credits `coinAmount` to wallet |
| `EMOJI_PACK` | `POST /store/buy-with-coins` | Unlocks pack once (`ownedPackIds`) |
| `GIFT` | `POST /store/buy-with-coins` **or** pay at send time | Inventory unit, or coins deducted when sending in chat |

- Coin packs use **money** (`priceMoneyMinor` in paise, `currency` usually `INR`).
- Emoji packs and gifts use **coins** (`priceCoins`).
- Demo payments: simulate checkout with `providerProof.outcome` = `SUCCESS` \| `FAILURE`. Real IAP adapters come later.
- Checkout TTL ≈ **30 minutes**.

### `StoreItem`

```json
{
  "id": "coins_100",
  "kind": "COIN_PACK",
  "title": "100 Coins",
  "description": "A small top-up for gifts and emoji packs.",
  "emoji": "🪙",
  "imageUrl": "",
  "emojis": [],
  "priceCoins": 0,
  "priceMoneyMinor": 4900,
  "currency": "INR",
  "coinAmount": 100,
  "isActive": true,
  "sortOrder": 10,
  "priceLabel": "₹49"
}
```

- `COIN_PACK`: use `priceMoneyMinor` + `coinAmount`; `priceLabel` is rupee text.
- `EMOJI_PACK` / `GIFT`: use `priceCoins`; `priceLabel` is like `"80 coins"`.
- `EMOJI_PACK.emojis`: allowed emoji characters for chat `paidEmoji`.

### `Wallet`

```json
{
  "coinBalance": 100,
  "ownedPackIds": ["emoji_pack_hearts"],
  "giftInventory": [{ "itemId": "gift_rose", "quantity": 2 }]
}
```

### `Purchase` (history / checkout)

```json
{
  "id": "...",
  "checkoutId": "store_...",
  "itemId": "coins_100",
  "kind": "COIN_PACK",
  "provider": "demo",
  "environment": "demo",
  "platform": "IOS",
  "amountMinor": 4900,
  "currency": "INR",
  "coinsDelta": 100,
  "status": "PENDING",
  "isDemo": true,
  "failureReason": null,
  "verifiedAt": null,
  "createdAt": "2026-11-17T00:00:00.000Z"
}
```

Statuses: `PENDING` \| `SUCCEEDED` \| `FAILED` \| `CANCELLED`.

---

## Default catalogue IDs

Seeded on first use (admin can change active items later).

| id | kind | Notes |
| --- | --- | --- |
| `coins_100` | `COIN_PACK` | 100 coins · ₹49.00 |
| `coins_500` | `COIN_PACK` | 500 coins · ₹199.00 |
| `coins_1200` | `COIN_PACK` | 1,200 coins · ₹399.00 |
| `emoji_pack_hearts` | `EMOJI_PACK` | 80 coins · `💕💖💗💓💞💘` |
| `emoji_pack_neon` | `EMOJI_PACK` | 120 coins · `✨🔥⚡🌟💫🪩` |
| `gift_rose` | `GIFT` | 25 coins |
| `gift_coffee` | `GIFT` | 40 coins |
| `gift_teddy` | `GIFT` | 75 coins |
| `gift_chocolate` | `GIFT` | 50 coins |
| `gift_sparkler` | `GIFT` | 90 coins |
| `gift_crown` | `GIFT` | 150 coins |

---

## REST endpoints

All under `/api/v1/store`. All require auth.

### `GET /store/catalog`

Active items only.

```json
{
  "items": [/* StoreItem */],
  "coinPacks": [],
  "emojiPacks": [],
  "gifts": []
}
```

Use the grouped arrays for UI sections; `items` is the flat list.

---

### `GET /store/wallet`

Current balance, owned emoji packs, and gift stock.

---

### `GET /store/history?limit=20&cursor=`

Cursor pagination (same style as other member lists).

```json
{
  "items": [/* Purchase */],
  "nextCursor": null
}
```

---

### `POST /store/checkout`

Start a **coin pack** purchase only.

**Body**

```json
{
  "itemId": "coins_100",
  "platform": "IOS"
}
```

| Field | Rules |
| --- | --- |
| `itemId` | Required string; must be active `COIN_PACK` |
| `platform` | `IOS` \| `ANDROID` \| `WEB` |

**Response (data)** includes purchase fields plus:

```json
{
  "checkoutId": "store_...",
  "status": "PENDING",
  "checkoutExpiresAt": "2026-11-17T00:30:00.000Z",
  "clientPayload": {
    "mode": "demo",
    "simulateOutcomes": ["SUCCESS", "FAILURE"],
    "amountMinor": 4900,
    "currency": "INR",
    "itemId": "coins_100",
    "coinAmount": 100,
    "instructions": "Call POST /store/verify with providerProof.outcome SUCCESS or FAILURE."
  }
}
```

| Error | When |
| --- | --- |
| `400` `MUST_BE_COIN_PACK` | Emoji pack / gift passed as `itemId` |
| `404` | Unknown / inactive item |
| `501` `FEATURE_NOT_CONFIGURED` | Demo store payments disabled on server |

Rate limit: ~40 / hour / user.

---

### `POST /store/verify`

Complete a pending coin-pack checkout (demo).

**Body**

```json
{
  "checkoutId": "store_...",
  "providerProof": { "outcome": "SUCCESS" }
}
```

| Field | Rules |
| --- | --- |
| `checkoutId` | Required |
| `providerProof.outcome` | `SUCCESS` \| `FAILURE` (demo) |

**Response**

```json
{
  "purchase": { /* Purchase */ },
  "wallet": { /* Wallet */ },
  "replayed": false
}
```

- `SUCCESS` → credits `coinsDelta`, status `SUCCEEDED`.
- `FAILURE` → status `FAILED`, no coins.
- Same `SUCCESS` again → `replayed: true`, balance not double-credited.

| Error | When |
| --- | --- |
| `404` | Unknown checkout |
| `403` `FORBIDDEN` | Checkout belongs to another user |
| `409` | Already `FAILED` / `CANCELLED` |
| `400` | Bad `providerProof.outcome` |
| `501` | Demo payments not enabled |

Rate limit: ~60 / hour / user.

---

### `POST /store/buy-with-coins`

Buy an **emoji pack** or add **one gift** to inventory.

**Body**

```json
{ "itemId": "emoji_pack_hearts" }
```

**Response**

```json
{
  "item": { /* StoreItem */ },
  "wallet": { /* Wallet */ }
}
```

| Error | When |
| --- | --- |
| `400` `MUST_BE_PACK_OR_GIFT` | Coin pack passed here |
| `404` | Unknown / inactive item |
| `409` | Emoji pack already owned |
| Insufficient coins | Not enough `coinBalance` |

Rate limit: ~60 / hour / user.

---

## Chat integration (gifts & paid emoji)

Use existing chat send:

`POST /api/v1/conversations/:conversationId/messages`

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <accessToken>` |
| `Idempotency-Key` | Same UUID as `clientMessageId` |

Exactly **one** content mode: text/attachment **or** gift **or** paid emoji.

### Send gift

```json
{
  "giftItemId": "gift_rose",
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Server prefers one inventory unit; otherwise deducts `priceCoins` at send time.

Message `data` includes:

```json
{
  "gift": {
    "itemId": "gift_rose",
    "title": "Rose",
    "emoji": "🌹",
    "imageUrl": "",
    "priceCoins": 25
  }
}
```

### Send paid emoji

Caller must own the pack (`ownedPackIds`).

```json
{
  "paidEmoji": {
    "packId": "emoji_pack_hearts",
    "emoji": "💕"
  },
  "clientMessageId": "550e8400-e29b-41d4-a716-446655440000"
}
```

`emoji` must be in that pack’s `emojis` list.

Message `data` includes:

```json
{
  "paidEmoji": {
    "packId": "emoji_pack_hearts",
    "packTitle": "Hearts Pack",
    "emoji": "💕"
  }
}
```

Socket event `message:new` carries the same message shape.

---

## Recommended Flutter flows

### Store screen

1. `GET /store/catalog`
2. `GET /store/wallet`
3. Show coin packs / emoji packs / gifts from grouped arrays
4. Disable “Buy pack” if `item.id` is already in `ownedPackIds`

### Buy coins

1. `POST /store/checkout` with `itemId` + `platform` (`IOS` / `ANDROID`)
2. Demo: skip real payment UI
3. `POST /store/verify` with `providerProof.outcome: "SUCCESS"`
4. Refresh from returned `wallet` (or `GET /store/wallet`)

### Buy emoji pack / stock a gift

1. Ensure `coinBalance` ≥ `priceCoins`
2. `POST /store/buy-with-coins` with `itemId`
3. Update UI from returned `wallet`

### Chat gift

1. Optional: pre-buy via `buy-with-coins`, or send with enough coins
2. `POST .../messages` with `giftItemId` + matching `Idempotency-Key`

### Chat paid emoji

1. Buy pack via `buy-with-coins` if needed
2. Pick emoji from pack `emojis`
3. `POST .../messages` with `paidEmoji` + matching `Idempotency-Key`

---

## Errors (quick reference)

| Code / HTTP | When |
| --- | --- |
| `401` | Missing / expired access token |
| `400` validation | Bad body, wrong item kind |
| `403` / insufficient coins | Gift send or spend without balance |
| `404` | Unknown item or checkout |
| `409` | Pack already owned; checkout no longer pending |
| `501` `FEATURE_NOT_CONFIGURED` | Demo store payments off |
| Rate limited | Too many checkout / verify / buy calls — honor `Retry-After` |

---

## Security checklist for Flutter

- [ ] Never call `/admin/store/*`
- [ ] Only trust wallet / inventory from API responses
- [ ] Use server `checkoutId`; do not invent credit amounts client-side
- [ ] Keep `Idempotency-Key` === `clientMessageId` for gift / paid-emoji sends
- [ ] Refresh access token before long store sessions if JWT may expire

---

*Member store contract for the mobile app. Admin catalogue management is intentionally omitted.*
