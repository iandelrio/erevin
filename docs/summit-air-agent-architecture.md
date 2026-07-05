# Summit Air AI Phone Agent Architecture

Status: 72-hour MVP design

## Goal

Build an English-only inbound phone agent for Summit Air that can hold a real scheduling conversation, triage HVAC urgency, collect service-request details, and send a structured summary by email or SMS. The MVP should be callable from a real phone number and easy to tune live after test calls.

## Scope

In scope:

- Answer inbound calls for Summit Air.
- Identify the HVAC issue without troubleshooting.
- Determine residential vs. commercial.
- Confirm service area: Manhattan, Queens, or Brooklyn only.
- Collect caller name, phone number, service address, issue, urgency indicators, and availability.
- Distinguish routine, priority, dangerous, and out-of-area calls.
- Confirm the requested service window or next step and send a structured service request summary.

Out of scope:

- Price quoting.
- HVAC troubleshooting or repair advice.
- CRM, dispatch, calendar, or database integration.
- Requests outside Manhattan, Queens, or Brooklyn.
- Non-English handling beyond politely saying Summit Air's AI assistant currently supports English.

## Recommended Stack

Primary path:

- ElevenLabs Conversational AI for the realtime voice agent, turn-taking, speech-to-text, text-to-speech, and prompt-driven conversation flow.
- A Summit Air agent configured in ElevenLabs with:
  - A production system prompt.
  - First message and silence behavior.
  - Tool or webhook support for submitting the final service request.
  - Post-call transcript and summary capture if available on the account.
- Twilio Programmable Voice for the callable phone number, call routing, call logs, fallback routing, and SMS notifications.
- ElevenLabs native Twilio integration to connect the purchased Twilio number directly to the Summit Air agent.
- A tiny HTTPS service for receiving service-request JSON and sending summaries.
- Twilio SMS for the customer confirmation summary when caller ID is present. Email is only needed as a fallback when caller ID is private, anonymous, unknown, or otherwise unavailable.

Why this is the recommended demo path:

- Twilio is the safest default for quickly buying a US number, validating inbound calls, checking call logs, and adding fallback behavior.
- ElevenLabs should still own the realtime AI conversation. Do not build a custom audio bridge unless the native integration blocks delivery.
- A purchased Twilio number is required for inbound calls. A verified caller ID is useful for outbound caller ID, but it cannot receive inbound calls or be assigned to the agent.
- Twilio provides inbound caller ID as the `From` value when available. ElevenLabs' Twilio personalization webhook exposes this as `caller_id`, so the agent can usually avoid asking for the caller's phone number.
- If an ElevenLabs-managed number is immediately available in the account, it may be faster for the first smoke test, but Twilio remains the better demo foundation because it gives more operational control.

Fallback path if native ElevenLabs telephony setup blocks delivery:

- Keep the Twilio Programmable Voice number.
- Route through SIP trunking if the native Twilio integration is unavailable.
- As a last resort, use a Twilio webhook that returns TwiML and bridges the call to a realtime voice endpoint.
- Only use a custom Twilio Media Streams bridge if the native ElevenLabs phone/SIP integration is not available, because maintaining realtime audio bridging is the highest-risk part of the MVP.

Useful vendor docs:

- ElevenLabs Conversational AI docs: https://elevenlabs.io/docs/conversational-ai
- ElevenLabs native Twilio integration docs: https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration
- ElevenLabs Twilio personalization docs: https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/customising-calls
- ElevenLabs SIP trunking docs: https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking
- Twilio Programmable Voice docs: https://www.twilio.com/docs/voice
- Twilio Voice request parameters: https://www.twilio.com/docs/voice/twiml#request-parameters
- Twilio Media Streams reference, only for fallback custom audio bridging: https://www.twilio.com/docs/voice/twiml/stream

## Runtime Flow

1. Caller dials the Summit Air AI number.
2. Twilio routes the call to the ElevenLabs agent through the native integration.
3. Agent greets the caller as Summit Air's AI scheduling assistant.
4. Agent asks what is going on and classifies the call:
   - Dangerous: gas smell, carbon monoxide alarm/symptoms, smoke, fire, sparking, or immediate life-safety issue.
   - Priority: urgent but not currently dangerous, such as no heat in winter with an elderly person, infant, medical condition, or unsafe indoor temperature; no AC during heat with medical vulnerability; severe commercial operational impact.
   - Routine: maintenance, tune-up, filter/checkup request, non-urgent comfort issue.
   - Out of area: not in Manhattan, Queens, or Brooklyn.
5. Agent collects only the missing required fields, one question at a time.
6. Agent summarizes the captured request and confirms the requested service window.
7. Agent submits structured JSON to the webhook.
8. Webhook validates the JSON and sends a concise SMS confirmation to the caller's captured phone number. If caller ID was private or unavailable, it sends email confirmation to the address collected during the call.

## Scheduling Policy

Summit Air offers 24/7 support and always has a technician available for the MVP. Once the caller gives an available window, the agent can confirm that the service request is booked for that requested window.

Allowed confirmation:

