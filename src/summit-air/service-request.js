const COVERED_BOROUGHS = new Set(['Manhattan', 'Queens', 'Brooklyn'])
const ISSUE_CATEGORIES = new Set([
  'no_heat',
  'no_ac',
  'maintenance',
  'gas_smell',
  'carbon_monoxide',
  'water_leak',
  'noise',
  'other'
])
const PROPERTY_TYPES = new Set(['residential', 'commercial', 'unknown'])
const HVAC_SYSTEMS = new Set(['ac', 'furnace', 'heat_pump', 'boiler', 'thermostat', 'unknown'])
const URGENCY_LEVELS = new Set(['routine', 'priority', 'dangerous_safety_handoff', 'out_of_area'])
const PHONE_SOURCES = new Set(['twilio_caller_id', 'caller_provided', 'unavailable'])
const NEXT_STEP_STATUSES = new Set(['booked', 'not_booked'])

function processServiceRequestPayload(payload, options = {}) {
  const normalized = normalizeServiceRequestPayload(payload, options)
  const validation = validateServiceRequest(normalized.serviceRequest)

  return {
    ...normalized,
    validation,
    // Always build an email. Validation issues annotate the email as review
    // flags rather than blocking delivery, so ops gets a lead after every call.
    email: buildOpsEmail(normalized.serviceRequest, {
      errors: validation.errors,
      warnings: validation.warnings,
      transcriptSummary: normalized.transcriptSummary,
      transcriptText: normalized.transcriptText,
      receivedPayloadType: normalized.receivedPayloadType
    })
  }
}

function normalizeServiceRequestPayload(payload, options = {}) {
  const receivedPayloadType = payload && payload.type === 'post_call_transcription'
    ? 'elevenlabs_post_call_transcription'
    : 'service_request'

  if (receivedPayloadType === 'elevenlabs_post_call_transcription') {
    return normalizeElevenLabsPostCallPayload(payload, options)
  }

  const source = unwrapServiceRequest(payload)
  const serviceRequest = isNestedServiceRequest(source)
    ? applyDefaults(deepClone(source), payload, options)
    : buildServiceRequestFromFlatFields(source || {}, payload, options)

  return {
    receivedPayloadType,
    serviceRequest,
    transcriptText: extractTranscriptText(payload),
    transcriptSummary: extractTranscriptSummary(payload),
    idempotencyKey: makeIdempotencyKey(serviceRequest, payload)
  }
}

function normalizeElevenLabsPostCallPayload(payload, options = {}) {
  const data = payload.data || {}
  const analysis = data.analysis || {}
  const dataCollection = unboxDataCollectionResults(analysis.data_collection_results || {})
  const dynamicVariables = data.conversation_initiation_client_data?.dynamic_variables || {}
  const metadata = data.metadata || {}
  const twilioCallerId = findCallerId(dynamicVariables, metadata, payload)

  const flatFields = {
    ...dynamicVariables,
    ...dataCollection,
    transcript_summary: analysis.transcript_summary,
    transcript_url: pickFirst(dataCollection.transcript_url, dynamicVariables.transcript_url, data.transcript_url),
    agent_version: pickFirst(dataCollection.agent_version, data.version_id, dynamicVariables.agent_version, 'summit-air-v1'),
    conversation_id: data.conversation_id
  }

  // The analysis LLM sometimes fills caller_phone with a literal instruction
  // like "Twilio caller ID" instead of a real number, since it cannot see the
  // actual caller ID. Discard values that are neither a usable phone nor a
  // recognized private marker so the Twilio system__caller_id fallback wins.
  if (
    flatFields.caller_phone &&
    !isUsablePhone(flatFields.caller_phone) &&
    !isPrivateCallerId(flatFields.caller_phone)
  ) {
    delete flatFields.caller_phone
    delete flatFields.phone_source
    delete flatFields.caller_id_private
    delete flatFields.callback_phone_available
  }

  if (!flatFields.caller_phone && twilioCallerId && isUsablePhone(twilioCallerId)) {
    flatFields.caller_phone = twilioCallerId
    flatFields.phone_source = 'twilio_caller_id'
    flatFields.caller_id_private = false
    flatFields.callback_phone_available = true
  } else if (!flatFields.caller_phone && twilioCallerId && isPrivateCallerId(twilioCallerId)) {
    flatFields.caller_phone = 'unknown'
    flatFields.phone_source = 'unavailable'
    flatFields.caller_id_private = true
    flatFields.callback_phone_available = false
  }

  const serviceRequest = buildServiceRequestFromFlatFields(flatFields, payload, options)

  return {
    receivedPayloadType: 'elevenlabs_post_call_transcription',
    serviceRequest,
    transcriptText: extractTranscriptText(payload),
    transcriptSummary: extractTranscriptSummary(payload),
    idempotencyKey: makeIdempotencyKey(serviceRequest, payload)
  }
}

