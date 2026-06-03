# Playwright base image: Chromium + all system libs preinstalled (no apt headaches)
# IMPORTANT: keep this version in sync with "playwright" in package.json
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Railway injects PORT; the app reads process.env.PORT (falls back to 3000)
EXPOSE 3000
CMD ["node", "mainstreet-vendor-lookup.js"]
