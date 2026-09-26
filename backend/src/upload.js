import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_ROOT = path.join(__dirname, "..", "uploads");

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_RECEIPT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

const SUBDIR_BY_FIELD = {
  idDocument: "id-documents",
  photos: "inspection-photos",
  selfie: "selfie-photos"
};

// Item images use dynamically-named fields (itemImages_0, itemImages_1, ...) since the number of items is
// not known ahead of time — see the "any field starting with itemImages_" rule below.
const ITEM_IMAGES_SUBDIR = "order-item-images";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const subdir = file.fieldname.startsWith("itemImages_") ? ITEM_IMAGES_SUBDIR : (SUBDIR_BY_FIELD[file.fieldname] || "screenshots");
    cb(null, path.join(UPLOAD_ROOT, subdir));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    cb(new Error("Only PNG, JPG, or WEBP images are allowed."));
    return;
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }
});

export const ITEM_IMAGES_FIELD_PREFIX = "itemImages_";

// Separate instance (not merged into `upload` above) because a payment receipt may legitimately be a PDF,
// while ID documents/selfies/item images must stay image-only — loosening the shared instance would let a
// PDF slip into those unrelated upload paths too.
const receiptStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, "payment-receipts")),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || (file.mimetype === "application/pdf" ? ".pdf" : ".jpg");
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

function receiptFileFilter(req, file, cb) {
  if (!ALLOWED_RECEIPT_MIME.has(file.mimetype)) {
    cb(new Error("Only PNG, JPG, WEBP, or PDF files are allowed for a receipt."));
    return;
  }
  cb(null, true);
}

export const uploadReceipt = multer({
  storage: receiptStorage,
  fileFilter: receiptFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }
});