function unwrapServiceRequest(payload) {
  if (!payload || typeof payload !== 'object') return payload

  return payload.service_request || payload.serviceRequest || payload.request || payload
}

function isNestedServiceRequest(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.caller &&
    value.service_location &&
    value.issue &&
    value.urgency
  )
}

function buildServiceRequestFromFlatFields(fields, rawPayload, options = {}) {
  const preferredWindows = asArray(pickFirst(
    fields.preferred_windows,
    fields.preferred_window,
    fields.availability,
    fields.available_window,
    fields.desired_service_window
  ))

  const borough = normalizeBorough(pickFirst(fields.borough, fields.service_borough))
  const callerPhone = normalizePhone(pickFirst(fields.caller_phone, fields.phone, fields.callback_phone))
  const phoneSource = normalizeEnum(
    pickFirst(fields.phone_source, inferPhoneSource(callerPhone, fields)),
    PHONE_SOURCES,
    'unavailable'
  )
  const callerIdPrivate = asBoolean(pickFirst(fields.caller_id_private, isPrivateCallerId(callerPhone)), false)
  const callbackPhoneAvailable = asBoolean(
    pickFirst(fields.callback_phone_available, isUsablePhone(callerPhone)),
    false
  )

  return applyDefaults({
    source: pickFirst(fields.source, 'summit_air_ai_phone_agent'),
    submitted_at: pickFirst(fields.submitted_at, eventTimestampToIso(rawPayload?.event_timestamp), options.now),
    caller: {
      name: cleanString(pickFirst(fields.caller_name, fields.full_name, fields.name)),
      phone: callerPhone || 'unknown',
      phone_source: phoneSource,
      caller_id_private: callerIdPrivate,
      callback_phone_available: callbackPhoneAvailable
    },
    service_location: {
      address_line_1: cleanString(pickFirst(fields.address_line_1, fields.service_address, fields.address)),
      address_line_2: nullableString(pickFirst(fields.address_line_2, fields.unit, fields.apartment)),
      borough,
      is_in_service_area: asBoolean(
        pickFirst(fields.is_in_service_area, borough ? COVERED_BOROUGHS.has(borough) : undefined),
        false
      )
    },
    property: {
      type: normalizeEnum(pickFirst(fields.property_type, fields.type), PROPERTY_TYPES, 'unknown'),
      business_name: nullableString(pickFirst(fields.business_name, fields.company_name))
    },
    issue: {
      category: normalizeEnumArray(pickFirst(fields.issue_category, fields.category), ISSUE_CATEGORIES, 'other'),
      description: cleanString(pickFirst(fields.issue_description, fields.description, fields.issue)),
      system: normalizeEnum(pickFirst(fields.system, fields.hvac_system), HVAC_SYSTEMS, 'unknown')
    },
    urgency: {
      level: normalizeEnum(pickFirst(fields.urgency_level, fields.urgency, fields.level), URGENCY_LEVELS, 'routine'),
      priority_reasons: asArray(pickFirst(fields.priority_reasons, fields.priority_reason)),
      safety_action_given: nullableString(pickFirst(fields.safety_action_given, fields.safety_instructions_given)),
      caller_confirmed_safe: asBoolean(fields.caller_confirmed_safe, false)
    },
    availability: {
      preferred_windows: preferredWindows,
      timezone: pickFirst(fields.timezone, 'America/New_York')
    },
    next_step: {
      status: normalizeEnum(pickFirst(fields.next_step_status, fields.status), NEXT_STEP_STATUSES, 'not_booked'),
      spoken_confirmation: cleanString(pickFirst(fields.spoken_confirmation, fields.confirmation))
    },
    conversation: {
      transcript_url: nullableString(fields.transcript_url),
      conversation_id: nullableString(fields.conversation_id),
      agent_version: pickFirst(fields.agent_version, 'summit-air-v1')
    }
  }, rawPayload, options)
}

