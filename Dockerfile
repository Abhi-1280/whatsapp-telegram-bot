FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Switch to root to install dependencies
USER root

# Install additional dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (CHANGED THIS LINE)
RUN npm install --omit=dev

# Copy application files
COPY . .

# Create a non-root user to run the app
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# Switch to non-root user
USER pptruser

# Expose port (Render uses 10000 by default)
EXPOSE 10000

# Start the application
CMD ["node", "index.js"]
