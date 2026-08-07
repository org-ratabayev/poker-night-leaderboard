# Single stage is enough: the app has zero runtime dependencies.
# bun:sqlite and Bun.password are built into the Bun runtime.
FROM oven/bun:1

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src
COPY static ./static

# Run as the unprivileged `bun` user shipped in the image.
USER bun

EXPOSE 8787
CMD ["bun", "src/server.ts"]
