FROM node:22-slim

WORKDIR /app/src/frontend

# Install deps (node_modules stays in container, not mounted from host)
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm install

# Copy source for initial layer (src/ is volume-mounted at runtime)
COPY src/frontend/ ./

# Copy biome.json from repo root (also volume-mounted at runtime)
COPY biome.json /app/biome.json

EXPOSE 5173

# Vite dev server — host=true to listen on all interfaces
CMD ["npm", "run", "dev", "--", "--host"]
