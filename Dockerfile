# Use Apify's official Playwright image (includes browsers pre-installed)
FROM apify/actor-node-playwright-chrome:20

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm --quiet set progress=false \
  && npm install --omit=dev --omit=optional \
  && echo "npm install done"

# Copy source code
COPY . ./

# Run the actor
CMD npm start
