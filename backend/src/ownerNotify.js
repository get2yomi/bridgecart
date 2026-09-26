import nodemailer from "nodemailer";
import { query } from "./db/pool.js";
import { getTransporter } from "./email.js";
import { sendCarrierSms } from "./smsGateways.js";

async function getOwnerContact() {
  const result = await query("SELECT id, email, phone, phone_carrier FROM admin_users WHERE role = 'owner' AND is_active = true ORDER BY id ASC LIMIT 1");
  return result.rows[0] || null;
}

// Emails the business owner (not the shopper) — used for operational alerts like a QC approval waiting on them.
export async function notifyOwner(subject, body) {
  const owner = await getOwnerContact();
  if (!owner) {
    console.error("Failed to notify owner: no active owner account found.");
    return;
  }

  try {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: '"NaijaBridge" <no-reply@naijabridge.test>',
      to: owner.email,
      subject,
      text: body
    });
    console.log(`Owner notification emailed to ${owner.email}: ${subject}`);
    console.log(`Preview URL: ${nodemailer.getTestMessageUrl(info)}`);
  } catch (error) {
    console.error("Failed to email owner:", error.message);
  }

  if (owner.phone && owner.phone_carrier) {
    const transporter = await getTransporter();
    await sendCarrierSms(transporter, owner.phone, owner.phone_carrier, `${subject} - ${body}`.slice(0, 200));
  } else {
    console.log("Skipping owner SMS: phone/carrier not set on owner profile.");
  }
}
