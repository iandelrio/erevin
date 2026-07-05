const { verifyWebhookAuth } = require('../../src/summit-air/auth')
const { sendOpsEmail } = require('../../src/summit-air/resend')
const { processServiceRequestPayload } = require('../../src/summit-air/service-request')

module.exports = async function serviceRequestHandler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' })
  }

  const rawBody = await readRawBody(req)
  const auth = verifyWebhookAuth({
    headers: req.headers,
    rawBody,
    env: process.env
  })

  if (!auth.ok) {
    return sendJson(res, auth.statusCode || 401, { ok: false, error: auth.error })
  }

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Request body must be valid JSON' })
  }

  const result = processServiceRequestPayload(payload)

  if (!result.validation.isValid) {
    return sendJson(res, 422, {
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

    return sendJson(res, 200, {
      ok: true,
      received: true,
      auth_method: auth.method,
      email_id: delivery?.id || null,
      warnings: result.validation.warnings
    })
  } catch (error) {
    console.error('Summit Air email delivery failed:', error)

    return sendJson(res, 502, {
      ok: false,
      error: 'Service request was valid, but ops email delivery failed'
    })
  }
}

async function readRawBody(req) {
  if (typeof req.body === 'string') {
    return req.body
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8')
  }

  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
    return JSON.stringify(req.body)
  }

  const chunks = []

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode

  for (const [key, value] of Object.entries({
    'Content-Type': 'application/json',
    ...headers
  })) {
    res.setHeader(key, value)
  }

  res.end(JSON.stringify(body))
}

module.exports.config = {
  maxDuration: 10
}
