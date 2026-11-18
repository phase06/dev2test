# Remote runtime image. Build from the repo root after `npm run build`:
#   docker build -f deploy/Dockerfile -t crew-runtime .
#   docker run -d --name crew -p 127.0.0.1:4780:4780 -v crew-data:/data crew-runtime
#   docker logs crew        # prints the "Open:" link with the access token
FROM mcr.microsoft.com/playwright:v1.49.0-noble
# ^ ships Node + Chromium so the browser tool works. Use node:22-slim if you don't need it.
RUN apt-get update && apt-get install -y --no-install-recommends git curl python3 python3-pip jq ripgrep && rm -rf /var/lib/apt/lists/* \
 && npm i -g playwright@1.49.0
ENV NODE_PATH=/usr/lib/node_modules CREW_HOME=/data CREW_HOST=0.0.0.0
WORKDIR /app
COPY dist/ /app/
VOLUME /data
EXPOSE 4780
CMD ["node", "/app/crew-runtime.mjs"]
