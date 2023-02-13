FROM node:16-alpine as build
WORKDIR /tmp
COPY . .
RUN npm ci

FROM node:16-alpine
RUN apk add  --no-cache ffmpeg
WORKDIR /usr/src/app
COPY --from=build /tmp/index.js ./index.js
COPY --from=build /tmp/package.json ./package.json
COPY --from=build /tmp/package-lock.json ./package-lock.json
RUN apk add --no-cache jq \
  && npm ci --only=production
EXPOSE 3000
VOLUME ["/usr/src/app/data"]
CMD [ "/usr/local/bin/node", "/usr/src/app/index.js" ]
