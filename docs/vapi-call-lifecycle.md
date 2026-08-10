# Vapi call lifecycle

The Telegram approval token is the local idempotency key. The bot writes a
`vapi_calls` row before `POST /call`, gives Vapi a `letyclaw-<token>` call name,
and persists the returned provider call ID before confirming in Telegram.
Webhook events are preferred; polling resumes after restarts as a fallback.

## Secrets and services

Create a high-entropy Vapi bearer credential and keep only webhook-facing
values in `/etc/letyclaw-health-webhook/env`:

```dotenv
HEALTH_WEBHOOK_SECRET=<optional Apple Health secret>
VAPI_WEBHOOK_SECRET=<dedicated Vapi bearer secret>
VAPI_ASSISTANT_ID=<assistant id>
VAPI_SERVER_URL=https://bot.example.com/voice/vapi
VAPI_SERVER_CREDENTIAL_ID=<Vapi credential id>
VAPI_INBOUND_TOPIC_ID=<Telegram topic id used as a readiness gate>
```

Keep provider API and routing values in `/etc/letyclaw-bot/env`:

```dotenv
VAPI_API_KEY=<private API key>
VAPI_PHONE_NUMBER_ID=<phone number id>
VAPI_ASSISTANT_ID=<assistant id>
VAPI_SERVER_URL=https://bot.example.com/voice/vapi
VAPI_SERVER_CREDENTIAL_ID=<Vapi credential id>
VAPI_INBOUND_TOPIC_ID=<Telegram topic id>
VAPI_INBOUND_AGENT_ID=<configured agent id>
VAPI_INBOUND_CHAT_ID=<Telegram group id>
```

The systemd units share only `/var/lib/letyclaw-vapi/events` and the expiring,
phone-number-hashed `/var/lib/letyclaw-vapi/inbound-context` registry. The
internet-facing webhook has a distinct UID; it cannot read the bot API key,
Telegram token, session database, or connector credentials.

Run `scripts/deploy-agents.sh`, install the nginx snippet as described in
`docs/health-webhook-ingress.md`, rebuild, and restart `health-webhook` and
`letyclaw-bot`. Validate nginx before reloading it.

## Vapi configuration

1. Set the outbound assistant server URL to the HTTPS endpoint with the Vapi
   bearer credential. Request `status-update` and `end-of-call-report` events.
2. For callbacks, configure the phone number for dynamic assistant routing and
   use the same server URL and credential. `npm run vapi:configure-phone`
   applies this configuration from the environment and fails closed if a
   required value is absent.
3. Make the inbound greeting identify itself generically as the operator's
   automated assistant. It may use prior task context only after the caller
   independently identifies a matching callback purpose.
4. Never put the bearer secret in the URL.

Official references: [server events](https://docs.vapi.ai/server-url/events),
[server URLs and credentials](https://docs.vapi.ai/server-url/setting-server-urls),
[dynamic inbound assistants](https://docs.vapi.ai/assistants/personalization),
and [assistant hooks](https://docs.vapi.ai/assistants/assistant-hooks).

## Verification

For one approved outbound test, verify:

1. one `vapi_calls` row exists for the approval token;
2. it has exactly one provider call ID;
3. Telegram shows that ID immediately;
4. an event file is consumed or polling updates the row;
5. the same status message is edited with the ended reason and any real
   transcript; and
6. `notified_at` is set with no duplicate completion after a restart.

For an inbound test, call back from the same approved destination. A call from
another number must remain generic. The terminal result must appear in the
configured topic and link to the local outbound call when context matched.
