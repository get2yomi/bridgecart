import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db/pool.js";
import { authRouter } from "./routes/auth.js";
import { accountDashboardRouter } from "./routes/accountDashboard.js";
import { adminAuthRouter } from "./routes/adminAuth.js";
import { ordersRouter } from "./routes/orders.js";
import { paymentsRouter } from "./routes/payments.js";
import { subscriptionsRouter } from "./routes/subscriptions.js";
import { adminRouter } from "./routes/admin.js";
import { staffRouter } from "./routes/staff.js";
import { qualityInspectionsRouter } from "./routes/qualityInspections.js";
import { settingsPublicRouter } from "./routes/settingsPublic.js";
import { customsFeeRouter } from "./routes/customsFee.js";
import { shippingLabelRouter } from "./routes/shippingLabel.js";
import { UPLOAD_ROOT } from "./upload.js";
import { requireAdmin } from "./middleware/auth.js";
import { warmEmailTransporter } from "./email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PgSession = connectPgSimple(session);

const app = express();
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7,
    secure: process.env.NODE_ENV === "production"
  }
}));

app.use("/api/auth", authRouter);
app.use("/api/account", accountDashboardRouter);
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/settings", settingsPublicRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin/staff", staffRouter);
app.use("/api/admin", qualityInspectionsRouter);
app.use("/api/admin", customsFeeRouter);
app.use("/api/admin", shippingLabelRouter);

app.use("/uploads/id-documents", requireAdmin, express.static(path.join(UPLOAD_ROOT, "id-documents")));
app.use("/uploads/screenshots", requireAdmin, express.static(path.join(UPLOAD_ROOT, "screenshots")));
app.use("/uploads/inspection-photos", requireAdmin, express.static(path.join(UPLOAD_ROOT, "inspection-photos")));
app.use("/uploads/selfie-photos", requireAdmin, express.static(path.join(UPLOAD_ROOT, "selfie-photos")));
app.use("/uploads/order-item-images", requireAdmin, express.static(path.join(UPLOAD_ROOT, "order-item-images")));
app.use("/uploads/payment-receipts", requireAdmin, express.static(path.join(UPLOAD_ROOT, "payment-receipts")));

app.use(express.static(path.join(__dirname, "..", "..", "site")));
app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));

app.use((err, req, res, next) => {
  if (err) {
    console.error(err);
    return res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
  }
  next();
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`NaijaBridge backend listening on http://localhost:${port}`));
warmEmailTransporter();
