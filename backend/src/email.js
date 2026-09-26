import nodemailer from "nodemailer";
import { query } from "./db/pool.js";

let transporterPromise = null;

export async function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      const testAccount = await nodemailer.createTestAccount();
      const transporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass }
      });
      console.log(`Ethereal test inbox ready. Log in at https://ethereal.email/login with user "${testAccount.user}" / pass "${testAccount.pass}" to browse sent mail.`);
      return transporter;
    })();
  }
  return transporterPromise;
}

export function warmEmailTransporter() {
  getTransporter().catch((error) => console.error("Failed to initialize Ethereal test account:", error.message));
}

export async function sendShopperEmail(shopperId, subject, body, sender = {}) {
  const { senderType = "system", senderId = null, senderName = null } = sender;
  const inserted = await query(
    `INSERT INTO notifications (shopper_id, subject, body, sender_type, sender_id, sender_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [shopperId, subject, body, senderType, senderId, senderName]
  );
  const notificationId = inserted.rows[0]?.id;

  try {
    const shopperResult = await query("SELECT email, first_name, last_name FROM shoppers WHERE id = $1", [shopperId]);
    const shopper = shopperResult.rows[0];
    if (!shopper) return;

    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: '"NaijaBridge" <no-reply@naijabridge.test>',
      to: shopper.email,
      subject,
      text: body
    });
    console.log(`Email sent to ${shopper.email}: ${subject}`);
    console.log(`Preview URL: ${nodemailer.getTestMessageUrl(info)}`);

    if (notificationId) {
      await query("UPDATE notifications SET sent_at = now() WHERE id = $1", [notificationId]);
    }
  } catch (error) {
    console.error("Failed to send shopper email:", error.message);
  }
}