function applyDefaults(serviceRequest, rawPayload, options = {}) {
  serviceRequest.source ||= 'summit_air_ai_phone_agent'
  serviceRequest.submitted_at ||= eventTimestampToIso(rawPayload?.event_timestamp) || options.now || new Date().toISOString()

  serviceRequest.caller ||= {}
  serviceRequest.caller.name = cleanString(serviceRequest.caller.name)
  serviceRequest.caller.phone = normalizePhone(serviceRequest.caller.phone) || 'unknown'
  serviceRequest.caller.phone_source = normalizeEnum(serviceRequest.caller.phone_source, PHONE_SOURCES, 'unavailable')
  serviceRequest.caller.caller_id_private = asBoolean(
    serviceRequest.caller.caller_id_private,
    isPrivateCallerId(serviceRequest.caller.phone)
  )
  serviceRequest.caller.callback_phone_available = asBoolean(
    serviceRequest.caller.callback_phone_available,
    isUsablePhone(serviceRequest.caller.phone)
  )

  serviceRequest.service_location ||= {}
  serviceRequest.service_location.address_line_1 = cleanString(serviceRequest.service_location.address_line_1)
  serviceRequest.service_location.address_line_2 = nullableString(serviceRequest.service_location.address_line_2)
  serviceRequest.service_location.borough = normalizeBorough(serviceRequest.service_location.borough)
  serviceRequest.service_location.is_in_service_area = asBoolean(
    serviceRequest.service_location.is_in_service_area,
    serviceRequest.service_location.borough
      ? COVERED_BOROUGHS.has(serviceRequest.service_location.borough)
      : false
  )

  serviceRequest.property ||= {}
  serviceRequest.property.type = normalizeEnum(serviceRequest.property.type, PROPERTY_TYPES, 'unknown')
  serviceRequest.property.business_name = nullableString(serviceRequest.property.business_name)

  serviceRequest.issue ||= {}
  serviceRequest.issue.category = normalizeEnumArray(serviceRequest.issue.category, ISSUE_CATEGORIES, 'other')
  serviceRequest.issue.description = cleanString(serviceRequest.issue.description)
  serviceRequest.issue.system = normalizeEnum(serviceRequest.issue.system, HVAC_SYSTEMS, 'unknown')

  serviceRequest.urgency ||= {}
  serviceRequest.urgency.level = normalizeEnum(serviceRequest.urgency.level, URGENCY_LEVELS, 'routine')
  serviceRequest.urgency.priority_reasons = asArray(serviceRequest.urgency.priority_reasons)
  serviceRequest.urgency.safety_action_given = nullableString(serviceRequest.urgency.safety_action_given)
  serviceRequest.urgency.caller_confirmed_safe = asBoolean(serviceRequest.urgency.caller_confirmed_safe, false)

  serviceRequest.availability ||= {}
  serviceRequest.availability.preferred_windows = asArray(serviceRequest.availability.preferred_windows)
  serviceRequest.availability.timezone ||= 'America/New_York'

  serviceRequest.next_step ||= {}
  serviceRequest.next_step.status = normalizeEnum(serviceRequest.next_step.status, NEXT_STEP_STATUSES, 'not_booked')
  serviceRequest.next_step.spoken_confirmation = cleanString(serviceRequest.next_step.spoken_confirmation)

  serviceRequest.conversation ||= {}
  serviceRequest.conversation.transcript_url = nullableString(serviceRequest.conversation.transcript_url)
  serviceRequest.conversation.conversation_id = nullableString(serviceRequest.conversation.conversation_id)
  serviceRequest.conversation.agent_version ||= 'summit-air-v1'

  return serviceRequest
}

