# NaijaBridge (bridgecart)

This package contains the NaijaBridge website design and product-cost calculator.

## Included

- Responsive customer-facing website
- USD/NGN quote calculator
- Item, Indiana tax, store delivery, international shipping, customs, protection, and service-fee breakdown
- Free-shipping indicator
- Product title and image lookup through Microlink
- Direct structured-product-data fallback
- Checkout and order-tracking previews

## Project structure

- `site/index.html` — page structure
- `site/styles.css` — design and responsive styling
- `site/app.js` — calculator and customer interactions
- `worker/index.template.js` — server and product-lookup endpoint
- `scripts/build.mjs` — creates the deployable output
- `.openai/hosting.json` — Sites project configuration

## Run the build

Install Node.js 18 or newer, open a terminal in this folder, and run:

```bash
npm run build
npm run validate
```

The deployable application will be generated in the `dist` folder.

## Important limitation

Microlink's free endpoint has a small daily request allowance. Product titles and images are generally more available than current prices. Amazon and some other retailers may block prices or expose shipping only during checkout, so the website keeps manual verification as a fallback.

Payment processing, customer accounts, a production database, and retailer-specific API credentials are not included yet.
