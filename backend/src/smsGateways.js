// Carrier email-to-SMS gateways. This covers common US carriers only — there is no reliable, standardized
// email-to-SMS gateway for Nigerian carriers (MTN, Glo, Airtel, 9mobile), so this is a starting point aimed
// at a US-based owner phone; Nigerian-carrier support would need a real SMS API (Termii, Africa's Talking, etc.)
// rather than this free email-gateway trick.
export const SMS_GATEWAYS = {
  att: "txt.att.net",
  verizon: "vtext.com",
  tmobile: "tmomail.net",
  sprint: "messaging.sprintpcs.com"
};

export function digitsOnly(phoneNumber) {
  return String(phoneNumber || "").replace(/\D/g, "");
}

export async function sendCarrierSms(transporter, phoneNumber, carrierKey, message) {
  const gateway = SMS_GATEWAYS[carrierKey];
  const digits = digitsOnly(phoneNumber);
  if (!gateway || !digits) {
    console.log(`Skipping carrier SMS: no phone/carrier gateway configured (carrier="${carrierKey || ""}").`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: '"NaijaBridge" <no-reply@naijabridge.test>',
      to: `${digits}@${gateway}`,
      subject: "",
      text: message
    });
    console.log(`Carrier SMS sent to ${digits}@${gateway}`);
    return true;
  } catch (error) {
    console.error("Failed to send carrier SMS:", error.message);
    return false;
  }
}