function validateServiceRequest(serviceRequest) {
  const errors = []
  const warnings = []

  requireString(errors, serviceRequest.source, 'source')
  requireString(errors, serviceRequest.submitted_at, 'submitted_at')
  requireString(errors, serviceRequest.caller?.name, 'caller.name')
  requireString(errors, serviceRequest.service_location?.address_line_1, 'service_location.address_line_1')
  requireString(errors, serviceRequest.service_location?.borough, 'service_location.borough')
  requireString(errors, serviceRequest.issue?.description, 'issue.description')

  requireEnum(errors, serviceRequest.caller?.phone_source, PHONE_SOURCES, 'caller.phone_source')
  requireEnum(errors, serviceRequest.property?.type, PROPERTY_TYPES, 'property.type')
  requireEnumArray(errors, serviceRequest.issue?.category, ISSUE_CATEGORIES, 'issue.category')
  requireEnum(errors, serviceRequest.issue?.system, HVAC_SYSTEMS, 'issue.system')
  requireEnum(errors, serviceRequest.urgency?.level, URGENCY_LEVELS, 'urgency.level')
  requireEnum(errors, serviceRequest.next_step?.status, NEXT_STEP_STATUSES, 'next_step.status')

  const borough = serviceRequest.service_location?.borough
  const isInServiceArea = serviceRequest.service_location?.is_in_service_area
  const urgencyLevel = serviceRequest.urgency?.level
  const nextStepStatus = serviceRequest.next_step?.status

  if (borough && !COVERED_BOROUGHS.has(borough)) {
    if (urgencyLevel !== 'out_of_area') {
      errors.push(`service_location.borough is outside the service area: ${borough}`)
    } else {
      warnings.push(`Out-of-area borough flagged: ${borough}`)
    }
  }

  if (isInServiceArea === false && urgencyLevel !== 'out_of_area') {
    errors.push('service_location.is_in_service_area is false but urgency.level is not out_of_area')
  }

  if (urgencyLevel === 'out_of_area' && nextStepStatus !== 'not_booked') {
    errors.push('out_of_area requests must have next_step.status set to not_booked')
  }

  if (urgencyLevel === 'dangerous_safety_handoff') {
    requireString(errors, serviceRequest.urgency?.safety_action_given, 'urgency.safety_action_given')

    if (serviceRequest.urgency?.caller_confirmed_safe !== true) {
      errors.push('dangerous_safety_handoff requests must confirm urgency.caller_confirmed_safe')
    }
  }

  if (nextStepStatus === 'booked' && !serviceRequest.availability?.preferred_windows?.length) {
    errors.push('booked requests must include at least one availability.preferred_windows value')
  }

  if (nextStepStatus === 'booked' && !cleanString(serviceRequest.next_step?.spoken_confirmation)) {
    warnings.push('Booked but no spoken confirmation was captured on the call')
  }

  if (!isUsablePhone(serviceRequest.caller?.phone)) {
    warnings.push('Callback phone is unavailable or unknown')
  }

  if (serviceRequest.caller?.caller_id_private && !serviceRequest.caller?.callback_phone_available) {
    warnings.push('Caller ID was private and no caller-provided callback phone was captured')
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  }
}

