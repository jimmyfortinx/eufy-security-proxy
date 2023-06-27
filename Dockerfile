FROM --platform=linux/amd64 node:16-alpine
RUN apk add --no-cache tzdata
RUN apk add --no-cache ffmpeg
WORKDIR /usr/app
COPY src /usr/app/src/
COPY views /usr/app/views/
COPY package.json /usr/app/package.json
COPY package-lock.json /usr/app/package-lock.json
RUN apk add --no-cache jq \
  && npm ci --only=production
EXPOSE 3000
VOLUME ["/usr/app/data"]
CMD [ "/usr/local/bin/node", "/usr/app/src/index.js" ]
