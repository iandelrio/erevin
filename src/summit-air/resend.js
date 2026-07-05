const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails'
const DEFAULT_OPS_EMAIL = 'iandelriow@gmail.com'
const DEFAULT_FROM_EMAIL = 'Summit Air Intake <success@payment.tryverex.com>'
const DEFAULT_REPLY_TO = 'Verex Support <support@tryverex.com>'

async function sendOpsEmail(email, options = {}) {
  const env = options.env || process.env
  const fetchFn = options.fetchFn || globalThis.fetch

  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured')
  }

  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is not available in this runtime')
  }

  const payload = {
    from: env.SUMMIT_AIR_EMAIL_FROM || DEFAULT_FROM_EMAIL,
    to: splitRecipients(env.SUMMIT_AIR_OPS_EMAIL || DEFAULT_OPS_EMAIL),
    subject: email.subject,
    html: email.html,
    text: email.text
  }

  const replyTo = env.SUMMIT_AIR_REPLY_TO || DEFAULT_REPLY_TO
  if (replyTo) {
    payload.reply_to = replyTo
  }

  const headers = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json'
  }

  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey
  }

  const response = await fetchFn(RESEND_EMAIL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  const responseBody = await readResponseBody(response)

  if (!response.ok) {
    const detail = responseBody ? `: ${JSON.stringify(responseBody)}` : ''
    throw new Error(`Resend email request failed with ${response.status}${detail}`)
  }

  return responseBody
}

function splitRecipients(value) {
  return String(value || '')
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean)
}

async function readResponseBody(response) {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

module.exports = {
  DEFAULT_FROM_EMAIL,
  DEFAULT_OPS_EMAIL,
  RESEND_EMAIL_ENDPOINT,
  sendOpsEmail,
  splitRecipients
}
