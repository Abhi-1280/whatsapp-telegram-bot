FROM ghcr.io/puppeteer/puppeteer:21.5.2

USER root

# Since puppeteer image already has Chrome, we don't need to install it again
# Just install additional dependencies if needed
RUN apt-get update && apt-get install -y \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create a non-root user
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 10000

CMD ["node", "index.js"]
