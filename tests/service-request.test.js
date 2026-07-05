const assert = require('node:assert/strict')
const test = require('node:test')
const crypto = require('node:crypto')

const { verifyElevenLabsSignature, verifyWebhookAuth } = require('../src/summit-air/auth')
const { sendOpsEmail } = require('../src/summit-air/resend')
const {
  buildOpsEmail,
  normalizeServiceRequestPayload,
  processServiceRequestPayload,
  validateServiceRequest
} = require('../src/summit-air/service-request')
const serviceRequestHandler = require('../api/summit-air/service-request')

function routinePayload(overrides = {}) {
  return {
    source: 'summit_air_ai_phone_agent',
    submitted_at: '2026-07-05T18:30:00.000Z',
    caller: {
      name: 'Jane Smith',
      phone: '+17185550123',
      phone_source: 'twilio_caller_id',
      caller_id_private: false,
      callback_phone_available: true
    },
    service_location: {
      address_line_1: '123 Atlantic Ave',
      address_line_2: 'Apt 4B',
      borough: 'Brooklyn',
      is_in_service_area: true
    },
    property: {
      type: 'residential',
      business_name: null
    },
    issue: {
      category: 'maintenance',
      description: 'annual AC maintenance',
      system: 'ac'
    },
    urgency: {
      level: 'routine',
      priority_reasons: [],
      safety_action_given: null,
      caller_confirmed_safe: false
    },
    availability: {
      preferred_windows: ['July 7, 2026 between 10 AM and noon'],
      timezone: 'America/New_York'
    },
    next_step: {
      status: 'booked',
      spoken_confirmation: 'Booked for July 7, 2026 between 10 AM and noon.'
    },
    conversation: {
      transcript_url: null,
      agent_version: 'summit-air-v1'
    },
    ...overrides
  }
}

test('valid routine payload builds a dispatcher email', () => {
  const result = processServiceRequestPayload(routinePayload())

  assert.equal(result.validation.isValid, true)
  assert.match(result.email.subject, /\[Summit Air\] ROUTINE maintenance - Brooklyn - Jane Smith/)
  assert.match(result.email.text, /Raw Structured JSON/)
})

test('dangerous payload requires safety action and caller safe confirmation', () => {
  const payload = routinePayload({
    issue: {
      category: 'gas_smell',
      description: 'caller smells rotten eggs near furnace',
      system: 'furnace'
    },
    urgency: {
      level: 'dangerous_safety_handoff',
      priority_reasons: ['gas smell'],
      safety_action_given: null,
      caller_confirmed_safe: false
    }
  })

  const validation = validateServiceRequest(payload)

  assert.equal(validation.isValid, false)
  assert(validation.errors.some((error) => error.includes('urgency.safety_action_given')))
  assert(validation.errors.some((error) => error.includes('caller_confirmed_safe')))
})

test('private caller without callback phone is valid but visibly warned', () => {
  const payload = routinePayload({
    caller: {
      name: 'Taylor Morgan',
      phone: 'unknown',
      phone_source: 'unavailable',
      caller_id_private: true,
      callback_phone_available: false
    }
  })

  const result = processServiceRequestPayload(payload)

  assert.equal(result.validation.isValid, true)
  assert(result.validation.warnings.some((warning) => warning.includes('Caller ID was private')))
  assert.match(result.email.html, /CALLBACK PHONE UNAVAILABLE/)
})

test('out-of-area booked payload is rejected', () => {
  const payload = routinePayload({
    service_location: {
      address_line_1: '1 Fordham Plaza',
      address_line_2: null,
      borough: 'Bronx',
      is_in_service_area: false
    }
  })

  const validation = validateServiceRequest(payload)

  assert.equal(validation.isValid, false)
  assert(validation.errors.some((error) => error.includes('outside the service area')))
})

test('out-of-area not booked payload is flagged but accepted', () => {
  const payload = routinePayload({
    service_location: {
      address_line_1: '1 Fordham Plaza',
      address_line_2: null,
      borough: 'Bronx',
      is_in_service_area: false
    },
    urgency: {
      level: 'out_of_area',
      priority_reasons: [],
      safety_action_given: null,
      caller_confirmed_safe: false
    },
    availability: {
      preferred_windows: [],
      timezone: 'America/New_York'
    },
    next_step: {
      status: 'not_booked',
      spoken_confirmation: 'Summit Air only serves Manhattan, Queens, and Brooklyn.'
    }
  })

  const validation = validateServiceRequest(payload)

  assert.equal(validation.isValid, true)
  assert(validation.warnings.some((warning) => warning.includes('Out-of-area borough flagged')))
})

