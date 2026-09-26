import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { generateShopperCode } from "../shopperCode.js";
import { generateResetToken } from "../resetToken.js";
import { upload } from "../upload.js";
import { sendShopperEmail } from "../email.js";
import { logActivity } from "../activityLog.js";

export const authRouter = Router();

authRouter.post("/register", upload.fields([{ name: "idDocument", maxCount: 1 }, { name: "selfie", maxCount: 1 }]), async (req, res) => {
  const {
    firstName, lastName, payerFirstName, payerLastName, email, username, password, phone,
    streetAddress, city, state, physicalStreetAddress, physicalCity, physicalState, idType, idNumber, nin
  } = req.body;

  if (!firstName || !lastName || !payerFirstName || !payerLastName || !email || !username || !password || !idType || !idNumber) {
    return res.status(400).json({ error: "All required fields must be filled." });
  }
  if (!nin || !nin.trim()) {
    return res.status(400).json({ error: "Your National Identification Number (NIN) is required." });
  }
  if (!/^\d{11}$/.test(nin.trim())) {
    return res.status(400).json({ error: "NIN must be exactly 11 digits." });
  }
  if (!phone || !phone.trim()) {
    return res.status(400).json({ error: "A phone number is required." });
  }
  if (!streetAddress || !streetAddress.trim() || !city || !city.trim() || !state || !state.trim()) {
    return res.status(400).json({ error: "Your shipping address (street, city, state) is required." });
  }
  if (!physicalStreetAddress || !physicalStreetAddress.trim() || !physicalCity || !physicalCity.trim() || !physicalState || !physicalState.trim()) {
    return res.status(400).json({ error: "Your physical (home) address is required." });
  }
  const nameMatches = firstName.trim().toLowerCase() === payerFirstName.trim().toLowerCase()
    && lastName.trim().toLowerCase() === payerLastName.trim().toLowerCase();
  if (!nameMatches) {
    return res.status(400).json({ error: "Payer name must match your registered full name." });
  }
  const idDocumentFile = req.files?.idDocument?.[0];
  const selfieFile = req.files?.selfie?.[0];
  if (!idDocumentFile) {
    return res.status(400).json({ error: "An identification document is required." });
  }
  if (!selfieFile) {
    return res.status(400).json({ error: "A live photo is required to verify your identity." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const usernameNormalized = username.trim().toLowerCase();
  const existingEmail = await query("SELECT 1 FROM shoppers WHERE email = $1", [email.toLowerCase()]);
  if (existingEmail.rowCount > 0) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  const existingUsername = await query("SELECT 1 FROM shoppers WHERE username = $1", [usernameNormalized]);
  if (existingUsername.rowCount > 0) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const shopperCode = await generateShopperCode();
  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  const payerName = `${payerFirstName.trim()} ${payerLastName.trim()}`;

  const inserted = await query(
    `INSERT INTO shoppers (first_name, last_name, payer_first_name, payer_last_name, full_name, payer_name, email, username, password_hash, phone, street_address, city, state, physical_street_address, physical_city, physical_state, shopper_code, id_type, id_number, nin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id, shopper_code, verification_status`,
    [
      firstName.trim(), lastName.trim(), payerFirstName.trim(), payerLastName.trim(), fullName, payerName,
      email.toLowerCase().trim(), usernameNormalized, passwordHash, phone.trim(),
      streetAddress.trim(), city.trim(), state.trim(),
      physicalStreetAddress.trim(), physicalCity.trim(), physicalState.trim(),
      shopperCode, idType, idNumber.trim(), nin.trim()
    ]
  );
  const shopper = inserted.rows[0];

  await query(
    `INSERT INTO id_documents (shopper_id, file_path, original_name, mime_type) VALUES ($1, $2, $3, $4)`,
    [shopper.id, idDocumentFile.filename, idDocumentFile.originalname, idDocumentFile.mimetype]
  );
  await query(
    `INSERT INTO selfie_photos (shopper_id, file_path, mime_type) VALUES ($1, $2, $3)`,
    [shopper.id, selfieFile.filename, selfieFile.mimetype]
  );

  await sendShopperEmail(shopper.id, "Registration received", "Your NaijaBridge account is pending identity verification. We'll notify you once it's reviewed.");
  await logActivity({
    actorType: "shopper", actorId: shopper.id, actorName: fullName,
    action: "shopper_registered", targetType: "shopper", targetId: shopper.id
  });

  res.status(201).json({
    message: "Registration received. Your account is pending verification.",
    shopperCode: shopper.shopper_code
  });
});

authRouter.post("/login", async (req, res) => {
  const { email, username, password } = req.body;
  const identifier = (email || username || "").toLowerCase().trim();
  if (!identifier || !password) return res.status(400).json({ error: "Email/username and password are required." });

  const result = await query(
    "SELECT * FROM shoppers WHERE lower(email) = $1 OR lower(username) = $1",
    [identifier]
  );
  const shopper = result.rows[0];
  if (!shopper || !(await bcrypt.compare(password, shopper.password_hash))) {
    return res.status(401).json({ error: "Invalid email/username or password." });
  }

  req.session.shopperId = shopper.id;
  req.session.shopperStatus = shopper.verification_status;

  await logActivity({
    actorType: "shopper", actorId: shopper.id, actorName: `${shopper.first_name} ${shopper.last_name}`,
    action: "shopper_logged_in", targetType: "shopper", targetId: shopper.id
  });

  res.json({
    id: shopper.id,
    fullName: `${shopper.first_name} ${shopper.last_name}`,
    shopperCode: shopper.shopper_code,
    verificationStatus: shopper.verification_status
  });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Logged out." }));
});

authRouter.get("/me", async (req, res) => {
  if (!req.session.shopperId) return res.status(401).json({ error: "Not logged in." });
  const result = await query(
    "SELECT id, first_name, last_name, email, username, shopper_code, verification_status, us_address_line FROM shoppers WHERE id = $1",
    [req.session.shopperId]
  );
  const shopper = result.rows[0];
  if (!shopper) return res.status(401).json({ error: "Not logged in." });
  res.json({
    id: shopper.id,
    fullName: `${shopper.first_name} ${shopper.last_name}`,
    email: shopper.email,
    username: shopper.username,
    shopperCode: shopper.shopper_code,
    verificationStatus: shopper.verification_status,
    usAddressLine: shopper.us_address_line
  });
});

authRouter.post("/forgot-password", async (req, res) => {
  const identifier = (req.body.email || req.body.username || "").toLowerCase().trim();
  const genericMessage = { message: "If an account exists for that email, a reset link has been sent." };
  if (!identifier) return res.json(genericMessage);

  const result = await query(
    "SELECT id, email FROM shoppers WHERE lower(email) = $1 OR lower(username) = $1",
    [identifier]
  );
  const shopper = result.rows[0];
  if (!shopper) return res.json(genericMessage);

  const token = await generateResetToken();
  await query(
    "UPDATE shoppers SET reset_token = $1, reset_token_expires_at = now() + interval '1 hour' WHERE id = $2",
    [token, shopper.id]
  );

  const resetLink = `${req.protocol}://${req.get("host")}/reset-password.html?token=${token}`;
  await sendShopperEmail(
    shopper.id,
    "Reset your NaijaBridge password",
    `We received a request to reset your password. Use this link within the next hour to choose a new one:\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`
  );

  res.json(genericMessage);
});

authRouter.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "A reset token and new password are required." });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const result = await query(
    "SELECT id FROM shoppers WHERE reset_token = $1 AND reset_token_expires_at > now()",
    [token]
  );
  const shopper = result.rows[0];
  if (!shopper) return res.status(400).json({ error: "This reset link is invalid or has expired." });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await query(
    "UPDATE shoppers SET password_hash = $1, reset_token = NULL, reset_token_expires_at = NULL WHERE id = $2",
    [passwordHash, shopper.id]
  );

  res.json({ message: "Your password has been reset. You can now log in." });
});