function buildOpsEmail(serviceRequest, options = {}) {
  const warnings = options.warnings || []
  const errors = options.errors || []
  const needsReview = errors.length > 0
  const reviewItems = [...errors, ...warnings]
  const urgencyLabel = serviceRequest.urgency.level.toUpperCase()
  const categoryLabel = serviceRequest.issue.category
    .map((category) => category.replaceAll('_', ' '))
    .join(', ')
  const borough = serviceRequest.service_location.borough || 'Unknown borough'
  const callerName = serviceRequest.caller.name || 'Unknown caller'
  const callbackUnavailable = !isUsablePhone(serviceRequest.caller.phone)

  const subject = [
    '[Summit Air]',
    needsReview ? 'NEEDS REVIEW -' : null,
    urgencyLabel,
    categoryLabel,
    '-',
    borough,
    '-',
    callerName
  ].filter(Boolean).join(' ')

  // Prefer ElevenLabs' clean third-person summary when present; the locally
  // built one stitches raw first-person quotes together and reads poorly.
  const summary = cleanString(options.transcriptSummary) || buildHumanSummary(serviceRequest)
  const structuredJson = JSON.stringify(serviceRequest, null, 2)
  const transcriptText = options.transcriptText || null

  const isDangerousCall = serviceRequest.urgency.level === 'dangerous_safety_handoff'
  const conversationLink = serviceRequest.conversation.transcript_url
    || (serviceRequest.conversation.conversation_id
      ? `https://elevenlabs.io/app/conversational-ai/history/${serviceRequest.conversation.conversation_id}`
      : null)

  const rows = [
    ['Urgency', urgencyLabel],
    ['Priority reasons', serviceRequest.urgency.priority_reasons.join(', ') || 'None provided'],
    ['Caller', callerName],
    ['Callback phone', serviceRequest.caller.phone],
    ['Phone source', serviceRequest.caller.phone_source],
    ['Address', formatAddress(serviceRequest)],
    ['Property', formatProperty(serviceRequest)],
    ['Issue', `${categoryLabel}: ${serviceRequest.issue.description}`],
    ['System', serviceRequest.issue.system],
    ['Requested window', serviceRequest.availability.preferred_windows.join(', ') || 'Not provided'],
    ['Next step', `${serviceRequest.next_step.status}: ${serviceRequest.next_step.spoken_confirmation || 'No spoken confirmation captured'}`],
    ['Safety action', isDangerousCall ? (serviceRequest.urgency.safety_action_given || 'None recorded') : 'N/A'],
    ['Caller confirmed safe', isDangerousCall ? String(serviceRequest.urgency.caller_confirmed_safe) : 'N/A'],
    ['Call recording', conversationLink || 'Not provided'],
    ['Agent version', serviceRequest.conversation.agent_version],
    ['Payload source', options.receivedPayloadType || 'service_request']
  ]

  const reviewTitle = needsReview
    ? 'INCOMPLETE — NEEDS REVIEW'
    : (callbackUnavailable ? 'CALLBACK PHONE UNAVAILABLE' : 'Review needed')
  const reviewBlock = reviewItems.length
    ? `<div style="border: 2px solid ${needsReview ? '#b91c1c' : '#b45309'}; background: ${needsReview ? '#fef2f2' : '#fffbeb'}; color: ${needsReview ? '#7f1d1d' : '#78350f'}; padding: 12px; margin: 0 0 16px 0;">
        <strong>${reviewTitle}</strong>
        <ul>${reviewItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>`
    : ''

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 760px; margin: 0 auto; color: #111827;">
      <h1 style="font-size: 22px; margin: 0 0 8px 0;">Summit Air Service Request</h1>
      <p style="margin: 0 0 18px 0; color: #4b5563;">${escapeHtml(summary)}</p>
      ${reviewBlock}
      <table style="width: 100%; border-collapse: collapse; margin: 0 0 20px 0;">
        <tbody>
          ${rows.map(([label, value]) => `
            <tr>
              <th style="text-align: left; vertical-align: top; width: 180px; padding: 8px; border-bottom: 1px solid #e5e7eb; background: #f9fafb;">${escapeHtml(label)}</th>
              <td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(value)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <h2 style="font-size: 16px; margin: 20px 0 8px 0;">Raw Structured JSON</h2>
      <pre style="white-space: pre-wrap; overflow-wrap: anywhere; background: #f3f4f6; padding: 12px; border-radius: 6px;">${escapeHtml(structuredJson)}</pre>
      ${transcriptText ? `
        <h2 style="font-size: 16px; margin: 20px 0 8px 0;">Transcript</h2>
        <pre style="white-space: pre-wrap; overflow-wrap: anywhere; background: #f3f4f6; padding: 12px; border-radius: 6px;">${escapeHtml(transcriptText)}</pre>
      ` : ''}
    </div>
  `

  const text = [
    'Summit Air Service Request',
    '',
    summary,
    '',
    reviewItems.length ? `${needsReview ? 'NEEDS REVIEW' : 'Warnings'}:\n${reviewItems.map((item) => `- ${item}`).join('\n')}` : null,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Raw Structured JSON:',
    structuredJson,
    transcriptText ? `\nTranscript:\n${transcriptText}` : null
  ].filter(Boolean).join('\n')

  return { subject, html, text }
}

function buildHumanSummary(serviceRequest) {
  const caller = serviceRequest.caller.name || 'The caller'
  const property = serviceRequest.property.type
  const borough = serviceRequest.service_location.borough || 'an unknown borough'
  const window = serviceRequest.availability.preferred_windows.join(', ') || 'no requested window'

  return `${caller} requested ${serviceRequest.urgency.level.replaceAll('_', ' ')} ${property} HVAC service in ${borough} for ${serviceRequest.issue.description}. Requested window: ${window}.`
}

function unboxDataCollectionResults(results) {
  const flat = {}

  for (const [key, value] of Object.entries(results || {})) {
    flat[key] = unwrapCollectedValue(value)
  }

  return flat
}

function unwrapCollectedValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }

  for (const key of ['value', 'result', 'data', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return unwrapCollectedValue(value[key])
    }
  }

  return value
}

