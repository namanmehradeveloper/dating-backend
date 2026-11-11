# Voice & video calls API (Flutter / member app)

Member signalling for `AUDIO` and `VIDEO` calls. Media runs on **Agora RTC**; this API only handles call lifecycle and issues per-participant tokens. **Do not** put `AGORA_APP_CERTIFICATE` in the app.

Admin call ops (`/admin/calls/*`) are out of scope for the member app.

---

## Base

| Item | Value |
| --- | --- |
| REST base | `{BASE_URL}/api/v1` |
| Auth header | `Authorization: Bearer <accessToken>` |
| Socket.IO | same host, namespace `/v1` |
| Socket auth | `auth: { token: accessToken }` |
| Transport | `websocket` |

Every protected REST call and the socket handshake need a valid access token.

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
    "details": [{ "field": "type", "reason": "INVALID" }]
  },
  "meta": { "requestId": "req_..." }
}
```

---

## Concepts

| Concept | Notes |
| --- | --- |
| Types | `AUDIO` \| `VIDEO` |
| Statuses | `RINGING` \| `ACCEPTED` \| `REJECTED` \| `CANCELLED` \| `MISSED` \| `BUSY` \| `ENDED` |
| Who can call | Only participants of an active, visible match **conversation** |
| One active call | A user may only be in one `RINGING` or `ACCEPTED` call at a time |
| Ring timeout | Default **30 seconds** (`CALL_RING_TIMEOUT_SECONDS`, range 10–120). Missed calls are swept about every 5s |
| Agora | Required. If not configured, start/accept return `FEATURE_NOT_CONFIGURED` |

### `Call` object

```json
{
  "id": "665f1c2e9b1d4a0012345678",
  "conversationId": "cnv_...",
  "callerId": "usr_...",
  "calleeId": "usr_...",
  "type": "AUDIO",
  "status": "RINGING",
  "createdAt": "2026-11-10T10:00:00.000Z",
  "ringExpiresAt": "2026-11-10T10:00:30.000Z",
  "acceptedAt": null,
  "endedAt": null
}
```

### `Credentials` object (Agora join)

```json
{
  "appId": "0123456789abcdef0123456789abcdef",
  "channelName": "call_...",
  "token": "...",
  "uid": 123456789,
  "expiresAt": "2026-11-10T11:00:00.000Z"
}
```

- Token TTL ≈ **1 hour**
- Each participant gets their **own** `uid` + `token` for the same `channelName`
- Flutter: join with Agora RTC using `appId`, `channelName`, `token`, `uid`
- Never expect `appCertificate` in responses

---

## REST endpoints

All under `/api/v1/calls`. All require auth.

### 1. Start call

`POST /calls`  
Rate limit: **10 starts per user per minute**

**Body**

```json
{
  "conversationId": "cnv_...",
  "type": "AUDIO"
}
```

`type` must be `AUDIO` or `VIDEO`.

**201 — ringing (normal)**

```json
{
  "call": {
    "id": "...",
    "conversationId": "cnv_...",
    "callerId": "usr_...",
    "calleeId": "usr_...",
    "type": "VIDEO",
    "status": "RINGING",
    "createdAt": "...",
    "ringExpiresAt": "...",
    "acceptedAt": null,
    "endedAt": null
  },
  "credentials": {
    "appId": "...",
    "channelName": "call_...",
    "token": "...",
    "uid": 111,
    "expiresAt": "..."
  }
}
```

- Caller may join Agora immediately with `credentials`
- Callee receives socket event `call:incoming` with `{ call }` (no credentials yet)

**Busy (callee already in a call)**

```json
{
  "call": { "status": "BUSY", "...": "..." },
  "credentials": null
}
```

- Caller also gets socket `call:busy`

**Errors**

| Situation | Typical result |
| --- | --- |
| Missing / invalid token | `401` |
| Bad `type` or missing `conversationId` | `400` + validation details |
| Conversation not found / not a participant | `404` |
| Caller already in a call | `409` — “You are already in a call.” |
| Agora not configured | `501` `FEATURE_NOT_CONFIGURED` |
| Start rate exceeded | rate-limit error + `Retry-After` |

---

### 2. Accept call (callee only)

`POST /calls/:callId/accept`

**200**

```json
{
  "call": { "status": "ACCEPTED", "acceptedAt": "...", "...": "..." },
  "credentials": {
    "appId": "...",
    "channelName": "call_...",
    "token": "...",
    "uid": 222,
    "expiresAt": "..."
  }
}
```

- Callee joins Agora with returned `credentials`
- Caller receives `call:accepted`
- Non-callee or outsider → `404`
- Expired / no longer ringing → `409`

---

### 3. Reject call (callee, while `RINGING`)

`POST /calls/:callId/reject`

**200** — `Call` with `status: "REJECTED"`  
Caller receives `call:rejected`.

---

### 4. Cancel call (caller, while `RINGING`)

`POST /calls/:callId/cancel`

**200** — `Call` with `status: "CANCELLED"`  
Callee receives `call:cancelled`.

---

### 5. End call (either party, while `ACCEPTED`)

`POST /calls/:callId/end`

**200** — `Call` with `status: "ENDED"`  
Both parties receive `call:ended`.  
Leave the Agora channel after this.

---

### 6. Active call (reconnect / app resume)

`GET /calls/active`

**No active call**

```json
{
  "call": null,
  "direction": null,
  "credentials": null
}
```

**Active call**

```json
{
  "call": { "...": "..." },
  "direction": "OUTGOING",
  "credentials": { "...": "..." }
}
```

| Field | Meaning |
| --- | --- |
| `direction` | `OUTGOING` (you are caller) or `INCOMING` (you are callee) |
| `credentials` | `null` when you are **incoming** and still `RINGING` (must accept first). Otherwise join credentials for the current user |

If the ring window already expired, the call is marked `MISSED` and this returns the empty shape.

---

### 7. Call history

`GET /calls?limit=20`

- `limit` optional, integer **1–50**, default **20**
- Newest first
- Only calls where the authenticated user is caller or callee

**200**

```json
{
  "items": [
    {
      "id": "...",
      "conversationId": "cnv_...",
      "callerId": "usr_...",
      "calleeId": "usr_...",
      "type": "VIDEO",
      "status": "ENDED",
      "createdAt": "...",
      "ringExpiresAt": "...",
      "acceptedAt": "...",
      "endedAt": "..."
    }
  ]
}
```

---

## Socket.IO events

Connect to namespace `/v1` with `auth.token = accessToken`.

| Event | Delivered to | Payload |
| --- | --- | --- |
| `call:incoming` | Callee | `{ "call": Call }` |
| `call:accepted` | Caller | `{ "call": Call }` |
| `call:rejected` | Caller | `{ "call": Call }` |
| `call:cancelled` | Callee | `{ "call": Call }` |
| `call:ended` | Both | `{ "call": Call }` |
| `call:missed` | Both | `{ "call": Call }` |
| `call:busy` | Caller | `{ "call": Call }` |

Events carry **call metadata only** — never Agora tokens. Tokens come only from REST (`start`, `accept`, `active`).

---

## Recommended Flutter flows

### Outgoing

1. Ensure Socket.IO `/v1` is connected.
2. `POST /calls` with `conversationId` + `type`.
3. If `credentials != null` and `status == RINGING`, join Agora.
4. Listen for `call:accepted` | `call:rejected` | `call:missed` | `call:busy`.
5. While ringing: cancel with `POST /calls/:id/cancel`.
6. After accepted: hang up with `POST /calls/:id/end`, then leave channel.

### Incoming

1. On `call:incoming`, show ringing UI (`call.type` drives audio vs video UI).
2. Accept → `POST /calls/:id/accept` → join Agora with `credentials`.
3. Or reject → `POST /calls/:id/reject`.
4. On app resume / socket reconnect → `GET /calls/active` to restore UI and credentials.

### Audio vs video

Same REST + socket contract. Only `type` differs; turn camera on for `VIDEO`, off for `AUDIO` in the Agora client.

---

## Error codes (quick reference)

| Code / HTTP | When |
| --- | --- |
| `401` unauthenticated | Missing or expired access token |
| `400` validation | Invalid `type`, missing `conversationId`, bad `limit` |
| `404` | Unknown call/conversation, or not a participant |
| `409` conflict | Already in a call, ring expired, wrong lifecycle state |
| `501` `FEATURE_NOT_CONFIGURED` | Agora credentials not set on the server |
| Rate limited | Too many `POST /calls` (check `Retry-After`) |

---

## Security checklist for Flutter

- [ ] Never ship `AGORA_APP_CERTIFICATE` in the app
- [ ] Use only server-issued `token` + `uid` + `channelName`
- [ ] Do not call `/admin/calls/*` from the member app
- [ ] Refresh access token before long calls if JWT may expire mid-call
- [ ] On `call:ended` / `call:missed` / reject / cancel, always leave the Agora channel
- [ ] Treat `BUSY` as a soft failure (show “user busy”), not as credentials to join