> I have you booked for a Summit Air service request tonight between 7 and 9 PM, and I am marking it as priority.

Still avoid promising:

- Exact arrival minute.
- Exact repair completion.
- Parts availability.
- Price.
- A specific technician.

## Dangerous Situation Policy

The agent must not continue normal booking until it has addressed safety.

Dangerous triggers:

- Gas smell, rotten egg smell, suspected gas leak.
- Carbon monoxide alarm, CO warning, dizziness, nausea, headache, confusion, faintness, or suspected CO exposure.
- Smoke, fire, burning electrical smell, sparking equipment, or exposed live electrical hazard.

Required behavior:

1. Interrupt normal intake.
2. Tell the caller to leave the building immediately if they have not already.
3. Tell them to call 911 or the appropriate emergency service from a safe location.
4. Ask whether they are currently in a safe location.
5. Only after they confirm they are safe, offer to create a Summit Air service request.
6. Mark the request as `dangerous_safety_handoff` and include the safety instruction given.

The agent should not say Summit Air can replace emergency services.

## Priority Policy

Priority means the agent verbally tells the caller Summit Air is treating the request as priority and records that classification in the structured output.

Priority triggers:

- No heat during cold weather, especially in January or when the caller mentions elderly residents, infants, medical conditions, or unsafe indoor temperature.
- No AC during a heat wave or for a caller with a relevant medical condition.
- HVAC failure affecting a commercial site where operations, inventory, tenants, patients, or safety-sensitive areas are impacted.
- Caller explicitly says the situation is urgent, but there is no immediate danger trigger.

Agent language:

> I understand. I am marking this as a priority service request for Summit Air.

Avoid promising:

- Exact arrival minute.
- Repair completion.
- Parts availability.
- Price.
- A specific technician.

## Service Area Policy

Covered areas:

- Manhattan
- Queens
- Brooklyn

If the address is outside the service area:

- Apologize briefly.
- Say Summit Air can only book calls in Manhattan, Queens, and Brooklyn.
- Do not create a service request.
- If the location is ambiguous, ask one clarifying question before refusing.

## Caller Contact Policy

Default assumption: inbound callers are calling from a cell phone, and Twilio caller ID is SMS-capable.

Contact capture rules:

- If Twilio/ElevenLabs provides a valid `caller_id`, store it as the caller phone number and do not ask the caller to repeat it unless the agent needs to confirm the best callback/SMS number.
- If caller ID is `anonymous`, `unknown`, `private`, unavailable, or clearly not a phone number, ask for an email address for the confirmation summary.
- Do not require both phone and email for the MVP. Require either a valid caller phone number or a caller-provided email address.
- Customer-facing SMS should be concise and should not include raw JSON.
- Internal logs or the ops copy may include the raw structured JSON for debugging.

## Structured Service Request Schema

```json
{
  "source": "summit_air_ai_phone_agent",
  "submitted_at": "2026-07-03T18:30:00-04:00",
  "caller": {
    "name": "string",
    "phone": "E.164 string | anonymous | unknown | null",
    "phone_source": "twilio_caller_id | caller_provided | unavailable",
    "caller_id_private": false,
    "email": "string | null",
    "confirmation_channel": "sms | email"
  },
  "service_location": {
    "address_line_1": "string",
    "address_line_2": "string | null",
    "borough": "Manhattan | Queens | Brooklyn",
    "is_in_service_area": true
  },
  "property": {
    "type": "residential | commercial | unknown",
    "business_name": "string | null"
  },
  "issue": {
    "category": "no_heat | no_ac | maintenance | gas_smell | carbon_monoxide | water_leak | noise | other",
    "description": "string",
    "system": "ac | furnace | heat_pump | boiler | thermostat | unknown"
  },
  "urgency": {
    "level": "routine | priority | dangerous_safety_handoff | out_of_area",
    "priority_reasons": ["string"],
    "safety_action_given": "string | null",
    "caller_confirmed_safe": true
  },
  "availability": {
    "preferred_windows": ["string"],
    "timezone": "America/New_York"
  },
  "next_step": {
    "status": "booked | not_booked",
    "spoken_confirmation": "string"
  },
  "notifications": {
    "customer_summary_channel": "sms | email",
    "customer_summary_destination": "string",
    "ops_summary_channel": "sms | email | log_only"
  },
  "conversation": {
    "transcript_url": "string | null",
    "agent_version": "summit-air-v1"
  }
}
```

## Agent Prompt Skeleton

Use this as the core ElevenLabs system prompt, then tune after calls.

