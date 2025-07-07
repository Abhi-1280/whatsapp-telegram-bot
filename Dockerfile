FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (using npm install instead of ci)
RUN npm install --omit=dev --no-audit --no-fund

# Copy application files
COPY . .

# Expose port
EXPOSE 10000

# Start the application
CMD ["node", "index.js"]
