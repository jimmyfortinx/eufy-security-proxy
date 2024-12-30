FROM node:20-alpine 
RUN apk add --no-cache ffmpeg jq
WORKDIR /usr/app
RUN test -f .env && cp .env /usr/app/.env || echo "File does not exist"
COPY node_modules /usr/app/node_modules
COPY src /usr/app/src/
COPY views /usr/app/views/
COPY package.json /usr/app/package.json
EXPOSE 3000
VOLUME ["/usr/app/data"]
CMD [ "/usr/local/bin/node", "--security-revert=CVE-2023-46809", "/usr/app/src/index.js" ]
