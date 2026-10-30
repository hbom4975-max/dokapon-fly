# อิมเมจนี้มี Chromium ติดตั้งมาแล้ว (เวอร์ชันต้องตรงกับ playwright-core ใน package.json)
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