test('ElevenLabs post-call data collection payload normalizes into service request schema', () => {
  const payload = {
    type: 'post_call_transcription',
    event_timestamp: 1783276200,
    data: {
      conversation_id: 'conv_123',
      version_id: 'summit-air-v1',
      transcript: [
        { role: 'agent', message: 'Thanks for calling Summit Air.' },
        { role: 'user', message: 'My heat is out in Queens.' }
      ],
      metadata: {
        phone_call: {
          caller_id: '+16465550111'
        }
      },
      analysis: {
        transcript_summary: 'Caller reported no heat in Queens.',
        data_collection_results: {
          caller_name: { value: 'Morgan Lee' },
          address_line_1: { value: '42-10 31st Ave' },
          borough: { value: 'Queens' },
          property_type: { value: 'residential' },
          issue_category: { value: 'no_heat' },
          issue_description: { value: 'no heat in the apartment' },
          system: { value: 'boiler' },
          urgency_level: { value: 'priority' },
          priority_reasons: { value: 'No heat in cold weather' },
          preferred_windows: { value: 'Tonight between 7 and 9 PM' },
          next_step_status: { value: 'booked' },
          spoken_confirmation: { value: 'Booked tonight between 7 and 9 PM.' }
        }
      }
    }
  }

  const result = normalizeServiceRequestPayload(payload)

  assert.equal(result.serviceRequest.caller.phone, '+16465550111')
  assert.equal(result.serviceRequest.caller.phone_source, 'twilio_caller_id')
  assert.equal(result.serviceRequest.service_location.borough, 'Queens')
  assert.equal(result.serviceRequest.urgency.level, 'priority')
  assert.match(result.transcriptText, /agent: Thanks/)
})

test('shared-secret auth accepts bearer and rejects wrong secret', () => {
  const rawBody = JSON.stringify({ ok: true })
  const env = { SUMMIT_AIR_WEBHOOK_SECRET: 'test-secret' }

  const accepted = verifyWebhookAuth({
    headers: { authorization: 'Bearer test-secret' },
    rawBody,
    env
  })
  const rejected = verifyWebhookAuth({
    headers: { authorization: 'Bearer nope' },
    rawBody,
    env
  })

  assert.equal(accepted.ok, true)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.statusCode, 401)
})

test('HMAC auth helper accepts timestamped signatures', () => {
  const rawBody = JSON.stringify({ type: 'post_call_transcription' })
  const timestamp = Math.floor(Date.now() / 1000)
  const secret = 'hmac-secret'
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')

  assert.equal(
    verifyElevenLabsSignature({
      rawBody,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret
    }),
    true
  )
})

test('Resend sender uses configured API endpoint and tryverex default from email', async () => {
  const email = buildOpsEmail(routinePayload())
  const calls = []
  const response = await sendOpsEmail(email, {
    env: {
      RESEND_API_KEY: 're_test',
      SUMMIT_AIR_OPS_EMAIL: 'ops@example.com'
    },
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'email_123' })
      }
    }
  })

  const body = JSON.parse(calls[0].init.body)

  assert.equal(response.id, 'email_123')
  assert.equal(body.from, 'Summit Air Intake <success@payment.tryverex.com>')
  assert.deepEqual(body.to, ['ops@example.com'])
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test')
})

test('API route authenticates, validates, and sends ops email', async (t) => {
  const envBackup = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SUMMIT_AIR_WEBHOOK_SECRET: process.env.SUMMIT_AIR_WEBHOOK_SECRET,
    SUMMIT_AIR_OPS_EMAIL: process.env.SUMMIT_AIR_OPS_EMAIL
  }
  const fetchBackup = globalThis.fetch

  process.env.RESEND_API_KEY = 're_test'
  process.env.SUMMIT_AIR_WEBHOOK_SECRET = 'test-secret'
  process.env.SUMMIT_AIR_OPS_EMAIL = 'ops@example.com'
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: 'email_route_123' })
  })

  t.after(() => {
    restoreEnv('RESEND_API_KEY', envBackup.RESEND_API_KEY)
    restoreEnv('SUMMIT_AIR_WEBHOOK_SECRET', envBackup.SUMMIT_AIR_WEBHOOK_SECRET)
    restoreEnv('SUMMIT_AIR_OPS_EMAIL', envBackup.SUMMIT_AIR_OPS_EMAIL)
    globalThis.fetch = fetchBackup
  })

  const req = {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-secret'
    },
    body: JSON.stringify(routinePayload())
  }
  const res = createMockResponse()

  await serviceRequestHandler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.email_id, 'email_route_123')
})

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(value) {
      this.body = JSON.parse(value)
    }
  }
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
