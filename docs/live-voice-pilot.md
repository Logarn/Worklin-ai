# Live voice pilot

Worklin's live-voice UI and conversation bridge are provider-neutral. The
server-owned `services.voice.engine` selector chooses `native`, `hume`, or
`elevenlabs`; it is intentionally not exposed as a customer setting.

## Pilot configuration

Enable the `voice-mode` assistant flag, then add a server-only block to the
assistant configuration:

```json
{
  "services": {
    "voice": {
      "engine": "hume",
      "pilotAllowlist": ["<actor-principal-id>"],
      "providers": {
        "hume": { "configId": "<evi-config-id>", "voiceId": "" },
        "elevenlabs": { "agentId": "<agent-id>", "voiceId": "" }
      }
    }
  }
}
```

Store pilot credentials through the existing secure credential service; do not
put them in config files or renderer environment variables:

```sh
assistant credentials set --service hume --field api_key
assistant credentials set --service hume --field secret_key
assistant credentials set --service elevenlabs --field api_key
```

These become `credential/hume/api_key`, `credential/hume/secret_key`, and
`credential/elevenlabs/api_key`. Worklin exchanges them for short-lived client
credentials and never returns the stored keys to the renderer.

## Provider setup

Point the provider's OpenAI-compatible custom language model at:

```text
https://<public-worklin-gateway>/v1/live-voice/providers/chat/completions
```

For Hume, configure that URL as the EVI config's custom language model. Worklin
passes its signed session binding in `custom_session_id`.

For ElevenLabs, configure the Speech Engine resource's `wsUrl` as:

```text
wss://<public-worklin-gateway>/v1/live-voice/providers/elevenlabs/upstream
```

The browser receives only a short-lived WebRTC conversation token. Worklin
verifies ElevenLabs' upstream HS256 authorization JWT, binds the provider
conversation ID to the signed Worklin session, cancels stale `event_id`
generations on interruption, and streams correlated `agent_response` chunks.

The pilot stores completed Worklin messages and latency metrics. It does not
archive provider audio. The first microphone activation shows an AI-voice and
third-party processing disclosure. Approval-required tools continue through
Worklin's normal approval UI.

## Surfaces

- In-app voice expands inside the existing chat composer.
- The Electron overlay uses the same React panel and defaults to
  `Option+Space`; the shortcut is configurable under Keyboard Shortcuts.
- `Escape` or Close ends the active conversation and releases microphone,
  playback, provider transport, and the server session lease.

Keep `native` available until both managed providers pass the continuous-turn,
barge-in, reconnect, persistence, safety, and latency pilot gates.
