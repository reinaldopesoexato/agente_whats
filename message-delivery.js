// whatsapp-web.js exposes ack on outgoing messages and forwarding metadata on the message itself.
function messageDelivery(message) {
  const fields = {}
  if (message.fromMe && Number.isInteger(message.ack) && message.ack >= -1 && message.ack <= 4) {
    fields.ack = message.ack
  }
  if (message.isForwarded === true || message.forwardingScore > 0) fields.isForwarded = true
  else if (message.isForwarded === false) fields.isForwarded = false
  return fields
}

function mergeDelivery(record, observation) {
  const {ack, isForwarded} = messageDelivery(observation)
  let changed = false
  // A stale page can arrive after the live receipt. Positive acknowledgements only advance.
  if (record.fromMe && ack !== undefined && ack !== record.ack && !(record.ack > 0 && ack < record.ack)) {
    record.ack = ack
    changed = true
  }
  if (isForwarded !== undefined && record.isForwarded !== true && record.isForwarded !== isForwarded) {
    record.isForwarded = isForwarded
    changed = true
  }
  return changed
}

module.exports = {messageDelivery, mergeDelivery}
