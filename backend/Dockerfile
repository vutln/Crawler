FROM node:22-bookworm

# Install Chromium (required for Selenium)
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy the rest of the application code
COPY . .

# Build the NestJS application
RUN npm run build

# Start command
# Runs migrations, then starts the server
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:prod"]
