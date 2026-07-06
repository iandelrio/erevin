const { verifyWebhookAuth } = require('../../src/summit-air/auth')
const { sendOpsEmail } = require('../../src/summit-air/resend')
const { processServiceRequestPayload } = require('../../src/summit-air/service-request')

// Web-standard handler (Request -> Response), selected by exporting a named
// `POST`. The legacy (req, res) signature is a non-starter here: @vercel/node
// auto-parses the JSON body, and re-serializing it produces different bytes
// than ElevenLabs signed, which breaks HMAC verification. `request.text()`
// gives us the exact raw bytes that were signed.
async function POST(request) {
  const rawBody = await request.text()
  const headers = headersToObject(request.headers)

  const auth = verifyWebhookAuth({ headers, rawBody, env: process.env })

  if (!auth.ok) {
    console.warn('Summit Air webhook auth failed:', {
      status: auth.statusCode || 401,
      error: auth.error,
      hasElevenLabsSecret: Boolean(process.env.ELEVENLABS_WEBHOOK_SECRET),
      hasSharedSecret: Boolean(process.env.SUMMIT_AIR_WEBHOOK_SECRET),
      hasSignatureHeader: Boolean(headers['elevenlabs-signature']),
      rawBodyLength: rawBody ? rawBody.length : 0,
      contentLength: headers['content-length'] || null,
      contentType: headers['content-type'] || null
    })

    return json(auth.statusCode || 401, { ok: false, error: auth.error })
  }

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json(400, { ok: false, error: 'Request body must be valid JSON' })
  }

  const result = processServiceRequestPayload(payload)

  if (!result.validation.isValid) {
    return json(422, {
      ok: false,
      error: 'Invalid service request payload',
      errors: result.validation.errors,
      warnings: result.validation.warnings
    })
  }

  try {
    const delivery = await sendOpsEmail(result.email, {
      idempotencyKey: result.idempotencyKey
    })

    return json(200, {
      ok: true,
      received: true,
      auth_method: auth.method,
      email_id: delivery?.id || null,
      warnings: result.validation.warnings
    })
  } catch (error) {
    console.error('Summit Air email delivery failed:', error)

    return json(502, {
      ok: false,
      error: 'Service request was valid, but ops email delivery failed'
    })
  }
}

function headersToObject(headers) {
  const result = {}

  for (const [key, value] of headers) {
    result[key] = value
  }

  return result
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  })
}

module.exports = {
  POST,
  config: {
    maxDuration: 10
  }
}