```text
You are Summit Air's AI scheduling assistant for inbound HVAC service calls.

Your job is to create service requests, not to troubleshoot HVAC systems. Speak naturally, warmly, and efficiently. Ask one question at a time. Do not ask for information the caller already gave you. If the caller gives multiple details at once, acknowledge them and continue with the most important missing field.

Summit Air serves Manhattan, Queens, and Brooklyn only. Summit Air offers 24/7 support and can schedule any time. Once the caller gives an available service window, you can confirm the service request is booked for that window. Do not quote prices. Do not promise an exact arrival minute, exact repair outcome, parts availability, or a specific technician.

Required fields before creating a service request:
- Caller name.
- Service address and borough.
- Residential or commercial.
- HVAC issue in the caller's own words.
- Availability or desired service window.
- Urgency classification and reason.

Urgency rules:
- Dangerous: gas smell, rotten egg smell, carbon monoxide alarm or symptoms, smoke, fire, sparking, or immediate safety risk. Stop normal intake. Tell the caller to leave the building, get to fresh air, and call 911 or emergency services from a safe location. Ask if they are safe before continuing. Only create a Summit Air request after they confirm they are safe.
- Priority: no heat in cold weather, no AC in high heat, elderly person, infant, medical condition, unsafe indoor temperature, urgent commercial impact, or caller says it is urgent without a current danger trigger. Tell the caller: "I am marking this as a priority service request."
- Routine: annual maintenance, tune-up, non-urgent service, or comfort issue with no safety or vulnerability indicators.
- Out of area: outside Manhattan, Queens, and Brooklyn. Do not book.

Conversation behavior:
- If the caller goes on a long unrelated tangent, briefly acknowledge it and redirect to the current missing detail: "I hear you. To get the service request set up, I just need..."
- If the caller is silent at the start, wait briefly, then say: "Hello, this is Summit Air's scheduling assistant. Can you hear me?" If silence continues, try once more, then politely end the call.
- If the caller goes silent mid-call, repeat the last question once. If silence continues, summarize what you have and ask whether they want to continue. If there is still no response, say Summit Air did not get enough information to book and end politely.
- If asked to promise arrival, repair, or price, do not promise. Say you can mark priority when appropriate, capture their availability, and have the request sent to Summit Air.
- If asked for troubleshooting, say you are not an HVAC technician and cannot safely troubleshoot by phone, but you can get a service request started.
- If the caller uses relative times like tonight, tomorrow morning, or this afternoon, confirm the concrete date and window in Eastern time.

Before ending:
- Summarize the request in one or two sentences.
- Confirm whether it is booked for the requested window, priority, dangerous safety follow-up, or not booked because it is out of area.
```

## Edge Case Handling

| Edge case | Desired behavior | Implementation lever |
| --- | --- | --- |
| Super long unrelated tangent | Acknowledge briefly, then redirect to the most important missing field. After repeated tangents, explain that the agent needs a few details to schedule service. | Prompt rule plus transcript QA. |
| Context window rot | Keep an explicit checklist in the prompt and require a final summary based only on captured facts. Avoid long explanations and avoid troubleshooting branches. | Prompt structure, short questions, service-request schema validation. |
| Prolonged silence at start | Agent checks audibility, retries once, then ends politely if there is no response. | ElevenLabs silence/turn-taking settings plus prompt. |
| Prolonged silence mid-call | Agent repeats last question, then summarizes known details and asks to continue, then ends if still silent. | ElevenLabs silence settings plus prompt. |
| Asked to promise something | Agent avoids guarantees on arrival, repair, parts, price, or exact technician. It can confirm that the request was captured and marked priority if applicable. | Prompt refusal pattern. |
| Routine vs. urgent | Maintenance is routine; comfort failures with vulnerability, weather risk, or major commercial impact are priority. | Prompt classification rules and final JSON field. |
| Dangerous situation | Safety first, instruct caller to evacuate/get fresh air/call 911, confirm safe, then optionally create request. | Prompt hard rule; dangerous test cases. |
| Caller wants price | No quote. Offer to create service request and note that Summit Air can discuss pricing separately. | Prompt rule. |
| Caller wants troubleshooting | No troubleshooting. Capture symptoms and book. | Prompt rule. |
| Outside coverage area | Do not book; explain service area. | Prompt rule plus borough validation. |
| Private or unknown caller ID | Ask for email address for the confirmation summary. Do not require both phone and email. | Twilio caller ID metadata plus prompt rule. |
| Mixed intent | Handle safety first, then booking. Example: gas smell plus annual maintenance becomes dangerous first. | Prompt priority order. |

## Notification Summary

Customer SMS should include:

- Summit Air confirmation.
- Requested service window.
- Urgency level if priority or dangerous safety follow-up.
- Address or borough.
- Short issue description.
- No raw JSON.

Customer email fallback should include the same fields when caller ID is private or unavailable.

Internal ops summary, if enabled, should include:

- Subject line: `[Summit Air] PRIORITY no heat - Queens - Jane Smith`
- Human summary.
- Urgency level and reasons.
- Caller name, phone if available, and email if collected.
- Address and borough.
- Residential/commercial.
- Requested window.
- Safety instructions given, if any.
- Raw structured JSON.
- Transcript link or transcript text if available.

## Operational Notes

- Version the prompt as `summit-air-v1`, `summit-air-v2`, etc.
- Keep a call-test matrix with the transcript, expected classification, actual classification, and prompt changes made.
- Log webhook delivery failures and send retry/error alerts during testing.
- Do not store more personal data than needed for the service request.
- Use environment variables for all vendor keys and notification recipients.