function extractTranscriptText(payload) {
  const transcript = payload?.data?.transcript || payload?.conversation?.transcript

  if (Array.isArray(transcript)) {
    return transcript
      .map((turn) => `${turn.role || 'unknown'}: ${turn.message || ''}`.trim())
      .filter(Boolean)
      .join('\n')
  }

  return nullableString(payload?.conversation?.transcript_text || payload?.transcript_text)
}

function extractTranscriptSummary(payload) {
  return nullableString(payload?.data?.analysis?.transcript_summary || payload?.transcript_summary)
}

function findCallerId(...sources) {
  // Keys are matched after stripping non-alphanumerics and lowercasing, so
  // entries here must be in that normalized form (e.g. ElevenLabs'
  // `system__caller_id` dynamic variable normalizes to `systemcallerid`).
  const keys = new Set([
    'callerid',
    'systemcallerid',
    'from',
    'caller',
    'callernumber',
    'phonenumber',
    'phone'
  ])

  for (const source of sources) {
    const found = findValueByKey(source, keys)
    if (found) return String(found)
  }

  return null
}

function findValueByKey(value, targetKeys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')

    if (targetKeys.has(normalizedKey) && typeof nestedValue !== 'object') {
      return nestedValue
    }

    const found = findValueByKey(nestedValue, targetKeys, depth + 1)
    if (found) return found
  }

  return null
}

function makeIdempotencyKey(serviceRequest, payload) {
  const conversationId = payload?.data?.conversation_id || payload?.conversation?.conversation_id || payload?.conversation_id

  if (conversationId) {
    return `summit-air-${conversationId}`
  }

  return [
    'summit-air',
    serviceRequest.submitted_at,
    serviceRequest.caller.name,
    serviceRequest.service_location.address_line_1
  ]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 120)
}

function normalizeBorough(value) {
  const text = cleanString(value)
  if (!text) return ''

  const lower = text.toLowerCase()
  if (lower.includes('manhattan') || lower === 'new york' || lower === 'nyc') return 'Manhattan'
  if (lower.includes('queens')) return 'Queens'
  if (lower.includes('brooklyn') || lower.includes('kings')) return 'Brooklyn'
  if (lower.includes('bronx')) return 'Bronx'
  if (lower.includes('staten')) return 'Staten Island'

  return text
}

