FROM ghcr.io/puppeteer/puppeteer:21.5.2

WORKDIR /app

# Copy package files as root
COPY --chown=pptruser:pptruser package*.json ./

# Switch to pptruser to install dependencies
USER pptruser

RUN npm install

# Copy rest of the application
COPY --chown=pptruser:pptruser . .

EXPOSE 10000

CMD ["node", "index.js"]
