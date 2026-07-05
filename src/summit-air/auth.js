const crypto = require('node:crypto')

function getHeader(headers, name) {
  const target = name.toLowerCase()

  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== target) continue
    return Array.isArray(value) ? value[0] : value
  }

  return undefined
}

function timingSafeEqualString(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false
  }

  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)

  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

function getBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function parseSignatureHeader(signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { values: [] }
  }

  const parsed = { values: [] }
  const parts = signatureHeader.split(/[,\s]+/).filter(Boolean)

  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split('=')

    if (!rawValue.length) {
      parsed.values.push(cleanSignature(part))
      continue
    }

    const key = rawKey.toLowerCase()
    const value = cleanSignature(rawValue.join('='))

    if (key === 't' || key === 'timestamp') {
      parsed.timestamp = value
    } else if (key === 'v0' || key === 'v1' || key === 'signature' || key === 'sig') {
      parsed.values.push(value)
    }
  }

  return parsed
}

function cleanSignature(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^sha256=/i, '')
}

function isFreshTimestamp(timestamp, toleranceSeconds) {
  if (!timestamp) return true

  const numericTimestamp = Number(timestamp)
  if (!Number.isFinite(numericTimestamp)) return false

  const seconds = numericTimestamp > 10_000_000_000
    ? Math.floor(numericTimestamp / 1000)
    : numericTimestamp

  return Math.abs(Math.floor(Date.now() / 1000) - seconds) <= toleranceSeconds
}

function hmacDigests(payload, secret) {
  const buffer = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest()

  return [
    buffer.toString('hex'),
    buffer.toString('base64'),
    buffer.toString('base64url')
  ]
}

function verifyElevenLabsSignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300 }) {
  if (!signatureHeader || !secret) return false

  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed.values.length) return false
  if (!isFreshTimestamp(parsed.timestamp, toleranceSeconds)) return false

  const candidatePayloads = parsed.timestamp
    ? [`${parsed.timestamp}.${rawBody}`, rawBody]
    : [rawBody]

  const expectedDigests = candidatePayloads.flatMap((payload) => hmacDigests(payload, secret))

  return parsed.values.some((providedSignature) => (
    expectedDigests.some((expectedSignature) => timingSafeEqualString(providedSignature, expectedSignature))
  ))
}

function verifyWebhookAuth({ headers, rawBody, env = process.env }) {
  const sharedSecret = env.SUMMIT_AIR_WEBHOOK_SECRET
  const elevenLabsSecret = env.ELEVENLABS_WEBHOOK_SECRET
  const elevenLabsSignature = getHeader(headers, 'elevenlabs-signature')

  if (elevenLabsSecret && elevenLabsSignature) {
    const signatureIsValid = verifyElevenLabsSignature({
      rawBody,
      signatureHeader: elevenLabsSignature,
      secret: elevenLabsSecret
    })

    if (signatureIsValid) {
      return { ok: true, method: 'elevenlabs_hmac' }
    }
  }

  if (!sharedSecret && !elevenLabsSecret) {
    return {
      ok: false,
      statusCode: 500,
      error: 'Webhook authentication is not configured'
    }
  }

  if (sharedSecret) {
    const bearerToken = getBearerToken(getHeader(headers, 'authorization'))
    const headerSecret = getHeader(headers, 'x-summit-air-webhook-secret')

    if (
      timingSafeEqualString(bearerToken, sharedSecret) ||
      timingSafeEqualString(headerSecret, sharedSecret)
    ) {
      return { ok: true, method: 'shared_secret' }
    }
  }

  return {
    ok: false,
    statusCode: 401,
    error: 'Invalid webhook authentication'
  }
}

module.exports = {
  getHeader,
  parseSignatureHeader,
  timingSafeEqualString,
  verifyElevenLabsSignature,
  verifyWebhookAuth
}