function normalizePhone(value) {
  const text = cleanString(value)
  if (!text) return ''
  if (isPrivateCallerId(text)) return 'unknown'
  return text
}

function inferPhoneSource(phone, fields) {
  if (fields.phone_source) return fields.phone_source
  if (isUsablePhone(phone) && asBoolean(fields.caller_id_private, false)) return 'caller_provided'
  if (isUsablePhone(phone)) return 'twilio_caller_id'
  return 'unavailable'
}

function isUsablePhone(value) {
  const text = cleanString(value)
  if (!text || isPrivateCallerId(text)) return false

  const digits = text.replace(/\D/g, '')
  return digits.length >= 7
}

function isPrivateCallerId(value) {
  const text = cleanString(value).toLowerCase()
  return ['anonymous', 'private', 'restricted', 'unknown', 'unavailable', 'withheld', 'blocked', 'null'].includes(text)
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(/\n|,/)
      .map(cleanString)
      .filter(Boolean)
  }

  if (value == null) return []
  return [cleanString(value)].filter(Boolean)
}

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value == null || value === '') return fallback

  const text = String(value).trim().toLowerCase()
  if (['true', 'yes', 'y', '1'].includes(text)) return true
  if (['false', 'no', 'n', '0'].includes(text)) return false

  return fallback
}

function normalizeEnumOrNull(value, allowedValues) {
  const text = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  return allowedValues.has(text) ? text : null
}

function normalizeEnum(value, allowedValues, fallback) {
  return normalizeEnumOrNull(value, allowedValues) ?? fallback
}

function normalizeEnumArray(value, allowedValues, fallback) {
  const items = asArray(value)
    .map((item) => normalizeEnumOrNull(item, allowedValues))
    .filter(Boolean)
  const unique = [...new Set(items)]
  if (unique.length) return unique
  return fallback ? [fallback] : []
}

function cleanString(value) {
  if (value == null) return ''
  return String(value).trim()
}

function nullableString(value) {
  const text = cleanString(value)
  return text || null
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function eventTimestampToIso(timestamp) {
  if (!timestamp) return null

  const numericTimestamp = Number(timestamp)
  if (!Number.isFinite(numericTimestamp)) return null

  const milliseconds = numericTimestamp > 10_000_000_000
    ? numericTimestamp
    : numericTimestamp * 1000

  return new Date(milliseconds).toISOString()
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function requireString(errors, value, path) {
  if (!cleanString(value)) {
    errors.push(`${path} is required`)
  }
}

function requireEnum(errors, value, allowedValues, path) {
  if (!allowedValues.has(value)) {
    errors.push(`${path} must be one of: ${Array.from(allowedValues).join(', ')}`)
  }
}

function requireEnumArray(errors, values, allowedValues, path) {
  const list = Array.isArray(values) ? values : []

  if (!list.length) {
    errors.push(`${path} must include at least one of: ${Array.from(allowedValues).join(', ')}`)
    return
  }

  for (const value of list) {
    if (!allowedValues.has(value)) {
      errors.push(`${path} has an invalid value: ${value}`)
    }
  }
}

function formatAddress(serviceRequest) {
  const parts = [
    serviceRequest.service_location.address_line_1,
    serviceRequest.service_location.address_line_2,
    serviceRequest.service_location.borough
  ].filter(Boolean)

  return parts.join(', ')
}

function formatProperty(serviceRequest) {
  return serviceRequest.property.business_name
    ? `${serviceRequest.property.type} (${serviceRequest.property.business_name})`
    : serviceRequest.property.type
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

module.exports = {
  buildOpsEmail,
  buildServiceRequestFromFlatFields,
  normalizeServiceRequestPayload,
  processServiceRequestPayload,
  unboxDataCollectionResults,
  validateServiceRequest
}
