# Summit Air Implementation Plan

Status: lightweight 72-hour build plan

## Assumptions

- We have access to an ElevenLabs account with Conversational AI credits.
- We can buy a US phone number through Twilio.
- We can import the purchased Twilio number into ElevenLabs using the native Twilio integration.
- We can send an internal ops/demo email from the webhook to a fixed recipient.
- We will not use customer SMS or WhatsApp for the take-home MVP because production messaging compliance and sender setup can block delivery.
- Most callers will expose caller ID. If caller ID is private or unavailable, the agent will ask once for the best callback phone number.
- The agent will not ask callers for email addresses.
- Customer confirmation is spoken during the call. The written summary is sent only to the fixed ops/demo email recipient.
- Covered service area is Manhattan, Queens, and Brooklyn.

## Telephony Decision

Use Twilio for the demo phone number and call routing, and use ElevenLabs for the actual AI conversation.

Default call path:

`Caller -> Twilio purchased number -> ElevenLabs native Twilio integration -> Summit Air ElevenLabs agent -> service-request webhook`

Do not start with a custom Twilio Media Streams bridge. It adds realtime audio handling, latency risk, and operational surface area that the native ElevenLabs integration already covers. Keep Media Streams as a last-resort fallback only if the native integration or SIP trunking path is blocked.

## Milestone 1: Phone Infrastructure Smoke Test

Goal: prove a real phone number can be called.

Tasks:

- Buy and provision a Twilio phone number that supports inbound voice.
- Configure a temporary inbound response:
  - "Thanks for calling Summit Air. This is a test line."
- Call the number from a mobile phone.
- Verify inbound audio, caller ID, call logs, and hangup behavior. Confirm the inbound caller ID is available as Twilio `From` / ElevenLabs `caller_id`.
- Save the number and provider configuration in the project notes.

Pass criteria:

- A real phone can call the number.
- The call connects within a normal timeframe.
- Logs show the inbound call and caller metadata.
- Caller ID is captured when the caller does not block it.

## Milestone 2: ElevenLabs Baseline Agent

Goal: connect the phone number to a basic ElevenLabs conversation.

Tasks:

- Create the Summit Air agent in ElevenLabs.
- Configure:
  - First message.
  - Voice.
  - English-only behavior.
  - Interruptions/barge-in.
  - Silence timeout behavior.
  - Base system prompt from `docs/summit-air-agent-architecture.md`.
- Import the purchased Twilio number into ElevenLabs.
- Assign the Summit Air agent to the inbound-capable Twilio number.
- Use SIP trunking only if the native Twilio integration is unavailable or blocked.
- Run basic live calls.

Initial tests:

- "I need annual AC maintenance in Brooklyn."
- "My furnace is not turning on in Queens."
- "This is a commercial office in Manhattan and the AC is down."

Pass criteria:

- Agent answers naturally.
- Agent asks one question at a time.
- Agent collects name, address, residential/commercial, issue, and availability.
- Agent stores caller ID as the callback number when available.
- Agent confirms the selected service window as booked.
- Agent does not quote prices or troubleshoot.

## Milestone 3: Service Request Webhook and Notification

Goal: turn the conversation into a structured service request sent to a fixed Summit Air ops/demo email recipient.

Tasks:

- Build a small HTTPS endpoint, for example `/api/summit-air/service-request`.
- Validate incoming payloads against the schema in the architecture doc.
- Add a shared secret or provider signature check.
- Send a dispatcher-ready email summary to a fixed ops/demo recipient, configured through an environment variable.
- Include the caller phone from Twilio/ElevenLabs caller ID when available.
- Include a caller-provided callback phone only when caller ID is private, anonymous, unknown, or unavailable.
- Include the raw structured JSON in the ops email or internal logs for review.
- Do not send customer SMS, WhatsApp, or customer email in the MVP.
- Return a clear success/failure response to the agent platform.

Suggested payload validation:

- Required: caller name, address, borough, property type, issue description, urgency level, availability or desired next step.
- If caller ID is available, store it as the caller phone and set `phone_source` to `twilio_caller_id`.
- If caller ID is private or unavailable, ask once for a callback phone number and set `phone_source` to `caller_provided` if captured.
- If no callback phone is available, mark the caller phone as `unknown` and make that limitation visible in the ops email.
- Reject or flag out-of-area boroughs.
- Require `safety_action_given` and `caller_confirmed_safe` for dangerous classifications.

Tests:

- Submit a fake routine payload directly to the webhook.
- Submit a fake priority payload directly to the webhook.
- Submit a fake dangerous payload directly to the webhook.
- Submit a fake private-caller payload with a caller-provided callback phone.
- Submit a fake private-caller payload with no callback phone and verify the ops limitation is visible.
- Complete a real phone call and verify the summary arrives.

Pass criteria:

- Valid payload sends a readable ops email.
- The ops email contains the human summary, urgency, callback phone if available, and raw structured JSON.
- Invalid payload is rejected or clearly marked incomplete.
- Priority and dangerous fields appear prominently in the notification.

## Milestone 4: Edge-Case Prompt Hardening

Goal: make the agent robust when callers do not follow the happy path.

Test cases:

| Case | Caller behavior | Expected result |
| --- | --- | --- |
| Long tangent | Caller talks for 2 minutes about unrelated history. | Agent acknowledges briefly and redirects to the missing scheduling detail. |
| Context rot | Caller gives many details out of order. | Agent retains captured facts and asks only for missing required fields. |
| Silence at start | Caller says nothing after pickup. | Agent checks audibility, retries once, then ends politely. |
| Silence mid-call | Caller goes silent after giving address. | Agent repeats the last question, summarizes known info, then ends if no response. |
| Promise request | Caller asks, "Can you promise someone will fix it tonight?" | Agent confirms the requested service window if available, but does not promise exact arrival, repair completion, price, parts, or technician. |
| Routine maintenance | Caller wants annual tune-up. | Agent classifies routine and books/records normal service request. |
| Priority no heat | Caller has no heat in January and elderly parent in home. | Agent marks priority verbally and in JSON. |
| Priority no AC | Caller has no AC during high heat with medical condition. | Agent marks priority verbally and in JSON. |
| Gas smell | Caller smells gas. | Agent instructs evacuation/fresh air/911, confirms safety, then optionally creates request. |
| Carbon monoxide | Caller says CO alarm is going off. | Agent instructs evacuation/fresh air/911, confirms safety, then optionally creates request. |
| Outside area | Caller is in the Bronx or Nassau County. | Agent declines booking because Summit Air only serves Manhattan, Queens, and Brooklyn. |
| Troubleshooting request | Caller asks how to relight a pilot or reset equipment. | Agent says it cannot troubleshoot and offers to book service. |
| Price request | Caller asks how much it will cost. | Agent does not quote; says Summit Air can discuss pricing separately. |
| Private caller ID | Caller blocks caller ID. | Agent asks once for the best callback phone number and records `unknown` if none is provided. |

Prompt iteration loop:

1. Run the call.
2. Save transcript and structured output.
3. Mark pass/fail for classification, tone, and data capture.
4. Edit the prompt only where the failure occurred.
5. Re-run the same test before moving on.

## Milestone 5: End-to-End Dress Rehearsal

Goal: verify the full caller experience before sharing the number.

Tasks:

- Call from at least two phones.
- Test both interrupting the agent and changing answers mid-call.
- Test a caller who gives address before name.
- Test a caller who asks if the agent is human.
- Test a normal caller-ID call and verify the ops email includes caller ID.
- Test private/unknown caller ID and verify caller-provided callback handling.
- Test noisy background audio if practical.
- Verify every completed call creates exactly one summary.
- Verify dangerous calls do not create a normal-looking routine request.

Pass criteria:

- The agent handles off-script conversation without losing the booking objective.
- The summary is accurate enough for a dispatcher to act on.
- The agent remains inside scope: no price quotes, no troubleshooting, no unsupported locations.

## Milestone 6: Launch Checklist

Before giving out the number:

- Phone number is active and inbound routing is stable.
- ElevenLabs agent is using the current prompt version.
- Ops/demo email delivery works.
- Caller ID capture works, or the private/unknown caller limitation is documented.
- Webhook secrets are configured.
- Test calls cover routine, priority, dangerous, silence, tangent, out-of-area, price, troubleshooting, caller-ID, and private-caller cases.
- Known limitations are documented.
- Backup plan is defined if the agent platform or webhook is down:
  - Option A: route to a static voicemail.
  - Option B: Twilio fallback message that asks the caller to leave name, number, address, and issue.

## 72-Hour Delivery Sequence

Day 1:

- Acquire/configure phone number.
- Prove inbound calling works.
- Create ElevenLabs agent.
- Connect phone number to the agent.
- Run happy-path calls.

Day 2:

- Build webhook and ops email summary.
- Add structured output validation.
- Add caller ID capture and private-caller callback handling.
- Run routine, priority, dangerous, and out-of-area calls.
- Tune prompt based on transcripts.

Day 3:

- Run edge-case test matrix.
- Tighten prompt and notification format.
- Re-run failed cases.
- Prepare the callable number, ops email sample, prompt version, and test notes for live stress testing.

## What to Skip for the MVP

- Calendar optimization.
- Technician assignment.
- CRM writeback.
- Multi-language support.
- Detailed HVAC diagnostics.
- Payment collection.
- Pricing estimates.
- Complex identity verification.

These are valuable later, but they do not improve the core evaluation as much as a reliable phone connection, natural intake, correct urgency handling, and accurate summaries.
