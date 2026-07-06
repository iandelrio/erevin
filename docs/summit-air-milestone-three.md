# Summit Air Milestone 3

Status: implemented as a Vercel-compatible serverless endpoint.

## Endpoint

`POST /api/summit-air/service-request`

This endpoint:

- accepts the nested service request schema from `docs/summit-air-agent-architecture.md`;
- also accepts ElevenLabs `post_call_transcription` webhook payloads and normalizes `analysis.data_collection_results`;
- validates required dispatcher fields, service area, dangerous-safety fields, and callback-phone handling;
- sends the ops email through Resend from `Summit Air Intake <success@payment.tryverex.com>`;
- defaults the ops recipient to `iandelriow@gmail.com`;
- returns `200` for delivered emails, `422` for invalid service-request content, `401` for bad auth, and `502` if Resend delivery fails.

GitHub Pages is not a fit for this milestone because the webhook needs server-side secrets for Resend and webhook authentication. Deploy this repo on Vercel, Netlify Functions, Cloudflare Workers/Pages Functions, or another serverless host. The checked-in implementation is shaped for Vercel's `/api` routing.

## Environment Variables

Set these on the serverless host:

```bash
RESEND_API_KEY=re_...
SUMMIT_AIR_OPS_EMAIL=iandelriow@gmail.com
SUMMIT_AIR_EMAIL_FROM="Summit Air Intake <success@payment.tryverex.com>"
SUMMIT_AIR_REPLY_TO="Verex Support <support@tryverex.com>"
SUMMIT_AIR_WEBHOOK_SECRET="generate-a-long-random-secret"
```

Optional for ElevenLabs post-call HMAC delivery:

```bash
ELEVENLABS_WEBHOOK_SECRET="the-hmac-secret-from-elevenlabs"
```

Use the same `RESEND_API_KEY` already configured in `verex-web` if that key has permission to send from `success@payment.tryverex.com`.

## Manual Test

With a local or deployed endpoint:

```bash
curl -X POST "https://YOUR_HOST/api/summit-air/service-request" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUMMIT_AIR_WEBHOOK_SECRET" \
  --data-binary @examples/summit-air/routine.json
```

Run the other sample payloads:

```bash
for file in examples/summit-air/*.json; do
  curl -sS -X POST "https://YOUR_HOST/api/summit-air/service-request" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $SUMMIT_AIR_WEBHOOK_SECRET" \
    --data-binary "@$file"
  echo
done
```

## ElevenLabs Agent Changes

Use one of these integration paths.

### Preferred During-Call Tool

Create a webhook tool named `submit_service_request`.

- Method: `POST`
- URL: `https://YOUR_HOST/api/summit-air/service-request`
- Headers:
  - `Content-Type: application/json`
  - `Authorization: Bearer <SUMMIT_AIR_WEBHOOK_SECRET>` or `X-Summit-Air-Webhook-Secret: <SUMMIT_AIR_WEBHOOK_SECRET>`
- Body: the nested JSON schema from `docs/summit-air-agent-architecture.md`.

Add this to the agent prompt:

```text
After you summarize the request and before ending the call, call the submit_service_request webhook exactly once if the request is booked or if the caller is out of area and not booked. Do not call it before safety instructions are given for dangerous calls. Do not call it for pure silence or abandoned calls without enough service details.

The webhook body must match the Summit Air structured service request schema. Use caller_id as the phone when available and set phone_source to twilio_caller_id. If caller_id is private, anonymous, unknown, unavailable, or not a phone number, ask once for a callback phone. If the caller does not provide one, set caller.phone to unknown, phone_source to unavailable, caller_id_private to true, and callback_phone_available to false.
```

### Post-Call Webhook Path

Enable post-call transcription webhooks to the same endpoint, then add data collection items in the agent's Analysis tab. Use these identifiers:

- `caller_name`
- `caller_phone`
- `phone_source`
- `caller_id_private`
- `callback_phone_available`
- `address_line_1`
- `address_line_2`
- `borough`
- `is_in_service_area`
- `property_type`
- `business_name`
- `issue_category`
- `issue_description`
- `system`
- `urgency_level`
- `priority_reasons`
- `safety_action_given`
- `caller_confirmed_safe`
- `preferred_windows`
- `timezone`
- `next_step_status`
- `spoken_confirmation`
- `transcript_url`
- `agent_version`

Data collection descriptions should be explicit. Example:

```text
urgency_level: Classify as exactly one of routine, priority, dangerous_safety_handoff, or out_of_area. Use dangerous_safety_handoff only for gas smell, carbon monoxide, smoke, fire, sparking, or immediate safety risk. Use out_of_area when the location is outside Manhattan, Queens, and Brooklyn.
```

`issue_category` supports multiple values. Configure it as a **String** data
point (not a single-select enum) so the agent can return more than one issue,
and instruct it to return a comma-separated list drawn from the allowed values:

```text
issue_category: One or more of no_heat, no_ac, maintenance, gas_smell, carbon_monoxide, water_leak, noise, other. Return every category that applies as a comma-separated list, e.g. "noise, water_leak". Do not invent categories outside this list.
```

The endpoint normalizes the string into an array and drops any value outside the
allowed set.

For Twilio caller ID, either:

- pass `caller_id` into the conversation as a dynamic variable through ElevenLabs Twilio personalization, or
- include it in the webhook tool body directly when the agent calls `submit_service_request`.

The endpoint will use a valid `caller_id` as `caller.phone` when available. If it receives `anonymous`, `private`, `unknown`, or `unavailable`, it will keep the phone as `unknown` and the ops email will prominently show that no callback phone is available.
