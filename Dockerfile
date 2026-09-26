# NaijaBridge backend — serves both the Express API and the static site/ and
# backend/public/admin/ directories (see backend/src/server.js), so the whole
# repo (not just backend/) is copied in to preserve those relative paths.

FROM node:20-alpine

WORKDIR /app

# Install backend dependencies first so this layer is cached unless package*.json changes.
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci --omit=dev

# Now bring in the rest of the project (site/, backend/src, scripts, etc.).
COPY . .

# multer writes into these subdirectories directly and does not create them itself.
RUN mkdir -p \
    backend/uploads/id-documents \
    backend/uploads/screenshots \
    backend/uploads/inspection-photos \
    backend/uploads/selfie-photos \
    backend/uploads/order-item-images \
    backend/uploads/payment-receipts

ENV NODE_ENV=production
EXPOSE 4000

WORKDIR /app/backend
CMD ["node", "src/server.js"]
