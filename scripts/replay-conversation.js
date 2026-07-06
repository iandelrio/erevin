#!/usr/bin/env node
'use strict'

// Replay a past ElevenLabs conversation through the Summit Air post-call webhook
// logic. Two modes:
//
//   1. Local (default): runs the payload through the same normalize/validate/
//      build-email logic the endpoint uses and prints the result. No network,
//      no secret needed. Best for debugging data-collection field mapping.
//
//   2. --send: signs the payload with ELEVENLABS_WEBHOOK_SECRET (exactly like
//      ElevenLabs does) and POSTs it to the live endpoint. Tests auth + the
//      full path including the real Resend email send.
//
// Input source (pick one):
//   --conversation-id <id>   fetch the conversation from the ElevenLabs API
//                            (needs XI_API_KEY in env)
//   --file <path>            read a saved JSON file (a webhook payload OR a
//                            raw conversation object)
//
// Examples:
//   node scripts/replay-conversation.js --conversation-id conv_abc123
//   node scripts/replay-conversation.js --file examples/summit-air/routine.json
//   node scripts/replay-conversation.js --conversation-id conv_abc123 --send \
//     --url https://erevin.vercel.app/api/summit-air/service-request

const crypto = require('node:crypto')
const fs = require('node:fs')
const { processServiceRequestPayload } = require('../src/summit-air/service-request')

function parseArgs(argv) {
  const args = { send: false }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--send') args.send = true
    else if (key === '--conversation-id') args.conversationId = argv[++i]
    else if (key === '--file') args.file = argv[++i]
    else if (key === '--url') args.url = argv[++i]
  }
  return args
}

async function loadConversation({ conversationId, file }) {
  if (file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  if (conversationId) {
    const apiKey = process.env.XI_API_KEY
    if (!apiKey) throw new Error('XI_API_KEY is required to fetch a conversation by id')

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { headers: { 'xi-api-key': apiKey } }
    )
    if (!res.ok) {
      throw new Error(`ElevenLabs API returned ${res.status}: ${await res.text()}`)
    }
    return res.json()
  }

  throw new Error('Provide --conversation-id <id> or --file <path>')
}

// Normalize input into something processServiceRequestPayload understands.
// - Already a webhook payload -> pass through.
// - A nested/flat service_request -> pass through (handled directly).
// - A raw ElevenLabs conversation object (analysis/transcript) -> wrap in the
//   post_call_transcription envelope the webhook uses.
function toWebhookPayload(input) {
  if (input && input.type === 'post_call_transcription' && input.data) {
    return input
  }
  const looksLikeServiceRequest = input && (
    input.service_request || input.serviceRequest ||
    (input.caller && input.service_location && input.issue && input.urgency)
  )
  if (looksLikeServiceRequest) {
    return input
  }
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: input
  }
}

function signBody(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
  return `t=${timestamp},v0=${digest}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const conversation = await loadConversation(args)
  const payload = toWebhookPayload(conversation)

  if (!args.send) {
    const result = processServiceRequestPayload(payload)
    console.log('--- Validation ---')
    console.log('isValid:', result.validation.isValid)
    if (result.validation.errors.length) console.log('errors:', result.validation.errors)
    if (result.validation.warnings.length) console.log('warnings:', result.validation.warnings)
    console.log('\n--- Service request ---')
    console.log(JSON.stringify(result.serviceRequest, null, 2))
    if (result.email) {
      console.log('\n--- Email subject ---')
      console.log(result.email.subject)
      console.log('\n--- Email text ---')
      console.log(result.email.text)
    } else {
      console.log('\nNo email built (validation failed).')
    }
    return
  }

  const url = args.url || 'https://erevin.vercel.app/api/summit-air/service-request'
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET
  if (!secret) throw new Error('ELEVENLABS_WEBHOOK_SECRET is required to sign a --send request')

  const rawBody = JSON.stringify(payload)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'elevenlabs-signature': signBody(rawBody, secret)
    },
    body: rawBody
  })
  console.log('HTTP', res.status)
  console.log(await res.text())
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
